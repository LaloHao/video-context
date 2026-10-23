import { describe, expect, it } from 'vitest'

import { framesAround, framesBetween, parseShowinfoTimes, selectExpression } from '../src/frames.js'
import { formatTime, parseTime } from '../src/time.js'
import { fold, parseMlxJson, parseWhisperJson, rangeText, searchSegments, toMarkdown, toSrt, type Segment } from '../src/transcript.js'

describe('time', () => {
  it('formats and parses', () => {
    expect(formatTime(5)).toBe('0:05')
    expect(formatTime(754.9)).toBe('12:34')
    expect(formatTime(3723)).toBe('1:02:03')
    expect(parseTime('1:02:03')).toBe(3723)
    expect(parseTime('62:03')).toBe(3723)
    expect(parseTime('90.5')).toBe(90.5)
    expect(parseTime(12)).toBe(12)
    expect(parseTime('ayer')).toBeNull()
    expect(parseTime('')).toBeNull()
  })
})

const whisper = {
  transcription: [
    { offsets: { from: 0, to: 4000 }, text: ' Bienvenidos a la sesión del motor de pagos.' },
    { offsets: { from: 4000, to: 6000 }, text: ' [BLANK_AUDIO]' },
    { offsets: { from: 6000, to: 9000 }, text: ' Primero generamos la referencia' },
    { offsets: { from: 9000, to: 12000 }, text: ' con el folio de la infracción.' },
    { offsets: { from: 60000, to: 64000 }, text: ' Después se valida el token.' }
  ]
}

describe('transcript', () => {
  const segments: Segment[] = parseWhisperJson(whisper)

  it('parses whisper.cpp JSON, dropping blank markers', () => {
    expect(segments).toHaveLength(4)
    expect(segments[0]).toEqual({ start: 0, end: 4, text: 'Bienvenidos a la sesión del motor de pagos.' })
    expect(() => parseWhisperJson({})).toThrow(/whisper/)
  })

  it('parses mlx_whisper JSON the same way', () => {
    const mlx = {
      text: '…',
      language: 'es',
      segments: whisper.transcription.map((t, id) => ({ id, start: t.offsets.from / 1000, end: t.offsets.to / 1000, text: t.text, no_speech_prob: 0.1 }))
    }
    expect(parseMlxJson(mlx)).toEqual(segments)
    expect(() => parseMlxJson(whisper)).toThrow(/mlx_whisper/)
  })

  it('renders Markdown paragraphs with their time, SRT and ranges', () => {
    const md = toMarkdown(segments, 'Motor', 45)
    expect(md).toContain('**[0:00]** Bienvenidos')
    expect(md).toContain('**[1:00]** Después se valida el token.')
    expect(toSrt(segments)).toContain('00:00:06,000 --> 00:00:09,000')
    expect(rangeText(segments, 5, 13)).toBe('[0:06] Primero generamos la referencia\n[0:09] con el folio de la infracción.')
  })

  it('searches ignoring accents and case, with context, merging overlaps', () => {
    expect(fold('Sesión')).toBe('sesion')
    const hits = searchSegments(segments, 'FOLIO infraccion')
    expect(hits).toHaveLength(1)
    expect(hits[0].start).toBe(6)
    expect(hits[0].text).toContain('con el folio de la infracción.')
    expect(searchSegments(segments, 'token')[0].start).toBe(9)
    expect(searchSegments(segments, 'inexistente')).toEqual([])
  })
})

describe('frames', () => {
  it('reads the frame times from the showinfo log', () => {
    const log = '[Parsed_showinfo_1 @ 0x1] n:   0 pts:      0 pts_time:0       duration:1\n[Parsed_showinfo_1 @ 0x1] n:   1 pts: 123456 pts_time:41.152  duration:1'
    expect(parseShowinfoTimes(log)).toEqual([0, 41.152])
    expect(selectExpression(0.3, 60)).toBe('gt(scene\\,0.3)+isnan(prev_selected_t)+gte(t-prev_selected_t\\,60)')
  })

  it('picks frames around a time or spread over a range', () => {
    const frames = [0, 30, 60, 90, 120, 150].map((time) => ({ file: `f${time}.jpg`, time }))
    expect(framesAround(frames, 95, 2).map((f) => f.time)).toEqual([90, 120])
    expect(framesBetween(frames, 30, 150, 3).map((f) => f.time)).toEqual([30, 90, 150])
    expect(framesBetween(frames, 0, 60, 5).map((f) => f.time)).toEqual([0, 30, 60])
  })
})
