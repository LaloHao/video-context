// Across every processed video: search them all at once, and the extras the
// web page keeps next to a video's results (chapters, the user's notes).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { searchScreen, type ScreenHit } from './frames.js'
import { hasTag, inFolder } from './labels.js'
import { listVideos, loadVideo, type Manifest } from './process.js'
import { fold, searchSegments, type SearchHit } from './transcript.js'

export interface LibraryHit {
  id: string
  title: string
  duration: number
  said: SearchHit[]
  shown: ScreenHit[]
}

/** Which videos: those in a folder (and its subfolders), with a tag, or both. */
export interface VideoFilter {
  folder?: string
  tag?: string
}

/** The processed videos that pass `filter`, newest first. */
export function findVideos(filter: VideoFilter = {}): Manifest[] {
  return listVideos().filter((m) => (!filter.folder || inFolder(m.folder, filter.folder)) && (!filter.tag || hasTag(m.tags, filter.tag)))
}

/** A video's line in a list: "Name" (folder · #tag) — id, length. */
export function describeVideo(m: Manifest): string {
  const where = [m.folder, ...(m.tags ?? []).map((t) => `#${t}`)].filter(Boolean).join(' · ')
  return `"${m.title}"${where ? ` (${where})` : ''} — ${m.id}`
}

/**
 * A video by what someone calls it: its id, its name, or words that only one video's
 * name, original title, file name, folder or tags have. Several matches, or none, say
 * which videos there are, to ask.
 */
export function resolveVideo(ref: string): { id: string } | { error: string } {
  const wanted = String(ref ?? '').trim()
  if (/^[0-9a-f]{16}$/.test(wanted) && loadVideo(wanted)) return { id: wanted }
  const all = listVideos()
  const q = fold(wanted)
  const exact = all.filter((m) => fold(m.title) === q || (m.processedTitle && fold(m.processedTitle) === q))
  if (exact.length === 1) return { id: exact[0].id }
  const words = q.split(/\s+/).filter(Boolean)
  const found = exact.length > 1 ? exact : all.filter((m) => {
    const haystack = fold([m.title, m.processedTitle, basename(m.source), m.folder, ...(m.tags ?? [])].filter(Boolean).join(' '))
    return words.length > 0 && words.every((w) => haystack.includes(w))
  })
  if (found.length === 1) return { id: found[0].id }
  const list = (videos: Manifest[]): string => videos.slice(0, 15).map((m) => `- ${describeVideo(m)}`).join('\n')
  if (found.length > 1) return { error: `"${wanted}" matches ${found.length} videos: say which one (more of its name, or its id).\n${list(found)}` }
  return { error: all.length ? `No video is called "${wanted}". The videos:\n${list(all)}` : 'No video has been processed yet.' }
}

/** Where `query` is said or shown in each processed video (of `filter`), the videos with most hits first. */
export function searchLibrary(query: string, limitPerVideo = 5, filter: VideoFilter = {}): LibraryHit[] {
  const hits: LibraryHit[] = []
  for (const manifest of findVideos(filter)) {
    const video = loadVideo(manifest.id)
    if (!video) continue
    const said = searchSegments(video.segments, query, limitPerVideo)
    const shown = searchScreen(video.manifest.frames, query, fold, limitPerVideo)
    if (said.length || shown.length) hits.push({ id: manifest.id, title: manifest.title, duration: manifest.duration, said, shown })
  }
  return hits.sort((a, b) => b.said.length + b.shown.length - (a.said.length + a.shown.length))
}

/** A part of a video, from `start` (seconds) to the next chapter. */
export interface Chapter {
  start: number
  title: string
  summary?: string
}

/** Something the user marked at a time of a video; an empty text is a bookmark. */
export interface Note {
  id: string
  time: number
  text: string
  createdAt: string
}

function readList<T>(dir: string, name: string): T[] {
  const file = join(dir, name)
  if (!existsSync(file)) return []
  try {
    const list = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return Array.isArray(list) ? (list as T[]) : []
  } catch {
    return []
  }
}

export const readChapters = (dir: string): Chapter[] => readList<Chapter>(dir, 'chapters.json')
export const readNotes = (dir: string): Note[] => readList<Note>(dir, 'notes.json')

export function writeChapters(dir: string, chapters: Chapter[]): void {
  writeFileSync(join(dir, 'chapters.json'), JSON.stringify(chapters, null, 2))
}

export function writeNotes(dir: string, notes: Note[]): void {
  writeFileSync(join(dir, 'notes.json'), JSON.stringify([...notes].sort((a, b) => a.time - b.time), null, 2))
}

/** Chapters as a model returns them (`start` as "m:ss" or seconds), cleaned: in order, inside the video, the first at 0. */
export function cleanChapters(raw: { start: string | number; title: string; summary?: string }[], duration: number, parse: (t: string | number) => number | null): Chapter[] {
  const chapters = raw
    .map((c) => ({ start: parse(c.start) ?? -1, title: String(c.title ?? '').trim(), summary: c.summary ? String(c.summary).trim() : undefined }))
    .filter((c) => c.start >= 0 && c.start <= duration && Boolean(c.title))
    .sort((a, b) => a.start - b.start)
    .filter((c, i, list) => i === 0 || c.start - list[i - 1].start >= 1)
  if (chapters.length) chapters[0].start = 0
  return chapters
}
