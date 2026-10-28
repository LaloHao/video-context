#!/usr/bin/env node
// `video-context-ui`: a local web page to watch a processed video next to its
// transcript, process new ones, and ask Claude about them. Claude is the
// `claude` CLI (Claude Code) run in print mode with this package's MCP server,
// so it uses the user's own login and can search the transcript and look at frames.

import { spawn, type ChildProcess } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { basename, dirname, extname, join, normalize, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { ENGINES, findBinary, homeDir, MODELS, type Engine, type ModelName } from './deps.js'
import { exportArchive, importArchive } from './export.js'
import { screenAt } from './screen.js'
import { Log } from './log.js'
import { writeZip } from './zip.js'
import { cleanChapters, readChapters, readNotes, searchLibrary, writeChapters, writeNotes, type Note } from './library.js'
import { listVideos, loadVideo, processVideo, videoId } from './process.js'
import { parseRecording, readRecording } from './recording.js'
import { Queue, type JobOptions } from './queue.js'
import { formatTime, parseTime } from './time.js'
import { spoken } from './transcript.js'

const USAGE = `Usage: video-context-ui [--port <n>] [--open]

A local page to watch processed videos with their transcript, process new ones,
and ask Claude about them (needs the claude CLI: https://claude.com/claude-code).

Options:
  -p, --port <n>  Port on 127.0.0.1 (default: 4317)
      --open      Open the page in the browser
  -h, --help      Show this help`

const { values } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    open: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }
  }
})
if (values.help) {
  console.log(USAGE)
  process.exit(0)
}

const PORT = Number(values.port ?? process.env.VIDEO_CONTEXT_UI_PORT ?? 4317)
const PAGE = fileURLToPath(new URL('../ui/index.html', import.meta.url))
const MCP_SERVER = fileURLToPath(new URL('./mcp.js', import.meta.url))
/** Claude models offered in the page; any other name works through the API too. */
const CLAUDE_MODELS = ['sonnet', 'opus', 'fable', 'haiku']
/** The transcript goes whole into the prompt up to this size; longer ones are read with the MCP tools. */
const MAX_INLINE_TRANSCRIPT = 60_000

const LOG_FILE = join(homeDir(), 'logs', 'ui.log')
const log = new Log(LOG_FILE, true)
const queue = new Queue(processVideo, { file: join(homeDir(), 'queue.json'), log: (level, message, detail) => log.add(level, 'queue', message, detail) })
const chats = new Set<ChildProcess>()

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif'
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 1_000_000) throw new Error('Request too large.')
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

