// Near-duplicate frames: a difference hash (dHash) of each frame from a 9×8
// grayscale thumbnail, compared by Hamming distance. A frame almost identical
// to the last kept one (a still screen sampled twice) adds nothing.

/** 64-bit dHash of a 9×8 grayscale image (72 bytes, row by row): bit = pixel brighter than its right neighbour. */
export function dhash(pixels: Uint8Array): bigint {
  if (pixels.length !== 72) throw new Error(`dhash needs 72 grayscale pixels (9×8), got ${pixels.length}.`)
  let hash = 0n
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      hash = (hash << 1n) | (pixels[row * 9 + col] > pixels[row * 9 + col + 1] ? 1n : 0n)
    }
  }
  return hash
}

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b
  let count = 0
  while (x) {
    x &= x - 1n
    count++
  }
  return count
}

/**
 * The indexes to keep: the first frame, and each one whose hash differs from
 * the last kept frame's by more than `threshold` bits (of 64).
 */
export function keepDistinct(hashes: readonly bigint[], threshold = 4): number[] {
  const kept: number[] = []
  let last: bigint | null = null
  hashes.forEach((hash, i) => {
    if (last === null || hamming(hash, last) > threshold) {
      kept.push(i)
      last = hash
    }
  })
  return kept
}
