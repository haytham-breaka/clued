// RGBA to Sixel, the graphics Windows Terminal (1.22 and later), foot, mlterm and xterm -ti vt340
// draw. At most 256 colours: an image with fewer keeps its own; one with more gets a palette by
// median cut over 15-bit colours. Transparent pixels are left unpainted, so the background shows.

import type { Bitmap } from './png.ts'

/** A palette of at most `max` colours for the image, and each pixel's index in it (-1: transparent). */
export function quantize(img: Bitmap, max = 256): { palette: [number, number, number][]; index: Int16Array } {
  const { data } = img
  const n = img.width * img.height
  const index = new Int16Array(n).fill(-1)
  // A pixel half transparent or less isn't painted; one more opaque is painted as it is.
  const key = new Int32Array(n).fill(-1)
  const exact = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3]! < 128) continue
    const rgb = (data[i * 4]! << 16) | (data[i * 4 + 1]! << 8) | data[i * 4 + 2]!
    key[i] = rgb
    if (exact.size <= max) exact.set(rgb, (exact.get(rgb) ?? 0) + 1)
  }
  if (exact.size <= max) {
    const palette: [number, number, number][] = []
    const at = new Map<number, number>()
    for (const rgb of exact.keys()) {
      at.set(rgb, palette.length)
      palette.push([rgb >> 16, (rgb >> 8) & 255, rgb & 255])
    }
    for (let i = 0; i < n; i++) if (key[i]! >= 0) index[i] = at.get(key[i]!)!
    return { palette, index }
  }
  // 5 bits a channel: a histogram of 32768 boxes, then median cut.
  const hist = new Uint32Array(32768)
  const b15 = (rgb: number) => ((rgb >> 19) << 10) | (((rgb >> 11) & 31) << 5) | ((rgb >> 3) & 31)
  for (let i = 0; i < n; i++) if (key[i]! >= 0) hist[b15(key[i]!)]!++
  const colors: number[] = []
  for (let c = 0; c < 32768; c++) if (hist[c]) colors.push(c)
  const ch = (c: number, k: number) => (k === 0 ? c >> 10 : k === 1 ? (c >> 5) & 31 : c & 31)
  type Box = { items: number[] }
  const boxes: Box[] = [{ items: colors }]
  const range = (b: Box): [number, number] => {
    let best = -1, axis = 0
    for (let k = 0; k < 3; k++) {
      let lo = 31, hi = 0
      for (const c of b.items) {
        const v = ch(c, k)
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      if (hi - lo > best) { best = hi - lo; axis = k }
    }
    return [best, axis]
  }
  while (boxes.length < max) {
    // The box that spans the most (weighted by its pixels, so busy colours get more of the palette).
    let pick = -1, score = 0, most = 0, axis = 0
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!
      if (b.items.length < 2) continue
      let w = 0
      for (const c of b.items) w += hist[c]!
      const [r, ax] = range(b)
      if (r * Math.sqrt(w) > score) { score = r * Math.sqrt(w); pick = i; most = w; axis = ax }
    }
    if (pick < 0) break
    const b = boxes[pick]!
    b.items.sort((x, y) => ch(x, axis) - ch(y, axis))
    // Split where half the pixels are on each side.
    let acc = 0, cut = 1
    for (let i = 0; i < b.items.length - 1; i++) {
      acc += hist[b.items[i]!]!
      if (acc * 2 >= most) { cut = i + 1; break }
    }
    boxes.splice(pick, 1, { items: b.items.slice(0, cut) }, { items: b.items.slice(cut) })
  }
  const palette: [number, number, number][] = []
  const map = new Int16Array(32768).fill(-1)
  for (const b of boxes) {
    let r = 0, g = 0, bl = 0, w = 0
    for (const c of b.items) {
      const h = hist[c]!
      r += ch(c, 0) * h
      g += ch(c, 1) * h
      bl += ch(c, 2) * h
      w += h
      map[c] = palette.length
    }
    palette.push([Math.round(((r / w) * 255) / 31), Math.round(((g / w) * 255) / 31), Math.round(((bl / w) * 255) / 31)])
  }
  for (let i = 0; i < n; i++) if (key[i]! >= 0) index[i] = map[b15(key[i]!)]!
  return { palette, index }
}

/** A sixel run: `!n` repeats a character when that is shorter. */
const run = (ch: string, n: number) => (n > 3 ? `!${n}${ch}` : ch.repeat(n))

/** The image as one Sixel sequence (DCS … ST), drawn from the cursor down. */
export function sixel(img: Bitmap): string {
  const { width: w, height: h } = img
  const { palette, index } = quantize(img)
  // P2 = 1: pixels no colour paints keep what is behind them.
  let s = `\x1bP0;1;0q"1;1;${w};${h}`
  palette.forEach(([r, g, b], i) => (s += `#${i};2;${Math.round((r * 100) / 255)};${Math.round((g * 100) / 255)};${Math.round((b * 100) / 255)}`))
  const bits = new Uint8Array(palette.length * w)
  const used = new Uint8Array(palette.length)
  for (let y = 0; y < h; y += 6) {
    bits.fill(0)
    used.fill(0)
    for (let k = 0; k < 6 && y + k < h; k++) {
      const row = (y + k) * w
      for (let x = 0; x < w; x++) {
        const c = index[row + x]!
        if (c < 0) continue
        bits[c * w + x]! |= 1 << k
        used[c] = 1
      }
    }
    const bands: string[] = []
    for (let c = 0; c < palette.length; c++) {
      if (!used[c]) continue
      let band = `#${c}`
      let last = -1, count = 0
      // Trailing empty columns are left out.
      let end = w
      while (end > 0 && !bits[c * w + end - 1]) end--
      for (let x = 0; x < end; x++) {
        const v = bits[c * w + x]!
        if (v === last) count++
        else {
          if (count) band += run(String.fromCharCode(63 + last), count)
          last = v
          count = 1
        }
      }
      if (count) band += run(String.fromCharCode(63 + last), count)
      bands.push(band)
    }
    s += bands.join('$') + (y + 6 < h ? '$-' : '$')
  }
  return s + '\x1b\\'
}
