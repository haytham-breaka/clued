import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { crc32, deflateSync } from 'node:zlib'
import { cropRows, decodePng, encodePng, imageSize, isPng, scale } from '../../app/png.ts'
import type { Bitmap } from '../../app/png.ts'

/** A PNG made by hand: IHDR, then the extra chunks, then the scanlines (each with its filter byte). */
function png(w: number, h: number, depth: number, type: number, lines: Uint8Array, extra: [string, Buffer][] = [], interlace = 0): Buffer {
  const chunk = (name: string, body: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length)
    head.write(name, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0)
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = depth
  ihdr[9] = type
  ihdr[12] = interlace
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra.map(([n, b]) => chunk(n, b)), chunk('IDAT', deflateSync(lines)), chunk('IEND', Buffer.alloc(0))])
}
const px = (img: Bitmap, x: number, y: number) => [...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)]

describe('decodePng', () => {
  test('RGBA comes back as it went in (encodePng, filter sub)', () => {
    const data = new Uint8Array(5 * 3 * 4).map((_, i) => (i * 37) % 256)
    const img = { width: 5, height: 3, data }
    const back = decodePng(encodePng(img))
    assert.equal(back.width, 5)
    assert.equal(back.height, 3)
    assert.deepEqual([...back.data], [...data])
  })

  test('grey at 1 bit, unfiltered: each bit a black or white pixel', () => {
    const img = decodePng(png(8, 2, 1, 0, Uint8Array.from([0, 0b10100000, 0, 0b01000000])))
    assert.deepEqual(px(img, 0, 0), [255, 255, 255, 255])
    assert.deepEqual(px(img, 1, 0), [0, 0, 0, 255])
    assert.deepEqual(px(img, 2, 0), [255, 255, 255, 255])
    assert.deepEqual(px(img, 1, 1), [255, 255, 255, 255])
    assert.deepEqual(px(img, 0, 1), [0, 0, 0, 255])
  })

  test('a palette at 2 bits, with tRNS making index 1 clear', () => {
    const plte = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255])
    const img = decodePng(png(3, 1, 2, 3, Uint8Array.from([0, 0b00011000]), [['PLTE', plte], ['tRNS', Buffer.from([255, 0])]]))
    assert.deepEqual(px(img, 0, 0), [255, 0, 0, 255])
    assert.deepEqual(px(img, 1, 0), [0, 255, 0, 0])
    assert.deepEqual(px(img, 2, 0), [0, 0, 255, 255])
  })

  test('RGB at 16 bits keeps the high byte; its tRNS colour is clear', () => {
    const line = Uint8Array.from([0, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0, 1, 0, 2, 0, 3])
    const img = decodePng(png(2, 1, 16, 2, line, [['tRNS', Buffer.from([0, 1, 0, 2, 0, 3])]]))
    assert.deepEqual(px(img, 0, 0), [0x12, 0x56, 0x9a, 255])
    assert.deepEqual(px(img, 1, 0), [0, 0, 0, 0])
  })

  test('grey with alpha, and grey with a tRNS grey', () => {
    assert.deepEqual(px(decodePng(png(1, 1, 8, 4, Uint8Array.from([0, 100, 50]))), 0, 0), [100, 100, 100, 50])
    const g = decodePng(png(2, 1, 8, 0, Uint8Array.from([0, 7, 9]), [['tRNS', Buffer.from([0, 7])]]))
    assert.deepEqual(px(g, 0, 0), [7, 7, 7, 0])
    assert.deepEqual(px(g, 1, 0), [9, 9, 9, 255])
    // At 4 bits, 15 is white.
    assert.deepEqual(px(decodePng(png(1, 1, 4, 0, Uint8Array.from([0, 0xf0]))), 0, 0), [255, 255, 255, 255])
  })

  test('the up, average and Paeth filters', () => {
    // Two rows of RGB: the second filtered against the first.
    const row0 = [10, 20, 30, 40, 50, 60]
    const row1 = [11, 22, 33, 44, 55, 66]
    const enc = (f: number) => {
      const out = [f]
      for (let i = 0; i < 6; i++) {
        const a = i >= 3 ? row1[i - 3]! : 0
        const b = row0[i]!
        const c = i >= 3 ? row0[i - 3]! : 0
        const p = a + b - c
        const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c
        const pred = f === 2 ? b : f === 3 ? (a + b) >> 1 : pr
        out.push((row1[i]! - pred) & 255)
      }
      return out
    }
    for (const f of [2, 3, 4]) {
      const img = decodePng(png(2, 2, 8, 2, Uint8Array.from([0, ...row0, ...enc(f)])))
      assert.deepEqual([px(img, 0, 1), px(img, 1, 1)], [[11, 22, 33, 255], [44, 55, 66, 255]], `filter ${f}`)
    }
  })

  test('Adam7: an interlaced image lands where it should', () => {
    // 3×3 grey, values 0..8: passes 1 (0,0), 4 (2,0), 5 (0,2),(2,2), 6 (1,0),(1,2), 7 (0,1),(1,1),(2,1).
    const v = (x: number, y: number) => y * 3 + x
    const lines = [0, v(0, 0), 0, v(2, 0), 0, v(0, 2), v(2, 2), 0, v(1, 0), 0, v(1, 2), 0, v(0, 1), v(1, 1), v(2, 1)]
    const img = decodePng(png(3, 3, 8, 0, Uint8Array.from(lines), [], 1))
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) assert.equal(img.data[(y * 3 + x) * 4], v(x, y))
  })

  test('what it refuses: not a PNG, cut short, an odd depth, too many pixels, a bad filter, no palette', () => {
    assert.throws(() => decodePng(Buffer.from('nope')), /not a PNG/)
    const good = png(2, 2, 8, 0, Uint8Array.from([0, 1, 2, 0, 3, 4]))
    assert.throws(() => decodePng(good.subarray(0, 40)))
    assert.throws(() => decodePng(good.subarray(0, 45)), /cut short/)
    assert.throws(() => decodePng(png(1, 1, 3, 0, Uint8Array.from([0, 0]))), /unsupported/)
    assert.throws(() => decodePng(good, 3), /too large/)
    assert.throws(() => decodePng(png(1, 1, 8, 0, Uint8Array.from([9, 0]))), /bad PNG filter/)
    assert.throws(() => decodePng(png(1, 1, 8, 3, Uint8Array.from([0, 0]))), /palette/)
    assert.throws(() => decodePng(png(2, 2, 8, 0, Uint8Array.from([0, 1, 2]))), /cut short/)
  })
})

