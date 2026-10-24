// A small ZIP writer and reader, enough for the exports of the web page: files
// stored (videos, images) or deflated (text), UTF-8 names, and ZIP64 for files
// or archives past 4 GB. Written straight to a stream: a video is read twice
// (its CRC first), never held in memory.

import { once } from 'node:events'
import { createReadStream, createWriteStream, closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs'
import type { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'

export interface ZipInput {
  /** The path inside the archive, with `/`. */
  name: string
  /** Its content, or the file to read it from. */
  data?: Buffer | string
  file?: string
}

export interface ZipEntry {
  name: string
  method: number
  crc: number
  compressedSize: number
  size: number
  /** Where its local header starts. */
  offset: number
}

const MAX32 = 0xffffffff

// zlib.crc32 exists from Node 20.15 / 22.2; a table does it before that.
const TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
type Crc = (data: Buffer, value?: number) => number
const nativeCrc = (zlib as unknown as { crc32?: Crc }).crc32
export const crc32: Crc =
  nativeCrc ??
  ((data, value = 0) => {
    let c = ~value >>> 0
    for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
    return ~c >>> 0
  })

async function fileCrc(file: string): Promise<number> {
  let crc = 0
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) crc = crc32(chunk as Buffer, crc)
  return crc
}

function dosTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  }
}

/** Already compressed formats are stored as they are; the rest is deflated. */
const STORE = /\.(mp4|m4v|mov|webm|mkv|ogv|mp3|m4a|ogg|flac|jpe?g|png|gif|webp|zip)$/i

/** Write `inputs` as a ZIP archive to `out` (left open). `zip64` forces the ZIP64 fields (they are used past 4 GB anyway). */
export async function writeZip(inputs: ZipInput[], out: Writable, { zip64: force = false } = {}): Promise<void> {
  let offset = 0
  const write = async (chunk: Buffer): Promise<void> => {
    offset += chunk.length
    if (!out.write(chunk)) await once(out, 'drain')
  }
  const now = dosTime(new Date())
  const central: Buffer[] = []

  for (const input of inputs) {
    const name = Buffer.from(input.name.replace(/\\/g, '/'), 'utf8')
    const stored = input.file !== undefined || STORE.test(input.name)
    let data: Buffer | undefined
    let crc: number
    let size: number
    let compressedSize: number
    let method: number
    if (input.file !== undefined) {
      size = statSync(input.file).size
      compressedSize = size
      crc = await fileCrc(input.file)
      method = 0
    } else {
      const raw = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data ?? '', 'utf8')
      size = raw.length
      crc = crc32(raw)
      data = stored ? raw : zlib.deflateRawSync(raw, { level: 6 })
      compressedSize = data.length
      method = stored ? 0 : 8
    }
    const zip64 = force || size >= MAX32 || compressedSize >= MAX32 || offset >= MAX32
    const headerOffset = offset

    // Local header; with ZIP64 the sizes go in an extra field.
    const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0)
    if (zip64) {
      extra.writeUInt16LE(0x0001, 0)
      extra.writeUInt16LE(16, 2)
      extra.writeBigUInt64LE(BigInt(size), 4)
      extra.writeBigUInt64LE(BigInt(compressedSize), 12)
    }
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(zip64 ? 45 : 20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(now.time, 10)
    local.writeUInt16LE(now.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(zip64 ? MAX32 : compressedSize, 18)
    local.writeUInt32LE(zip64 ? MAX32 : size, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(extra.length, 28)
    await write(Buffer.concat([local, name, extra]))
    if (data) await write(data)
    else {
      for await (const chunk of createReadStream(input.file!, { highWaterMark: 1 << 20 })) await write(chunk as Buffer)
    }

    // Central directory entry.
    const cextra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0)
    if (zip64) {
      cextra.writeUInt16LE(0x0001, 0)
      cextra.writeUInt16LE(24, 2)
      cextra.writeBigUInt64LE(BigInt(size), 4)
      cextra.writeBigUInt64LE(BigInt(compressedSize), 12)
      cextra.writeBigUInt64LE(BigInt(headerOffset), 20)
    }
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE((3 << 8) | (zip64 ? 45 : 20), 4) // made by Unix
    c.writeUInt16LE(zip64 ? 45 : 20, 6)
    c.writeUInt16LE(0x0800, 8)
    c.writeUInt16LE(method, 10)
    c.writeUInt16LE(now.time, 12)
    c.writeUInt16LE(now.date, 14)
    c.writeUInt32LE(crc, 16)
    c.writeUInt32LE(zip64 ? MAX32 : compressedSize, 20)
    c.writeUInt32LE(zip64 ? MAX32 : size, 24)
    c.writeUInt16LE(name.length, 28)
    c.writeUInt16LE(cextra.length, 30)
    c.writeUInt32LE((0o100644 << 16) >>> 0, 38) // a regular file, rw-r--r--
    c.writeUInt32LE(zip64 ? MAX32 : headerOffset, 42)
    central.push(Buffer.concat([c, name, cextra]))
  }

  const cdOffset = offset
  const cd = Buffer.concat(central)
  await write(cd)
  const zip64End = force || cdOffset >= MAX32 || cd.length >= MAX32 || inputs.length >= 0xffff
  if (zip64End) {
    const rec = Buffer.alloc(56)
    rec.writeUInt32LE(0x06064b50, 0)
    rec.writeBigUInt64LE(44n, 4)
    rec.writeUInt16LE(45, 12)
    rec.writeUInt16LE(45, 14)
    rec.writeBigUInt64LE(BigInt(inputs.length), 24)
    rec.writeBigUInt64LE(BigInt(inputs.length), 32)
    rec.writeBigUInt64LE(BigInt(cd.length), 40)
    rec.writeBigUInt64LE(BigInt(cdOffset), 48)
    const recOffset = offset
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50, 0)
    locator.writeBigUInt64LE(BigInt(recOffset), 8)
    locator.writeUInt32LE(1, 16)
    await write(Buffer.concat([rec, locator]))
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(zip64End ? 0xffff : inputs.length, 8)
  end.writeUInt16LE(zip64End ? 0xffff : inputs.length, 10)
  end.writeUInt32LE(zip64End ? MAX32 : cd.length, 12)
  end.writeUInt32LE(zip64End ? MAX32 : cdOffset, 16)
  await write(end)
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, position + done)
    if (n === 0) break
    done += n
  }
  return buf.subarray(0, done)
}

