// Draws a Sixel sequence back into pixels, as a terminal would: for checking what the app wrote.

import assert from 'node:assert/strict'
import type { Bitmap } from '../../app/png.ts'

/** Draws a Sixel sequence back into pixels (unpainted ones stay clear), as a terminal would. */
export function unsixel(seq: string): Bitmap {
  const m = seq.match(/^\x1bP0;1;0q"1;1;(\d+);(\d+)(.*)\x1b\\$/s)
  assert.ok(m, 'a Sixel sequence, transparent background, with its size')
  const w = Number(m[1]), h = Number(m[2]), body = m[3]!
  const data = new Uint8Array(w * h * 4)
  const pal: number[][] = []
  let c = 0, x = 0, y = 0
  for (let i = 0; i < body.length;) {
    const ch = body[i]!
    if (ch === '#') {
      const mm = body.slice(i).match(/^#(\d+)(?:;2;(\d+);(\d+);(\d+))?/)!
      c = Number(mm[1])
      if (mm[2]) pal[c] = [mm[2], mm[3], mm[4]].map(v => Math.round(Number(v) * 2.55))
      i += mm[0].length
      continue
    }
    if (ch === '$' || ch === '-') {
      x = 0
      if (ch === '-') y += 6
      i++
      continue
    }
    let rep = 1
    if (ch === '!') {
      const mm = body.slice(i).match(/^!(\d+)/)!
      rep = Number(mm[1])
      i += mm[0].length
    }
    const v = body.charCodeAt(i++) - 63
    for (let r = 0; r < rep; r++, x++) for (let k = 0; k < 6; k++) if (v & (1 << k) && y + k < h && x < w) data.set([...pal[c]!, 255], ((y + k) * w + x) * 4)
  }
  return { width: w, height: h, data }
}
