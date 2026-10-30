// A browser's recording (MediaRecorder: a meeting recorder, a screen recorder) is
// written while it records and never finished: its header has no duration and it
// has no index (cues), so players can play it through but not seek in it. A copy
// remuxed by ffmpeg (no re-encoding: fast, same quality) has both; the page, the
// clips, the screens and the exports use it, and the original file is left as it is.

import { execFile } from 'node:child_process'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'

import { findBinary } from './deps.js'

const run = promisify(execFile)

/** True when the file's header says how long it is (ffprobe), which unfinished browser recordings don't. */
export async function hasDuration(file: string): Promise<boolean> {
  const ffprobe = findBinary('VIDEO_CONTEXT_FFPROBE', ['ffprobe'])
  if (!ffprobe) return true
  const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file])
  return Number.isFinite(Number(stdout.trim()))
}

/** The name of the playable copy of `source` in a video's folder: the same kind of file. */
export function playableName(source: string): string {
  const ext = extname(source).toLowerCase()
  return ext === '.mp4' || ext === '.m4v' || ext === '.mov' ? 'playable.mp4' : ext === '.mkv' ? 'playable.mkv' : 'playable.webm'
}

/** Remux `source` into `dir`, with a duration and its index at the start (for players that stream it). Returns the file name. */
export async function makePlayable(source: string, dir: string, signal?: AbortSignal): Promise<string> {
  const ffmpeg = findBinary('VIDEO_CONTEXT_FFMPEG', ['ffmpeg'])
  if (!ffmpeg) throw new Error('ffmpeg is not installed.')
  const name = playableName(source)
  const tmp = join(dir, `${name}.part${extname(name)}`)
  // MP4: the index (moov) first; Matroska/WebM: the cues first, so seeking needs no read to the end.
  const index = name.endsWith('.mp4') ? ['-movflags', '+faststart'] : ['-cues_to_front', '1']
  try {
    await run(ffmpeg, ['-v', 'error', '-y', '-i', source, '-map', '0', '-c', 'copy', ...index, tmp], { signal, maxBuffer: 1 << 20 })
    renameSync(tmp, join(dir, name))
  } finally {
    rmSync(tmp, { force: true })
  }
  return name
}

/** The file to read a processed video from: its playable copy when it has one, else its source. */
export function mediaFile(dir: string, manifest: { source: string; playable?: string }): string {
  if (manifest.playable) {
    const copy = join(dir, manifest.playable)
    if (existsSync(copy)) return copy
  }
  return manifest.source
}