/** The entries of a ZIP archive, from its central directory. */
export function listZip(file: string): ZipEntry[] {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    // The end record is in the last 22 bytes plus a comment of up to 64 KB.
    const tailStart = Math.max(0, size - 22 - 0xffff)
    const tail = readAt(fd, tailStart, size - tailStart)
    let at = -1
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { at = i; break }
    if (at < 0) throw new Error('Not a ZIP file.')
    let count = tail.readUInt16LE(at + 10)
    let cdSize = tail.readUInt32LE(at + 12)
    let cdOffset = tail.readUInt32LE(at + 16)
    if ((count === 0xffff || cdSize === MAX32 || cdOffset === MAX32) && at >= 20 && tail.readUInt32LE(at - 20) === 0x07064b50) {
      const rec = readAt(fd, Number(tail.readBigUInt64LE(at - 20 + 8)), 56)
      if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error('Damaged ZIP64 file.')
      count = Number(rec.readBigUInt64LE(32))
      cdSize = Number(rec.readBigUInt64LE(40))
      cdOffset = Number(rec.readBigUInt64LE(48))
    }
    const cd = readAt(fd, cdOffset, cdSize)
    const entries: ZipEntry[] = []
    let p = 0
    for (let n = 0; n < count; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged ZIP file.')
      const method = cd.readUInt16LE(p + 10)
      const crc = cd.readUInt32LE(p + 16)
      let compressedSize = cd.readUInt32LE(p + 20)
      let usize = cd.readUInt32LE(p + 24)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      let offset = cd.readUInt32LE(p + 42)
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8')
      // ZIP64: the fields set to 0xFFFFFFFF are in the extra field, in this order.
      let e = p + 46 + nameLen
      const extraEnd = e + extraLen
      while (e + 4 <= extraEnd) {
        const id = cd.readUInt16LE(e)
        const len = cd.readUInt16LE(e + 2)
        if (id === 0x0001) {
          let q = e + 4
          if (usize === MAX32) { usize = Number(cd.readBigUInt64LE(q)); q += 8 }
          if (compressedSize === MAX32) { compressedSize = Number(cd.readBigUInt64LE(q)); q += 8 }
          if (offset === MAX32) offset = Number(cd.readBigUInt64LE(q))
        }
        e += 4 + len
      }
      entries.push({ name, method, crc, compressedSize, size: usize, offset })
      p = extraEnd + commentLen
    }
    return entries
  } finally {
    closeSync(fd)
  }
}

function dataStart(file: string, entry: ZipEntry): number {
  const fd = openSync(file, 'r')
  try {
    const local = readAt(fd, entry.offset, 30)
    if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`Damaged ZIP entry: ${entry.name}`)
    return entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
  } finally {
    closeSync(fd)
  }
}

function checkMethod(entry: ZipEntry): void {
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name}: compression method ${entry.method} is not supported (only stored and deflate).`)
}

/** A small entry's content. */
export function readZipEntry(file: string, entry: ZipEntry): Buffer {
  checkMethod(entry)
  const fd = openSync(file, 'r')
  try {
    const raw = readAt(fd, dataStart(file, entry), entry.compressedSize)
    const data = entry.method === 8 ? zlib.inflateRawSync(raw) : raw
    if (crc32(data) !== entry.crc) throw new Error(`${entry.name} is damaged (CRC).`)
    return data
  } finally {
    closeSync(fd)
  }
}

/** Write an entry to `target`, streamed (for a video). */
export async function extractZipEntry(file: string, entry: ZipEntry, target: string): Promise<void> {
  checkMethod(entry)
  if (entry.compressedSize === 0) {
    await pipeline([], createWriteStream(target))
    return
  }
  const start = dataStart(file, entry)
  const source = createReadStream(file, { start, end: start + entry.compressedSize - 1, highWaterMark: 1 << 20 })
  let crc = 0
  const check = async function* (chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    for await (const chunk of chunks) {
      crc = crc32(chunk, crc)
      yield chunk
    }
  }
  if (entry.method === 8) await pipeline(source, zlib.createInflateRaw(), check, createWriteStream(target))
  else await pipeline(source, check, createWriteStream(target))
  if (crc !== entry.crc) throw new Error(`${entry.name} is damaged (CRC).`)
}
