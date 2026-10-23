import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { cleanChapters, readNotes, searchLibrary, writeNotes } from '../src/library.js'
import { parseTime } from '../src/time.js'

describe('chapters', () => {
  it('orders them, drops the invalid and the repeated, and starts at 0', () => {
    const chapters = cleanChapters(
      [
        { start: '2:00', title: 'Tablas', summary: ' Filas y columnas. ' },
        { start: '0:05', title: 'Inicio' },
        { start: '2:00', title: 'Otra vez' },
        { start: 'ayer', title: 'Mal' },
        { start: '99:00', title: 'Después del final' },
        { start: '3:00', title: '  ' }
      ],
      600,
      parseTime
    )
    expect(chapters).toEqual([
      { start: 0, title: 'Inicio', summary: undefined },
      { start: 120, title: 'Tablas', summary: 'Filas y columnas.' }
    ])
  })
})

describe('library', () => {
  const previous = process.env.VIDEO_CONTEXT_HOME
  const home = mkdtempSync(join(tmpdir(), 'vc-library-'))

  function video(id: string, title: string, texts: string[], screen?: string): string {
    const dir = join(home, 'videos', id)
    mkdirSync(dir, { recursive: true })
    const frames = screen ? [{ file: 'frames/00010s-00001.jpg', time: 10, text: screen }] : []
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, id, source: `/v/${title}.mp4`, title, duration: 100, language: 'es', model: 'small', createdAt: `2026-10-2${id.at(-1)}T00:00:00Z`, segments: texts.length, frames }))
    writeFileSync(join(dir, 'transcript.json'), JSON.stringify(texts.map((text, i) => ({ start: i * 10, end: i * 10 + 10, text }))))
    return dir
  }

  beforeAll(() => {
    process.env.VIDEO_CONTEXT_HOME = home
    video('aaaaaaaaaaaaaaa1', 'Daily', ['Revisamos las facturas pendientes.', 'Nada más.'])
    video('aaaaaaaaaaaaaaa2', 'Capacitación', ['Hoy vemos tablas.', 'Cada factura se valida con el token.'], 'https://facturas.example.com')
    video('aaaaaaaaaaaaaaa3', 'Otra', ['Sin relación.'])
  })
  afterAll(() => {
    if (previous === undefined) delete process.env.VIDEO_CONTEXT_HOME
    else process.env.VIDEO_CONTEXT_HOME = previous
  })

  it('searches every video, said and on screen, accents aside', () => {
    const found = searchLibrary('facturas')
    expect(found.map((v) => v.title)).toEqual(['Capacitación', 'Daily'])
    expect(found[0].shown).toHaveLength(1)
    expect(found[1].said[0].start).toBe(0)
    expect(searchLibrary('capacitacion')).toEqual([])
    expect(searchLibrary('nada que ver')).toEqual([])
  })

  it('keeps notes in time order', () => {
    const dir = join(home, 'videos', 'aaaaaaaaaaaaaaa1')
    expect(readNotes(dir)).toEqual([])
    writeNotes(dir, [
      { id: 'b', time: 30, text: 'después', createdAt: 'x' },
      { id: 'a', time: 5, text: '', createdAt: 'x' }
    ])
    expect(readNotes(dir).map((n) => n.id)).toEqual(['a', 'b'])
  })
})
