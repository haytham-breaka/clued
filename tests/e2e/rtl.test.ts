// Right-to-left text: an Arabic message and an Arabic reply in display order, on the right of their
// bubbles; English, inline code, a path and a number in the right places; the input box; copying.
// Arabic joined by clued (presentation forms), or in Windows Terminal left for its font to join.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cells } from '../../app/text.ts'
import { withApp } from './harness.ts'
import type { App } from './harness.ts'

/**
 * Right-to-left text as a terminal that draws left to right must get it: its letters (each with
 * its marks, a lam with its alef) in reverse. The screen shows Arabic in its joined forms: NFKC
 * gives the plain letters back, a lam-alef as lam then alef.
 */
const vis = (s: string) => (s.match(/ل[اأإآ]\p{M}*|\P{M}\p{M}*/gu) ?? []).reverse().join('')
const plain = (s: string) => s.normalize('NFKC')

const MESSAGE = 'مرحبا، أريد رداً بالعربية'

/** The chat's rows (right of the panel), in plain letters. */
const chat = (app: App, s: string) => {
  const div = app.divider()
  return s.split('\n').map(l => plain([...l].slice(div).join('')))
}

describe('right-to-left text', () => {
  test('an Arabic message and its Arabic reply read from the right, each line on the right of its bubble', () =>
    withApp({ unfocused: true, env: { CLUED_BIDI: 'app' } }, async app => {
      await app.send(MESSAGE)
      const s = await app.waitIdle('npm test')
      const rows = chat(app, s)
      // Yours: reversed for the terminal, and the bubble snug around it.
      assert.ok(rows.some(r => r.endsWith(`│ ${vis(MESSAGE)} │`)), rows.join('\n'))
      // Claude's: the short first line on the right, the longer one filling the bubble.
      const first = rows.find(r => r.includes(vis('أهلاً بك! هذا رد بالعربية.')))!
      assert.match(first, /│ {3,}\S.*\S │$/)
      assert.ok(first.endsWith(`${vis('أهلاً بك! هذا رد بالعربية.')} │`), first)
      // English, inline code, a path and a number keep their own order, where the sentence puts them;
      // the full stop ends it, on the left.
      const mixed = `.${vis('دقائق')} 3 ${vis('في')} app/main.ts ${vis('افتح')} ${vis('ثم')} npm test ${vis('شغّل')}`
      assert.ok(rows.some(r => r.includes(`│ ${mixed} │`)), rows.join('\n'))
      // The panel's preview of the reply reads from the right too.
      assert.ok(plain(s).includes(vis('أهلاً بك!')))
      // VTE was told the app does it.
      assert.ok(app.output().includes('\x1b[8l'))
    }))

  test('a selection and /copy copy the text as written', () =>
    withApp({ unfocused: true, env: { CLUED_BIDI: 'app' } }, async app => {
      await app.send(MESSAGE)
      const s = await app.waitIdle('npm test')
      // From the first cell of your message to its last.
      const row = s.split('\n').findIndex(r => plain(r).endsWith(`${vis(MESSAGE)} │`))
      const line = s.split('\n')[row]!
      const end = cells(line) - 2
      const start = end - cells(MESSAGE) + 1
      await app.drag({ row: row + 1, col: start }, { row: row + 1, col: end })
      await app.waitClipboard(MESSAGE)
      await app.send('/copy')
      await app.waitClipboard('أهلاً بك! هذا رد بالعربية.\n\nشغّل `npm test` ثم افتح app/main.ts في 3 دقائق.')
    }))

  test('typing Arabic: the line on the right, the cursor where the next letter goes, ← on through the text', () =>
    withApp({ env: { CLUED_BIDI: 'app' } }, async app => {
      app.type('اكتب هنا')
      const s = await app.waitFor(t => plain(t).includes(vis('اكتب هنا')))
      const lines = s.split('\n')
      const r = lines.findIndex(l => plain(l).includes(vis('اكتب هنا')))
      const line = lines[r]!
      // Flush with the box's right border.
      assert.ok(plain(line).endsWith(`${vis('اكتب هنا')} │`), line)
      const right = cells(line) - 2
      const left = right - cells('اكتب هنا') + 1
      // At the end of the text: just left of its last letter.
      assert.deepEqual(app.cursor(), { row: r + 1, col: left - 1 })
      // Home: on the first letter, at the right.
      app.keys('Home')
      await app.waitFor(() => app.cursor().col === right)
      // ← goes on to the next letter, which is left of it; a letter typed there goes after the first.
      app.keys('Left')
      await app.waitFor(() => app.cursor().col === right - 1)
      app.type('و')
      await app.waitFor(t => plain(t).includes(vis('اوكتب هنا')))
      app.keys('Right')
      await app.waitFor(() => app.cursor().col === right - 1)
    }))

  test('in Windows Terminal: plain letters in display order for its font to join, a lam-alef one ligature', () =>
    withApp({ unfocused: true, env: { WT_SESSION: '0b7c0b6e-0000-4000-8000-000000000001' } }, async app => {
      await app.send(MESSAGE)
      const s = await app.waitIdle('npm test')
      const rows = s.split('\n').map(l => [...l].slice(app.divider()).join(''))
      // Yours, as it is on the screen: the letters reversed, each with its marks after it (the
      // tanween of رداً after its alef), and no joined forms.
      assert.ok(rows.some(r => r.endsWith(`│ ${vis(MESSAGE)} │`)), rows.join('\n'))
      // Claude's: the lam-alef of أهلاً after a heh is the final ligature, its tanween after it.
      const reply = '.ةيبرعلاب در اذه !كب \ufefcًهأ'
      assert.ok(rows.some(r => r.endsWith(`${reply} │`)), rows.join('\n'))
      // The bytes sent: the same, and no presentation form but the lam-alef ligatures.
      const out = app.output()
      assert.ok(out.includes(reply))
      assert.ok(!/[\ufb50-\ufdff\ufe70-\ufef4\ufefd-\ufeff]/u.test(out))
      // Still reordered by clued: VTE was told so.
      assert.ok(out.includes('\x1b[8l'))
      // The reply's first line (in the chat, below the panel's preview of it) copies as written, the
      // ligature as its two letters.
      const row = s.split('\n').findLastIndex(r => r.includes(reply))
      const end = cells(s.split('\n')[row]!) - 2
      await app.drag({ row: row + 1, col: end - cells(reply) + 1 }, { row: row + 1, col: end })
      await app.waitClipboard('أهلاً بك! هذا رد بالعربية.')
    }))

  test('CLUED_ARABIC=app joins the letters in clued, in Windows Terminal too', () =>
    withApp({ unfocused: true, env: { WT_SESSION: '0b7c0b6e-0000-4000-8000-000000000001', CLUED_ARABIC: 'app' } }, async app => {
      await app.send(MESSAGE)
      await app.waitIdle('npm test')
      // مرحبا's meem, initial; the reply's lam-alef, final.
      assert.ok(app.output().includes('\ufee3'))
      assert.ok(app.output().includes('\ufefc'))
    }))

  test('in terminal mode the text goes as written, for a terminal that reorders it itself', () =>
    withApp({ unfocused: true, env: { CLUED_BIDI: 'terminal' } }, async app => {
      await app.send(MESSAGE)
      const s = await app.waitIdle('npm test')
      assert.ok(s.split('\n').some(r => r.endsWith(`│ ${MESSAGE} │`)), s)
      assert.ok(!app.output().includes('\x1b[8l'))
    }))
})
