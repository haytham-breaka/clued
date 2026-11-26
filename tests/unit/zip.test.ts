// Files out of a zip by ranges: the central directory from the end, then each entry, stored or
// deflated; zips it can't read are refused with why.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { entries, extract } from '../../app/zip.ts'
import { makeZip, ranges } from './zip-make.ts'

describe('zip by ranges', () => {
  test('lists the entries and extracts one, deflated or stored, reading only what it needs', async () => {
    const zip = makeZip([{ name: 'a/one.ttf', data: Buffer.from('hello font') }, { name: 'b.txt', data: Buffer.from('plain'), method: 0, extra: 5 }], 100_000)
    const r = ranges(zip)
    const list = await entries(r.get, zip.length)
    assert.deepEqual(list.map(e => [e.name, e.method, e.size]), [['a/one.ttf', 8, 10], ['b.txt', 0, 5]])
    // The central directory sat in the tail read: one range so far.
    assert.equal(r.asked.length, 1)
    assert.equal((await extract(r.get, list[0]!)).toString(), 'hello font')
    assert.equal((await extract(r.get, list[1]!)).toString(), 'plain')
    // A central directory longer than the tail read: read with a range of its own.
    const many = makeZip(Array.from({ length: 1500 }, (_, k) => ({ name: `fonts/${String(k).padStart(40, '0')}.ttf`, data: Buffer.from(String(k)), method: 0 as const })))
    const r2 = ranges(many)
    const l2 = await entries(r2.get, many.length)
    assert.equal(l2.length, 1500)
    assert.equal(r2.asked.length, 2)
    assert.equal((await extract(r2.get, l2[1234]!)).toString(), '1234')
    // An empty entry needs no range for its bytes.
    const empty = makeZip([{ name: 'e', data: new Uint8Array(0), method: 0 }])
    const r3 = ranges(empty)
    assert.equal((await extract(r3.get, (await entries(r3.get, empty.length))[0]!)).length, 0)
  })

  test('refuses what it cannot read', async () => {
    const zip = makeZip([{ name: 'a', data: Buffer.from('abc') }])
    const r = ranges(zip)
    await assert.rejects(entries(ranges(Buffer.alloc(100)).get, 100), /not a zip/)
    const z64 = Buffer.from(zip)
    z64.writeUInt32LE(0xffffffff, z64.length - 6)
    await assert.rejects(entries(ranges(z64).get, z64.length), /zip64/)
    const past = Buffer.from(zip)
    past.writeUInt32LE(zip.length, past.length - 6)
    await assert.rejects(entries(ranges(past).get, past.length), /past the end/)
    const badCd = Buffer.from(zip)
    badCd.writeUInt32LE(0, badCd.readUInt32LE(badCd.length - 6))
    await assert.rejects(entries(ranges(badCd).get, badCd.length), /bad central directory/)
    const [e] = await entries(r.get, zip.length)
    await assert.rejects(extract(r.get, { ...e!, offset: 1 }), /bad local header/)
    await assert.rejects(extract(async (a, b) => new Uint8Array(zip.subarray(a, Math.min(b + 1, a === 0 ? 30 : a + 1))), e!), /came short/)
    await assert.rejects(extract(r.get, { ...e!, method: 12 }), /compressed in a way/)
    await assert.rejects(extract(r.get, { ...e!, size: 4 }), /unpacked to 3 bytes, not 4/)
  })
})
