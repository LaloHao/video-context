import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'

import { afterEach, describe, expect, it } from 'vitest'

import { exportArchive, importArchive, safeName, type ExportData } from '../src/export.js'
import { readChapters, readNotes } from '../src/library.js'
import { loadVideo } from '../src/process.js'
import { listZip, readZipEntry, writeZip, type ZipInput } from '../src/zip.js'

const PAGE = '<html lang="en"><body><!-- video-context:export --><script>app()</script></body></html>'
const previous = process.env.VIDEO_CONTEXT_HOME
afterEach(() => {
  if (previous === undefined) delete process.env.VIDEO_CONTEXT_HOME
  else process.env.VIDEO_CONTEXT_HOME = previous
})

async function zipTo(file: string, inputs: ZipInput[]): Promise<void> {
  const out = createWriteStream(file)
  await writeZip(inputs, out)
  out.end()
  await finished(out)
}

/** A processed video in a fresh cache, as processing leaves it. */
function processedVideo(): { home: string; id: string; videoBytes: Buffer } {
  const home = mkdtempSync(join(tmpdir(), 'vc-export-'))
  process.env.VIDEO_CONTEXT_HOME = home
  const id = 'abcdef0123456789'
  const dir = join(home, 'videos', id)
  mkdirSync(join(dir, 'frames'), { recursive: true })
  const source = join(home, 'Reunión semanal.webm')
  const videoBytes = Buffer.from(Array.from({ length: 50_000 }, (_, i) => i % 251))
  writeFileSync(source, videoBytes)
  writeFileSync(join(dir, 'frames', '00010s-00001.jpg'), 'jpeg bytes')
  const segments = [{ start: 0, end: 4, text: 'Hola </script> a todos.' }, { start: 4, end: 9, text: 'Empezamos.' }]
  writeFileSync(join(dir, 'transcript.json'), JSON.stringify(segments))
  writeFileSync(join(dir, 'chapters.json'), JSON.stringify([{ start: 0, title: 'Inicio' }]))
  writeFileSync(join(dir, 'notes.json'), JSON.stringify([{ id: 'n', time: 4, text: 'importante', createdAt: 'x' }]))
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ version: 1, id, source, title: 'Reunión semanal', duration: 9, language: 'es', model: 'small', createdAt: 'x', segments: 2, frames: [{ file: 'frames/00010s-00001.jpg', time: 10, text: 'pantalla' }] })
  )
  return { home, id, videoBytes }
}

describe('export', () => {
  it('names files safely', () => {
    expect(safeName('Daily: 10/22 <ok>?')).toBe('Daily_ 10_22 _ok_')
    expect(safeName('  ')).toBe('video')
  })

  it('exports a video with a page that carries its data, and imports it elsewhere without processing', async () => {
    const { home, id, videoBytes } = processedVideo()
    const { name, entries } = exportArchive(id, PAGE)
    expect(name).toBe('Reunión semanal.zip')
    const zip = join(home, name)
    await zipTo(zip, entries)

    const names = listZip(zip).map((e) => e.name)
    expect(names).toEqual(expect.arrayContaining(['Reunión semanal/index.html', 'Reunión semanal/video.webm', 'Reunión semanal/frames/00010s-00001.jpg', 'Reunión semanal/transcript.srt', 'Reunión semanal/notes.json']))

    // The page: the data inside, and nothing in it closes the <script>.
    const html = readZipEntry(zip, listZip(zip).find((e) => e.name.endsWith('index.html'))!).toString('utf8')
    const script = /window\.VIDEO_CONTEXT_EXPORT = (.*?)<\/script>/.exec(html)!
    expect(script[1]).not.toContain('</script')
    expect(html).toContain('<html lang="en" class="static">')
    const data = JSON.parse(script[1]) as ExportData
    expect(data).toMatchObject({ title: 'Reunión semanal', video: 'video.webm', originalName: 'Reunión semanal.webm', chapters: [{ title: 'Inicio' }], notes: [{ text: 'importante' }] })
    expect(data.manifest.source).toBe('video.webm')
    expect(data.segments[0].text).toBe('Hola </script> a todos.')

    // Another machine.
    const other = mkdtempSync(join(tmpdir(), 'vc-import-'))
    process.env.VIDEO_CONTEXT_HOME = other
    const imported = await importArchive(zip)
    expect(imported.already).toBe(false)
    const video = loadVideo(imported.id)!
    expect(video.manifest.source.startsWith(join(other, 'imports'))).toBe(true)
    expect(readFileSync(video.manifest.source).equals(videoBytes)).toBe(true)
    expect(video.manifest.importedFrom).toMatchObject({ id, originalName: 'Reunión semanal.webm' })
    expect(video.segments).toHaveLength(2)
    expect(existsSync(join(video.dir, 'frames', '00010s-00001.jpg'))).toBe(true)
    expect(readChapters(video.dir)[0].title).toBe('Inicio')
    expect(readNotes(video.dir)[0].text).toBe('importante')
    expect(readFileSync(join(video.dir, 'transcript.srt'), 'utf8')).toContain('00:00:00,000 --> 00:00:04,000')

    // Once is enough.
    expect(await importArchive(zip)).toMatchObject({ id: imported.id, already: true })
  })

  it('refuses what is not an export, and paths outside the export', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vc-import-'))
    process.env.VIDEO_CONTEXT_HOME = home
    const plain = join(home, 'plain.zip')
    await zipTo(plain, [{ name: 'a.txt', data: 'hi' }])
    await expect(importArchive(plain)).rejects.toThrow(/not a video-context export/)

    const evil = join(home, 'evil.zip')
    const manifest = { version: 1, id: '0123456789abcdef', source: 'x.webm', title: 'T', duration: 1, language: 'es', model: 'small', createdAt: 'x', segments: 0, frames: [{ file: '../../../escaped.jpg', time: 0 }] }
    await zipTo(evil, [
      { name: 'video-context.json', data: JSON.stringify({ schema: 'video-context-export/1', exportedAt: 'x', id: '0123456789abcdef', title: 'T', video: null, originalName: 'x.webm' }) },
      { name: 'manifest.json', data: JSON.stringify(manifest) },
      { name: 'transcript.json', data: '[]' },
      { name: '../../../escaped.jpg', data: 'no' }
    ])
    const imported = await importArchive(evil)
    expect(loadVideo(imported.id)!.manifest.frames).toEqual([])
    expect(existsSync(join(home, '..', 'escaped.jpg'))).toBe(false)
  })
})
