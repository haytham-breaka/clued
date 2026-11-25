// PNG in and out, and the few pixel operations inline images need: decoding a PNG to RGBA (every
// colour type, bit depth and Adam7), scaling it, cropping rows, and encoding RGBA back to PNG.
// Node's zlib does the compression, so nothing needs installing. Image sizes from file headers
// (PNG, JPEG, GIF, WebP) without decoding them.

import { crc32, deflateSync, inflateSync } from 'node:zlib'

/** Pixels, 4 bytes each (red, green, blue, alpha), row after row. */
export type Bitmap = { width: number; height: number; data: Uint8Array }

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Channels of each PNG colour type: grey, RGB, palette, grey and alpha, RGBA. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** The Adam7 passes: start x, start y, step x, step y. */
const ADAM7 = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
] as const

export const isPng = (buf: Uint8Array) => buf.length >= 8 && SIGNATURE.equals(buf.subarray(0, 8))

/** Decodes a PNG. Throws on what isn't one, or is cut short. `maxPixels` guards memory. */
export function decodePng(buf: Buffer, maxPixels = 40_000_000): Bitmap {
  if (!isPng(buf)) throw new Error('not a PNG')
  let at = 8
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0
  let palette: Uint8Array | undefined
  let trns: Buffer | undefined
  const idat: Buffer[] = []
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at)
    const name = buf.toString('latin1', at + 4, at + 8)
    const body = buf.subarray(at + 8, at + 8 + len)
    if (body.length < len) throw new Error('PNG cut short')
    if (name === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      depth = body[8]!
      type = body[9]!
      interlace = body[12]!
    } else if (name === 'PLTE') palette = body
    else if (name === 'tRNS') trns = body
    else if (name === 'IDAT') idat.push(body)
    else if (name === 'IEND') break
    at += 12 + len
  }
  const channels = CHANNELS[type]
  if (!width || !height || !channels || ![1, 2, 4, 8, 16].includes(depth)) throw new Error('unsupported PNG')
  if (width * height > maxPixels) throw new Error('PNG too large')
  if (type === 3 && !palette) throw new Error('PNG palette missing')
  const raw = inflateSync(Buffer.concat(idat))
  const out = new Uint8Array(width * height * 4)
  const bpp = Math.max(1, (channels * depth) >> 3)
  let pos = 0
  const pass = (x0: number, y0: number, dx: number, dy: number) => {
    const w = Math.ceil((width - x0) / dx)
    const h = Math.ceil((height - y0) / dy)
    if (w <= 0 || h <= 0) return
    const stride = Math.ceil((w * channels * depth) / 8)
    let prev = new Uint8Array(stride)
    for (let y = 0; y < h; y++) {
      if (pos + 1 + stride > raw.length) throw new Error('PNG cut short')
      const filter = raw[pos]!
      const line = new Uint8Array(raw.subarray(pos + 1, pos + 1 + stride))
      pos += 1 + stride
      unfilter(filter, line, prev, bpp)
      for (let x = 0; x < w; x++) pixel(line, x, out, ((y0 + y * dy) * width + x0 + x * dx) * 4)
      prev = line
    }
  }
  const max = (1 << depth) - 1
  const sample = (line: Uint8Array, i: number): number => {
    if (depth === 8) return line[i]!
    if (depth === 16) return line[i * 2]!
    const bit = i * depth
    return ((line[bit >> 3]! >> (8 - depth - (bit & 7))) & max)
  }
  // A sample as 8 bits; the raw value for tRNS (which is at the image's own depth).
  const to8 = (v: number) => (depth === 16 ? v : depth === 8 ? v : Math.round((v * 255) / max))
  const raw16 = (line: Uint8Array, i: number) => (depth === 16 ? (line[i * 2]! << 8) | line[i * 2 + 1]! : sample(line, i))
  const pixel = (line: Uint8Array, x: number, o: Uint8Array, p: number) => {
    if (type === 3) {
      const idx = sample(line, x)
      o[p] = palette![idx * 3] ?? 0
      o[p + 1] = palette![idx * 3 + 1] ?? 0
      o[p + 2] = palette![idx * 3 + 2] ?? 0
      o[p + 3] = trns && idx < trns.length ? trns[idx]! : 255
    } else if (type === 0 || type === 4) {
      const g = to8(sample(line, x * channels))
      o[p] = o[p + 1] = o[p + 2] = g
      o[p + 3] = type === 4 ? to8(sample(line, x * 2 + 1)) : trns && trns.length >= 2 && raw16(line, x) === trns.readUInt16BE(0) ? 0 : 255
    } else {
      const c = x * channels
      o[p] = to8(sample(line, c))
      o[p + 1] = to8(sample(line, c + 1))
      o[p + 2] = to8(sample(line, c + 2))
      o[p + 3] = type === 6 ? to8(sample(line, c + 3))
        : trns && trns.length >= 6 && raw16(line, c) === trns.readUInt16BE(0) && raw16(line, c + 1) === trns.readUInt16BE(2) && raw16(line, c + 2) === trns.readUInt16BE(4) ? 0 : 255
    }
  }
  if (interlace) for (const [x0, y0, dx, dy] of ADAM7) pass(x0, y0, dx, dy)
  else pass(0, 0, 1, 1)
  return { width, height, data: out }
}

