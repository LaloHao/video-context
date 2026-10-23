// Across every processed video: search them all at once, and the extras the
// web page keeps next to a video's results (chapters, the user's notes).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { searchScreen, type ScreenHit } from './frames.js'
import { listVideos, loadVideo } from './process.js'
import { fold, searchSegments, type SearchHit } from './transcript.js'

export interface LibraryHit {
  id: string
  title: string
  duration: number
  said: SearchHit[]
  shown: ScreenHit[]
}

/** Where `query` is said or shown in each processed video, the videos with most hits first. */
export function searchLibrary(query: string, limitPerVideo = 5): LibraryHit[] {
  const hits: LibraryHit[] = []
  for (const manifest of listVideos()) {
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