/** A file, honoring `Range` so the player can seek. */
function sendFile(req: IncomingMessage, res: ServerResponse, file: string): void {
  const size = statSync(file).size
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    if (start >= size || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${size}` })
      res.end()
      return
    }
    res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' })
    createReadStream(file, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' })
  createReadStream(file).pipe(res)
}

const VIDEO_TOOLS = ['search_transcript', 'get_transcript', 'get_frames', 'get_screen', 'list_frames', 'list_videos', 'search_videos']

function claudeBinary(): string | null {
  return findBinary('VIDEO_CONTEXT_CLAUDE', ['claude'])
}

function claudeModel(value: unknown): string {
  return typeof value === 'string' && /^[\w.\-[\]]+$/.test(value) ? value : 'sonnet'
}

/** One line per chapter: "0:00 Title". */
const chapterLines = (dir: string): string => readChapters(dir).map((c) => `${formatTime(c.start)} ${c.title}`).join('; ')

/** What Claude is told about one video: what it is, how to cite times, and the transcript when it fits. */
function videoPrompt(id: string): string {
  const video = loadVideo(id)
  if (!video) return ''
  const m = video.manifest
  const transcript = video.segments.map((s) => `[${formatTime(s.start)}] ${spoken(s)}`).join('\n')
  const inline = transcript.length <= MAX_INLINE_TRANSCRIPT
  const chapters = chapterLines(video.dir)
  const notes = readNotes(video.dir).filter((n) => n.text)
  return [
    `The user is watching the video "${m.title}" (${formatTime(m.duration)}, video id ${m.id}) in a player next to its transcript, and asks you about it.`,
    'Answer in the language the user writes in. Be concise.',
    'Cite the moments you rely on as [m:ss] or [h:mm:ss] (for example [3:07]), or a range as [3:07–4:10]: the page turns them into links that seek the player there. Cite generously.',
    `The MCP tools of the video-context server work on this video with id "${m.id}": search_transcript finds where something is said or shown on screen, get_frames shows you the key frames around a time (use it when the question is about something visual), get_screen shows the exact screen at any times, from the video file (use it to read code or text typed between key frames, or to look closer at a moment), get_transcript reads a range. search_videos searches every other processed video too.`,
    chapters && `Chapters: ${chapters}`,
    notes.length > 0 && `The user's notes on this video:\n${notes.map((n) => `[${formatTime(n.time)}] ${n.text}`).join('\n')}`,
    inline ? `The whole transcript:\n\n${transcript}` : 'The transcript is long: read it with get_transcript and search_transcript.'
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** What Claude is told to answer about every processed video: a short label per video ("V2") that citations use. */
function libraryPrompt(): { prompt: string; labels: Record<string, string> } {
  const labels: Record<string, string> = {}
  const lines = listVideos().map((m, i) => {
    const label = `V${i + 1}`
    labels[label] = m.id
    const chapters = chapterLines(join(homeDir(), 'videos', m.id))
    const speakers = m.recording?.speakers.length ? `; speakers: ${m.recording.speakers.join(', ')}` : ''
    return `${label}: "${m.title}" — video id ${m.id}, ${formatTime(m.duration)}, processed ${m.createdAt.slice(0, 10)}${speakers}${chapters ? `; chapters: ${chapters}` : ''}`
  })
  const prompt = [
    'The user asks about their library of processed videos (recordings of meetings, trainings, screencasts):',
    lines.join('\n'),
    'Answer in the language the user writes in. Be concise.',
    'Find which videos talk about something with the search_videos tool, then dig into one with search_transcript, get_transcript, get_frames (its key frames) or get_screen (the exact screen at any time) and its video id.',
    'Cite every moment you rely on with the video label and the time, as [V2 3:07] or a range as [V2 3:07–4:10]: the page turns them into links that open that video there. Never cite a time without its label.'
  ].join('\n\n')
  return { prompt, labels }
}

/** Ask Claude about a video, or about every video: the claude CLI streams back as NDJSON events for the page. */
function chat(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): void {
  const library = body.scope === 'library'
  const id = String(body.videoId ?? '')
  const question = String(body.question ?? '').trim()
  const video = library ? null : loadVideo(id)
  if ((!library && !video) || !question) return json(res, 400, { error: 'A processed video and a question are needed.' })
  const claude = claudeBinary()
  if (!claude) return json(res, 500, { error: 'The claude CLI is not installed: https://claude.com/claude-code' })
  const session = typeof body.sessionId === 'string' && /^[0-9a-f-]{36}$/.test(body.sessionId) ? body.sessionId : null
  const { prompt, labels } = library ? libraryPrompt() : { prompt: videoPrompt(id), labels: undefined }
  // The same cache as the page, whatever the environment of the claude CLI.
  const mcp = { mcpServers: { 'video-context': { command: process.execPath, args: [MCP_SERVER], env: { VIDEO_CONTEXT_HOME: homeDir() } } } }
  const args = [
    '-p', question,
    '--model', claudeModel(body.model),
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--mcp-config', JSON.stringify(mcp), '--strict-mcp-config',
    // Only the videos' tools: no shell, no file edits.
    '--tools', '',
    '--allowedTools', VIDEO_TOOLS.map((t) => `mcp__video-context__${t}`).join(','),
    '--append-system-prompt', prompt
  ]
  if (session) args.push('--resume', session)
  // Run in the video's folder (or the cache) so no project's CLAUDE.md or settings leak in.
  const cwd = video?.dir ?? homeDir()
  mkdirSync(cwd, { recursive: true })
  const about = library ? 'all videos' : `"${video!.manifest.title}"`
  log.info('chat', `Question about ${about} with ${claudeModel(body.model)}${session ? ' (follow-up)' : ''}`, question)
  const child = spawn(claude, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  chats.add(child)
  let answered = false
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
  const send = (event: Record<string, unknown>): void => void res.write(`${JSON.stringify(event)}\n`)
  if (labels) send({ type: 'labels', labels })
  let buffer = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.type === 'system' && msg.subtype === 'init') send({ type: 'session', id: msg.session_id, model: msg.model })
      else if (msg.type === 'stream_event' && msg.parent_tool_use_id === null) {
        const e = msg.event
        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') send({ type: 'text', text: e.delta.text })
        else if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use')
          send({ type: 'tool', name: String(e.content_block.name).replace(/^mcp__video-context__/, '') })
        else if (e.type === 'message_start') send({ type: 'turn' })
      } else if (msg.type === 'assistant') {
        // Which frames Claude looked at, so the page can show them.
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'tool_use' && /get_frames$/.test(block.name)) send({ type: 'frames', input: block.input })
          if (block.type === 'tool_use' && /get_screen$/.test(block.name)) send({ type: 'screens', input: block.input })
        }
      } else if (msg.type === 'result') {
        answered = true
        const error = msg.is_error ? claudeHint(String(msg.result ?? 'Claude failed.')) : undefined
        if (error) log.error('chat', `Claude failed on a question about ${about}: ${error}`, line.slice(0, 4000))
        else log.info('chat', `Answered about ${about} in ${((msg.duration_ms ?? 0) / 1000).toFixed(1)} s${msg.total_cost_usd ? ` ($${Number(msg.total_cost_usd).toFixed(4)})` : ''}`)
        send({ type: 'done', error, cost: msg.total_cost_usd, ms: msg.duration_ms })
      }
    }
  })
  child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)))
  child.on('error', (error) => {
    send({ type: 'done', error: error.message })
    res.end()
  })
  child.on('close', (code, signal) => {
    chats.delete(child)
    if (signal === 'SIGTERM' && !answered) log.info('chat', `Stopped the answer about ${about}`)
    else if (code !== 0 && !answered) {
      const reason = stderr.trim().split('\n').slice(-3).join(' ') || `claude exited with code ${code}`
      log.error('chat', `Claude failed on a question about ${about}: ${reason}`, stderr)
      send({ type: 'done', error: claudeHint(reason) })
    }
    res.end()
  })
  // Stop Claude when the page stops listening (the user pressed stop or left).
  res.on('close', () => {
    if (child.exitCode === null) child.kill('SIGTERM')
  })
}

