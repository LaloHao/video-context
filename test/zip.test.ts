import { spawnSync } from 'node:child_process'
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'

import { describe, expect, it } from 'vitest'

import { crc32, extractZipEntry, listZip, readZipEntry, writeZip } from '../src/zip.js'

async function zipTo(file: string, inputs: Parameters<typeof writeZip>[0], zip64 = false): Promise<void> {
  const out = createWriteStream(file)
  await writeZip(inputs, out, { zip64 })
  out.end()
  await finished(out)
}

const hasUnzip = spawnSync('unzip', ['-v']).status === 0

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
    expect(crc32(Buffer.from('6789'), crc32(Buffer.from('12345')))).toBe(0xcbf43926)
  })

  for (const zip64 of [false, true]) {
    it(`writes and reads back text (deflated), files (stored) and UTF-8 names${zip64 ? ' with ZIP64' : ''}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'vc-zip-'))
      const video = join(dir, 'in.webm')
      const bytes = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7919) % 256))
      writeFileSync(video, bytes)
      const text = 'Línea de transcripción. '.repeat(2000)
      const zip = join(dir, 'out.zip')
      await zipTo(zip, [
        { name: 'Reunión/transcript.md', data: text },
        { name: 'Reunión/video.webm', file: video },
        { name: 'Reunión/empty.json', data: '' }
      ], zip64)

      const entries = listZip(zip)
      expect(entries.map((e) => [e.name, e.method])).toEqual([['Reunión/transcript.md', 8], ['Reunión/video.webm', 0], ['Reunión/empty.json', 8]])
      expect(entries[0].compressedSize).toBeLessThan(entries[0].size)
      expect(readZipEntry(zip, entries[0]).toString('utf8')).toBe(text)
      await extractZipEntry(zip, entries[1], join(dir, 'back.webm'))
      expect(readFileSync(join(dir, 'back.webm')).equals(bytes)).toBe(true)
      await extractZipEntry(zip, entries[2], join(dir, 'empty.json'))
      expect(readFileSync(join(dir, 'empty.json')).length).toBe(0)

      // Another tool agrees.
      if (hasUnzip) expect(spawnSync('unzip', ['-tq', zip], { encoding: 'utf8' }).stdout).toMatch(/No errors/)
    })
  }

  it('rejects what is not a ZIP file, and a damaged entry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-zip-'))
    writeFileSync(join(dir, 'no.zip'), 'hello')
    expect(() => listZip(join(dir, 'no.zip'))).toThrow(/Not a ZIP/)

    const zip = join(dir, 'ok.zip')
    await zipTo(zip, [{ name: 'a.txt', data: 'some text to damage' }])
    const raw = readFileSync(zip)
    raw[30 + 'a.txt'.length + 2] ^= 0xff
    writeFileSync(zip, raw)
    expect(() => readZipEntry(zip, listZip(zip)[0])).toThrow()
  })
})
