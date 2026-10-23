// The external tools video-context needs: ffmpeg/ffprobe and a whisper engine
// (whisper.cpp, or mlx-whisper on Apple silicon), plus a whisper model. Nothing
// is bundled: the binaries are found on PATH (or through environment
// variables) and the model is downloaded once.

import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
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

/** How the audio is transcribed: whisper.cpp's `whisper-cli`, or `mlx_whisper` (Apple silicon's GPU). */
export const ENGINES = ['whisper.cpp', 'mlx'] as const
export type Engine = (typeof ENGINES)[number]

export interface Tools {
  ffmpeg: string
  ffprobe: string
  engine: Engine
  /** The engine's command: `whisper-cli` or `mlx_whisper`. */
  whisper: string
}

const MLX_INSTALL = '`uv tool install mlx-whisper` or `pipx install mlx-whisper`'

/** How to install what is missing, for this system. `mlx` only on Apple silicon. */
export function installHints(): { ffmpeg: string; whisperCpp: string; mlx?: string } {
  if (process.platform === 'darwin') {
    return { ffmpeg: '`brew install ffmpeg`', whisperCpp: '`brew install whisper-cpp`', ...(process.arch === 'arm64' && { mlx: MLX_INSTALL }) }
  }
  if (process.platform === 'win32') {
    return {
      ffmpeg: '`winget install Gyan.FFmpeg`',
      whisperCpp: 'the `whisper-bin-x64.zip` of a whisper.cpp release (https://github.com/ggml-org/whisper.cpp/releases), with its folder on PATH'
    }
  }
  return {
    ffmpeg: '`sudo apt install ffmpeg` (or your distribution\'s package)',
    whisperCpp: 'build whisper.cpp (https://github.com/ggml-org/whisper.cpp#quick-start) and put `build/bin/whisper-cli` on PATH'
  }
}

/**
 * The tools, or a message that says what is missing and how to install it.
 * Without an `engine` (or `VIDEO_CONTEXT_ENGINE`), mlx-whisper is used when
 * installed, else whisper.cpp.
 */
export function findTools(engine?: Engine): Tools | { missing: string } {
  const wanted = engine ?? (process.env.VIDEO_CONTEXT_ENGINE as Engine | undefined)
  if (wanted && !(ENGINES as readonly string[]).includes(wanted)) return { missing: `Unknown engine "${wanted}": use ${ENGINES.join(' or ')}.` }
  const ffmpeg = findBinary('VIDEO_CONTEXT_FFMPEG', ['ffmpeg'])
  const ffprobe = findBinary('VIDEO_CONTEXT_FFPROBE', ['ffprobe'])
  const mlx = wanted === 'whisper.cpp' ? null : findBinary('VIDEO_CONTEXT_MLX_WHISPER', ['mlx_whisper'])
  const cpp = wanted === 'mlx' ? null : findBinary('VIDEO_CONTEXT_WHISPER', ['whisper-cli', 'whisper-cpp', 'whisper.cpp'])
  const hints = installHints()
  const missing: string[] = []
  if (!ffmpeg || !ffprobe) missing.push(`ffmpeg: ${hints.ffmpeg}`)
  if (wanted === 'mlx' && !mlx) missing.push(`mlx_whisper (Apple silicon only): ${MLX_INSTALL}, or set VIDEO_CONTEXT_MLX_WHISPER`)
  else if (!mlx && !cpp) {
    const orMlx = hints.mlx && wanted !== 'whisper.cpp' ? `; or mlx-whisper, faster on Apple silicon: ${hints.mlx}` : ''
    missing.push(`whisper.cpp's \`whisper-cli\`: ${hints.whisperCpp} (or set VIDEO_CONTEXT_WHISPER)${orMlx}`)
  }
  if (missing.length > 0) return { missing: `Missing: ${missing.join('; ')}. Run \`video-context --doctor\` to check the setup.` }
  return mlx ? { ffmpeg: ffmpeg!, ffprobe: ffprobe!, engine: 'mlx', whisper: mlx } : { ffmpeg: ffmpeg!, ffprobe: ffprobe!, engine: 'whisper.cpp', whisper: cpp! }
}

export const MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3-turbo', 'large-v3'] as const
export type ModelName = (typeof MODELS)[number]

/** The mlx-community conversion of each model, which mlx_whisper downloads to the Hugging Face cache. */
const MLX_REPOS: Record<ModelName, string> = {
  tiny: 'mlx-community/whisper-tiny-mlx',
  base: 'mlx-community/whisper-base-mlx',
  small: 'mlx-community/whisper-small-mlx',
  medium: 'mlx-community/whisper-medium-mlx',
  'large-v3-turbo': 'mlx-community/whisper-large-v3-turbo',
  'large-v3': 'mlx-community/whisper-large-v3-mlx'
}

/** The model mlx_whisper loads: `VIDEO_CONTEXT_MLX_MODEL` (a folder or a Hugging Face repo), else the mlx-community one. */
export function mlxModel(name: ModelName): string {
  return process.env.VIDEO_CONTEXT_MLX_MODEL || MLX_REPOS[name]
}

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

/**
 * What `video-context --doctor` prints: each tool, found (and where) or how to
 * install it, and which engine a video would be transcribed with. `ok` is
 * false when a video cannot be processed.
 */
export function doctor(): { ok: boolean; lines: string[] } {
  const hints = installHints()
  const line = (name: string, found: string | null, otherwise: string): string => (found ? `  ✓ ${name}: ${found}` : `  ✗ ${name}: ${otherwise}`)
  const ffmpeg = findBinary('VIDEO_CONTEXT_FFMPEG', ['ffmpeg'])
  const ffprobe = findBinary('VIDEO_CONTEXT_FFPROBE', ['ffprobe'])
  const cpp = findBinary('VIDEO_CONTEXT_WHISPER', ['whisper-cli', 'whisper-cpp', 'whisper.cpp'])
  const mlx = findBinary('VIDEO_CONTEXT_MLX_WHISPER', ['mlx_whisper'])
  const tesseract = findBinary('VIDEO_CONTEXT_TESSERACT', ['tesseract'])
  const models = existsSync(join(homeDir(), 'models')) ? readdirSync(join(homeDir(), 'models')).filter((f) => f.endsWith('.bin')) : []
  const tools = findTools()
  const lines = [
    `video-context on ${process.platform} ${process.arch}, Node ${process.versions.node}`,
    '',
    'Required',
    line('ffmpeg', ffmpeg, `install it: ${hints.ffmpeg}`),
    line('ffprobe', ffprobe, 'comes with ffmpeg'),
    '',
    'Transcription (one of them)',
    line('whisper.cpp (whisper-cli)', cpp, hints.whisperCpp),
    ...(hints.mlx || mlx ? [line('mlx-whisper (mlx_whisper)', mlx, `${MLX_INSTALL} (faster on Apple silicon)`)] : []),
    '',
    'Optional',
    line('tesseract (text on screen)', tesseract, process.platform === 'darwin' ? '`brew install tesseract tesseract-lang`' : process.platform === 'win32' ? '`winget install UB-Mannheim.TesseractOCR`' : '`sudo apt install tesseract-ocr tesseract-ocr-spa`'),
    '',
    `Cache: ${homeDir()}${models.length > 0 ? ` (whisper.cpp models: ${models.join(', ')})` : ''}`,
    'missing' in tools ? `Not ready. ${tools.missing.replace(/ Run .*$/, '')}` : `Ready: videos are transcribed with ${tools.engine} (${tools.whisper}).`
  ]
  return { ok: !('missing' in tools), lines }
}