/** Run a tool to the end: its output and exit code, whether it failed or not (claude reports its errors on stdout). */
function runTool(command: string, args: string[], cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    chats.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-8000)))
    child.on('error', reject)
    child.on('close', (code) => {
      chats.delete(child)
      resolvePromise({ code, stdout, stderr })
    })
  })
}

/** An error already in the log with its details: the request handler only answers with it. */
class LoggedError extends Error {}

/** What to do about a claude error the user can fix. */
function claudeHint(message: string): string {
  if (/authenticat|oauth|logged in|log in|login|401/i.test(message)) return `${message} Sign in again: run \`claude auth login\` in a terminal.`
  if (/rate.?limit|usage limit|429/i.test(message)) return `${message} Wait a moment, or pick another model.`
  return message
}

const CHAPTERS_SCHEMA = {
  type: 'object',
  properties: {
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        properties: { start: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' } },
        required: ['start', 'title', 'summary']
      }
    }
  },
  required: ['chapters']
}

/** Chapters written by Claude from the transcript, saved next to it. */
async function makeChapters(id: string, model: string): Promise<unknown> {
  const video = loadVideo(id)
  if (!video) throw new Error('No such video.')
  const claude = claudeBinary()
  if (!claude) throw new Error('The claude CLI is not installed: https://claude.com/claude-code')
  const m = video.manifest
  const transcript = video.segments.map((s) => `[${formatTime(s.start)}] ${spoken(s)}`).join('\n')
  const count = Math.max(3, Math.min(15, Math.round(m.duration / 240)))
  const prompt = [
    `Split this video, "${m.title}" (${formatTime(m.duration)}), into about ${count} chapters where the topic changes, for a table of contents.`,
    'For each chapter: "start" as m:ss (or h:mm:ss), the time of the transcript line where it begins (the first one at 0:00); a short "title" (2–6 words); a one-sentence "summary".',
    'Write titles and summaries in the language spoken in the video.',
    `Transcript:\n\n${transcript}`
  ].join('\n\n')
  log.info('chapters', `Generating chapters for "${m.title}" with ${model}`)
  const started = Date.now()
  const out = await runTool(
    claude,
    ['-p', prompt, '--model', model, '--output-format', 'json', '--json-schema', JSON.stringify(CHAPTERS_SCHEMA), '--tools', '', '--strict-mcp-config', '--no-session-persistence'],
    video.dir
  )
  let result: { is_error?: boolean; result?: string; total_cost_usd?: number; structured_output?: { chapters?: { start: string; title: string; summary?: string }[] } } = {}
  try {
    result = JSON.parse(out.stdout)
  } catch {
    /* not JSON: the error is in stderr */
  }
  if (out.code !== 0 || result.is_error || !result.structured_output?.chapters) {
    const reason = result.result || out.stderr.trim().split('\n').slice(-3).join(' ') || `claude exited with code ${out.code}`
    log.error('chapters', `Chapters for "${m.title}" failed: ${reason}`, [`exit code ${out.code}`, out.stderr.trim(), out.stdout.trim().slice(0, 4000)].filter(Boolean).join('\n\n'))
    throw new LoggedError(claudeHint(reason))
  }
  const chapters = cleanChapters(result.structured_output.chapters, m.duration, parseTime)
  writeChapters(video.dir, chapters)
  log.info('chapters', `${chapters.length} chapters for "${m.title}" in ${((Date.now() - started) / 1000).toFixed(1)} s${result.total_cost_usd ? ` ($${result.total_cost_usd.toFixed(4)})` : ''}`)
  return chapters
}

