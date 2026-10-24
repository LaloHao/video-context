// Text on screen: tesseract on each kept frame (optional). Screen recordings
// show what is never said aloud — URLs, JSON, field names — and this makes it
// searchable.

import { spawn, spawnSync } from 'node:child_process'

import { findBinary } from './deps.js'

export function findTesseract(): string | null {
  return findBinary('VIDEO_CONTEXT_TESSERACT', ['tesseract'])
}

/** The tesseract languages installed (e.g. eng, spa). */
export function tesseractLanguages(bin: string): string[] {
  const out = spawnSync(bin, ['--list-langs'], { encoding: 'utf8' })
  return `${out.stdout ?? ''}`
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[a-z_]{3,}$/.test(l) && l !== 'osd')
}

/** Spoken language (ISO 639-1, as whisper takes it) → tesseract's code. */
const TESSERACT_CODE: Record<string, string> = { es: 'spa', en: 'eng', pt: 'por', fr: 'fra', de: 'deu', it: 'ita' }

/** The OCR languages for a video: its spoken language when installed, plus English (code, URLs). */
export function ocrLanguages(spoken: string | undefined, installed: readonly string[]): string[] {
  const wanted = [TESSERACT_CODE[spoken ?? ''], 'eng'].filter((l): l is string => Boolean(l))
  const langs = [...new Set(wanted)].filter((l) => installed.includes(l))
  return langs.length > 0 ? langs : installed.slice(0, 1)
}

/** OCR output as searchable text: no blank lines, no lines without at least two letters or digits. */
export function cleanOcr(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => (l.match(/[\p{L}\p{N}]/gu) ?? []).length >= 2)
    .join('\n')
}

export function ocrImage(bin: string, file: string, langs: readonly string[], signal?: AbortSignal, onSpawn?: (pid: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [file, 'stdout', '-l', langs.join('+'), '--psm', '3'], { stdio: ['ignore', 'pipe', 'pipe'], signal })
    if (child.pid) onSpawn?.(child.pid)
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', () => {})
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(cleanOcr(out)) : reject(new Error(`tesseract failed (exit ${code})`))))
  })
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
