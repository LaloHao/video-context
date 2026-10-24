// The web page's processing queue: videos are processed one at a time (whisper
// already uses every core), in the order they were added. Each job keeps the
// progress of every stage, can be canceled, retried or moved to the front, and
// the queue is saved so that a restart picks up where it was.

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
}

export type Runner = (path: string, opts: ProcessOptions) => Promise<ProcessedVideo>

/** Finished jobs kept in the list (the newest). */
const KEEP_FINISHED = 30

export class Queue {
  private jobs: Job[] = []
  private running: { job: Job; abort: AbortController } | null = null

  constructor(
    private readonly run: Runner,
    private readonly file?: string,
    private readonly onFinished?: (job: Job) => void
  ) {
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
    Object.assign(job, { state: 'running', startedAt: Date.now(), stage: undefined, message: 'Starting…', transcribe: undefined, transcribeStartedAt: undefined, frames: undefined, ocr: undefined, error: undefined, cached: undefined })
    this.changed()
    let reported = false
    this.run(job.path, {
      ...job.options,
      signal: abort.signal,
      onProgress: (p) => {
        reported = true
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
    if (error) job.error = error
    if (state === 'done') Object.assign(job, { stage: 'done', message: job.cached ? 'Already processed.' : 'Done.' })
    if (this.running?.job === job) this.running = null
    // Only the newest finished jobs stay in the list.
    const finished = this.jobs.filter((j) => j.state !== 'queued' && j.state !== 'running')
    const drop = new Set(finished.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).slice(KEEP_FINISHED))
    this.jobs = this.jobs.filter((j) => !drop.has(j))
    this.changed()
    this.onFinished?.(job)
    this.pump()
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Job[]
      // A job that was running when the server stopped starts again.
      this.jobs = saved.map((j) => (j.state === 'running' ? { ...j, state: 'queued', startedAt: undefined, message: undefined } : j))
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
