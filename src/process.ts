// Processing one video: audio → whisper transcript (whisper.cpp or mlx-whisper), and key frames, into a
// cache folder per video. Idempotent: a video already processed (same path,
// size and modification time) is not processed again unless forced.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path'

import { ensureModel, findTools, homeDir, mlxModel, type Engine, type ModelName, type Tools } from './deps.js'
import { dhash, keepDistinct } from './dedupe.js'
import { parseShowinfoTimes, selectExpression, type Frame } from './frames.js'
import { findTesseract, mapLimit, ocrImage, ocrLanguages, tesseractLanguages } from './ocr.js'
import { assignSpeakers, readRecording, speakerNames } from './recording.js'
import { parseMlxJson, parseWhisperJson, toMarkdown, toSrt, type Segment } from './transcript.js'

export interface ProcessOptions {
  /** Spoken language (`es`, `en`…) or `auto`. Default `auto`. */
  language?: string
  model?: ModelName
  /** whisper.cpp or mlx (Apple silicon). Default: `VIDEO_CONTEXT_ENGINE`, else mlx when installed, else whisper.cpp. */
  engine?: Engine
  /** Scene change (0–1) that takes a frame. Default 0.25. */
  sceneThreshold?: number
  /** At most this many seconds without a frame. Default 60. */
  frameEvery?: number
  /** Drop a frame this close (dHash bits of 64) to the last kept one. Default 4; -1 keeps every frame. */
  dedupeThreshold?: number
  /** Read the text on screen of each frame with tesseract, when installed. Default true. */
  ocr?: boolean
  /** Process again even when a result exists. */
  force?: boolean
  onProgress?(progress: Progress): void
  signal?: AbortSignal
}

export interface Progress {
  stage: 'audio' | 'model' | 'transcribe' | 'frames' | 'ocr' | 'done'
  /** 0–100 for the transcription. */
  percent?: number
  message: string
}

export interface Manifest {
  version: 1
  id: string
  source: string
  title: string
  duration: number
  language: string
  model: string
  /** Absent in videos processed before there was a choice: whisper.cpp. */
  engine?: Engine
  createdAt: string
  segments: number
  frames: Frame[]
  /** Frames dropped as near-duplicates. */
  droppedFrames?: number
  /** How the on-screen text was read, or null when OCR did not run (and why). */
  ocr?: { engine: 'tesseract'; languages: string[] } | { skipped: string } | null
  /** From the recording file next to the video (`<name>.json`), when there is one. */
  recording?: { url?: string; startedAt?: string; speakers: string[] }
}

export interface ProcessedVideo {
  dir: string
  manifest: Manifest
}

/** Stable id of a video file: its absolute path, size and modification time. */
export function videoId(path: string): string {
  const abs = resolve(path)
  const stat = statSync(abs)
  return createHash('sha1').update(`${abs}\0${stat.size}\0${stat.mtimeMs}`).digest('hex').slice(0, 16)
}

export function videoDir(id: string): string {
  return join(homeDir(), 'videos', id)
}

/** A processed video, or null if it was not processed (or the id is not one). */
export function loadVideo(id: string): { dir: string; manifest: Manifest; segments: Segment[] } | null {
  if (!/^[0-9a-f]{16}$/.test(id)) return null
  const dir = videoDir(id)
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest
    const segments = JSON.parse(readFileSync(join(dir, 'transcript.json'), 'utf8')) as Segment[]
    return { dir, manifest, segments }
  } catch {
    return null
  }
}

/** Every processed video, newest first. */
export function listVideos(): Manifest[] {
  const root = join(homeDir(), 'videos')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .map((id) => loadVideo(id)?.manifest)
    .filter((m): m is Manifest => Boolean(m))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function run(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; onStderr?: (chunk: string) => void } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString()
      // The log can be large (a line per frame): only the tail is kept for errors, the callback sees it all.
      stderr = (stderr + text).slice(-20_000)
      opts.onStderr?.(text)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr })
      else reject(new Error(`${basename(command)} failed (exit ${code}): ${stderr.trim().split('\n').slice(-3).join(' ')}`))
    })
  })
}

async function duration(tools: Tools, file: string, signal?: AbortSignal): Promise<number> {
  const { stdout } = await run(tools.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { signal })
  let seconds = Number(stdout.trim())
  if (!Number.isFinite(seconds)) {
    // WebM files from a browser's MediaRecorder have no duration in their header:
    // read the packets through without decoding and take the last time reached.
    const { stderr } = await run(tools.ffmpeg, ['-hide_banner', '-i', file, '-map', '0', '-c', 'copy', '-f', 'null', '-'], { signal })
    seconds = lastProgressTime(stderr) ?? Number.NaN
  }
  if (!Number.isFinite(seconds)) throw new Error('Could not read the video duration: is it a video file?')
  return seconds
}

