import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ProcessOptions, ProcessedVideo } from '../src/process.js'
import { Queue, type Runner } from '../src/queue.js'

/** A runner whose jobs finish when the test says so. */
function fakeRunner() {
  const calls: { path: string; opts: ProcessOptions; resolve: () => void; reject: (e: Error) => void }[] = []
  const run: Runner = (path, opts) =>
    new Promise<ProcessedVideo>((resolve, reject) => {
      const call = { path, opts, resolve: () => resolve({ dir: '', manifest: {} as ProcessedVideo['manifest'] }), reject }
      opts.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      calls.push(call)
    })
  return { run, calls }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const states = (q: Queue) => q.list().map((j) => `${j.name}:${j.state}`)

describe('queue', () => {
  it('runs one job at a time, in order, and keeps their progress', async () => {
    const { run, calls } = fakeRunner()
    const q = new Queue(run)
    q.add('/v/a.mp4', 'a')
    q.add('/v/b.mp4', 'b')
    expect(states(q)).toEqual(['a.mp4:running', 'b.mp4:queued'])
    expect(calls).toHaveLength(1)

    calls[0].opts.onProgress?.({ stage: 'transcribe', percent: 40, message: 'Transcribing… 40%' })
    calls[0].opts.onProgress?.({ stage: 'frames', message: 'Extracting key frames…' })
    calls[0].opts.onProgress?.({ stage: 'ocr', percent: 50, message: 'Reading text on screen… 5/10' })
    const a = q.list()[0]
    expect(a).toMatchObject({ transcribe: 40, frames: true, ocr: 50, stage: 'ocr' })
    expect(a.transcribeStartedAt).toBeTypeOf('number')

    calls[0].resolve()
    await tick()
    expect(states(q)).toEqual(['a.mp4:done', 'b.mp4:running'])
    expect(q.list()[0].cached).toBe(false)
    expect(calls[1].path).toBe('/v/b.mp4')
  })

  it('marks a job finished without any progress as already processed', async () => {
    const { run, calls } = fakeRunner()
    const q = new Queue(run)
    q.add('/v/a.mp4', 'a')
    calls[0].resolve()
    await tick()
    expect(q.list()[0]).toMatchObject({ state: 'done', cached: true, message: 'Already processed.' })
  })

  it('does not add a video twice while it waits', () => {
    const { run } = fakeRunner()
    const q = new Queue(run)
    const first = q.add('/v/a.mp4', 'a')
    expect(q.add('/v/a.mp4', 'a')).toBe(first)
    expect(q.list()).toHaveLength(1)
  })

  it('cancels, retries, moves to the front, removes and clears', async () => {
    const { run, calls } = fakeRunner()
    const q = new Queue(run)
    const a = q.add('/v/a.mp4', 'a')
    const b = q.add('/v/b.mp4', 'b')
    const c = q.add('/v/c.mp4', 'c')

    q.moveToFront(c.id)
    expect(states(q)).toEqual(['a.mp4:running', 'c.mp4:queued', 'b.mp4:queued'])

    q.cancel(b.id)
    expect(states(q)).toContain('b.mp4:canceled')

    q.cancel(a.id)
    await tick()
    expect(q.get(a.id)?.state).toBe('canceled')
    expect(calls.at(-1)?.path).toBe('/v/c.mp4')

    calls.at(-1)?.reject(new Error('whisper-cli failed'))
    await tick()
    expect(q.get(c.id)).toMatchObject({ state: 'failed', error: 'whisper-cli failed' })

    const again = q.retry(c.id)
    expect(again?.state).toBe('running')
    expect(q.remove(again!.id)).toBe(false)
    expect(q.remove(b.id)).toBe(true)

    q.clearFinished()
    expect(states(q)).toEqual(['c.mp4:running'])
  })

  it('saves the queue, and starts again a job that was running', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vc-queue-')), 'queue.json')
    const first = fakeRunner()
    const q = new Queue(first.run, file)
    q.add('/v/a.mp4', 'a')
    q.add('/v/b.mp4', 'b')
    q.stop()
    expect(JSON.parse(readFileSync(file, 'utf8')).map((j: { state: string }) => j.state)).toEqual(['running', 'queued'])

    const second = fakeRunner()
    const restarted = new Queue(second.run, file)
    expect(states(restarted)).toEqual(['a.mp4:running', 'b.mp4:queued'])
    expect(second.calls[0].path).toBe('/v/a.mp4')
  })
})