/** A part of the video as an MP4 (or M4A for audio), or a GIF: made once with ffmpeg, kept in the video's folder. */
async function clip(req: IncomingMessage, res: ServerResponse, id: string, url: URL): Promise<void> {
  const video = loadVideo(id)!
  const m = video.manifest
  const from = Number(url.searchParams.get('from'))
  const to = Number(url.searchParams.get('to'))
  const audioOnly = m.frames.length === 0
  const format = url.searchParams.get('format') === 'gif' ? 'gif' : audioOnly ? 'm4a' : 'mp4'
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || from >= m.duration) return json(res, 400, { error: 'A start before the end is needed.' })
  if (format === 'gif' && (audioOnly || to - from > 30)) return json(res, 400, { error: audioOnly ? 'An audio file has no picture for a GIF.' : 'A GIF is at most 30 seconds.' })
  if (!existsSync(m.source)) return json(res, 404, { error: 'The video file is no longer there.' })
  const ffmpeg = findBinary('VIDEO_CONTEXT_FFMPEG', ['ffmpeg'])
  if (!ffmpeg) return json(res, 500, { error: 'ffmpeg is not installed.' })
  const dir = join(video.dir, 'clips')
  mkdirSync(dir, { recursive: true })
  const a = from.toFixed(2)
  const b = Math.min(to, m.duration).toFixed(2)
  const file = join(dir, `${a}-${b}.${format}`)
  if (!existsSync(file)) {
    const tmp = `${file}.part.${format}`
    const input = ['-hide_banner', '-v', 'error', '-y', '-ss', a, '-to', b, '-i', m.source]
    const encode =
      format === 'gif'
        ? ['-vf', 'fps=10,scale=min(720\\,iw):-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer', '-loop', '0']
        : format === 'm4a'
          ? ['-vn', '-c:a', 'aac', '-b:a', '128k']
          : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart']
    // -ss before -i seeks fast, and accurately since the clip is encoded again.
    const out = await runTool(ffmpeg, [...input, ...encode, tmp])
    if (out.code !== 0) {
      log.error('clip', `Clip ${formatTime(from)}–${formatTime(to)} of "${m.title}" failed`, out.stderr)
      return json(res, 500, { error: `ffmpeg failed: ${out.stderr.trim().split('\n').slice(-2).join(' ')}` })
    }
    renameSync(tmp, file)
    log.info('clip', `${format.toUpperCase()} clip ${formatTime(from)}–${formatTime(to)} of "${m.title}"`)
  }
  const name = `${m.title} ${formatTime(from).replace(/:/g, '-')} to ${formatTime(to).replace(/:/g, '-')}.${format}`
  res.setHeader('content-disposition', `attachment; filename="${name.replace(/[^\w.\- ]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`)
  sendFile(req, res, file)
}

