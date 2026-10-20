/** A key frame on disk and when it shows in the video. */
export interface Frame {
  file: string
  time: number
  /** Text on screen (OCR), when it ran and found some. */
  text?: string
}

/**
 * The time of each frame ffmpeg wrote, in order, from its `showinfo` log
 * (`… n:   3 pts: 1234 pts_time:41.2 …`).
 */
export function parseShowinfoTimes(log: string): number[] {
  const times: number[] = []
  for (const match of log.matchAll(/\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:(-?[\d.]+)/g)) {
    const t = Number(match[1])
    if (Number.isFinite(t)) times.push(Math.max(0, t))
  }
  return times
}

/** The ffmpeg `select` expression: a scene change above `threshold`, or one frame every `everySeconds`. */
export function selectExpression(threshold: number, everySeconds: number): string {
  return `gt(scene\\,${threshold})+isnan(prev_selected_t)+gte(t-prev_selected_t\\,${everySeconds})`
}

/** Frames in `[from, to]`, at most `limit`, spread evenly from the first to the last. */
export function framesBetween(frames: Frame[], from: number, to: number, limit: number): Frame[] {
  const inside = frames.filter((f) => f.time >= from && f.time <= to)
  if (inside.length <= limit) return inside
  if (limit === 1) return [inside[0]]
  return Array.from({ length: limit }, (_, i) => inside[Math.round((i * (inside.length - 1)) / (limit - 1))])
}

/** The `limit` frames closest to `time`, in time order. */
export function framesAround(frames: Frame[], time: number, limit: number): Frame[] {
  return [...frames]
    .sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time))
    .slice(0, limit)
    .sort((a, b) => a.time - b.time)
}

export interface ScreenHit {
  time: number
  file: string
  /** The OCR lines that contain the words. */
  text: string
}

/** Frames whose on-screen text has every word of the query (accents and case aside), in time order. */
export function searchScreen(frames: readonly Frame[], query: string, fold: (s: string) => string, limit = 10): ScreenHit[] {
  const words = fold(query).split(/\s+/).filter((w) => w.length > 1)
  if (words.length === 0) return []
  const hits: ScreenHit[] = []
  let lastText = ''
  for (const frame of frames) {
    if (!frame.text) continue
    const folded = fold(frame.text)
    if (!words.every((w) => folded.includes(w))) continue
    const lines = frame.text.split('\n').filter((l) => words.some((w) => fold(l).includes(w)))
    const text = lines.join('\n')
    // The same screen across several frames: once is enough.
    if (text === lastText) continue
    lastText = text
    hits.push({ time: frame.time, file: frame.file, text })
    if (hits.length >= limit) break
  }
  return hits
}
