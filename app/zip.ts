// A few files out of a zip on a web server, without the whole zip: its central directory read from
// the end (one HTTP range), then each file's bytes (one range each), inflated here. For /setup's
// fonts: two 2.5 MB fonts out of a 150 MB release zip.

import { inflateRawSync } from 'node:zlib'

/** Bytes `from` to `to` (inclusive) of the file. */
export type GetRange = (from: number, to: number) => Promise<Uint8Array>

export type Entry = { name: string; method: number; compressed: number; size: number; offset: number }

const u16 = (b: Buffer, at: number) => b.readUInt16LE(at)
const u32 = (b: Buffer, at: number) => b.readUInt32LE(at)

/** The zip's entries, from its central directory. `size`: the whole zip's size. */
export async function entries(get: GetRange, size: number): Promise<Entry[]> {
  const tailFrom = Math.max(0, size - 65_557)
  const tail = Buffer.from(await get(tailFrom, size - 1))
  let at = -1
  for (let k = tail.length - 22; k >= 0; k--)
    if (u32(tail, k) === 0x06054b50) {
      at = k
      break
    }
  if (at < 0) throw new Error('not a zip (no end of central directory)')
  const count = u16(tail, at + 10)
  const cdSize = u32(tail, at + 12)
  const cdAt = u32(tail, at + 16)
  if (cdAt === 0xffffffff || count === 0xffff) throw new Error('a zip64 file, which this does not read')
  if (cdAt + cdSize > size) throw new Error('the central directory is past the end of the file')
  const cd = cdAt >= tailFrom ? tail.subarray(cdAt - tailFrom, cdAt - tailFrom + cdSize) : Buffer.from(await get(cdAt, cdAt + cdSize - 1))
  const out: Entry[] = []
  for (let p = 0; p + 46 <= cd.length && out.length < count; ) {
    if (u32(cd, p) !== 0x02014b50) throw new Error('a bad central directory entry')
    const nameLen = u16(cd, p + 28)
    out.push({ name: cd.subarray(p + 46, p + 46 + nameLen).toString('utf8'), method: u16(cd, p + 10), compressed: u32(cd, p + 20), size: u32(cd, p + 24), offset: u32(cd, p + 42) })
    p += 46 + nameLen + u16(cd, p + 30) + u16(cd, p + 32)
  }
  return out
}

/** One entry's bytes, read and inflated (stored or deflated). */
export async function extract(get: GetRange, e: Entry): Promise<Buffer> {
  const head = Buffer.from(await get(e.offset, e.offset + 29))
  if (head.length < 30 || u32(head, 0) !== 0x04034b50) throw new Error(`a bad local header for ${e.name}`)
  const from = e.offset + 30 + u16(head, 26) + u16(head, 28)
  const raw = e.compressed ? Buffer.from(await get(from, from + e.compressed - 1)) : Buffer.alloc(0)
  if (raw.length !== e.compressed) throw new Error(`${e.name} came short (${raw.length} of ${e.compressed} bytes)`)
  const data = e.method === 0 ? raw : e.method === 8 ? inflateRawSync(raw) : undefined
  if (!data) throw new Error(`${e.name} is compressed in a way this does not read (${e.method})`)
  if (data.length !== e.size) throw new Error(`${e.name} unpacked to ${data.length} bytes, not ${e.size}`)
  return data
}
