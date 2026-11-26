// The game (Ctrl+G): Comet, in the chat's place, while Claude works. Its keys go to it and never to
// the box (↑ there takes back your last message); Claude answering pauses it and says so, its view
// staying open; the best score is kept in panel.json; the window's size is followed.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { boardSize, newGame } from '../../app/game.ts'
import { rowOf, withApp } from './harness.ts'
import type { App } from './harness.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * At the harness's 120 × 34 the sky is its largest, 32 × 18. A seed whose first spark is in the
 * comet's row, ahead of it: flying straight on gathers it.
 */
const SKY = { w: 32, h: 18 }
const SEED = (() => {
  for (let seed = 1; ; seed++) {
    const g = newGame(SKY.w, SKY.h, 0, seed)
    if (g.spark!.y === g.body[0]!.y && g.spark!.x > g.body[0]!.x + 2) return seed
  }
})()

/** Whether the fake notifier (notify-send, osascript, or powershell.exe on WSL) was asked to show `title`. */
function notified(app: App, title: string): boolean {
  return app.read('notify.log').split('\n').some(l => {
    if (l.includes('notify-send') || l.includes('osascript')) return l.includes(title)
    if (!l.includes('powershell.exe') || l.includes('Clipboard')) return false
    return [...l.matchAll(/FromBase64String\('([^']*)'\)/g)].some(m => Buffer.from(m[1]!, 'base64').toString('utf8').includes(`<text>${title}</text>`))
  })
}

describe('the game (Ctrl+G)', () => {
  test('opens as a view while Claude works; plays; the score in its banner; Esc back; an arrow never takes back a message', () =>
    withApp({ env: { CLUED_QUEUE: '', CLUED_GAME_SEED: String(SEED) } }, async app => {
      assert.ok(boardSize(120 - 35 - 2, 28), 'the sky fits')
      await app.send('hold on')
      await app.waitFor('Slow work')
      // A message waiting in queue: ↑ in the empty box would take it back.
      await app.send('next please')
      let s = await app.waitFor('⏳ in queue')
      assert.match(s, /Claude is working… you can still send messages \(Esc interrupts · Ctrl\+G to play\)/)
      app.keys('C-g')
      s = await app.waitFor('Arrows or WASD to fly, Space to start')
      assert.match(rowOf(s, '← back'), /← back {2}✦ Comet {3}score 0 {2}best 0/)
      assert.match(s, /Playing Comet: your keys go to the game {3}\(Esc back to chat\)/)
      assert.match(s, new RegExp(`╭${'─'.repeat(SKY.w * 2)}╮`))
      assert.ok(!s.includes('Starting the slow work.'), 'the chat is not drawn under it')
      // Space starts it: flying straight on, the comet gathers the spark ahead of it.
      app.keys('Space')
      s = await app.waitFor('score 1', 8000)
      assert.match(s, /▓▓██|██▓▓/)
      // ↑ and ↓ steer the comet: nothing is taken back, nothing goes in the box.
      app.keys('Up')
      await sleep(250)
      app.keys('Down')
      await sleep(250)
      app.keys('Up', 'Up')
      await sleep(150)
      app.type('w')
      app.keys('Space')
      s = await app.waitFor('Paused · Space to play on')
      assert.ok(!s.includes('Took back your message'))
      assert.match(s, /│ Playing Comet: your keys go to the game/, 'nothing back in the box')
      // Esc: back to the chat, the message still in queue.
      app.keys('Escape')
      s = await app.waitFor('Starting the slow work.')
      assert.ok(!s.includes('← back'))
      assert.ok(!s.includes('Took back your message'))
      assert.match(s, /⏳ in queue/)
      assert.match(s, /│ Claude is working…/, 'the box is still empty')
      // The best score went to panel.json as the view closed.
      await app.waitFor(() => /"gameBest":[1-9]/.test(app.read('home/.clued/panel.json')))
      // Opened again: the run where it was, paused.
      app.keys('C-g')
      s = await app.waitFor('Paused · Space to play on')
      assert.match(s, /score [1-9]/)
      // A click on ← back closes it too.
      await app.click('← back')
      await app.waitGone('Paused · Space to play on')
      app.release('slow')
      await app.waitFor('The slow work is done.')
      await app.waitFor(() => app.sent().length === 2)
      assert.deepEqual(app.sent().map(m => m.text), ['hold on', 'next please'])
    }))

  test('Claude answering pauses it, and says so; the view stays open, and the next arrow goes to the game', () =>
    withApp({}, async app => {
      await app.send('hold on')
      await app.waitFor('Slow work')
      app.keys('C-g')
      await app.waitFor('Space to start')
      app.keys('Space')
      await sleep(300)
      app.release('slow')
      let s = await app.waitFor('Claude answered: Esc back to the chat')
      assert.match(s, /Space to play on/)
      assert.match(s, /← back {2}✦ Comet/)
      const before = s
      await sleep(400)
      assert.equal(app.screen().split('\n').filter(l => l.includes('██')).join(), before.split('\n').filter(l => l.includes('██')).join(), 'paused: the comet holds still')
      app.keys('Up')
      await sleep(200)
      s = app.screen()
      assert.ok(!s.includes('Took back'))
      assert.match(s, /Playing Comet/)
      // Space plays on, the note gone.
      app.keys('Space')
      await app.waitGone('Claude answered')
      // Leaving the window pauses it too.
      app.raw('\x1b[O')
      await app.waitFor('Paused · Space to play on')
      app.raw('\x1b[I')
      app.keys('Escape')
      await app.waitFor('The slow work is done.')
    }))

  test('game keys do not count as you being at the tab: a question while you play still notifies', () =>
    withApp({ env: { CLUED_ACTIVE_MS: '2000' } }, async app => {
      await app.send('offer choices later')
      app.keys('C-g')
      await app.waitFor('Space to start')
      app.keys('Space')
      // Playing past the active time, the window focused all along.
      for (let i = 0; i < 6; i++) {
        app.keys(i % 2 ? 'Right' : 'Down')
        await sleep(450)
      }
      app.release('ask')
      await app.waitFor('Claude asks you something: Esc back to the chat')
      await app.waitFor(() => notified(app, 'Claude asks you · work'))
      app.keys('Escape')
      await app.waitFor('Which database should we use?')
    }))

  test('follows the window: too small, one line asking for more; bigger again, the game; a new best is kept', () =>
    withApp({ setup: ({ home }) => { mkdirSync(join(home, '.clued'), { recursive: true }); writeFileSync(join(home, '.clued', 'panel.json'), JSON.stringify({ gameBest: 40 })) } }, async app => {
      app.keys('C-g')
      let s = await app.waitFor('Space to start')
      assert.match(rowOf(s, '← back'), /score 0 {2}best 40/)
      app.resize(60, 13)
      s = await app.waitFor('Make the window bigger')
      assert.equal(s.split('\n').filter(l => l.includes('Make the window')).length, 1)
      app.resize(120, 34)
      s = await app.waitFor('Space to start')
      app.resize(80, 24)
      s = await app.waitFor(t => /╭─+╮/.test(t) && t.includes('Space to start'))
      const frame = s.split('\n').find(l => /╭─+╮/.test(l))!
      assert.ok(frame.length <= 80)
      // Ctrl+G closes it as well.
      app.keys('C-g')
      await app.waitGone('Space to start')
      assert.match(app.read('home/.clued/panel.json'), /"gameBest":40/)
    }))
})