/** The last `time=hh:mm:ss.xx` of an ffmpeg progress log, in seconds. */
export function lastProgressTime(log: string): number | null {
  const times = [...log.matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)]
  const last = times.at(-1)
  return last ? Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) : null
}

function onTranscribeProgress(opts: ProcessOptions, pattern: RegExp): (text: string) => void {
  return (text) => {
    for (const match of text.matchAll(pattern)) {
      const percent = Number(match[1])
      opts.onProgress?.({ stage: 'transcribe', percent, message: `Transcribing… ${percent}%` })
    }
  }
}

/** `model`: whisper.cpp's model file, or what mlx_whisper loads (a folder or a Hugging Face repo). */
async function transcribe(tools: Tools, model: string, dir: string, language: string, opts: ProcessOptions): Promise<Segment[]> {
  if (tools.engine === 'mlx') {
    const args = ['audio.wav', '--model', model, '--output-format', 'json', '--output-dir', '.', '--output-name', 'whisper', '--verbose', 'False']
    if (language !== 'auto') args.push('--language', language)
    // mlx_whisper reads the audio with the `ffmpeg` on PATH: make it the one found here.
    const env = { ...process.env, PATH: `${dirname(tools.ffmpeg)}${delimiter}${process.env.PATH ?? ''}` }
    // With --verbose False it draws tqdm bars on stderr: the transcription's ends in "frames/s]"
    // (" 42%|████▏ | 336/800 [00:01<00:01, 759frames/s]"); the others are the model download.
    const transcribing = onTranscribeProgress(opts, /(\d+)%\|[^\r\n]*frames/g)
    const onStderr = (text: string): void => {
      if (/frames/.test(text)) transcribing(text)
      else if (/\d+%\|/.test(text)) opts.onProgress?.({ stage: 'model', message: 'Fetching the mlx-whisper model (downloaded once)…' })
    }
    await run(tools.whisper, args, { cwd: dir, env, signal: opts.signal, onStderr })
    return parseMlxJson(JSON.parse(readFileSync(join(dir, 'whisper.json'), 'utf8')))
  }
  const threads = String(Math.max(1, Math.min(16, availableParallelism() - 2)))
  await run(tools.whisper, ['-m', model, '-l', language, '-t', threads, '-f', 'audio.wav', '-oj', '-of', 'whisper', '-pp'], {
    cwd: dir,
    signal: opts.signal,
    onStderr: onTranscribeProgress(opts, /progress\s*=\s*(\d+)%/g)
  })
  return parseWhisperJson(JSON.parse(readFileSync(join(dir, 'whisper.json'), 'utf8')))
}

/** Key frames: scene changes plus one every `frameEvery` s, near-duplicates dropped. One ffmpeg pass writes them and a 9×8 gray thumbnail of each. */
async function extractFrames(tools: Tools, file: string, dir: string, opts: ProcessOptions): Promise<{ frames: Frame[]; dropped: number }> {
  const framesDir = join(dir, 'frames')
  rmSync(framesDir, { recursive: true, force: true })
  mkdirSync(framesDir, { recursive: true })
  const thumbs = join(dir, 'thumbs.gray')
  let log = ''
  await run(
    tools.ffmpeg,
    [
      '-hide_banner', '-nostats', '-y', '-i', file,
      '-filter_complex',
      `[0:v]select='${selectExpression(opts.sceneThreshold ?? 0.25, opts.frameEvery ?? 60)}',showinfo,split[full][tiny];` +
        `[full]scale='min(1280,iw)':-2[big];[tiny]scale=9:8,format=gray[small]`,
      '-map', '[big]', '-fps_mode', 'vfr', '-q:v', '4', join(framesDir, '%05d.jpg'),
      '-map', '[small]', '-fps_mode', 'vfr', '-f', 'rawvideo', thumbs
    ],
    { signal: opts.signal, onStderr: (text) => (log += text) }
  )
  const times = parseShowinfoTimes(log)
  const files = readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort()
  const raw = readFileSync(thumbs)
  rmSync(thumbs, { force: true })
  const hashes = files.map((_, i) => dhash(raw.subarray(i * 72, i * 72 + 72)))
  const threshold = opts.dedupeThreshold ?? 4
  const keep = new Set(threshold < 0 ? files.map((_, i) => i) : keepDistinct(hashes, threshold))
  const frames: Frame[] = []
  files.forEach((name, i) => {
    if (!keep.has(i)) {
      rmSync(join(framesDir, name), { force: true })
      return
    }
    // Named by their time, so a file says where it is in the video.
    const time = times[i] ?? 0
    const target = `${String(Math.round(time)).padStart(5, '0')}s-${name}`
    renameSync(join(framesDir, name), join(framesDir, target))
    frames.push({ file: join('frames', target), time })
  })
  return { frames, dropped: files.length - frames.length }
}

