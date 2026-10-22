import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { assignSpeakers, parseRecording, readRecording, speakerNames, type SpeakerTurn } from '../src/recording.js'
import { rangeText, searchSegments, toMarkdown, toSrt, type Segment } from '../src/transcript.js'

const segments: Segment[] = [
  { start: 0, end: 4, text: 'Buenos días, empezamos.' },
  { start: 4, end: 10, text: 'Hoy revisamos el motor de pagos.' },
  { start: 30, end: 32, text: 'Silencio largo antes de esto.' }
]

const turn = (name: string, start: number, end: number, source = 'captions'): SpeakerTurn => ({ name, start, end, source })

describe('recording file', () => {
  it('parses the known schemas and keeps only valid turns', () => {
    const r = parseRecording({
      schema: 'video-context-recording/1',
      title: ' Daily ',
      recordingStartedAt: '2026-10-22T16:00:00.000Z',
      speakers: [turn('Ana', 0, 5), { name: '', start: 1, end: 2 }, { name: 'Bad', start: 5, end: 1 }]
    })
    expect(r?.title).toBe('Daily')
    expect(r?.speakers).toEqual([turn('Ana', 0, 5)])
    expect(parseRecording({ schema: 'meetily-recording/1' })?.speakers).toEqual([])
    expect(parseRecording({ schema: 'other' })).toBeNull()
    expect(parseRecording(null)).toBeNull()
  })

  it('reads <name>.json next to the video', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-rec-'))
    const video = join(dir, 'meeting.webm')
    expect(readRecording(video)).toBeNull()
    writeFileSync(join(dir, 'meeting.json'), JSON.stringify({ schema: 'meetily-recording/1', title: 'Daily', speakers: [turn('Ana', 0, 1)] }))
    expect(readRecording(video)?.title).toBe('Daily')
    writeFileSync(join(dir, 'meeting.json'), 'not json')
    expect(readRecording(video)).toBeNull()
  })
})

describe('assignSpeakers', () => {
  it('picks the speaker with the most overlap, or the nearest turn within 2 s', () => {
    const named = assignSpeakers(segments, [turn('Ana', 0, 5), turn('Carlos', 5, 12), turn('Ana', 12.5, 13)])
    expect(named.map((s) => s.speaker)).toEqual(['Ana', 'Carlos', undefined])
    expect(speakerNames(named)).toEqual(['Ana', 'Carlos'])

    // Captions lag the audio: no overlap, but 0.5 s away.
    expect(assignSpeakers([{ start: 10, end: 12, text: 'x' }], [turn('Ana', 12.5, 15)])[0].speaker).toBe('Ana')
  })

  it('prefers caption turns over the audio-level indicator', () => {
    const seg: Segment[] = [{ start: 10, end: 12, text: 'x' }]
    expect(assignSpeakers(seg, [turn('Indicador', 10, 12, 'indicator'), turn('Ana', 12.5, 15)])[0].speaker).toBe('Ana')
    expect(assignSpeakers(seg, [turn('Indicador', 10, 12, 'indicator')])[0].speaker).toBe('Indicador')
    expect(assignSpeakers(seg, [])).toBe(seg)
  })
})

describe('transcript with speakers', () => {
  const named = assignSpeakers(segments, [turn('Ana', 0, 5), turn('Carlos', 5, 12)])

  it('prefixes lines with the speaker', () => {
    expect(rangeText(named, 0, 20)).toBe('[0:00] Ana: Buenos días, empezamos.\n[0:04] Carlos: Hoy revisamos el motor de pagos.')
    expect(toSrt(named.slice(0, 1))).toContain('Ana: Buenos días')
  })

  it('starts a new paragraph when someone else speaks', () => {
    const md = toMarkdown(named, 'Daily')
    expect(md).toContain('**[0:00]** **Ana:** Buenos días, empezamos.')
    expect(md).toContain('**[0:04]** **Carlos:** Hoy revisamos el motor de pagos.')
  })

  it('finds a speaker by name together with the words', () => {
    const hits = searchSegments(named, 'carlos pagos')
    expect(hits).toHaveLength(1)
    expect(hits[0].text).toContain('Carlos: Hoy revisamos')
  })

  it('leaves transcripts without speakers as they were', () => {
    expect(rangeText(segments, 0, 4)).toBe('[0:00] Buenos días, empezamos.')
    expect(toMarkdown(segments, 'T')).toContain('**[0:00]** Buenos días, empezamos. Hoy revisamos el motor de pagos.')
  })
})

describe('duration of a browser recording', () => {
  it('takes the last time of an ffmpeg progress log', async () => {
    const { lastProgressTime } = await import('../src/process.js')
    expect(lastProgressTime('size=0kB time=00:00:00.00 bitrate=N/A\nsize=1144kB time=00:00:16.85 bitrate=556')).toBe(16.85)
    expect(lastProgressTime('time=01:02:03.5')).toBe(3723.5)
    expect(lastProgressTime('nothing here')).toBeNull()
  })
})