/** A file sent by the page is saved under ~/.cache/video-context/uploads, then processed like any other. */
async function upload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const name = basename(url.searchParams.get('name') ?? '').replace(/[^\w.\- ()]/g, '_')
  if (!name || name.startsWith('.')) return json(res, 400, { error: 'A file name is needed.' })
  const dir = join(homeDir(), 'uploads')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, name)
  await pipeline(req, createWriteStream(target))
  log.info('upload', `Received ${name} (${(statSync(target).size / 1e6).toFixed(1)} MB)`)
  json(res, 200, { path: target })
}

function processOptions(body: Record<string, unknown>): JobOptions {
  const language = typeof body.language === 'string' && /^(auto|[a-z]{2,3})$/.test(body.language) ? body.language : undefined
  const model = (MODELS as readonly string[]).includes(String(body.model)) ? (body.model as ModelName) : undefined
  const engine = (ENGINES as readonly string[]).includes(String(body.engine)) ? (body.engine as Engine) : undefined
  return { language, model, engine, force: body.force === true }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Only this machine: a page on another site must not reach the API (DNS rebinding, cross-site POSTs).
  const host = (req.headers.host ?? '').replace(/:\d+$/, '')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return json(res, 403, { error: 'Forbidden host.' })
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return json(res, 403, { error: 'Forbidden.' })
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-video-context'] !== '1') return json(res, 403, { error: 'Forbidden.' })

  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(readFileSync(PAGE))
    return
  }
  if (parts[0] !== 'api') return json(res, 404, { error: 'Not found.' })

  if (req.method === 'GET' && parts[1] === 'config' && parts.length === 2)
    return json(res, 200, { claudeModels: CLAUDE_MODELS, whisperModels: MODELS, engines: ENGINES, claude: Boolean(claudeBinary()), logFile: LOG_FILE.startsWith(homedir()) ? `~${LOG_FILE.slice(homedir().length)}` : LOG_FILE })

  if (req.method === 'GET' && parts[1] === 'videos' && parts.length === 2)
    return json(res, 200, listVideos().map((m) => ({ id: m.id, title: m.title, duration: m.duration, createdAt: m.createdAt, source: m.source, available: existsSync(m.source) })))

  if (parts[1] === 'videos' && parts[2]) {
    const video = loadVideo(parts[2])
    if (!video) return json(res, 404, { error: 'No such video.' })
    if (req.method === 'GET' && parts.length === 3)
      return json(res, 200, {
        manifest: video.manifest,
        segments: video.segments,
        available: existsSync(video.manifest.source),
        chapters: readChapters(video.dir),
        notes: readNotes(video.dir)
      })
    if (req.method === 'POST' && parts[3] === 'chapters') return json(res, 200, await makeChapters(video.manifest.id, claudeModel((await readJson(req)).model)))
    if (req.method === 'PUT' && parts[3] === 'notes') {
      const list = (await readJson(req)).notes
      if (!Array.isArray(list)) return json(res, 400, { error: 'A list of notes is needed.' })
      const notes: Note[] = list
        .filter((n) => n && Number.isFinite(Number(n.time)))
        .map((n) => ({ id: String(n.id ?? Math.random().toString(36).slice(2)), time: Number(n.time), text: String(n.text ?? ''), createdAt: String(n.createdAt ?? new Date().toISOString()) }))
      writeNotes(video.dir, notes)
      return json(res, 200, readNotes(video.dir))
    }
    if (req.method === 'GET' && parts[3] === 'clip') return clip(req, res, video.manifest.id, url)
    if (req.method === 'GET' && parts[3] === 'screen') {
      const time = Number(url.searchParams.get('t'))
      if (!Number.isFinite(time) || time < 0) return json(res, 400, { error: 'A time in seconds is needed.' })
      const screen = await screenAt(video.manifest.id, time, { ocr: false })
      return sendFile(req, res, join(video.dir, screen.file))
    }
    if (req.method === 'GET' && parts[3] === 'export') {
      // Streamed as it is written: a large video is never copied first.
      const { name, entries } = exportArchive(video.manifest.id, readFileSync(PAGE, 'utf8'))
      const started = Date.now()
      log.info('export', `Exporting "${video.manifest.title}" (${entries.length} files)`)
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${name.replace(/[^\w.\- ]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'cache-control': 'no-store'
      })
      try {
        await writeZip(entries, res)
        log.info('export', `Exported "${video.manifest.title}" in ${((Date.now() - started) / 1000).toFixed(1)} s`)
      } catch (error) {
        log.error('export', `Export of "${video.manifest.title}" failed`, error instanceof Error ? error.stack : String(error))
      }
      res.end()
      return
    }
    if (req.method === 'GET' && parts[3] === 'media') {
      if (!existsSync(video.manifest.source)) return json(res, 404, { error: 'The video file is no longer there.' })
      return sendFile(req, res, video.manifest.source)
    }
    if (req.method === 'GET' && parts[3] === 'frames' && parts[4]) {
      const file = normalize(join('frames', parts[4]))
      if (!video.manifest.frames.some((f) => normalize(f.file) === file)) return json(res, 404, { error: 'No such frame.' })
      return sendFile(req, res, join(video.dir, file))
    }
    if (req.method === 'GET' && parts[3] === 'transcript' && ['md', 'srt', 'json'].includes(parts[4] ?? '')) {
      const ext = parts[4]
      res.writeHead(200, {
        'content-type': ext === 'json' ? 'application/json' : 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="${video.manifest.title.replace(/[^\w.\- ]/g, '_')}.${ext}"`
      })
      res.end(readFileSync(join(video.dir, `transcript.${ext}`)))
      return
    }
  }

  if (parts[1] === 'logs') {
    if (req.method === 'GET') return json(res, 200, log.since(Number(url.searchParams.get('after') ?? 0)))
    if (req.method === 'DELETE') {
      log.clear()
      return json(res, 200, [])
    }
  }

  if (parts[1] === 'jobs') {
    if (req.method === 'GET' && parts.length === 2) return json(res, 200, { jobs: queue.list(), now: Date.now() })
    if (req.method === 'POST' && parts[2] === 'clear') {
      queue.clearFinished()
      return json(res, 200, { jobs: queue.list(), now: Date.now() })
    }
    const id = parts[2] ?? ''
    if (!queue.get(id)) return json(res, 404, { error: 'No such job.' })
    if (req.method === 'POST' && parts[3] === 'cancel') return json(res, 200, queue.cancel(id))
    if (req.method === 'POST' && parts[3] === 'retry') return json(res, 200, queue.retry(id))
    if (req.method === 'POST' && parts[3] === 'top') return json(res, 200, queue.moveToFront(id))
    if (req.method === 'DELETE' && parts.length === 3) return json(res, queue.remove(id) ? 200 : 409, { removed: id })
  }

  if (req.method === 'GET' && parts[1] === 'search') {
    const query = url.searchParams.get('q') ?? ''
    return json(res, 200, query.trim() ? searchLibrary(query, 8) : [])
  }

  if (req.method === 'POST' && parts[1] === 'upload') return upload(req, res, url)

  if (req.method === 'POST' && parts[1] === 'process') {
    const body = await readJson(req)
    const file = typeof body.path === 'string' ? resolve(body.path.replace(/^~(?=\/|$)/, process.env.HOME ?? '~')) : ''
    if (!file || !existsSync(file) || !statSync(file).isFile()) return json(res, 400, { error: `${file || 'The path'} does not exist.` })
    // A recorder's .json next to its video is no video: it is read when the video is processed.
    if (extname(file).toLowerCase() === '.json') {
      let recording = false
      try {
        recording = parseRecording(JSON.parse(readFileSync(file, 'utf8'))) !== null
      } catch {
        /* not JSON */
      }
      return json(res, 400, {
        recording,
        error: recording
          ? `${basename(file)} is the recording file of a video (its title, who spoke when): it is read when the video next to it, with the same name, is processed.`
          : `${basename(file)} is not a video or audio file.`
      })
    }
    const id = videoId(file)
    const options = processOptions(body)
    // Processed before its recording file was there: the speakers come only by processing it again.
    const done = loadVideo(id)
    const hint =
      done && !options.force && !done.manifest.recording && readRecording(file)
        ? `${basename(file)} was processed before its recording file (${basename(file, extname(file))}.json) was next to it: "Process again" adds who spoke when.`
        : undefined
    if (hint) log.warn('queue', hint)
    const job = queue.add(file, id, options)
    if (hint) job.hint = hint
    return json(res, 200, job)
  }

  if (req.method === 'POST' && parts[1] === 'import') {
    const body = await readJson(req)
    const file = typeof body.path === 'string' ? resolve(body.path.replace(/^~(?=\/|$)/, process.env.HOME ?? '~')) : ''
    if (!file || !existsSync(file)) return json(res, 400, { error: `${file || 'The path'} does not exist.` })
    try {
      const result = await importArchive(file)
      log.info('import', result.already ? `"${result.title}" was already imported` : `Imported "${result.title}" from ${basename(file)}`)
      // An uploaded archive is not needed once imported (the video is out of it).
      if (dirname(file) === join(homeDir(), 'uploads')) rmSync(file, { force: true })
      return json(res, 200, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('import', `Could not import ${basename(file)}: ${message}`, file)
      return json(res, 400, { error: message })
    }
  }

  if (req.method === 'POST' && parts[1] === 'chat') return chat(req, res, await readJson(req))

  json(res, 404, { error: 'Not found.' })
}

const server = createServer((req, res) => {
  route(req, res).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (!(error instanceof LoggedError)) log.error('server', `${req.method} ${req.url?.replace(/\?.*/, '')}: ${message}`, error instanceof Error ? error.stack : undefined)
    if (!res.headersSent) json(res, 500, { error: message })
    else res.end()
  })
})

server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${PORT} is in use: try --port <another>.` : error.message)
  process.exit(1)
})

server.listen(PORT, '127.0.0.1', () => {
  const address = `http://localhost:${PORT}`
  log.info('server', `video-context UI on ${address} (cache: ${homeDir()})`)
  if (values.open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
    spawn(opener, [address], { stdio: 'ignore', detached: true }).unref()
  }
})

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    for (const child of chats) child.kill('SIGTERM')
    queue.stop()
    process.exit(0)
  })
