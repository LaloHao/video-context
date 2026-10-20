#!/usr/bin/env node
// The MCP server (stdio). Processing a video takes minutes, longer than an MCP
// call should block, so `process_video` starts a background job and returns;
// `video_status` follows it. Everything else reads the cached result.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { MODELS, type ModelName } from './deps.js'
import { framesAround, framesBetween } from './frames.js'
import { listVideos, loadVideo, processVideo, videoId, type Progress } from './process.js'
import { formatTime, parseTime } from './time.js'
import { rangeText, searchSegments } from './transcript.js'

const MAX_TRANSCRIPT_CHARS = 40_000
const MAX_FRAMES = 8

interface Job {
  progress: Progress
  error?: string
}
const jobs = new Map<string, Job>()

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
const text = (value: string): { content: Content[] } => ({ content: [{ type: 'text', text: value }] })
const fail = (value: string): { content: Content[]; isError: true } => ({ content: [{ type: 'text', text: value }], isError: true })

function summary(id: string): string {
  const video = loadVideo(id)
  if (!video) return ''
  const m = video.manifest
  return [
    `Video ${m.id} is ready: "${m.title}", ${formatTime(m.duration)} long, ${m.segments} transcript segments, ${m.frames.length} key frames.`,
    `Transcript (Markdown, with times): ${join(video.dir, 'transcript.md')}`,
    'Read it with get_transcript (by time range), find topics with search_transcript, and look at the screen with get_frames.'
  ].join('\n')
}

const server = new McpServer({ name: 'video-context', version: '0.1.0' })

server.registerTool(
  'process_video',
  {
    description:
      'Start processing a local video file: a timestamped transcript (whisper.cpp, on this machine) and key frames. Returns at once with the video id; long videos take minutes, follow them with video_status. A video already processed is ready immediately.',
    inputSchema: {
      path: z.string().describe('Absolute path of the video (or audio) file.'),
      language: z.string().optional().describe('Spoken language code, e.g. "es" or "en". Default: auto-detect.'),
      model: z.enum(MODELS).optional().describe('Whisper model. Default "small"; "medium" or "large-v3-turbo" are more accurate and slower.'),
      force: z.boolean().optional().describe('Process again even if it was processed before.')
    }
  },
  async ({ path, language, model, force }) => {
    let id: string
    try {
      id = videoId(path)
    } catch {
      return fail(`${path} does not exist or cannot be read.`)
    }
    if (!force && loadVideo(id)) return text(summary(id))
    const running = jobs.get(id)
    if (running && !running.error && running.progress.stage !== 'done') return text(`Video ${id} is already being processed: ${running.progress.message}`)
    const job: Job = { progress: { stage: 'audio', message: 'Starting…' } }
    jobs.set(id, job)
    processVideo(path, { language, model: model as ModelName | undefined, force, onProgress: (p) => (job.progress = p) }).catch((error: unknown) => {
      job.error = error instanceof Error ? error.message : String(error)
    })
    return text(`Processing started for video ${id}. Call video_status with this id to follow it (an hour of video takes several minutes).`)
  }
)

server.registerTool(
  'video_status',
  {
    description: 'How the processing of a video is going, or what is ready once it finished.',
    inputSchema: { videoId: z.string() }
  },
  async ({ videoId: id }) => {
    const job = jobs.get(id)
    if (job?.error) return fail(`Processing failed: ${job.error}`)
    if (loadVideo(id)) return text(summary(id))
    if (job) return text(`Still processing: ${job.progress.message}`)
    return fail(`Unknown video id ${id}. Start it with process_video.`)
  }
)

server.registerTool(
  'list_videos',
  { description: 'The videos already processed: id, title, duration and source path.', inputSchema: {} },
  async () => {
    const videos = listVideos()
    if (videos.length === 0) return text('No video has been processed yet.')
    return text(videos.map((m) => `- ${m.id}: "${m.title}" (${formatTime(m.duration)}) — ${m.source}`).join('\n'))
  }
)