/** The text on screen of each frame (in place), or why it did not run. */
async function readScreens(dir: string, frames: Frame[], language: string, opts: ProcessOptions): Promise<Manifest['ocr']> {
  if (opts.ocr === false) return { skipped: 'disabled' }
  const bin = findTesseract()
  if (!bin) return { skipped: 'tesseract is not installed' }
  const languages = ocrLanguages(language === 'auto' ? undefined : language, tesseractLanguages(bin))
  if (languages.length === 0) return { skipped: 'tesseract has no language data installed' }
  let done = 0
  await mapLimit(frames, 4, async (frame) => {
    try {
      const text = await ocrImage(bin, join(dir, frame.file), languages, opts.signal)
      if (text) frame.text = text
    } catch {
      /* one unreadable frame does not stop the rest */
    }
    done++
    opts.onProgress?.({ stage: 'ocr', percent: Math.round((done / frames.length) * 100), message: `Reading text on screen… ${done}/${frames.length}` })
  })
  return { engine: 'tesseract', languages }
}

/** Process `file` (or return the cached result). Throws with a readable message when a tool is missing or fails. */
export async function processVideo(file: string, opts: ProcessOptions = {}): Promise<ProcessedVideo> {
  if (!existsSync(file)) throw new Error(`${file} does not exist.`)
  const id = videoId(file)
  const dir = videoDir(id)
  if (!opts.force) {
    const cached = loadVideo(id)
    if (cached) return { dir, manifest: cached.manifest }
  }
  const tools = findTools(opts.engine)
  if ('missing' in tools) throw new Error(tools.missing)
  mkdirSync(dir, { recursive: true })
  rmSync(join(dir, 'manifest.json'), { force: true })
  const abs = resolve(file)
  const seconds = await duration(tools, abs, opts.signal)
  const language = opts.language ?? 'auto'
  const modelName = opts.model ?? 'small'

  // whisper.cpp's model is downloaded here; mlx_whisper fetches its own (Hugging Face cache) the first time.
  opts.onProgress?.({ stage: 'model', message: `${tools.engine}, whisper model "${modelName}"` })
  const model = tools.engine === 'mlx' ? mlxModel(modelName) : await ensureModel(modelName, (message) => opts.onProgress?.({ stage: 'model', message }))

  opts.onProgress?.({ stage: 'audio', message: 'Extracting the audio…' })
  await run(tools.ffmpeg, ['-v', 'error', '-y', '-i', abs, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', join(dir, 'audio.wav')], { signal: opts.signal })

  // The frames are extracted while whisper transcribes: both take a while.
  opts.onProgress?.({ stage: 'transcribe', percent: 0, message: 'Transcribing…' })
  // OCR follows the frames, still while whisper works.
  const shots = extractFrames(tools, abs, dir, opts).then(async (r) => ({ ...r, ocr: await readScreens(dir, r.frames, language, opts) }))
  const [whisperSegments, { frames, dropped, ocr }] = await Promise.all([transcribe(tools, model, dir, language, opts), shots])
  rmSync(join(dir, 'audio.wav'), { force: true })

  // A recorder's metadata next to the video names the meeting and who spoke when.
  const recording = readRecording(abs)
  const segments = recording ? assignSpeakers(whisperSegments, recording.speakers) : whisperSegments
  const title = recording?.title ?? basename(file, extname(file))
  writeFileSync(join(dir, 'transcript.json'), JSON.stringify(segments))
  writeFileSync(join(dir, 'transcript.md'), toMarkdown(segments, title))
  writeFileSync(join(dir, 'transcript.srt'), toSrt(segments))
  const manifest: Manifest = {
    version: 1,
    id,
    source: abs,
    title,
    duration: seconds,
    language,
    model: modelName,
    engine: tools.engine,
    createdAt: new Date().toISOString(),
    segments: segments.length,
    frames,
    droppedFrames: dropped,
    ocr,
    ...(recording && {
      recording: { url: recording.url, startedAt: recording.recordingStartedAt, speakers: speakerNames(segments) }
    })
  }
  // Last: a folder with a manifest is a finished one.
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  const withText = frames.filter((f) => f.text).length
  opts.onProgress?.({
    stage: 'done',
    message: `Done: ${segments.length} transcript segments, ${frames.length} frames (${dropped} near-duplicates dropped${ocr && 'engine' in ocr ? `, text read on ${withText}` : ''}).`
  })
  return { dir, manifest }
}
