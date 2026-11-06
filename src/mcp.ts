#!/usr/bin/env node
// The MCP server (stdio). Processing a video takes minutes, longer than an MCP
// call should block, so `process_video` starts a background job and returns;
// `video_status` follows it. Everything else reads the cached result.

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { ENGINES, MODELS, type ModelName } from './deps.js'
import { framesAround, framesBetween, searchScreen } from './frames.js'
import { cleanFolder, cleanTags, readLabels, writeLabels } from './labels.js'
import { describeVideo, findVideos, resolveVideo, searchLibrary } from './library.js'
import { screenAt } from './screen.js'
import { listVideos, loadVideo, processVideo, videoDir, videoId, type Manifest, type Progress } from './process.js'
import { formatTime, parseTime } from './time.js'
import { fold, rangeText, searchSegments } from './transcript.js'

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

/** How a tool names a video: by id, or as the user calls it. */
const VIDEO = z
  .string()
  .describe('The video: its name, or words of its name, folder or tags ("weekly sync", "posgrado clase 3"), or its id. list_videos lists them.')

/** The video `ref` names, processed; or what to tell the agent (no such video, or which ones it could be). */
function resolveLoaded(ref: string): ({ id: string } & NonNullable<ReturnType<typeof loadVideo>>) | { error: string } {
  const found = resolveVideo(ref)
  if ('error' in found) return found
  const loaded = loadVideo(found.id)
  return loaded ? { id: found.id, ...loaded } : { error: `Video ${found.id} is not processed (yet).` }
}

function summary(id: string): string {
  const video = loadVideo(id)
  if (!video) return ''
  const m = video.manifest
  const screen =
    m.ocr && 'engine' in m.ocr
      ? ` Text on screen was read (OCR) on ${m.frames.filter((f) => f.text).length} of them, and search_transcript searches it too.`
      : ''
  const filed = m.folder || m.tags?.length ? ` Filed under ${[m.folder, ...(m.tags ?? []).map((t) => `#${t}`)].filter(Boolean).join(' · ')}.` : ''
  const speakers = m.recording?.speakers.length
    ? ` The transcript says who spoke (${m.recording.speakers.join(', ')}); search_transcript also finds a speaker's name.`
    : ''
  return [
    `Video ${m.id} is ready: "${m.title}", ${formatTime(m.duration)} long, ${m.segments} transcript segments, ${m.frames.length} key frames.${filed}${screen}${speakers}`,
    `Transcript (Markdown, with times): ${join(video.dir, 'transcript.md')}`,
    'Read it with get_transcript (by time range), find topics with search_transcript, and look at the screen with get_frames. The tools take its name as well as its id.'
  ].join('\n')
}

const server = new McpServer({ name: 'video-context', version: '0.3.0' })

server.registerTool(
  'process_video',
  {
    description:
      'Start processing a local video file: a timestamped transcript (whisper.cpp or mlx-whisper, on this machine) and key frames. Returns at once with the video id; long videos take minutes, follow them with video_status. A video already processed is ready immediately.',
    inputSchema: {
      path: z.string().describe('Absolute path of the video (or audio) file.'),
      language: z.string().optional().describe('Spoken language code, e.g. "es" or "en". Default: auto-detect.'),
      model: z.enum(MODELS).optional().describe('Whisper model. Default "small"; "medium" or "large-v3-turbo" are more accurate and slower.'),
      engine: z.enum(ENGINES).optional().describe('Transcription engine. Default: mlx (Apple silicon) when installed, else whisper.cpp.'),
      force: z.boolean().optional().describe('Process again even if it was processed before.'),
      title: z.string().optional().describe('A name to call it by, instead of the file name.'),
      folder: z.string().optional().describe('A folder to file it in, e.g. "Posgrado/Clases".'),
      tags: z.array(z.string()).optional().describe('Tags, e.g. ["redes", "examen"].')
    }
  },
  async ({ path, language, model, engine, force, title, folder, tags }) => {
    let id: string
    try {
      id = videoId(path)
    } catch {
      return fail(`${path} does not exist or cannot be read.`)
    }
    // Filed at once, so it can be called by its name while it is processed.
    if (title || folder || tags?.length) {
      mkdirSync(videoDir(id), { recursive: true })
      const before = readLabels(videoDir(id))
      writeLabels(videoDir(id), { title: title ?? before.title, folder: folder ?? before.folder, tags: tags ?? before.tags })
    }
    if (!force && loadVideo(id)) return text(summary(id))
    const running = jobs.get(id)
    if (running && !running.error && running.progress.stage !== 'done') return text(`Video ${id} is already being processed: ${running.progress.message}`)
    const job: Job = { progress: { stage: 'audio', message: 'Starting…' } }
    jobs.set(id, job)
    processVideo(path, { language, model: model as ModelName | undefined, engine, force, onProgress: (p) => (job.progress = p) }).catch((error: unknown) => {
      job.error = error instanceof Error ? error.message : String(error)
    })
    return text(`Processing started for video ${id}. Call video_status with this id to follow it (an hour of video takes several minutes).`)
  }
)

