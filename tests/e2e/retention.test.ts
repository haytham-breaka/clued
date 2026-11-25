// What clued keeps only for a while: at start the app trims sent.log to its last 7 days, and deletes
// pasted images over 30 days old that no session's kept state names.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withApp } from './harness.ts'

const DAY = 86_400_000
const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString()

describe('retention', () => {
  test('at start, sent.log keeps its last week and old pasted images no message names are deleted', () => {
    let images = ''
    return withApp({
      setup: ({ home }) => {
        const clued = join(home, '.clued')
        images = join(clued, 'images')
        mkdirSync(images, { recursive: true })
        mkdirSync(join(clued, 'sessions'), { recursive: true })
        writeFileSync(join(clued, 'sent.log'), `${at(30)} sent {"session":"s0","text":"a month ago"}\n${at(2)} sent {"session":"s0","text":"two days ago"}\n`)
        const old = (Date.now() - 60 * DAY) / 1000
        for (const n of ['1000', '1001', '1002']) {
          writeFileSync(join(images, `${n}.png`), 'png')
          if (n !== '1002') utimesSync(join(images, `${n}.png`), old, old)
        }
        // 1000 was sent with a message: its [image 1] still opens it.
        writeFileSync(join(clued, 'sessions', 's0.json'), JSON.stringify({ board: {}, reactions: {}, links: {}, images: { k: [join(images, '1000.png')] } }))
      },
    }, async app => {
      await app.send('hello there')
      await app.waitFor('Echo: hello there')
      const log = app.read('home/.clued/sent.log')
      assert.doesNotMatch(log, /a month ago/)
      assert.match(log, /two days ago/)
      assert.match(log, /sent \{"session":"s1","topic":"T1","text":"hello there"/)
      assert.ok(existsSync(join(images, '1000.png')), 'sent with a message: kept')
      assert.ok(!existsSync(join(images, '1001.png')), 'old, and no message names it: deleted')
      assert.ok(existsSync(join(images, '1002.png')), 'recent: kept')
    })
  })

  test('CLUED_LOG_DAYS=0 and CLUED_IMAGE_DAYS=0 keep everything', () => {
    let images = ''
    return withApp({
      env: { CLUED_LOG_DAYS: '0', CLUED_IMAGE_DAYS: '0' },
      setup: ({ home }) => {
        const clued = join(home, '.clued')
        images = join(clued, 'images')
        mkdirSync(images, { recursive: true })
        writeFileSync(join(clued, 'sent.log'), `${at(400)} sent {"session":"s0","text":"last year"}\n`)
        writeFileSync(join(images, '1000.png'), 'png')
        const old = (Date.now() - 400 * DAY) / 1000
        utimesSync(join(images, '1000.png'), old, old)
      },
    }, async app => {
      await app.send('hello there')
      await app.waitFor('Echo: hello there')
      assert.match(app.read('home/.clued/sent.log'), /last year/)
      assert.ok(existsSync(join(images, '1000.png')))
    })
  })
})
