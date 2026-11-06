import { createWriteStream, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { exportArchive, importArchive } from '../src/export.js'
import { cleanFolder, cleanLabels, cleanTags, hasTag, inFolder, readLabels, writeLabels } from '../src/labels.js'
import { findVideos, resolveVideo, searchLibrary } from '../src/library.js'
import { loadVideo } from '../src/process.js'
import { writeZip } from '../src/zip.js'

describe('labels, tidied', () => {
  it('folders', () => {
    expect(cleanFolder(' / Posgrado //  Clases  de  redes/ ')).toBe('Posgrado/Clases de redes')
    expect(cleanFolder('a\\b')).toBe('a/b')
    expect(cleanFolder('  ')).toBeUndefined()
    expect(cleanFolder(3)).toBeUndefined()
  })

  it('tags', () => {
    expect(cleanTags(['#Redes', 'redes', ' examen ', '', 7])).toEqual(['Redes', 'examen'])
    expect(cleanTags('a, b ,#a')).toEqual(['a', 'b'])
    expect(cleanLabels({ title: '  Clase   3 ', folder: '', tags: [] })).toEqual({ title: 'Clase 3', tags: [] })
  })

  it('folders inside folders, and tags, case aside', () => {
    expect(inFolder('Posgrado/Clases', 'posgrado')).toBe(true)
    expect(inFolder('Posgrado/Clases', 'Posgrado/Clases/')).toBe(true)
    expect(inFolder('Posgrado2', 'Posgrado')).toBe(false)
    expect(inFolder(undefined, 'Posgrado')).toBe(false)
    expect(inFolder(undefined, '')).toBe(true)
    expect(hasTag(['Redes'], '#redes')).toBe(true)
    expect(hasTag(undefined, 'x')).toBe(false)
  })
})

describe('videos by name, folder and tag', () => {
  const previous = process.env.VIDEO_CONTEXT_HOME
  const home = mkdtempSync(join(tmpdir(), 'vc-labels-'))
  const dirOf = (id: string): string => join(home, 'videos', id)

  function video(id: string, title: string, texts: string[], day: number): void {
    const dir = dirOf(id)
    mkdirSync(join(dir, 'frames'), { recursive: true })
    const source = join(home, `${title}.webm`)
    writeFileSync(source, 'video bytes')
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, id, source, title, duration: 60, language: 'es', model: 'small', createdAt: `2026-11-0${day}T00:00:00Z`, segments: texts.length, frames: [] }))
    writeFileSync(join(dir, 'transcript.json'), JSON.stringify(texts.map((text, i) => ({ start: i * 10, end: i * 10 + 10, text }))))
  }

  beforeAll(() => {
    process.env.VIDEO_CONTEXT_HOME = home
    video('aaaaaaaaaaaaaaa1', '2026-10-29_18-19-05_Posgrado Teams', ['Hoy vemos ruteo.'], 1)
    video('aaaaaaaaaaaaaaa2', '2026-10-30_18-00-00_Posgrado Teams', ['Repaso de ruteo para el examen.'], 2)
    video('aaaaaaaaaaaaaaa3', 'Daily', ['Revisamos el ruteo de tickets.'], 3)
    writeLabels(dirOf('aaaaaaaaaaaaaaa1'), { title: 'Clase 3: ruteo', folder: 'Posgrado/Redes', tags: ['clase'] })
    writeLabels(dirOf('aaaaaaaaaaaaaaa2'), { title: 'Clase 4: repaso', folder: 'Posgrado/Redes', tags: ['clase', 'examen'] })
    writeLabels(dirOf('aaaaaaaaaaaaaaa3'), { folder: 'Trabajo', tags: [] })
  })
  afterAll(() => {
    if (previous === undefined) delete process.env.VIDEO_CONTEXT_HOME
    else process.env.VIDEO_CONTEXT_HOME = previous
  })

  it('reads the name, folder and tags with the video, over the processed title', () => {
    const m = loadVideo('aaaaaaaaaaaaaaa1')!.manifest
    expect(m).toMatchObject({ title: 'Clase 3: ruteo', processedTitle: '2026-10-29_18-19-05_Posgrado Teams', folder: 'Posgrado/Redes', tags: ['clase'] })
    expect(loadVideo('aaaaaaaaaaaaaaa3')!.manifest).toMatchObject({ title: 'Daily', folder: 'Trabajo' })
  })

  it('finds a video by its id, name, words of it, folder or tags', () => {
    expect(resolveVideo('aaaaaaaaaaaaaaa3')).toEqual({ id: 'aaaaaaaaaaaaaaa3' })
    expect(resolveVideo('clase 3: RUTEO')).toEqual({ id: 'aaaaaaaaaaaaaaa1' })
    expect(resolveVideo('repaso')).toEqual({ id: 'aaaaaaaaaaaaaaa2' })
    expect(resolveVideo('examen')).toEqual({ id: 'aaaaaaaaaaaaaaa2' })
    expect(resolveVideo('trabajo')).toEqual({ id: 'aaaaaaaaaaaaaaa3' })
    // The file's original title still works.
    expect(resolveVideo('2026-10-29_18-19-05_Posgrado Teams')).toEqual({ id: 'aaaaaaaaaaaaaaa1' })
  })

  it('says which videos it could be, or that there is none', () => {
    const several = resolveVideo('posgrado clase')
    const message = 'error' in several ? several.error : ''
    expect(message).toMatch(/matches 2 videos/)
    expect(message).toContain('"Clase 3: ruteo" (Posgrado/Redes · #clase) — aaaaaaaaaaaaaaa1')
    expect(message).toContain('"Clase 4: repaso"')
    const none = resolveVideo('nada que ver')
    expect('error' in none && none.error).toMatch(/No video is called "nada que ver"[\s\S]*Daily/)
  })

  it('lists and searches by folder and tag', () => {
    expect(findVideos({ folder: 'posgrado' }).map((m) => m.id).sort()).toEqual(['aaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaa2'])
    expect(findVideos({ tag: 'examen' }).map((m) => m.id)).toEqual(['aaaaaaaaaaaaaaa2'])
    expect(searchLibrary('ruteo').map((v) => v.id)).toHaveLength(3)
    expect(searchLibrary('ruteo', 5, { folder: 'Posgrado' }).map((v) => v.title).sort()).toEqual(['Clase 3: ruteo', 'Clase 4: repaso'])
  })

  it('keeps no file when nothing is left, and goes back to the processed title', () => {
    writeLabels(dirOf('aaaaaaaaaaaaaaa3'), { title: '', folder: '', tags: [] })
    expect(existsSync(join(dirOf('aaaaaaaaaaaaaaa3'), 'labels.json'))).toBe(false)
    expect(loadVideo('aaaaaaaaaaaaaaa3')!.manifest.folder).toBeUndefined()
  })

  it('travel with an export, as labels, and come back editable', async () => {
    const { entries } = exportArchive('aaaaaaaaaaaaaaa1', '<html lang="en"><!-- video-context:export --></html>')
    const zip = join(home, 'clase.zip')
    const out = createWriteStream(zip)
    await writeZip(entries, out)
    out.end()
    await finished(out)

    const other = mkdtempSync(join(tmpdir(), 'vc-labels-import-'))
    process.env.VIDEO_CONTEXT_HOME = other
    const { id } = await importArchive(zip)
    const dir = join(other, 'videos', id)
    expect(readLabels(dir)).toEqual({ title: 'Clase 3: ruteo', folder: 'Posgrado/Redes', tags: ['clase'] })
    expect(loadVideo(id)!.manifest).toMatchObject({ title: 'Clase 3: ruteo', processedTitle: '2026-10-29_18-19-05_Posgrado Teams', folder: 'Posgrado/Redes' })
    // Moved out of its folder there: it really leaves it.
    writeLabels(dir, { title: 'Clase 3: ruteo', tags: ['clase'] })
    expect(loadVideo(id)!.manifest.folder).toBeUndefined()
    process.env.VIDEO_CONTEXT_HOME = home
  })
})