server.registerTool(
  'video_status',
  {
    description: 'How the processing of a video is going, or what is ready once it finished.',
    inputSchema: { videoId: VIDEO }
  },
  async ({ videoId: ref }) => {
    const found = /^[0-9a-f]{16}$/.test(ref) ? { id: ref } : resolveVideo(ref)
    if ('error' in found) return fail(found.error)
    const id = found.id
    const job = jobs.get(id)
    if (job?.error) return fail(`Processing failed: ${job.error}`)
    if (loadVideo(id)) return text(summary(id))
    if (job) return text(`Still processing: ${job.progress.message}`)
    return fail(`Unknown video id ${id}. Start it with process_video.`)
  }
)

server.registerTool(
  'list_videos',
  {
    description:
      'The videos already processed, by folder: name, tags, length, date and id. Filter by a folder (with its subfolders) or a tag. The other tools take a video by its name as well as its id.',
    inputSchema: {
      folder: z.string().optional().describe('Only this folder and its subfolders, e.g. "Posgrado".'),
      tag: z.string().optional().describe('Only the videos with this tag.')
    }
  },
  async ({ folder, tag }) => {
    const all = listVideos()
    if (all.length === 0) return text('No video has been processed yet.')
    const videos = findVideos({ folder, tag })
    if (videos.length === 0) return text(`No video${folder ? ` in "${folder}"` : ''}${tag ? ` tagged #${tag.replace(/^#/, '')}` : ''}. ${summaryOfLabels(all)}`)
    const byFolder = new Map<string, Manifest[]>()
    for (const m of videos) byFolder.set(m.folder ?? '', [...(byFolder.get(m.folder ?? '') ?? []), m])
    const sections = [...byFolder.entries()]
      .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
      .map(([name, list]) =>
        [`## ${name || 'No folder'}`, ...list.map((m) => `- "${m.title}"${m.tags?.length ? ` ${m.tags.map((t) => `#${t}`).join(' ')}` : ''} — ${formatTime(m.duration)}, ${m.createdAt.slice(0, 10)}, id ${m.id}`)].join('\n')
      )
    const shown = videos.length < all.length ? `Showing ${videos.length} of them.` : ''
    return text([[summaryOfLabels(all), shown].filter(Boolean).join(' '), ...sections].join('\n\n'))
  }
)

/** The folders and tags in use, with how many videos each. */
function summaryOfLabels(videos: Manifest[]): string {
  const count = (keys: string[]): string =>
    [...keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())].map(([k, n]) => `${k} (${n})`).join(', ')
  const folders = count(videos.flatMap((m) => (m.folder ? [m.folder] : [])))
  const tags = count(videos.flatMap((m) => (m.tags ?? []).map((t) => `#${t}`)))
  return `${videos.length} videos. Folders: ${folders || 'none'}. Tags: ${tags || 'none'}.`
}