describe('scale and cropRows', () => {
  const two = { width: 2, height: 1, data: Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255]) }
  test('shrinking averages the pixels it covers; a clear one adds no colour', () => {
    assert.deepEqual(px(scale(two, 1, 1), 0, 0), [128, 0, 128, 255])
    const half = { width: 2, height: 1, data: Uint8Array.from([255, 0, 0, 255, 0, 0, 0, 0]) }
    assert.deepEqual(px(scale(half, 1, 1), 0, 0), [255, 0, 0, 128])
    assert.deepEqual(px(scale({ width: 1, height: 1, data: new Uint8Array(4) }, 1, 2), 0, 1), [0, 0, 0, 0])
  })
  test('growing repeats the nearest; the same size is the same image', () => {
    const big = scale(two, 4, 2)
    assert.deepEqual([px(big, 1, 1), px(big, 2, 0)], [[255, 0, 0, 255], [0, 0, 255, 255]])
    assert.equal(scale(two, 2, 1), two)
  })
  test('cropRows keeps the rows asked for, within the image', () => {
    const img = { width: 1, height: 3, data: Uint8Array.from([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]) }
    assert.deepEqual([...cropRows(img, 1, 9).data], [2, 2, 2, 2, 3, 3, 3, 3])
    assert.equal(cropRows(img, 2, 1).height, 0)
  })
})

describe('imageSize', () => {
  test('PNG, GIF, the three WebPs and JPEG, from their headers', () => {
    assert.deepEqual(imageSize(png(7, 5, 8, 0, new Uint8Array(40))), { width: 7, height: 5, type: 'png' })
    const gif = Buffer.alloc(13)
    gif.write('GIF89a')
    gif.writeUInt16LE(30, 6)
    gif.writeUInt16LE(20, 8)
    assert.deepEqual(imageSize(gif), { width: 30, height: 20, type: 'gif' })
    const webp = (kind: string, fill: (b: Buffer) => void) => {
      const b = Buffer.alloc(32)
      b.write('RIFF')
      b.write('WEBP', 8)
      b.write(kind, 12)
      fill(b)
      return b
    }
    assert.deepEqual(imageSize(webp('VP8 ', b => (b.writeUInt16LE(640, 26), b.writeUInt16LE(480, 28)))), { width: 640, height: 480, type: 'webp' })
    assert.deepEqual(imageSize(webp('VP8L', b => b.writeUInt32LE(99 | (49 << 14), 21))), { width: 100, height: 50, type: 'webp' })
    assert.deepEqual(imageSize(webp('VP8X', b => (b.writeUIntLE(299, 24, 3), b.writeUIntLE(199, 27, 3)))), { width: 300, height: 200, type: 'webp' })
    assert.equal(imageSize(webp('ALPH', () => {})), undefined)
    // JPEG: an APP0 segment, then a SOF0 with height 120, width 160.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xff, 0xc0, 0, 11, 8, 0, 120, 0, 160, 3, 0, 0, 0, 0])
    assert.deepEqual(imageSize(jpeg), { width: 160, height: 120, type: 'jpeg' })
    assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0])), undefined)
    assert.equal(imageSize(Buffer.from('hello there, not an image')), undefined)
    assert.equal(isPng(Buffer.from('x')), false)
  })
})
