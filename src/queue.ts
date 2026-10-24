// The web page's processing queue: videos are processed one at a time (whisper
// already uses every core), in the order they were added. Each job keeps the
// progress of every stage, can be canceled, retried or moved to the front, and
// the queue is saved so that a restart picks up where it was.

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'

import type { Engine, ModelName } from './deps.js'
import type { Progress, ProcessOptions, ProcessedVideo } from './process.js'

export interface JobOptions {
  language?: string
  model?: ModelName
  engine?: Engine
  force?: boolean
}

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'canceled'

export interface Job {
  id: string
  videoId: string
  path: string
  name: string
  options: JobOptions
  state: JobState
  addedAt: number
  startedAt?: number
  finishedAt?: number
  /** The last stage reported, and what it said. */
  stage?: Progress['stage']
  message?: string
  /** 0–100, and when the transcription started (for an estimate of the time left). */
  transcribe?: number
  transcribeStartedAt?: number
  /** True once the key frames are being extracted. */
  frames?: boolean
  /** 0–100 of the frames read with OCR. */
  ocr?: number
  /** It was processed before: nothing was done again. */
  cached?: boolean
  error?: string
  /** The tools started for it (the newest), to stop them if the server dies halfway. */
  pids?: number[]
}

export type Runner = (path: string, opts: ProcessOptions) => Promise<ProcessedVideo>

export interface QueueOptions {
  /** Where the queue is saved. */
  file?: string
  log?: (level: 'info' | 'warn' | 'error', message: string, detail?: string) => void
  /** Stop the tools a job left running when the server died; returns those stopped. */
  stopLeftovers?: (pids: number[]) => number[]
}

/** Finished jobs kept in the list (the newest). */
const KEEP_FINISHED = 30
/** Process ids kept per job: the tools running now are among the last ones started. */
const KEEP_PIDS = 20

/** The tools processVideo runs: only a process with one of these names is stopped. */
const TOOL = /(^|\/)(ffmpeg|ffprobe|whisper[\w.-]*|mlx_whisper|tesseract)(\s|$)/

/** Stop the processes in `pids` that are still one of the tools (a process id can be reused by anything once its process ended). */
export function stopLeftovers(pids: number[]): number[] {
  if (process.platform === 'win32') return []
  const stopped: number[] = []
  for (const pid of pids) {
    const ps = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
    if (ps.status !== 0 || !TOOL.test(ps.stdout.trim())) continue
    try {
      process.kill(pid, 'SIGKILL')
      stopped.push(pid)
    } catch {
      /* it ended meanwhile */
    }
  }
  return stopped
}

export class Queue {
  private jobs: Job[] = []
  private running: { job: Job; abort: AbortController } | null = null

  private readonly file?: string
  private readonly log: NonNullable<QueueOptions['log']>
  private readonly stopLeftovers: NonNullable<QueueOptions['stopLeftovers']>

  constructor(
    private readonly run: Runner,
    options: QueueOptions = {}
  ) {
    this.file = options.file
    this.log = options.log ?? (() => {})
    this.stopLeftovers = options.stopLeftovers ?? stopLeftovers
    this.load()
    this.pump()
  }

  list(): Job[] {
    return this.jobs
  }

  get(id: string): Job | undefined {
    return this.jobs.find((j) => j.id === id)
  }

  /** Add a file at the end; a video already waiting or running is not added twice. */
  add(path: string, videoId: string, options: JobOptions = {}): Job {
    const pending = this.jobs.find((j) => j.videoId === videoId && (j.state === 'queued' || j.state === 'running'))
    if (pending) return pending
    const job: Job = { id: randomUUID(), videoId, path, name: basename(path), options, state: 'queued', addedAt: Date.now() }
    this.jobs.push(job)
    this.log('info', `Added ${job.name}`, `${path}\n${JSON.stringify(options)}`)
    this.changed()
    this.pump()
    return job
  }

  /** Stop a running job, or take a waiting one out of the line. */
  cancel(id: string): Job | undefined {
    const job = this.get(id)
    if (!job) return undefined
    if (job.state === 'queued') {
      this.finish(job, 'canceled')
    } else if (job.state === 'running' && this.running?.job === job) {
      this.log('info', `Canceling ${job.name}`)
      this.running.abort.abort()
    }
    return job
  }

  /** A failed or canceled job, back at the end of the line. */
  retry(id: string): Job | undefined {
    const job = this.get(id)
    if (!job || (job.state !== 'failed' && job.state !== 'canceled')) return job
    this.jobs = this.jobs.filter((j) => j !== job)
    return this.add(job.path, job.videoId, job.options)
  }