server.registerTool(
  'label_video',
  {
    description:
      'Name a video, file it in a folder, or tag it, to find and call it easily (in list_videos, search_videos, and by name in every tool). Only what is given changes; an empty title or folder removes it.',
    inputSchema: {
      videoId: VIDEO,
      title: z.string().optional().describe('Its name ("" goes back to the processed title).'),
      folder: z.string().optional().describe('Its folder, e.g. "Posgrado/Clases" ("" takes it out of any folder).'),
      tags: z.array(z.string()).optional().describe('Its tags, replacing the ones it has.'),
      addTags: z.array(z.string()).optional().describe('Tags to add.'),
      removeTags: z.array(z.string()).optional().describe('Tags to remove.')
    }
  },
  async ({ videoId: ref, title, folder, tags, addTags, removeTags }) => {
    const v = resolveLoaded(ref)
    if ('error' in v) return fail(v.error)
    const before = readLabels(v.dir)
    const removed = new Set(cleanTags(removeTags).map((t) => t.toLowerCase()))
    writeLabels(v.dir, {
      title: title ?? before.title,
      folder: folder !== undefined ? cleanFolder(folder) : before.folder,
      tags: [...(tags ? cleanTags(tags) : before.tags), ...cleanTags(addTags)].filter((t) => !removed.has(t.toLowerCase()))
    })
    const now = loadVideo(v.id)!.manifest
    return text(`Now: ${describeVideo(now)}`)
  }
)

server.registerTool(
  'get_transcript',
  {
    description: `The transcript of a processed video, one "[m:ss] text" line per segment, optionally only a time range. Long answers stop at about ${MAX_TRANSCRIPT_CHARS} characters and say where to continue.`,
    inputSchema: {
      videoId: VIDEO,
      from: z.string().optional().describe('Start time, e.g. "12:30" or "750". Default: the beginning.'),
      to: z.string().optional().describe('End time. Default: the end.')
    }
  },
  async ({ videoId: ref, from, to }) => {
    const video = resolveLoaded(ref)
    if ('error' in video) return fail(video.error)
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
    description:
      'Find something in a processed video: where it is said (transcript segments with all the words, accents and case aside, with the text around them) and where it is shown on screen (text read from the key frames: URLs, code, field names). Each hit has its time; look at a screen hit with get_frames at that time.',
    inputSchema: {
      videoId: VIDEO,
      query: z.string(),
      limit: z.number().int().min(1).max(30).optional()
    }
  },
  async ({ videoId: ref, query, limit }) => {
    const video = resolveLoaded(ref)
    if ('error' in video) return fail(video.error)
    const said = searchSegments(video.segments, query, limit ?? 10)
    const shown = searchScreen(video.manifest.frames, query, fold, limit ?? 10)
    if (said.length === 0 && shown.length === 0) return text(`"${query}" is not found in the transcript or on screen. Try other words or a synonym.`)
    const parts: string[] = []
    if (said.length > 0) parts.push(`Said:\n${said.map((h) => `[${formatTime(h.start)}–${formatTime(h.end)}] ${h.text}`).join('\n\n')}`)
    if (shown.length > 0) parts.push(`On screen:\n${shown.map((h) => `[${formatTime(h.time)}] ${h.text}`).join('\n\n')}`)
    return text(parts.join('\n\n'))
  }
)

server.registerTool(
  'get_frames',
  {
    description: `Key frames of a processed video as images, to see what the screen shows (code, forms, diagrams). Either the frames around one time ("at"), or spread over a range ("from"/"to"). At most ${MAX_FRAMES}.`,
    inputSchema: {
      videoId: VIDEO,
      at: z.string().optional().describe('A time, e.g. "23:10": the frames closest to it.'),
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.number().int().min(1).max(MAX_FRAMES).optional()
    }
  },
  async ({ videoId: ref, at, from, to, limit }) => {
    const video = resolveLoaded(ref)
    if ('error' in video) return fail(video.error)
    const count = limit ?? 4
    const atTime = parseTime(at)
    const frames =
      atTime !== null
        ? framesAround(video.manifest.frames, atTime, count)
        : framesBetween(video.manifest.frames, parseTime(from) ?? 0, parseTime(to) ?? Number.POSITIVE_INFINITY, count)
    if (frames.length === 0) return text('No key frame in that range.')
    const content: Content[] = []
    for (const frame of frames) {
      const onScreen = frame.text ? `\nText on screen (OCR, may have errors):\n${frame.text.slice(0, 1500)}` : ''
      content.push({ type: 'text', text: `Frame at ${formatTime(frame.time)}:${onScreen}` })
      content.push({ type: 'image', mimeType: 'image/jpeg', data: readFileSync(join(video.dir, frame.file)).toString('base64') })
    }
    return { content }
  }
)

