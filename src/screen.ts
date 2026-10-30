// The screen at an exact time, taken from the video file: what the key frames
// miss, like code typed little by little (no scene change) between two of them.
// Kept in the video's screens/ folder with its text on screen.

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { findBinary } from './deps.js'
import { findTesseract, ocrImage, ocrLanguages, tesseractLanguages } from './ocr.js'
import { mediaFile } from './playable.js'
import { loadVideo } from './process.js'

const run = promisify(execFile)

export interface Screen {
  /** Seconds, as taken (within the video). */
  time: number
  /** The image, relative to the video's folder: screens/<milliseconds>.jpg. */
  file: string
  /** Text on screen (OCR), when tesseract is installed and found some. */
  text?: string
}

/** The screen of video `id` at `seconds`. Throws when the video file is gone (then only key frames remain) or ffmpeg is missing. */
export async function screenAt(id: string, seconds: number, { ocr = true } = {}): Promise<Screen> {
  const video = loadVideo(id)
  if (!video) throw new Error(`Video ${id} is not processed.`)
  const m = video.manifest
  // The seekable copy when there is one: a browser's recording is slow to seek in.
  const media = mediaFile(video.dir, m)
  if (!existsSync(media)) throw new Error('The video file is no longer where it was processed: only its key frames can be seen (get_frames).')
  if (m.frames.length === 0) throw new Error('This is an audio file: there is no screen to see.')
  const ffmpeg = findBinary('VIDEO_CONTEXT_FFMPEG', ['ffmpeg'])
  if (!ffmpeg) throw new Error('ffmpeg is not installed.')
  const time = Math.max(0, Math.min(seconds, m.duration - 0.1))
  const ms = Math.round(time * 1000)
  const file = join('screens', `${ms}.jpg`)
  const image = join(video.dir, file)
  if (!existsSync(image)) {
    mkdirSync(join(video.dir, 'screens'), { recursive: true })
    // Its own temporary file: Claude may ask for the same time in calls made at once.
    const tmp = join(video.dir, 'screens', `${ms}.${process.pid}-${randomUUID()}.part.jpg`)
    await run(ffmpeg, ['-v', 'error', '-y', '-ss', String(time), '-i', media, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', tmp])
    renameSync(tmp, image)
  }
  const screen: Screen = { time, file }
  if (!ocr) return screen
  const textFile = join(video.dir, 'screens', `${ms}.txt`)
  if (existsSync(textFile)) {
    const text = readFileSync(textFile, 'utf8')
    return text ? { ...screen, text } : screen
  }
  const bin = findTesseract()
  if (!bin) return screen
  // The languages the key frames were read in, else the spoken one.
  const languages = m.ocr && 'engine' in m.ocr ? m.ocr.languages : ocrLanguages(m.language === 'auto' ? undefined : m.language, tesseractLanguages(bin))
  if (languages.length === 0) return screen
  const text = await ocrImage(bin, image, languages).catch(() => '')
  const tmpText = `${textFile}.${process.pid}-${randomUUID()}`
  writeFileSync(tmpText, text)
  renameSync(tmpText, textFile)
  return text ? { ...screen, text } : screen
}
