// The panel: Unread and Read, Waiting on you, Agents (/demo and real ones), your recent messages with
// the legend and search, Alt+↑/↓/→, a request's chain, and the panel's own layout.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { keyOf } from '../../hooks/model.ts'
import { rowOf, withApp, writeSession } from './harness.ts'

/** Any frame of the spinner a message something works on shows. */
const SPIN = '[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]'

/** A saved panel width (prefs), wide enough for agent rows in full. */
const widePanel = ({ home }: { home: string }) => {
  mkdirSync(join(home, '.clued'), { recursive: true })
  writeFileSync(join(home, '.clued', 'panel.json'), JSON.stringify({ width: 56 }))
}

describe('panel', () => {
  test('Unread and Read: mark one read, see it under Read, make it unread, mark all read', () =>
    withApp({ unfocused: true }, async app => {
      await app.send('first message')
      await app.waitFor('Echo: first message')
      await app.send('second message')
      let s = await app.waitFor('2 next ▸')
      assert.match(s, /✓ ● Echo: first message/)
      assert.match(s, /✓ ● Echo: second message/)
      assert.match(s, /mark all read/)
      assert.match(s, /● answered/)
      // ✓ on the left of a row marks it read without opening it.
      await app.click('✓ ● Echo: first message', { area: 'panel' })
      s = await app.waitFor('1 next ▸')
      assert.ok(!s.includes('✓ ● Echo: first message'))
      assert.match(s, /↪ answered/)
      await app.click('Read', { area: 'panel', nth: 0, dx: 0 })
      s = await app.waitFor('newest first')
      assert.match(s, /● ✓ Echo: first message/)
      // ● on a read row makes it unread again.
      await app.click('● ✓ Echo: first message', { area: 'panel' })
      s = await app.waitFor('none yet')
      await app.click('Unread', { area: 'panel' })
      s = await app.waitFor('2 next ▸')
      await app.click('mark all read', { area: 'panel' })
      s = await app.waitFor(t => /Unread  Read +none│/.test(t))
      // Kept for the session.
      await app.waitFor(() => (JSON.parse(app.read('home/.clued/sessions/s1.json') || '{}').read ?? []).length === 2)
    }))

  test('a reply counts as read once it has been on screen long enough with the window focused', () =>
    withApp({}, async app => {
      await app.send('read me')
      await app.waitFor('1 next ▸')
      // About 3 seconds for a short reply.
      await app.waitFor(t => /Unread  Read +none│/.test(t), 10_000)
      // Losing focus stops the clock: the next reply stays unread.
      app.raw('\x1b[O')
      await app.send('and me')
      await app.waitFor('1 next ▸')
      await new Promise(r => setTimeout(r, 3500))
      assert.match(app.screen(), /1 next ▸/)
      app.raw('\x1b[I')
      await app.waitFor(t => /Unread  Read +none│/.test(t), 10_000)
    }))

  test('Ctrl+N and "next ▸" go to the next unread reply', () =>
    withApp({ unfocused: true, height: 24 }, async app => {
      for (const m of ['one', 'two', 'three', 'four']) {
        await app.send(`message ${m}`)
        await app.waitFor(`Echo: message ${m}`, undefined)
      }
      // The oldest reply has scrolled off the 24-row screen: Ctrl+N brings it back.
      await app.waitGone(/│ Echo: message one/)
      app.keys('C-n')
      await app.waitFor(/│ Echo: message one/)
      await app.click('next ▸', { area: 'panel' })
      await app.waitFor(/│ Echo: message two/)
      // The chat is scrolled up now: the tag at the bottom brings it down.
      await app.click('more lines', { area: 'chat' })
      await app.waitFor(/│ Echo: message four/)
      await app.waitGone('more lines')
      // The wheel and Page Up/Down scroll the chat.
      app.wheel(10, 60, true)
      await app.waitFor('more lines')
      app.wheel(10, 60, false)
      await app.waitGone('more lines')
      app.keys('PageUp')
      await app.waitFor('more lines')
      app.keys('PageDown')
      await app.waitGone('more lines')
    }))

  test('Waiting on you lists the question; ✕ dismisses it, and Claude is told', () =>
    withApp({ unfocused: true }, async app => {
      await app.send('ask me something')
      let s = await app.waitFor('Waiting on you')
      assert.match(rowOf(s, 'Waiting on you'), /Waiting on you +1/)
      assert.match(s, /✕ ✋ Which one do you want\?/)
      assert.match(s, /✋ waiting for your answer {3}✕ dismiss/)
      assert.match(s, /✋ ask me something/)
      await app.click('✕ ✋ Which one', { area: 'panel' })
      s = await app.waitFor("Dismissed. Claude won't wait for an answer.")
      assert.ok(!s.includes('Waiting on you'))
      assert.match(s, /✓ ask me something/)
      await app.send('something else')
      await app.waitFor('Echo: something else')
      assert.match(app.sent().at(-1)!.note, /dismissed your question on T1 without answering/)
      // From the chat: ✕ dismiss under the bubble; two at once from the panel's "dismiss all".
      await app.send('ask me again')
      await app.waitFor('✕ dismiss')
      await app.click('✕ dismiss', { area: 'chat' })
      await app.waitGone('Waiting on you')
    }))

  test('answering the only open question puts it back with Claude', () =>
    withApp({ unfocused: true }, async app => {
      await app.send('ask me now')
      await app.waitFor('Waiting on you')
      await app.send('the first way')
      const s = await app.waitFor('Echo: the first way')
      // The note told Claude the question's topic was back on it.
      assert.match(app.sent().at(-1)!.note, /T1[^\n]*on Claude/)
      // The reply's tag didn't take it up (it lists only the new message): the answer was a guess, and
      // the question is open again.
      assert.match(s, /Waiting on you/)
      assert.match(s, /✋ ask me now/)
    }))

  test('/demo agents: listed under Agents, each with its own view to write from', () =>
    withApp({ unfocused: true }, async app => {
      await app.send('first message')
      await app.waitFor('Echo: first message')
      await app.send('/demo')
      let s = await app.waitFor('Demo on: fake agents')
      assert.match(s, /Agents +1 working/)
      assert.match(s, /✻ Claude \(lead\) +idle/)
      assert.match(s, /◐ James \(explorer\) · Explore…/)
      assert.match(s, /↳ “first message”/)
      // An agent is on it: its message is in progress, with a spinner.
      assert.match(s, new RegExp(`${SPIN} first message +in progress`))
      await app.click('James', { area: 'panel' })
      s = await app.waitFor('← back to chat')
      assert.match(s, /◇ James \(explorer\) · Explore the codebase {3}↳ “first message”/)
      assert.match(s, /✻ Claude asked/)
      assert.match(s, /I'll start by looking around\. \(demo\)/)
      assert.match(s, /◇ to James \(explorer\): Explore the codebase/)
      assert.match(s, /▸◐ James/)
      await app.send('what did you find')
      await app.waitFor('your messages about this agent')
      const note = app.sent().at(-1)!.note
      assert.match(note, /from inside the view of your agent James \(explorer\), "Explore the codebase"/)
      await app.click('← back to chat', { area: 'chat' })
      s = await app.waitGone('← back to chat')
      // The message keeps the agent's name, and a click opens it again.
      assert.match(s, /◇ James \(explorer\) · Explore the codebase/)
      await app.click('◇ James', { area: 'chat' })
      await app.waitFor('← back to chat')
      app.keys('Escape')
      await app.waitGone('← back to chat')
      // Each message from now on gets agents too, till /demo off.
      await app.send('another one')
      await app.waitFor(/Jake \(\w+\)/)
      await app.send('/demo off')
      await app.waitFor('Demo off.')
    }))

  test("real agents: Claude's Agent call and its steps, live, and what it hands back", () =>
    withApp({ height: 44, setup: widePanel }, async app => {
      await app.send('start agents')
      let s = await app.waitFor('· Grep')
      assert.match(s, /Agents +2 working/)
      assert.match(s, /◐ James \(explorer\) · Explore the code/)
      assert.match(s, /✻ Claude \(lead\) +working/)
      assert.match(s, /Working \d+s · Agent: Explore the c… {2}1 step ▸/)
      // Claude's own live view, from the panel.
      await app.click('Claude', { area: 'panel' })
      s = await app.waitFor('✻ Claude, live')
      assert.match(s, /You asked/)
      assert.match(s, /◇ Agent: Explore the code ▾/)
      await app.click('← back to chat', { area: 'chat' })
      await app.click('James', { area: 'panel' })
      s = await app.waitFor('Look around the code.')
      assert.match(s, /⌕ Searched for main ▾/)
      assert.match(s, /Looking for main\./)
      assert.match(s, /working · 1 step so far/)
      // Steps fold with a click.
      await app.click('⌕ Searched for main', { area: 'chat' })
      await app.waitFor('⌕ Searched for main ▸')
      app.release('agents')
      s = await app.waitFor('✓ handed back to Claude')
      assert.match(s, /Found the main file\./)
      assert.match(s, /· done after \d+s/)
      await app.click('⧉ copy', { area: 'chat', nth: 0 })
      await app.waitFor('Copied.')
      app.keys('Escape')
      s = await app.waitFor('The agent found the main file.')
      assert.match(s, /✓ James \(explorer\)/)
      assert.match(s, /all done/)
      assert.match(app.sent().at(-1)?.note ?? '', /T1/)
      // Messages from now on tell Claude the agents' names.
      await app.send('ask James more')
      await app.waitFor('Echo: ask James more')
      assert.match(app.sent().at(-1)!.note, /The app shows your agents by these names: James \(explorer\) = "Explore the code" \(done; Agent tool use agent-1, agent id task-1\)/)
    }))

  test('a background agent: Claude goes on by itself when it comes back', () =>
    withApp({ unfocused: true, setup: widePanel }, async app => {
      await app.send('background agent please')
      let s = await app.waitFor('Started it in the background.')
      assert.match(s, /Long job bg/)
      // The agent in the background is on it.
      assert.match(s, new RegExp(`${SPIN} background agent please +in progress`))
      // Its steps come from its own transcript: under Agents, and in its view.
      s = await app.waitFor('· Build the project')
      await app.click('Long job', { area: 'panel' })
      s = await app.waitFor('Checking the build first.')
      assert.match(s, /build ok/)
      app.keys('Escape')
      app.release('bg')
      s = await app.waitFor('The background job is done.')
      assert.match(s, /Claude · \d\d:\d\d · followed up/)
      assert.match(s, /✓ background agent please/)
      await app.waitFor(/✓ \w+ \(implementer\)/)
    }))

  test('your recent messages: the ? legend, and ⌕ search with the arrows and Enter', () =>
    withApp({ unfocused: true }, async app => {
      for (const m of ['apples are red', 'bananas are yellow', 'cherries are red']) {
        await app.send(m)
        await app.waitFor(`Echo: ${m}`)
      }
      app.type('draft text')
      await app.click('?', { area: 'panel' })
      let s = await app.waitFor('Claude is on it, no reply yet')
      for (const l of ['replied, still owes work', 'in progress: being worked on', 'waiting on you', 'not answered', '⚠ reply lost', '↩ replied  ↻ status', 'mark: open chain · text: jump'])
        assert.ok(s.includes(l), l)
      assert.ok(!s.includes('no update'))
      await app.click('done', { area: 'panel' })
      await app.waitGone('Claude is on it, no reply yet')
      await app.click('⌕', { area: 'panel' })
      s = await app.waitFor('⌕ search your messages')
      assert.match(s, /⌕ type to search +3 of 3/)
      app.type('red')
      s = await app.waitFor('“red”')
      assert.match(s, /“red” +2 of 3/)
      assert.ok(!/bananas are yellow +↩/.test(s))
      // The arrows go through the matches, newest first.
      app.keys('Down')
      s = await app.waitFor('›✓ cherries are red')
      app.keys('Down')
      s = await app.waitFor('›✓ apples are red')
      app.keys('Up')
      await app.waitFor('›✓ cherries are red')
      app.keys('Enter')
      s = await app.waitFor('▸ Alt+→ its reply')
      app.type('zzz')
      await app.waitFor('no message matches')
      app.keys('Enter')
      await app.waitFor('No message matches.')
      // Esc puts back what you were writing.
      app.keys('Escape')
      s = await app.waitFor('draft text')
      assert.match(rowOf(s, 'Your recent messages'), /\?  ⌕  3/)
      // Ctrl+F searches too.
      app.keys('C-f')
      await app.waitFor('⌕ search your messages')
      app.keys('Escape')
      await app.waitGone('⌕ search your messages')
    }))

  test('Alt+↑/↓ go through your messages; Alt+→ goes to the reply; Alt+← back', () =>
    withApp({ unfocused: true, height: 24 }, async app => {
      for (const m of ['alpha', 'beta', 'gamma']) {
        await app.send(m)
        await app.waitFor(`Echo: ${m}`)
      }
      app.keys('M-Up')
      let s = await app.waitFor('▸ Alt+→ its reply')
      assert.match(s, /›✓ gamma/)
      app.keys('M-Up')
      await app.waitFor('That is the first in the list.')
      app.keys('M-Down')
      await app.waitFor('›✓ beta')
      app.keys('M-Down')
      s = await app.waitFor('›✓ alpha')
      app.keys('M-Down')
      await app.waitFor('That is the last in the list.')
      app.keys('M-Right')
      s = await app.waitFor('│ Echo: alpha')
      app.keys('M-Left')
      await app.waitFor('▸ Alt+→ its reply')
      // Esc lets go of it.
      app.keys('Escape')
      await app.waitGone('▸ Alt+→ its reply')
      // A click on a message in the panel picks it too.
      await app.click('✓ beta', { area: 'panel', dx: 2 })
      await app.waitFor('›✓ beta')
    }))

  test('Alt+→ on a message with no reply yet says so', () =>
    withApp({ unfocused: true }, async app => {
      app.keys('M-Up')
      await app.waitFor('No messages of yours yet.')
      await app.send('hold on')
      await app.waitFor('Slow work')
      app.keys('M-Up')
      await app.waitFor('▸ Alt+→ its reply')
      app.keys('M-Right')
      await app.waitFor('No reply yet: Claude is still on it.')
      app.release('slow')
      await app.waitFor('The slow work is done.')
    }))

  test("a message's chain: its status mark opens the request, where it stands, with a way to ask", () =>
    withApp({ unfocused: true }, async app => {
      await app.send('fix the login')
      await app.waitFor('Echo: fix the login')
      await app.click('✓ fix the login', { area: 'panel' })
      let s = await app.waitFor('▣ Request T1')
      assert.match(s, /✓ done {2}“fix the login” {2}· ← back to chat/)
      assert.match(s, /✓ done {2}· {2}1 reply/)
      assert.match(s, /▣ in request T1: fix the login/)
      assert.match(s, /▸✓ fix the login/)
      await app.send('also the logout')
      await app.waitFor('Echo: also the logout')
      assert.match(app.sent().at(-1)!.note, /from inside the view of their request T1/)
      app.keys('Escape')
      s = await app.waitGone('▣ Request')
      // Sent from inside the request: it replies to it, and the chain grew.
      assert.match(s, /↩ you: “fix the login”/)
      assert.match(s, /⛓ chain · \d/)
      await app.click('⛓ chain', { area: 'chat' })
      await app.waitFor('▣ Request T1')
      await app.click('← back to chat', { area: 'chat' })
      // A request still open has "ask for status".
      await app.send('hold on')
      await app.waitFor('Slow work')
      // Claude is on it: a spinner (its mark, just left of the text) and "in progress".
      s = await app.waitFor(new RegExp(`${SPIN} hold on +in progress`))
      await app.click(' hold on ', { area: 'panel', dx: -1 })
      s = await app.waitFor('ask for status')
      assert.match(s, new RegExp(`${SPIN} in progress`))
      app.release('slow')
      await app.waitFor('✓ done')
    }))

  test('a message Claude still owes, with nothing running on it: "waiting", and "waiting for Claude" in its request', () =>
    withApp({
      args: ['--resume', 'owed-1'],
      ready: 'I will look into it.',
      setup: ({ home, work }) => {
        const at = new Date(Date.now() - 5 * 60_000).toISOString()
        writeSession(home, work, 'owed-1', [
          { type: 'user', timestamp: at, message: { content: [{ type: 'text', text: 'look into the crash' }, { type: 'text', text: '[clued] This message is topic T1.' }] } },
          { type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text: 'I will look into it.\n<clued>{"topics":[{"id":"T1","status":"claude"}]}</clued>' }] } },
        ])
        // Still on Claude, and it last moved five minutes ago.
        mkdirSync(join(home, '.clued', 'sessions'), { recursive: true })
        writeFileSync(join(home, '.clued', 'sessions', 'owed-1.json'), JSON.stringify({
          board: { topics: [{ id: 'T1', title: 'Crash', threadId: 0, status: 'claude', messageKeys: [keyOf('look into the crash')], updatedAt: Date.now() - 5 * 60_000 }], threads: [], answers: [], nextTopic: 2, turnTopics: [], replies: {} },
        }))
      },
    }, async app => {
      let s = await app.waitFor(/▶ look into the crash +waiting│/)
      assert.ok(!s.includes('no update') && !s.includes('in progress'))
      await app.click(' look into the crash ', { area: 'panel', dx: -1 })
      s = await app.waitFor('▣ Request T1')
      assert.match(s, /▶ waiting for Claude/)
      assert.match(s, /Claude said it still owes work here, but nothing is running on it right now\./)
      assert.ok(!s.includes('⚠'))
    }))

  test('/panel folds the panel to icons; the divider drags; the panel scrolls sideways', () =>
    withApp({ unfocused: true }, async app => {
      await app.send('a message with a fairly long text to slide')
      await app.waitFor('Echo: a message')
      await app.send('/panel')
      let s = await app.waitFor(/^☰ +○│/m)
      assert.match(s, /^● +1│/m)
      await app.waitFor(() => app.read('home/.clued/panel.json').includes('"folded":true'))
      await app.click('☰')
      s = await app.waitFor('☰ Overview')
      assert.equal(app.divider(), 35)
      // Drag the divider to make the panel wider.
      await app.drag({ row: 10, col: 35 }, { row: 10, col: 46 })
      await app.waitFor(() => app.divider() === 46)
      await app.waitFor(() => app.read('home/.clued/panel.json').includes('"width":45'))
      // Side scroll: › and ‹, and the wheel sideways.
      await app.click('›', { area: 'panel' })
      s = await app.waitFor('‹')
      assert.match(s, /‹ /)
      await app.click('‹', { area: 'panel' })
      app.raw('\x1b[<67;5;10M')
      await app.waitFor(/‹\w/)
      app.raw('\x1b[<66;5;10M')
      // Sideways over the chat does nothing; leaving the panel puts its rows back at their start.
      app.raw('\x1b[<67;5;10M')
      await app.waitFor(/‹\w/)
      app.raw('\x1b[<35;80;10M')
      await app.waitGone(/‹\w/)
      app.raw('\x1b[<67;80;10M\x1b[<35;80;11M')
      await new Promise(r => setTimeout(r, 300))
      assert.doesNotMatch(app.screen(), /‹\w/)
      // The wheel over the panel's empty part.
      app.wheel(30, 5, true)
      app.wheel(30, 5, false)
    }))

  test('a narrow window hides the panel', () =>
    withApp({ width: 50, height: 20 }, async app => {
      await app.send('hi')
      const s = await app.waitFor('Echo: hi')
      assert.ok(!s.includes('Overview'))
      assert.equal(app.divider() === 0 || !s.split('\n')[0]!.includes('│'), true)
    }))

  test('section boxes scroll with the wheel when they hold more than fits', () =>
    withApp({ unfocused: true, height: 22 }, async app => {
      for (let i = 1; i <= 8; i++) {
        await app.send(`msg ${i}`)
        await app.waitFor(`Echo: msg ${i}`)
      }
      // Six unread fit in the Unread box at most; it shows a bar for where it is.
      let s = app.screen()
      assert.match(s, /▐/)
      const at = await app.at('Echo: msg', { area: 'panel' })
      app.wheel(at.row, 5, false)
      s = await app.waitFor(t => t !== s)
      app.wheel(at.row, 5, true)
      const r = await app.at('msg 8', { area: 'panel' })
      app.wheel(r.row, 5, false)
      app.wheel(r.row, 5, true)
    }))
})
