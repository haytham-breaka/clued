// Zips made in memory for the tests (zip.test.ts, setup.test.ts), and ranges of them.

import { crc32, deflateRawSync } from 'node:zlib'

/** A zip of `files`, deflated (8) or stored (0), with `pad` bytes of nothing before the first. */
export function makeZip(files: { name: string; data: Uint8Array; method?: 0 | 8; extra?: number }[], pad = 0): Buffer {
  const parts: Buffer[] = [Buffer.alloc(pad)]
  const central: Buffer[] = []
  let at = pad
  for (const f of files) {
    const method = f.method ?? 8
    const body = method === 8 ? deflateRawSync(f.data) : Buffer.from(f.data)
    const name = Buffer.from(f.name)
    const extra = Buffer.alloc(f.extra ?? 0)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc32(f.data), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(f.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(extra.length, 28)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(crc32(f.data), 16)
    cd.writeUInt32LE(body.length, 20)
    cd.writeUInt32LE(f.data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(at, 42)
    central.push(cd, name)
    parts.push(local, name, extra, body)
    at += 30 + name.length + extra.length + body.length
  }
  const cdBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cdBuf.length, 12)
  end.writeUInt32LE(at, 16)
  return Buffer.concat([...parts, cdBuf, end])
}

/** Ranges of `zip`, each one asked for logged. */
export function ranges(zip: Buffer) {
  const asked: [number, number][] = []
  return { asked, get: async (from: number, to: number) => (asked.push([from, to]), new Uint8Array(zip.subarray(from, to + 1))) }
}
