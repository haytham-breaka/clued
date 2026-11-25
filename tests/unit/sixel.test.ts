import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { quantize, sixel } from '../../app/sixel.ts'
import type { Bitmap } from '../../app/png.ts'
import { unsixel } from './sixel-decode.ts'

const solid = (w: number, h: number, f: (x: number, y: number) => number[]): Bitmap => {
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4)
  return { width: w, height: h, data }
}

describe('sixel', () => {
  test('few colours: drawn back exactly (palette at 0–100 %, so to within a step); clear pixels unpainted', () => {
    const img = solid(9, 8, (x, y) => (x < 3 ? [255, 0, 0, 255] : x < 6 ? [0, 0, 255, 255] : y < 4 ? [0, 0, 0, 0] : [255, 255, 255, 255]))
    const seq = sixel(img)
    // Runs of a colour repeat with !n; two bands of six rows.
    assert.match(seq, /!\d+[?-~]/)
    assert.equal(seq.split('-').length, 2)
    const back = unsixel(seq)
    for (let i = 0; i < img.data.length; i++) assert.ok(Math.abs(back.data[i]! - img.data[i]!) <= 2, `byte ${i}`)
  })

  test('more than 256 colours: a median-cut palette of at most 256, every opaque pixel painted near its colour', () => {
    const img = solid(64, 12, (x, y) => [x * 4, y * 20, (x * y) % 256, 255])
    const q = quantize(img)
    assert.ok(q.palette.length <= 256)
    assert.ok(q.palette.length > 100)
    const back = unsixel(sixel(img))
    let worst = 0
    for (let i = 0; i < img.data.length; i += 4) for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(back.data[i + k]! - img.data[i + k]!))
    assert.ok(worst <= 24, `worst channel error ${worst}`)
  })

  test('a fully clear image has no colours and paints nothing', () => {
    const q = quantize(solid(2, 2, () => [9, 9, 9, 10]))
    assert.equal(q.palette.length, 0)
    assert.deepEqual([...q.index], [-1, -1, -1, -1])
    assert.ok(unsixel(sixel(solid(2, 2, () => [0, 0, 0, 0]))).data.every(v => v === 0))
  })
})
