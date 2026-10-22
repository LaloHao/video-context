// Recording metadata written next to a video by a recorder (browser extension,
// meeting bot): `meeting.webm` + `meeting.json`. It carries the meeting title, when
// the recording started, and who was speaking when — the transcript then says who
// said each thing.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, basename, join } from 'node:path'

import type { Segment } from './transcript.js'

/** Schema ids of a recording file; `meetily-recording/1` is the original name. */
export const RECORDING_SCHEMAS = ['video-context-recording/1', 'meetily-recording/1']

/** A span of time, in seconds from the start of the video, during which someone spoke. */
export interface SpeakerTurn {
  name: string
  start: number
  end: number
  /** `captions` (the meeting's live captions) or `indicator` (a tile's audio-level animation). */
  source?: string
}

export interface Recording {
  schema: string
  title?: string
  url?: string
  recordingStartedAt?: string
  speakers: SpeakerTurn[]
}

/** The recording file next to `videoPath` (same name, `.json`), or null when there is none. */
export function readRecording(videoPath: string): Recording | null {
  const path = join(dirname(videoPath), `${basename(videoPath, extname(videoPath))}.json`)
  if (!existsSync(path)) return null
  try {
    return parseRecording(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

export function parseRecording(raw: unknown): Recording | null {
  const r = raw as Partial<Recording> | null
  if (!r || typeof r.schema !== 'string' || !RECORDING_SCHEMAS.includes(r.schema)) return null
  const speakers = (Array.isArray(r.speakers) ? r.speakers : []).filter(
    (t): t is SpeakerTurn =>
      typeof t?.name === 'string' && t.name.trim() !== '' && Number.isFinite(t.start) && Number.isFinite(t.end) && t.end >= t.start
  )
  return {
    schema: r.schema,
    title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : undefined,
    url: typeof r.url === 'string' ? r.url : undefined,
    recordingStartedAt: typeof r.recordingStartedAt === 'string' ? r.recordingStartedAt : undefined,
    speakers
  }
}

/** Turns further than this from a segment can't be attributed to it. */
const MAX_GAP_SECONDS = 2

/**
 * Each segment with the speaker whose turns overlap it the most; when none
 * overlaps (captions lag the audio a little), the nearest turn within 2 s.
 * Caption turns are more reliable than the audio-level indicator, so indicator
 * turns are used only when there are no caption turns at all.
 */
export function assignSpeakers(segments: Segment[], turns: SpeakerTurn[]): Segment[] {
  const hasCaptions = turns.some((t) => t.source === 'captions')
  const usable = turns.filter((t) => !hasCaptions || t.source === 'captions')
  if (usable.length === 0) return segments
  return segments.map((segment) => {
    const overlap = new Map<string, number>()
    for (const turn of usable) {
      const o = Math.min(segment.end, turn.end) - Math.max(segment.start, turn.start)
      if (o > 0) overlap.set(turn.name, (overlap.get(turn.name) ?? 0) + o)
    }
    let speaker = [...overlap].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (!speaker) {
      const gap = (t: SpeakerTurn): number => (t.end < segment.start ? segment.start - t.end : t.start - segment.end)
      speaker = usable
        .filter((t) => gap(t) <= MAX_GAP_SECONDS)
        .sort((a, b) => gap(a) - gap(b))[0]?.name
    }
    return speaker ? { ...segment, speaker } : segment
  })
}

/** The people who spoke, in order of first appearance in the segments. */
export function speakerNames(segments: Segment[]): string[] {
  return [...new Set(segments.map((s) => s.speaker).filter((s): s is string => Boolean(s)))]
}
