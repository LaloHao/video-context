import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { findBinary } from '../src/deps.js'
import { hasDuration, makePlayable, mediaFile, playableName } from '../src/playable.js'

const ffmpeg = findBinary('VIDEO_CONTEXT_FFMPEG', ['ffmpeg'])
const ffprobe = findBinary('VIDEO_CONTEXT_FFPROBE', ['ffprobe'])

describe('playable copies', () => {
  it('are named like their source', () => {
    expect(playableName('/a/b.webm')).toBe('playable.webm')
    expect(playableName('/a/b.MP4')).toBe('playable.mp4')
    expect(playableName('/a/b.mkv')).toBe('playable.mkv')
  })

  it('are read instead of the source when there is one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-playable-'))
    expect(mediaFile(dir, { source: '/v/a.webm', playable: 'playable.webm' })).toBe('/v/a.webm') // not made (yet)
    expect(mediaFile(dir, { source: '/v/a.webm' })).toBe('/v/a.webm')
  })

  it.skipIf(!ffmpeg || !ffprobe)('give a browser-like recording a duration and an index', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-playable-'))
    const recording = join(dir, 'recording.webm')
    // Written to a pipe, as MediaRecorder writes: no way back to the header, so no duration and no cues.
    execSync(`"${ffmpeg}" -v error -f lavfi -i testsrc=d=6:s=160x120:r=10 -f lavfi -i sine=d=6 -c:v libvpx-vp9 -deadline realtime -c:a libopus -f webm pipe:1 > "${recording}"`)
    expect(await hasDuration(recording)).toBe(false)

    const name = await makePlayable(recording, dir)
    expect(name).toBe('playable.webm')
    const copy = join(dir, name)
    expect(await hasDuration(copy)).toBe(true)
    const seconds = Number(execFileSync(ffprobe!, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', copy], { encoding: 'utf8' }))
    expect(seconds).toBeCloseTo(6, 0)
    expect(existsSync(join(dir, 'playable.webm.part.webm'))).toBe(false)
    expect(mediaFile(dir, { source: recording, playable: name })).toBe(copy)
  })
})
