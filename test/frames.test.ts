import { describe, expect, it } from 'vitest'

import { dhash, hamming, keepDistinct } from '../src/dedupe.js'
import { searchScreen } from '../src/frames.js'
import { cleanOcr, mapLimit, ocrLanguages } from '../src/ocr.js'
import { fold } from '../src/transcript.js'

/** A 9×8 gradient, optionally with one pixel changed. */
function image(change?: { at: number; value: number }): Uint8Array {
  const px = new Uint8Array(72).map((_, i) => (i % 9) * 20)
  if (change) px[change.at] = change.value
  return px
}

describe('near-duplicate frames', () => {
  it('hashes a 9×8 image and measures the distance in bits', () => {
    const a = dhash(image())
    expect(a).toBe(0n) // a left-to-right gradient never gets brighter than its right neighbour
    expect(hamming(a, dhash(image({ at: 0, value: 255 })))).toBe(1)
    expect(() => dhash(new Uint8Array(10))).toThrow(/72/)
  })

  it('keeps the first frame and each one that changes enough from the last kept', () => {
    expect(keepDistinct([0n, 1n, 0b11n, 0xffffn, 0xfffen], 4)).toEqual([0, 3])
    expect(keepDistinct([0n, 0xffn, 0n], 4)).toEqual([0, 1, 2])
    expect(keepDistinct([], 4)).toEqual([])
  })
})

describe('text on screen', () => {
  it('cleans OCR output and picks the languages', () => {
    expect(cleanOcr('  POST  /referencias/CreaReferencia \n\n | \n—\n"total": "3"')).toBe('POST /referencias/CreaReferencia\n"total": "3"')
    expect(ocrLanguages('es', ['eng', 'spa'])).toEqual(['spa', 'eng'])
    expect(ocrLanguages('es', ['eng'])).toEqual(['eng'])
    expect(ocrLanguages(undefined, ['deu'])).toEqual(['deu'])
  })

  it('finds frames whose text has every word, once per distinct screen', () => {
    const frames = [
      { file: 'a.jpg', time: 10, text: 'Postman\nPOST https://x/api/v1/referencias/CreaReferencia' },
      { file: 'b.jpg', time: 20, text: 'Postman\nPOST https://x/api/v1/referencias/CreaReferencia' },
      { file: 'c.jpg', time: 30, text: 'GET https://x/api/v1/referencias/estatus/{ref}' },
      { file: 'd.jpg', time: 40 }
    ]
    expect(searchScreen(frames, 'pago referencia', fold)).toEqual([])
    expect(searchScreen(frames, 'crea referencia', fold).map((h) => h.time)).toEqual([10])
    expect(searchScreen(frames, 'CreaReferencia', fold)).toEqual([{ time: 10, file: 'a.jpg', text: 'POST https://x/api/v1/referencias/CreaReferencia' }])
    expect(searchScreen(frames, 'referencias', fold).map((h) => h.time)).toEqual([10, 30])
  })

  it('runs at most N at a time, keeping the order', async () => {
    let running = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40, 50])
    expect(peak).toBe(2)
  })
})
