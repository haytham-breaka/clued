// The mouse: selecting text (drag, double-click) and copying it; reply and react on hover.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { rowOf, withApp } from './harness.ts'
import type { App } from './harness.ts'

/** Two messages, the second answered in two parts. */
async function split(app: App) {
  await app.send('first message')
  await app.waitFor('Echo: first message')
  await app.send('please split')
  await app.waitFor('And this part answers the split request.')
}

describe('mouse', () => {
  test('drag to select in the chat copies the text; across lines it drops the bubble borders', () =>
    withApp({ unfocused: true }, async app => {
      await split(app)
      // Positions are looked up just before each drag: a toast ("Copied …") moves the chat up a row.
      let a = await app.at('More about', { area: 'chat' })
      await app.drag(a, { row: a.row, col: a.col + 9 })
      await app.waitFor('Copied 10 characters.')
      await app.waitClipboard('More about')
      // From inside one bubble to inside the next: just the words, no borders or quote tags.
      a = await app.at('More about', { area: 'chat' })
      const b = await app.at('split request.', { area: 'chat' })
      await app.drag(a, { row: b.row, col: b.col + 13 })
      await app.waitClipboard('More about your first message: part one.\n\nAnd this part answers the split request.')
      // Ctrl+C copies a selection again; Esc drops it.
      a = await app.at('More about', { area: 'chat' })
      await app.drag(a, { row: a.row, col: a.col + 3 })
      await app.waitClipboard('More')
      app.keys('C-c')
      await app.waitFor('Copied.')
      a = await app.at('More about', { area: 'chat' })
      await app.drag(a, { row: a.row, col: a.col + 1 })
      await app.waitClipboard('Mo')
      app.keys('Escape')
      // A press that does not move is a click, not a selection.
      a = await app.at('More about', { area: 'chat' })
      app.raw(`\x1b[<0;${a.col};${a.row}M\x1b[<32;${a.col};${a.row}M\x1b[<0;${a.col};${a.row}m`)
    }))

  test('dragging past the top of the chat scrolls it while selecting', () =>
    withApp({ unfocused: true, height: 20 }, async app => {
      for (const m of ['one', 'two', 'three']) {
        await app.send(`message ${m}`)
        await app.waitFor(`Echo: message ${m}`)
      }
      const a = await app.at('Echo: message three', { area: 'chat' })
      app.raw(`\x1b[<0;${a.col};${a.row}M`)
      for (let i = 0; i < 4; i++) app.raw(`\x1b[<32;${a.col};1M`)
      await app.waitFor('more lines')
      app.raw(`\x1b[<32;${a.col};19M`)
      app.raw(`\x1b[<0;${a.col};19m`)
      await app.waitFor(/Copied \d+ characters\./)
    }))

  test('double-click selects and copies a word; in the input box too, and typing replaces it', () =>
    withApp({ unfocused: true }, async app => {
      await split(app)
      const b = await app.at('split request', { area: 'chat' })
      const dbl = (row: number, col: number) => app.raw(`\x1b[<0;${col};${row}M\x1b[<0;${col};${row}m\x1b[<0;${col};${row}M\x1b[<0;${col};${row}m`)
      dbl(b.row, b.col + 2)
      await app.waitFor('Copied “split”.')
      await app.waitClipboard('split')
      // On a space: nothing to select.
      dbl(b.row, b.col + 5)
      // The input box: double-click a word, then type over it.
      app.type('hello wide world')
      const w = await app.at('wide', { area: 'chat' })
      dbl(w.row, w.col + 1)
      await app.waitFor('Copied “wide”.')
      app.type('big')
      await app.waitFor('hello big world')
      // Drag over a word in the input and delete it with Backspace.
      const h = await app.at('hello big', { area: 'chat' })
      await app.drag(h, { row: h.row, col: h.col + 5 })
      await app.waitClipboard('hello ')
      app.keys('BSpace')
      await app.waitFor(/│ big world +│/)
      // A click in the text moves the cursor there.
      const at = await app.at('big world', { area: 'chat' })
      await app.click({ row: at.row, col: at.col + 3 })
      app.type('!')
      await app.waitFor('big! world')
    }))

  test('a reply to a message from before a compaction brings its request\'s chain to Claude; a recent one does not', () =>
    withApp({ unfocused: true, height: 70 }, async app => {
      await app.send('deploy the api on port 8137')
      await app.waitFor('Echo: deploy the api on port 8137')
      await app.send('compact now')
      await app.waitFor('Compacted.')
      await app.send('fresh one')
      await app.waitFor('Echo: fresh one')
      // A recent message: the note is the plain one.
      await app.hover('fresh one', { area: 'chat' })
      await app.click('↩ reply', { area: 'chat' })
      await app.send('about the fresh one')
      await app.waitFor('Echo: about the fresh one')
      assert.ok(!app.sent().at(-1)!.note.includes('Earlier in this request'))
      // From before the compaction: its chain comes along, the app's copy.
      await app.hover('Echo: deploy the api on port 8137', { area: 'chat' })
      await app.click('↩ reply', { area: 'chat' })
      await app.send('same for staging')
      await app.waitFor('Echo: same for staging')
      const note = app.sent().at(-1)!.note
      assert.match(note, /The user is replying to your message:/)
      assert.match(note, /Earlier in this request \(the conversation was compacted since: this is the app's copy, in order\):\n- You \(its first message\): deploy the api on port 8137/)
    }))

  test('hover on your message: copy it, or reply to it', () =>
    withApp({ unfocused: true }, async app => {
      await app.send('my own words')
      await app.waitFor('Echo: my own words')
      await app.hover('my own words', { area: 'chat' })
      let s = await app.waitFor('⧉ copy  ↩ reply')
      await app.click('⧉ copy', { area: 'chat' })
      await app.waitClipboard('my own words')
      await app.hover('my own words', { area: 'chat' })
      await app.click('↩ reply', { area: 'chat' })
      s = await app.waitFor('↩ Replying to yourself')
      assert.match(rowOf(s, 'Replying to yourself'), /my own words .* ✕/)
      // ✕ and Esc both cancel it.
      await app.click('✕', { area: 'chat', nth: 0 })
      await app.waitGone('Replying to yourself')
      await app.hover('my own words', { area: 'chat' })
      await app.click('↩ reply', { area: 'chat' })
      await app.waitFor('Replying to yourself')
      app.keys('Escape')
      await app.waitGone('Replying to yourself')
      await app.hover('my own words', { area: 'chat' })
      await app.click('↩ reply', { area: 'chat' })
      await app.send('a follow-up')
      s = await app.waitFor('Echo: a follow-up')
      assert.match(s, /↩ you: “my own words”/)
      assert.match(app.sent().at(-1)!.note, /The user is replying to their own message:\n> my own words/)
      // The quote goes back to the message it quotes.
      await app.click('↩ you:', { area: 'chat' })
    }))

  test("hover on Claude's reply: react, reply, copy, mark unread", () =>
    withApp({ unfocused: true }, async app => {
      await app.send('tell me')
      await app.waitFor('Echo: tell me')
      await app.hover('Echo: tell me', { area: 'chat' })
      let s = await app.waitFor('↩ reply  ⧉ copy  ✓ mark read  ☆ save  👍 👎 ❓ 👀')
      // 👀 on finished work is only heard: it goes with your next message.
      await app.click('👀', { area: 'chat' })
      await app.hover({ row: 3, col: 60 })
      s = await app.waitFor('👀 you')
      await app.hover('Echo: tell me', { area: 'chat' })
      await app.click('⧉ copy', { area: 'chat' })
      await app.waitClipboard('Echo: tell me')
      await app.hover('Echo: tell me', { area: 'chat' })
      await app.click('✓ mark read', { area: 'chat' })
      await app.waitFor(/Unread  Read +none│/)
      await app.hover('Echo: tell me', { area: 'chat' })
      await app.click('● mark unread', { area: 'chat' })
      await app.waitFor('1 next ▸')
      await app.send('next one')
      await app.waitFor('Echo: next one')
      assert.match(app.sent().at(-1)!.note, /Since your last reply the user reacted: 👀 on your message “Echo: tell me”/)
      // A second click takes a reaction back.
      await app.hover('Echo: tell me', { area: 'chat' })
      await app.click('👀', { area: 'chat' })
      await app.hover({ row: 3, col: 60 })
      await app.waitGone('👀 you')
      // Reply to the whole answer.
      await app.hover('Echo: tell me', { area: 'chat' })
      await app.click('↩ reply', { area: 'chat' })
      s = await app.waitFor('↩ Replying to Claude')
      await app.send('thanks')
      s = await app.waitFor('Echo: thanks')
      assert.match(s, /↩ Claude: “Echo: tell me”/)
      assert.match(s, /⛓ 1 reply · chain/)
      await app.click('⛓ 1 reply · chain', { area: 'chat' })
      await app.waitFor('▣ Request')
    }))

  test('👍 on a question is a yes: it goes to Claude as a go-ahead; 👎 asks what to change', () =>
    withApp({ unfocused: true }, async app => {
      await app.send('ask me which')
      await app.waitFor('Which one do you want?')
      await app.hover('Which one do you want?', { area: 'chat' })
      await app.click('👍', { area: 'chat' })
      let s = await app.waitFor('you reacted 👍 on')
      const go = await app.waitLog(e => e.type === 'user' && JSON.stringify(e.message.content).includes('[clued reaction]'))
      assert.match(JSON.stringify(go.message.content), /\[clued reaction\] 👍 on your message “I can do it two ways\. Which one do you want\?”\. The user is saying yes: go ahead as you proposed\. Topics: T1\./)
      s = await app.waitFor('Echo: [clued reaction]')
      // Claude's answer quotes the reaction it answers.
      assert.match(s, /↩ your 👍 on “I can do it two ways/)
      await app.hover('Echo: [clued reaction]', { area: 'chat' })
      await app.click('👎', { area: 'chat' })
      await app.waitLog(e => JSON.stringify(e.message?.content ?? '').includes('The user disagrees'))
      // A click on "you reacted" goes to the reply it was on.
      await app.click('you reacted 👍', { area: 'chat' })
    }))

  test('a reply in parts: reply to one, add another, or reply to all; react to one part', () =>
    withApp({ unfocused: true, height: 40 }, async app => {
      await split(app)
      await app.hover('part one.', { area: 'chat' })
      await app.click('↩ reply', { area: 'chat' })
      let s = await app.waitFor('↩ Replying to Claude')
      assert.match(s, /↩ others to add them/)
      assert.match(s, /✓ in your reply/)
      await app.hover('split request.', { area: 'chat' })
      await app.click('↩ reply', { area: 'chat' })
      s = await app.waitFor("↩ Replying to 2 of Claude's replies")
      // ↩ again on one takes it out.
      await app.hover('split request.', { area: 'chat' })
      await app.click('✓ in your reply', { area: 'chat', nth: 2 })
      await app.waitFor('↩ others to add them')
      // The answer as a whole: reply to all of its parts.
      await app.hover('Claude · ', { area: 'chat', nth: 1 })
      s = await app.waitFor('↩ reply to all 2')
      assert.match(s, /⧉ copy all/)
      await app.click('↩ reply to all 2', { area: 'chat' })
      await app.waitFor("↩ Replying to 2 of Claude's replies")
      await app.send('answering both')
      s = await app.waitFor('Echo: answering both')
      // Each part it answers is quoted on its own line.
      assert.match(s, /│ ↩ Claude: “More about your first message: part one\.” │\n.*│ ↩ Claude: “And this part answers the split request\.” │/)
      assert.match(app.sent().at(-1)!.note, /The user is answering 2 of these messages at once/)
      assert.match(s, /⛓ 1 reply · chain/)
      // A reaction on one part stays on that part.
      await app.hover('part one.', { area: 'chat' })
      await app.click('❓', { area: 'chat' })
      await app.waitLog(e => JSON.stringify(e.message?.content ?? '').includes("The user doesn't follow"))
      await app.hover({ row: 2, col: 60 })
      s = await app.waitFor('❓ you')
      // The answer's own header (two rows above its first part) shows the actions for all of it.
      const first = await app.at('More about', { area: 'chat' })
      await app.hover({ row: first.row - 2, col: first.col })
      await app.click('⧉ copy all', { area: 'chat' })
      await app.waitClipboard('More about your first message: part one.\n\nAnd this part answers the split request.')
    }))

  test('a click on a quote goes to the message it quotes', () =>
    withApp({ unfocused: true, height: 20 }, async app => {
      await app.send('the very first')
      await app.waitFor('Echo: the very first')
      for (const m of ['x one', 'x two', 'x three']) {
        await app.send(m)
        await app.waitFor(`Echo: ${m}`)
      }
      await app.waitGone(/│ the very first │/)
      await app.click('Read', { area: 'panel' })
      await app.click('Unread', { area: 'panel' })
      await app.click('● Echo: the very first', { area: 'panel' })
      await app.waitFor('│ Echo: the very first')
      await app.click('↩ “the very first”', { area: 'chat' })
      await app.waitFor(/│ the very first │/)
    }))
})
