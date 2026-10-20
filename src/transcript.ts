import { formatTime } from './time.js'

/** One timestamped piece of speech. */
export interface Segment {
  start: number
  end: number
  text: string
}

/**
 * Segments from whisper.cpp's `--output-json` (`-oj`) file: `transcription[]`
 * with `offsets.from/to` in milliseconds. Blank pieces and whisper's
 * `[BLANK_AUDIO]`-style markers are dropped.
 */
export function parseWhisperJson(raw: unknown): Segment[] {
  const list = (raw as { transcription?: unknown })?.transcription
  if (!Array.isArray(list)) throw new Error('Not a whisper.cpp JSON transcript (no "transcription" list).')
  const segments: Segment[] = []
  for (const item of list) {
    const offsets = (item as { offsets?: { from?: unknown; to?: unknown } }).offsets
    const text = String((item as { text?: unknown }).text ?? '').trim()
    if (!text || /^\[[A-Z_ ]+\]$/.test(text) || /^\(.*\)$/.test(text)) continue
    const from = Number(offsets?.from)
    const to = Number(offsets?.to)
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue
    segments.push({ start: from / 1000, end: to / 1000, text })
  }
  return segments
}

/** Lower case without accents: "Sesión" and "sesion" match. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/**
 * The transcript as paragraphs of about `paragraphSeconds`, each starting with
 * its time: what a person (or an agent) reads.
 */
export function toMarkdown(segments: Segment[], title: string, paragraphSeconds = 45): string {
  const lines = [`# ${title}`, '']
  let paragraph: Segment[] = []
  const flush = (): void => {
    if (paragraph.length === 0) return
    lines.push(`**[${formatTime(paragraph[0].start)}]** ${paragraph.map((s) => s.text).join(' ')}`, '')
    paragraph = []
  }
  for (const segment of segments) {
    if (paragraph.length > 0 && segment.start - paragraph[0].start >= paragraphSeconds) flush()
    paragraph.push(segment)
  }
  flush()
  return lines.join('\n')
}

function srtTime(seconds: number): string {
  const ms = Math.round(seconds * 1000)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const rest = ms % 1000
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(rest, 3)}`
}

export function toSrt(segments: Segment[]): string {
  return segments.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}\n`).join('\n')
}

/** The segments that overlap `[from, to)`, one `[m:ss] text` line each. */
export function rangeText(segments: Segment[], from = 0, to = Number.POSITIVE_INFINITY): string {
  return segments
    .filter((s) => s.end > from && s.start < to)
    .map((s) => `[${formatTime(s.start)}] ${s.text}`)
    .join('\n')
}

export interface SearchHit {
  start: number
  end: number
  /** The matching segment with the one before and after, for context. */
  text: string
  score: number
}

/**
 * Segments that contain the query's words (accents and case aside), best
 * first: every word must appear in the segment or its neighbours; an exact
 * phrase scores higher. Overlapping hits are merged.
 */
export function searchSegments(segments: Segment[], query: string, limit = 10): SearchHit[] {
  const words = fold(query).split(/\s+/).filter((w) => w.length > 1)
  if (words.length === 0) return []
  const phrase = fold(query).trim()
  const hits: SearchHit[] = []
  segments.forEach((segment, i) => {
    const window = segments.slice(Math.max(0, i - 1), i + 2)
    const own = fold(segment.text)
    const around = fold(window.map((s) => s.text).join(' '))
    if (!words.every((w) => around.includes(w))) return
    const inOwn = words.filter((w) => own.includes(w)).length
    if (inOwn === 0) return
    const score = inOwn / words.length + (around.includes(phrase) ? 1 : 0)
    hits.push({ start: window[0].start, end: window[window.length - 1].end, text: window.map((s) => s.text).join(' '), score })
  })
  hits.sort((a, b) => b.score - a.score || a.start - b.start)
  const kept: SearchHit[] = []
  for (const hit of hits) {
    if (kept.some((k) => hit.start < k.end && k.start < hit.end)) continue
    kept.push(hit)
    if (kept.length >= limit) break
  }
  return kept.sort((a, b) => a.start - b.start)
}