  /** A waiting job, first in line (after the one running). */
  moveToFront(id: string): Job | undefined {
    const job = this.get(id)
    if (!job || job.state !== 'queued') return job
    this.jobs = [...this.jobs.filter((j) => j.state === 'running'), job, ...this.jobs.filter((j) => j !== job && j.state !== 'running')]
    this.changed()
    return job
  }

  /** A finished job, out of the list. */
  remove(id: string): boolean {
    const job = this.get(id)
    if (!job || job.state === 'queued' || job.state === 'running') return false
    this.jobs = this.jobs.filter((j) => j !== job)
    this.changed()
    return true
  }

  clearFinished(): void {
    this.jobs = this.jobs.filter((j) => j.state === 'queued' || j.state === 'running')
    this.changed()
  }

  /** On shutdown: kill the running job's tools without marking it, so that it is saved as running and starts again next time. */
  stop(): void {
    this.changed()
    this.running?.abort.abort()
  }

  private pump(): void {
    if (this.running) return
    const job = this.jobs.find((j) => j.state === 'queued')
    if (!job) return
    const abort = new AbortController()
    this.running = { job, abort }
    Object.assign(job, { state: 'running', startedAt: Date.now(), stage: undefined, message: 'Starting…', transcribe: undefined, transcribeStartedAt: undefined, frames: undefined, ocr: undefined, error: undefined, cached: undefined, pids: [] })
    this.changed()
    this.log('info', `Processing ${job.name}`)
    let reported = false
    const logged = new Set<string>()
    this.run(job.path, {
      ...job.options,
      signal: abort.signal,
      onSpawn: (pid) => {
        job.pids = [...(job.pids ?? []), pid].slice(-KEEP_PIDS)
        this.changed()
      },
      onProgress: (p) => {
        reported = true
        // Each step once in the log (the transcription and the OCR take turns), with what it said
        // first ("Audio kept from the last attempt.").
        if (!logged.has(p.stage)) {
          logged.add(p.stage)
          this.log('info', `${job.name}: ${p.message}`)
        }
        job.stage = p.stage
        job.message = p.message
        if (p.stage === 'transcribe') {
          job.transcribe = p.percent ?? job.transcribe ?? 0
          job.transcribeStartedAt ??= Date.now()
        } else if (p.stage === 'frames') job.frames = true
        else if (p.stage === 'ocr') job.ocr = p.percent
      }
    })
      .then(() => {
        job.cached = !reported
        this.finish(job, 'done')
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) this.finish(job, 'canceled')
        else this.finish(job, 'failed', error instanceof Error ? error.message : String(error))
      })
  }

  private finish(job: Job, state: JobState, error?: string): void {
    job.state = state
    job.finishedAt = Date.now()
    job.pids = undefined
    if (error) job.error = error
    if (state === 'failed') this.log('error', `Failed: ${job.name}`, error)
    else if (state === 'canceled') this.log('warn', `Canceled: ${job.name}`)
    else this.log('info', job.cached ? `Already processed: ${job.name}` : `Ready: ${job.name} (${Math.round(((job.finishedAt ?? 0) - (job.startedAt ?? 0)) / 1000)} s)`)
    if (state === 'done') Object.assign(job, { stage: 'done', message: job.cached ? 'Already processed.' : 'Done.' })
    if (this.running?.job === job) this.running = null
    // Only the newest finished jobs stay in the list.
    const finished = this.jobs.filter((j) => j.state !== 'queued' && j.state !== 'running')
    const drop = new Set(finished.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).slice(KEEP_FINISHED))
    this.jobs = this.jobs.filter((j) => !drop.has(j))
    this.changed()
    this.pump()
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Job[]
      // A job that was running when the server stopped starts again (from the steps it finished),
      // once the tools it left running are stopped.
      this.jobs = saved.map((j) => {
        if (j.state !== 'running') return j
        const stopped = j.pids?.length ? this.stopLeftovers(j.pids) : []
        this.log('warn', `${j.name} was processing when the server stopped: it starts again from the steps it finished`, stopped.length ? `Stopped the tools it left running: ${stopped.join(', ')}` : undefined)
        return { ...j, state: 'queued' as const, startedAt: undefined, message: undefined, pids: undefined }
      })
    } catch {
      this.jobs = []
    }
  }

  private changed(): void {
    if (!this.file) return
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.jobs, null, 2))
    renameSync(tmp, this.file)
  }
}