function unfilter(type: number, line: Uint8Array, prev: Uint8Array, bpp: number) {
  const n = line.length
  if (type === 0) return
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? line[i - bpp]! : 0
    const b = prev[i]!
    let v: number
    if (type === 1) v = a
    else if (type === 2) v = b
    else if (type === 3) v = (a + b) >> 1
    else if (type === 4) {
      const c = i >= bpp ? prev[i - bpp]! : 0
      const p = a + b - c
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      v = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
    } else throw new Error('bad PNG filter')
    line[i] = (line[i]! + v) & 255
  }
}

/** RGBA to a PNG file. */
export function encodePng(img: Bitmap): Buffer {
  const { width, height, data } = img
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    // Filter "sub": smaller for the flat areas charts and diagrams are made of.
    const o = y * (stride + 1)
    raw[o] = 1
    for (let i = 0; i < stride; i++) raw[o + 1 + i] = (data[y * stride + i]! - (i >= 4 ? data[y * stride + i - 4]! : 0)) & 255
  }
  const chunk = (name: string, body: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(name, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0)
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))])
}

/**
 * The image scaled to `width` × `height`: each new pixel the average of those it covers (alpha
 * weighted, so a transparent edge doesn't darken), or the nearest one when growing.
 */
export function scale(img: Bitmap, width: number, height: number): Bitmap {
  width = Math.max(1, Math.round(width))
  height = Math.max(1, Math.round(height))
  if (width === img.width && height === img.height) return img
  const out = new Uint8Array(width * height * 4)
  const sw = img.width, sh = img.height, src = img.data
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * sh) / height)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / height))
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * sw) / width)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / width))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const p = (yy * sw + xx) * 4
          const al = src[p + 3]!
          r += src[p]! * al
          g += src[p + 1]! * al
          b += src[p + 2]! * al
          a += al
          n++
        }
      }
      const o = (y * width + x) * 4
      if (a) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
      }
      out[o + 3] = Math.round(a / n)
    }
  }
  return { width, height, data: out }
}

/** Rows `from` up to (not including) `to`. */
export function cropRows(img: Bitmap, from: number, to: number): Bitmap {
  from = Math.max(0, Math.min(img.height, from))
  to = Math.max(from, Math.min(img.height, to))
  return { width: img.width, height: to - from, data: img.data.slice(from * img.width * 4, to * img.width * 4) }
}

/** The pixel size an image file says it has (PNG, JPEG, GIF, WebP), without decoding it. */
export function imageSize(buf: Buffer): { width: number; height: number; type: 'png' | 'jpeg' | 'gif' | 'webp' } | undefined {
  if (isPng(buf) && buf.length >= 24 && buf.toString('latin1', 12, 16) === 'IHDR') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: 'png' }
  if (buf.length >= 10 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), type: 'gif' }
  if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const kind = buf.toString('latin1', 12, 16)
    if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, type: 'webp' }
    if (kind === 'VP8L') {
      const bits = buf.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, type: 'webp' }
    }
    if (kind === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1, type: 'webp' }
    return undefined
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let at = 2
    while (at + 9 < buf.length) {
      if (buf[at] !== 0xff) return undefined
      const marker = buf[at + 1]!
      if (marker === 0xff) { at++; continue }
      const len = buf.readUInt16BE(at + 2)
      // A start of frame (not DHT, JPG or DAC, which share the range) holds the size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(at + 7), height: buf.readUInt16BE(at + 5), type: 'jpeg' }
      at += 2 + len
    }
  }
  return undefined
}