server.registerTool(
  'get_screen',
  {
    description: `The screen at exact times, taken from the video file: any moment, not only the key frames. Use it to read what changes little by little between key frames — code or text being typed, a form being filled, a dialog — or when the key frames around a time do not show what was said. At most ${MAX_FRAMES} times per call.`,
    inputSchema: {
      videoId: VIDEO,
      at: z.union([z.string(), z.array(z.string()).min(1).max(MAX_FRAMES)]).describe('A time like "3:15", or several: ["3:05", "3:15", "3:25"].')
    }
  },
  async ({ videoId: ref, at }) => {
    const video = resolveLoaded(ref)
    if ('error' in video) return fail(video.error)
    const id = video.id
    const times = (Array.isArray(at) ? at : [at]).map((t) => parseTime(t))
    if (times.some((t) => t === null)) return fail('Times look like "3:15", "1:02:03" or a number of seconds.')
    const content: Content[] = []
    try {
      for (const time of times as number[]) {
        const screen = await screenAt(id, time)
        const onScreen = screen.text ? `\nText on screen (OCR, may have errors):\n${screen.text.slice(0, 1500)}` : ''
        content.push({ type: 'text', text: `Screen at ${formatTime(screen.time)}:${onScreen}` })
        content.push({ type: 'image', mimeType: 'image/jpeg', data: readFileSync(join(video.dir, screen.file)).toString('base64') })
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    return { content }
  }
)

server.registerTool(
  'list_frames',
  { description: 'The times of every key frame of a processed video (to choose which to look at).', inputSchema: { videoId: VIDEO } },
  async ({ videoId: ref }) => {
    const video = resolveLoaded(ref)
    if ('error' in video) return fail(video.error)
    return text(video.manifest.frames.map((f) => formatTime(f.time)).join(', '))
  }
)

server.registerTool(
  'search_videos',
  {
    description:
      'Find something across every processed video at once: which videos say it or show it on screen, and when. Use it to answer "in which meeting did they talk about…". Every word of the query must appear (accents and case aside), so search one or two key words in the form spoken ("table", not "HTML tables"), and one topic per call. Then read a video with get_transcript or search_transcript.',
    inputSchema: {
      query: z.string(),
      limit: z.number().int().min(1).max(20).optional().describe('Hits per video (default 5).'),
      folder: z.string().optional().describe('Only the videos in this folder (and its subfolders).'),
      tag: z.string().optional().describe('Only the videos with this tag.')
    }
  },
  async ({ query, limit, folder, tag }) => {
    const found = searchLibrary(query, limit ?? 5, { folder, tag })
    const scope = `${folder ? ` in "${folder}"` : ''}${tag ? ` tagged #${tag.replace(/^#/, '')}` : ''}`
    if (found.length === 0) return text(`"${query}" is not found in any processed video${scope}. Try other words or a synonym.`)
    return text(
      found
        .map((v) => {
          const lines = [
            ...v.said.map((h) => `[${formatTime(h.start)}–${formatTime(h.end)}] ${h.text}`),
            ...v.shown.map((h) => `[${formatTime(h.time)}] (on screen) ${h.text}`)
          ]
          return `## ${v.title} (video ${v.id}, ${formatTime(v.duration)})\n${lines.join('\n')}`
        })
        .join('\n\n')
    )
  }
)

await server.connect(new StdioServerTransport())