server.registerTool(
  'get_transcript',
  {
    description: `The transcript of a processed video, one "[m:ss] text" line per segment, optionally only a time range. Long answers stop at about ${MAX_TRANSCRIPT_CHARS} characters and say where to continue.`,
    inputSchema: {
      videoId: z.string(),
      from: z.string().optional().describe('Start time, e.g. "12:30" or "750". Default: the beginning.'),
      to: z.string().optional().describe('End time. Default: the end.')
    }
  },
  async ({ videoId: id, from, to }) => {
    const video = loadVideo(id)
    if (!video) return fail(`Video ${id} is not processed (yet). Use process_video / video_status.`)
    const start = parseTime(from) ?? 0
    const end = parseTime(to) ?? Number.POSITIVE_INFINITY
    const lines = rangeText(video.segments, start, end).split('\n')
    let out = ''
    for (const line of lines) {
      if (out.length + line.length > MAX_TRANSCRIPT_CHARS) {
        const next = /^\[([\d:]+)\]/.exec(line)?.[1]
        return text(`${out}\n… (continues: call again with from="${next}")`)
      }
      out += (out ? '\n' : '') + line
    }
    return text(out || 'Nothing is said in that range.')
  }
)

server.registerTool(
  'search_transcript',
  {
    description: 'Find where something is said in a processed video: segments containing all the words (accents and case aside), with their time and the text around them.',
    inputSchema: {
      videoId: z.string(),
      query: z.string(),
      limit: z.number().int().min(1).max(30).optional()
    }
  },
  async ({ videoId: id, query, limit }) => {
    const video = loadVideo(id)
    if (!video) return fail(`Video ${id} is not processed (yet).`)
    const hits = searchSegments(video.segments, query, limit ?? 10)
    if (hits.length === 0) return text(`"${query}" is not found in the transcript. Try other words or a synonym.`)
    return text(hits.map((h) => `[${formatTime(h.start)}–${formatTime(h.end)}] ${h.text}`).join('\n\n'))
  }
)

server.registerTool(
  'get_frames',
  {
    description: `Key frames of a processed video as images, to see what the screen shows (code, forms, diagrams). Either the frames around one time ("at"), or spread over a range ("from"/"to"). At most ${MAX_FRAMES}.`,
    inputSchema: {
      videoId: z.string(),
      at: z.string().optional().describe('A time, e.g. "23:10": the frames closest to it.'),
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.number().int().min(1).max(MAX_FRAMES).optional()
    }
  },
  async ({ videoId: id, at, from, to, limit }) => {
    const video = loadVideo(id)
    if (!video) return fail(`Video ${id} is not processed (yet).`)
    const count = limit ?? 4
    const atTime = parseTime(at)
    const frames =
      atTime !== null
        ? framesAround(video.manifest.frames, atTime, count)
        : framesBetween(video.manifest.frames, parseTime(from) ?? 0, parseTime(to) ?? Number.POSITIVE_INFINITY, count)
    if (frames.length === 0) return text('No key frame in that range.')
    const content: Content[] = []
    for (const frame of frames) {
      content.push({ type: 'text', text: `Frame at ${formatTime(frame.time)}:` })
      content.push({ type: 'image', mimeType: 'image/jpeg', data: readFileSync(join(video.dir, frame.file)).toString('base64') })
    }
    return { content }
  }
)

server.registerTool(
  'list_frames',
  { description: 'The times of every key frame of a processed video (to choose which to look at).', inputSchema: { videoId: z.string() } },
  async ({ videoId: id }) => {
    const video = loadVideo(id)
    if (!video) return fail(`Video ${id} is not processed (yet).`)
    return text(video.manifest.frames.map((f) => formatTime(f.time)).join(', '))
  }
)

await server.connect(new StdioServerTransport())
