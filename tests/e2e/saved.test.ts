// Saved messages: ☆ save under a reply part or one of your messages, the panel's ★ Saved list
// (a click jumps, ✕ unsaves), Alt+S on the picked message, and the list coming back on resume.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chatRowsWith, rowOf, withApp, writeSession } from './harness.ts'

const t0 = Date.parse('2026-11-25T10:00:00.000Z')
const history = [
  { type: 'user', timestamp: new Date(t0).toISOString(), message: { role: 'user', content: 'remember this question' } },
  { type: 'assistant', timestamp: new Date(t0 + 2000).toISOString(), message: { content: [{ type: 'text', text: 'A reply worth keeping.' }] } },
]

describe('saved messages', () => {
  test('save a reply part and your own message; ★ Saved lists both, a click jumps, ✕ unsaves, Alt+S saves', () =>
    withApp({ unfocused: true, height: 30 }, async app => {
      await app.send('please split')
      await app.waitFor('And this part answers the split request.')
      // A reply part: its own ☆ save.
      await app.hover('And this part answers', { area: 'chat' })
      await app.click('☆ save', { area: 'chat' })
      let s = await app.waitFor('★ Saved')
      assert.match(rowOf(s, '★ Saved'), /★ Saved +1/)
      // Your own message.
      await app.hover('please split', { area: 'chat' })
      await app.click('☆ save', { area: 'chat' })
      s = await app.waitFor(/★ Saved +2/)
      assert.match(s, / you please split/)
      assert.match(s, /✻ And this part answers/)
      // Unhovered, the bubbles say they are saved.
      await app.hover({ row: 1, col: 110 })
      s = await app.waitFor(s => chatRowsWith(s, '★ saved') === 2)
      // More messages push the saved one off the chat; a click in the panel brings it back.
      for (const m of ['one', 'two', 'three', 'four']) {
        await app.send(`filler message ${m} with a few more words to fill the chat`)
        await app.waitFor(`Echo: filler message ${m}`)
      }
      await app.waitFor(s => chatRowsWith(s, 'And this part answers the split request.') === 0)
      await app.click('✻ And this part answers', { area: 'panel' })
      await app.waitFor(s => chatRowsWith(s, 'And this part answers the split request.') === 1)
      // ✕ unsaves.
      await app.click('✕ you please split', { area: 'panel' })
      s = await app.waitFor(/★ Saved +1/)
      assert.ok(!s.includes(' you please split'))
      // Alt+S on the message Alt+↑ picked saves it again.
      app.keys('M-s')
      await app.waitFor('Pick one of your messages')
      app.keys('M-Up')
      await app.waitFor(/★ Saved +1/)
      app.keys('M-s')
      await app.waitFor(/★ Saved +2/)
      await app.waitFor('Saved: it is under ★ Saved in the panel.')
      app.keys('M-s')
      await app.waitFor(/★ Saved +1/)
      await app.waitFor('Unsaved.')
    }))

  test('hovering ★ saved moves nothing: it and what follows it keep their columns, and so does a click on it', () =>
    withApp({ unfocused: true, height: 40 }, async app => {
      await app.send('first message')
      await app.waitIdle('Echo: first message')
      await app.send('please split')
      await app.waitIdle('And this part answers the split request.')
      const away = { row: 1, col: 110 }
      /** Where each of `texts` is on the row of `on` (the action row), as columns. */
      const cols = async (on: string, texts: string[]) => {
        await app.settle()
        const row = (await app.at(on, { area: 'chat' })).row
        return texts.map(t => {
          for (let n = 0; ; n++) {
            const p = app.find(t, { area: 'chat', nth: n })
            if (!p) return -1
            if (p.row === row) return p.col
          }
        })
      }
      /** Saves the message under `text`, reacts `emoji` (when given), then hovers ★ saved itself. */
      const check = async (text: string, after: string[], emoji?: string) => {
        await app.hover(text, { area: 'chat' })
        await app.click('☆ save', { area: 'chat' })
        if (emoji) {
          await app.hover(text, { area: 'chat' })
          await app.click(emoji, { area: 'chat' })
        }
        await app.hover(away)
        await app.waitFor(s => chatRowsWith(s, '★ saved') === 1)
        const before = await cols('★ saved', ['★ saved', ...after])
        assert.ok(before.every(c => c > 0), `all on the row before hover: ${before} ${after}`)
        await app.hover('★ saved', { area: 'chat' })
        await app.waitFor('⧉ copy')
        assert.deepEqual(await cols('★ saved', ['★ saved', ...after]), before, `${text}: hovering ★ saved moved the row\n${app.screen()}`)
        // Unsaving it (a click) moves nothing either.
        await app.click('★ saved', { area: 'chat' })
        await app.waitFor(s => chatRowsWith(s, '★ saved') === 0)
        assert.deepEqual(await cols('☆ save', ['☆ save', ...after]), before, `${text}: unsaving moved the row\n${app.screen()}`)
        await app.hover(away)
        await app.settle()
      }
      // Your message: ★ saved and its delivery mark after it.
      await check('please split', ['✓✓'])
      // One part of a reply in parts, with a reaction of yours after ★ saved.
      await check('And this part answers', ['❓'], '❓')
      // A reply in one part.
      await check('Echo: first message', ['👀'], '👀')
    }))

  test('saved messages are still saved after a resume, and a click opens them', async () => {
    let kept = ''
    const setup = (a: { home: string; work: string }) => {
      writeSession(a.home, a.work, 'old-1', history)
      if (kept) {
        mkdirSync(join(a.home, '.clued', 'sessions'), { recursive: true })
        writeFileSync(join(a.home, '.clued', 'sessions', 'old-1.json'), kept)
      }
    }
    await withApp({ setup, args: ['--resume', 'old-1'], unfocused: true, height: 30 }, async app => {
      await app.waitFor('A reply worth keeping.')
      await app.hover('A reply worth keeping.', { area: 'chat' })
      await app.click('☆ save', { area: 'chat' })
      await app.waitFor(/★ Saved +1/)
      await app.hover('remember this question', { area: 'chat' })
      await app.click('☆ save', { area: 'chat' })
      await app.waitFor(/★ Saved +2/)
      const file = join(app.home, '.clued', 'sessions', 'old-1.json')
      const until = Date.now() + 5000
      const count = () => { try { return JSON.parse(readFileSync(file, 'utf8')).saved?.length ?? 0 } catch { return 0 } }
      while (Date.now() < until && count() < 2) await new Promise(r => setTimeout(r, 50))
      kept = readFileSync(file, 'utf8')
    })
    assert.equal(JSON.parse(kept).saved.length, 2)
    await withApp({ setup, args: ['--resume', 'old-1'], unfocused: true, height: 30 }, async app => {
      const s = await app.waitFor(/★ Saved +2/)
      assert.match(s, / you remember this/)
      assert.match(s, /✻ A reply worth keeping\./)
      await app.click(' you remember this', { area: 'panel' })
      await app.hover({ row: 1, col: 110 })
      await app.waitFor(s => chatRowsWith(s, '★ saved') === 2)
    })
  })
})
