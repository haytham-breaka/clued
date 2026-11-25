import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanImages, DAY_MS, envLimit, keptImages, limits, trimLog, trimLogFile } from '../../app/retention.ts'

const root = mkdtempSync(join(tmpdir(), 'clued-retention-'))
after(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const fresh = () => {
  const d = join(root, String(n++))
  mkdirSync(d, { recursive: true })
  return d
}

const NOW = Date.UTC(2026, 10, 26, 12)
const line = (daysAgo: number, what = 'sent', text = 'hi') => `${new Date(NOW - daysAgo * DAY_MS).toISOString()} ${what} ${JSON.stringify({ session: 's1', text })}`
const WEEK = 7 * DAY_MS

describe('limits', () => {
  test('7 days and 5 MB of sent.log, images for 30 days, unless the environment says otherwise', () => {
    assert.deepEqual(limits({}), { logMs: WEEK, logBytes: 5 * 1024 * 1024, imageMs: 30 * DAY_MS })
    assert.deepEqual(limits({ CLUED_LOG_DAYS: '2', CLUED_LOG_MB: '0.5', CLUED_IMAGE_DAYS: '90' }), { logMs: 2 * DAY_MS, logBytes: 512 * 1024, imageMs: 90 * DAY_MS })
  })

  test('0 turns a limit off; a value that is no number from 0 up keeps the default', () => {
    assert.equal(envLimit('0', 7), Infinity)
    assert.equal(envLimit('', 7), 7)
    assert.equal(envLimit('  ', 7), 7)
    assert.equal(envLimit(undefined, 7), 7)
    assert.equal(envLimit('soon', 7), 7)
    assert.equal(envLimit('-1', 7), 7)
    assert.equal(envLimit('Infinity', 7), 7)
    assert.equal(limits({ CLUED_IMAGE_DAYS: '0' }).imageMs, Infinity)
  })
})

describe('trimLog', () => {
  test('entries older than the limit go, recent ones stay, in order', () => {
    const text = [line(10, 'sent', 'old'), line(8, 'enter', 'older'), line(6, 'sent', 'recent'), line(0, 'sent', 'now')].join('\n') + '\n'
    assert.equal(trimLog(text, NOW, WEEK, Infinity), [line(6, 'sent', 'recent'), line(0, 'sent', 'now')].join('\n') + '\n')
  })

  test('nothing to drop gives the same text back; an empty log stays empty', () => {
    const text = `${line(1)}\n${line(0)}\n`
    assert.equal(trimLog(text, NOW, WEEK, Infinity), text)
    assert.equal(trimLog('', NOW, WEEK, Infinity), '')
    assert.equal(trimLog(`${line(30)}\n`, NOW, WEEK, Infinity), '')
  })

  test('a last line cut short stays when recent, ended with its newline; an old one goes', () => {
    const partial = line(0).slice(0, -12)
    assert.equal(trimLog(`${line(1)}\n${partial}`, NOW, WEEK, Infinity), `${line(1)}\n${partial}\n`)
    assert.equal(trimLog(`${line(1)}\n${line(9).slice(0, -5)}`, NOW, WEEK, Infinity), `${line(1)}\n`)
  })

  test('a line with no time at its start (garbage, a torn write) goes', () => {
    const text = `${line(2)}\n\u0000\u0000garbage\n\n{"text":"no time"}\n${line(1)}\n`
    assert.equal(trimLog(text, NOW, WEEK, Infinity), `${line(2)}\n${line(1)}\n`)
  })

  test('the size cap keeps the newest whole lines that fit', () => {
    const lines = [line(3, 'sent', 'a'), line(2, 'sent', 'b'), line(1, 'sent', 'ü'), line(0, 'sent', 'd')]
    const size = (ls: string[]) => Buffer.byteLength(ls.map(l => `${l}\n`).join(''))
    const text = lines.map(l => `${l}\n`).join('')
    assert.equal(trimLog(text, NOW, WEEK, size(lines)), text)
    assert.equal(trimLog(text, NOW, WEEK, size(lines) - 1), lines.slice(1).map(l => `${l}\n`).join(''))
    assert.equal(trimLog(text, NOW, WEEK, size(lines.slice(2))), lines.slice(2).map(l => `${l}\n`).join(''), 'counts bytes, not characters')
    assert.equal(trimLog(text, NOW, WEEK, 10), '', 'a cap smaller than one line keeps nothing')
  })

  test('the tail of a bigger file: its first, partial line goes', () => {
    const text = `${line(1).slice(20)}\n${line(0)}\n`
    assert.equal(trimLog(text, NOW, WEEK, Infinity, true), `${line(0)}\n`)
  })
})

describe('trimLogFile', () => {
  test('rewrites the file with what stays, and leaves no temp file behind', () => {
    const d = fresh()
    const log = join(d, 'sent.log')
    writeFileSync(log, `${line(20)}\n${line(3)}\n${line(0)}`)
    assert.equal(trimLogFile(log, { logMs: WEEK, logBytes: Infinity }, NOW), true)
    assert.equal(readFileSync(log, 'utf8'), `${line(3)}\n${line(0)}\n`)
    assert.deepEqual(readdirSync(d), ['sent.log'])
    // Already trimmed: it leaves the file alone.
    assert.equal(trimLogFile(log, { logMs: WEEK, logBytes: Infinity }, NOW), false)
  })

  test('a file over the cap: only its tail is read, and the newest lines that fit stay', () => {
    const d = fresh()
    const log = join(d, 'sent.log')
    const lines = Array.from({ length: 2000 }, (_, i) => line(1 - i / 2000, 'sent', `message ${i}`))
    writeFileSync(log, lines.map(l => `${l}\n`).join(''))
    const cap = 10_000
    assert.equal(trimLogFile(log, { logMs: WEEK, logBytes: cap }, NOW), true)
    const out = readFileSync(log, 'utf8')
    assert.ok(Buffer.byteLength(out) <= cap, `${Buffer.byteLength(out)} bytes`)
    assert.ok(Buffer.byteLength(out) > cap - 200, 'about the cap')
    const kept = out.split('\n').filter(Boolean)
    assert.equal(kept.at(-1), lines.at(-1))
    assert.deepEqual(kept, lines.slice(-kept.length), 'whole lines, the newest, in order')
  })

  test('no log yet: nothing to do', () => {
    const d = fresh()
    assert.equal(trimLogFile(join(d, 'sent.log'), { logMs: WEEK, logBytes: Infinity }, NOW), false)
    assert.deepEqual(readdirSync(d), [])
  })

  test('a log it cannot rewrite stays as it was', () => {
    const d = fresh()
    const log = join(d, 'sent.log')
    writeFileSync(log, `${line(20)}\n${line(0)}\n`)
    // A folder where the temp file would go: writing it fails.
    mkdirSync(`${log}.${process.pid}.tmp`)
    assert.equal(trimLogFile(log, { logMs: WEEK, logBytes: Infinity }, NOW), false)
    assert.equal(readFileSync(log, 'utf8'), `${line(20)}\n${line(0)}\n`)
  })
})

describe('images', () => {
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
  /** A pasted image, `daysAgo` old. */
  const paste = (dir: string, name: string, daysAgo: number) => {
    const p = join(dir, name)
    writeFileSync(p, PNG)
    const t = (NOW - daysAgo * DAY_MS) / 1000
    utimesSync(p, t, t)
    return p
  }
  const setup = () => {
    const d = fresh()
    const images = join(d, 'images')
    const sessions = join(d, 'sessions')
    mkdirSync(images)
    mkdirSync(sessions)
    return { images, sessions }
  }

  test('keptImages: the files messages were sent with, and those of held messages', () => {
    assert.deepEqual(keptImages({ images: { k1: ['/tmp/a.png', '/tmp/b.png'], k2: ['/tmp/c.png', 3] }, held: [{ text: 'x', from: { images: [{ path: '/tmp/d.png', media: 'image/png' }] } }, { text: 'y', from: {} }, null] }), ['/tmp/a.png', '/tmp/b.png', '/tmp/c.png', '/tmp/d.png'])
    assert.deepEqual(keptImages({}), [])
    assert.deepEqual(keptImages(null), [])
    assert.deepEqual(keptImages({ images: { k: 'not a list' }, held: 'no' }), [])
  })

  test('an old pasted image no session names goes; a recent one, a named one, one in use and other files stay', () => {
    const { images, sessions } = setup()
    const sent = paste(images, '1000.png', 60)
    const held = paste(images, '1001.png', 60)
    paste(images, '1002.png', 60)
    paste(images, '1003.png', 10)
    const box = paste(images, '1004.png', 60)
    paste(images, 'mine.png', 60)
    mkdirSync(join(images, '1005.png'))
    utimesSync(join(images, '1005.png'), (NOW - 60 * DAY_MS) / 1000, (NOW - 60 * DAY_MS) / 1000)
    writeFileSync(join(sessions, 's1.json'), JSON.stringify({ board: {}, images: { k: [sent] } }))
    writeFileSync(join(sessions, 's2.json'), JSON.stringify({ board: {}, held: [{ text: 't', from: { images: [{ path: held }] } }] }))
    writeFileSync(join(sessions, 'notes.txt'), 'not a session')
    assert.deepEqual(cleanImages(images, sessions, 30 * DAY_MS, NOW, [box]), ['1002.png'])
    assert.deepEqual(readdirSync(images).sort(), ['1000.png', '1001.png', '1003.png', '1004.png', '1005.png', 'mine.png'])
  })

  test('a session file it cannot read: it deletes nothing, as it cannot tell what is still wanted', () => {
    const { images, sessions } = setup()
    paste(images, '2000.png', 60)
    writeFileSync(join(sessions, 's1.json'), '{"images": {"k": [')
    assert.deepEqual(cleanImages(images, sessions, 30 * DAY_MS, NOW), [])
    assert.ok(existsSync(join(images, '2000.png')))
  })

  test('no sessions folder: no image is named, so old ones go', () => {
    const { images } = setup()
    paste(images, '3000.png', 60)
    assert.deepEqual(cleanImages(images, join(images, 'nowhere'), 30 * DAY_MS, NOW), ['3000.png'])
  })

  test('a sessions path that is no folder: it deletes nothing', () => {
    const { images, sessions } = setup()
    paste(images, '3500.png', 60)
    const file = join(sessions, 'file')
    writeFileSync(file, '')
    assert.deepEqual(cleanImages(images, file, 30 * DAY_MS, NOW), [])
  })

  test('no limit (CLUED_IMAGE_DAYS=0), no images folder, nothing old: nothing goes', () => {
    const { images, sessions } = setup()
    paste(images, '4000.png', 400)
    assert.deepEqual(cleanImages(images, sessions, Infinity, NOW), [])
    assert.deepEqual(cleanImages(join(images, 'missing'), sessions, 30 * DAY_MS, NOW), [])
    paste(images, '4001.png', 1)
    assert.deepEqual(cleanImages(images, join(images, 'missing'), 500 * DAY_MS, NOW), [])
    assert.deepEqual(readdirSync(images).sort(), ['4000.png', '4001.png'])
  })
})
