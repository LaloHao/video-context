import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { findBinary } from '../src/deps.js'
import { screenAt } from '../src/screen.js'

const ffmpeg = findBinary('VIDEO_CONTEXT_FFMPEG', ['ffmpeg'])
const previous = process.env.VIDEO_CONTEXT_HOME

describe.skipIf(!ffmpeg)('screen at a time', () => {
  const home = mkdtempSync(join(tmpdir(), 'vc-screen-'))
  process.env.VIDEO_CONTEXT_HOME = home
  const id = '00112233445566ff'
  const dir = join(home, 'videos', id)
  const source = join(home, 'clip.mp4')
  afterAll(() => {
    if (previous === undefined) delete process.env.VIDEO_CONTEXT_HOME
    else process.env.VIDEO_CONTEXT_HOME = previous
  })

  mkdirSync(dir, { recursive: true })
  // Blue for 2 s, then red: the screen at 3 s is red.
  execFileSync(ffmpeg!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=2', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', source])
  writeFileSync(join(dir, 'transcript.json'), '[]')
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, id, source, title: 'clip', duration: 4, language: 'en', model: 'small', createdAt: 'x', segments: 0, frames: [{ file: 'frames/00000s-00001.jpg', time: 0 }] }))

  it('takes the exact screen from the video, once', async () => {
    process.env.VIDEO_CONTEXT_HOME = home
    const screen = await screenAt(id, 3, { ocr: false })
    expect(screen).toEqual({ time: 3, file: join('screens', '3000.jpg') })
    const image = join(dir, screen.file)
    expect(readFileSync(image).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])) // a JPEG
    // Red, not blue: the pixel in the middle.
    const rgb = execFileSync(ffmpeg!, ['-v', 'error', '-i', image, '-vf', 'format=rgb24,crop=1:1:160:120', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    expect(rgb[0]).toBeGreaterThan(200)
    expect(rgb[2]).toBeLessThan(60)
    // A second time comes from the cache, and a time past the end is the last screen.
    expect(await screenAt(id, 3, { ocr: false })).toEqual(screen)
    expect((await screenAt(id, 99, { ocr: false })).time).toBeCloseTo(3.9)
  })

  it('takes the same time asked for at once', async () => {
    process.env.VIDEO_CONTEXT_HOME = home
    const screens = await Promise.all([1, 1, 1, 1].map(() => screenAt(id, 1, { ocr: false })))
    expect(new Set(screens.map((s) => s.file))).toEqual(new Set([join('screens', '1000.jpg')]))
  })

  it('says so when the video file is gone', async () => {
    process.env.VIDEO_CONTEXT_HOME = home
    rmSync(source)
    await expect(screenAt(id, 2, { ocr: false })).rejects.toThrow(/key frames/)
    expect(existsSync(join(dir, 'screens', '2000.jpg'))).toBe(false)
  })
})
