// The external tools video-context needs: ffmpeg/ffprobe and whisper.cpp, plus
// a whisper model. Nothing is bundled: the binaries are found on PATH (or
// through environment variables) and the model is downloaded once.

import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Where processed videos and models live (`VIDEO_CONTEXT_HOME`, default `~/.cache/video-context`). */
export function homeDir(): string {
  return process.env.VIDEO_CONTEXT_HOME || join(homedir(), '.cache', 'video-context')
}

function onPath(name: string): boolean {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' })
  return probe.status === 0
}

/** The first command of `names` on PATH, or the one in `envVar`. */
export function findBinary(envVar: string, names: string[]): string | null {
  const fromEnv = process.env[envVar]
  if (fromEnv) return fromEnv
  return names.find(onPath) ?? null
}

export interface Tools {
  ffmpeg: string
  ffprobe: string
  whisper: string
}

/** The tools, or a message that says what is missing and how to install it. */
export function findTools(): Tools | { missing: string } {
  const ffmpeg = findBinary('VIDEO_CONTEXT_FFMPEG', ['ffmpeg'])
  const ffprobe = findBinary('VIDEO_CONTEXT_FFPROBE', ['ffprobe'])
  const whisper = findBinary('VIDEO_CONTEXT_WHISPER', ['whisper-cli', 'whisper-cpp', 'whisper.cpp'])
  const missing: string[] = []
  if (!ffmpeg || !ffprobe) missing.push('ffmpeg (https://ffmpeg.org/download.html; e.g. `sudo apt install ffmpeg` or `brew install ffmpeg`)')
  if (!whisper) missing.push('whisper.cpp\'s `whisper-cli` (https://github.com/ggml-org/whisper.cpp; e.g. `brew install whisper-cpp`), or set VIDEO_CONTEXT_WHISPER')
  if (missing.length > 0) return { missing: `Missing: ${missing.join('; ')}.` }
  return { ffmpeg: ffmpeg!, ffprobe: ffprobe!, whisper: whisper! }
}

export const MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3-turbo', 'large-v3'] as const
export type ModelName = (typeof MODELS)[number]

const MODEL_URL = (model: string): string => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`

/**
 * The path of a whisper model: `VIDEO_CONTEXT_MODEL` (a file), else
 * `<home>/models/ggml-<name>.bin`, downloaded the first time.
 */
export async function ensureModel(name: ModelName, onProgress?: (message: string) => void): Promise<string> {
  const fromEnv = process.env.VIDEO_CONTEXT_MODEL
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`VIDEO_CONTEXT_MODEL points to ${fromEnv}, which does not exist.`)
    return fromEnv
  }
  const dir = join(homeDir(), 'models')
  const file = join(dir, `ggml-${name}.bin`)
  if (existsSync(file)) return file
  mkdirSync(dir, { recursive: true })
  onProgress?.(`Downloading the whisper model "${name}" (once)…`)
  const response = await fetch(MODEL_URL(name))
  if (!response.ok || !response.body) throw new Error(`Could not download the whisper model "${name}" (HTTP ${response.status}).`)
  const tmp = `${file}.part`
  try {
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(tmp))
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
  return file
}
