// Taking a message back: the hold before a message goes (✎ edit, ✕ delete, Ctrl+Z, /hold), and
// deleting one written to Claude Code that it hasn't taken in yet. The harness sends at once
// (CLUED_HOLD_MS=0); HOLD below gives these tests the app's own default (3 s).

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rowOf, withApp, writeSession } from './harness.ts'

const HOLD = { CLUED_HOLD_MS: '' }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')

describe('hold before sending', () => {
  test('✕ delete within the hold: nothing reaches Claude, no turn, nothing in the panel', () =>
    withApp({ env: HOLD }, async app => {
      await app.send('oops wrong chat')
      let s = await app.waitFor('◌ sending in 3s · ✎ edit · ✕ delete')
      assert.match(s, /│ oops wrong chat │/)
      // Not written yet, and not a message of the panel's.
      assert.equal(app.sent().length, 0)
      assert.doesNotMatch(s, /Your recent messages.*\n.*oops/)
      await app.click('✕ delete', { area: 'chat' })
      s = await app.waitFor('Deleted. It never went to Claude.')
      assert.ok(!s.includes('oops wrong chat'))
      // Well past the hold: still nothing sent, and the chat is empty again.
      await sleep(3300)
      assert.equal(app.sent().length, 0)
      s = app.screen()
      assert.ok(!s.includes('oops wrong chat'))
      assert.match(s, /clued {2}on Claude Code/)
      assert.match(app.read('home/.clued/sent.log'), /deleted \{"session":"[^"]*","text":"oops wrong chat","held":true\}/)
    }))

  test('after the hold it goes as it would have; several held go in order, one deleted between', () =>
    withApp({ env: HOLD }, async app => {
      await app.send('first held')
      await app.send('second held')
      await app.send('third held')
      await app.waitFor(s => s.includes('third held') && s.split('◌ sending in').length === 4)
      // The second one out; the others go in the order they were written.
      await app.click('✕ delete', { area: 'chat', nth: 1 })
      await app.waitFor('Deleted. It never went to Claude.')
      const s = await app.waitFor(s => s.includes('Echo: first held') && s.includes('Echo: third held'), 10_000)
      assert.ok(!s.includes('◌ sending in'))
      assert.ok(!s.includes('second held'))
      const sent = app.sent()
      assert.deepEqual(sent.map(m => m.text), ['first held', 'third held'])
      // Topic ids as if the deleted one never was.
      assert.match(sent[0]!.note, /This message is topic T1\./)
      assert.match(sent[1]!.note, /This message is topic T2\./)
    }))

  test('✎ edit and Ctrl+Z put it back in the box with its image and what it replied to', () =>
    withApp({ env: HOLD }, async app => {
      // Sent at once first, so there is a reply to reply to.
      app.type('/hold 0')
      app.keys('Enter')
      await app.waitFor('Messages go at once.')
      await app.send('the first one')
      await app.waitFor('Echo: the first one')
      app.type('/hold 3')
      app.keys('Enter')
      await app.waitFor('Messages wait 3 s before they go')
      assert.match(app.read('home/.clued/panel.json'), /"holdMs":3000/)
      // A reply with an image, held.
      await app.hover('Echo: the first one', { area: 'chat' })
      await app.click('↩ reply', { area: 'chat' })
      await app.waitFor('↩ Replying to Claude')
      writeFileSync(join(app.dir, 'clip.png'), PNG)
      app.keys('C-v')
      await app.waitFor('│ [image 1]')
      await app.send('see this tpyo')
      let s = await app.waitFor('◌ sending in')
      assert.match(s, /↩ “Echo: the first one”/)
      assert.ok(!s.includes('↩ Replying to Claude'), 'the reply went with the message')
      // ✎ edit: back in the box, the reply bar too; nothing sent.
      await app.click('✎ edit', { area: 'chat' })
      s = await app.waitFor('↩ Replying to Claude')
      assert.match(s, /│ \[image 1\] see this tpyo/)
      assert.ok(!s.includes('◌ sending in'))
      // Fixed and sent again, then taken back with Ctrl+Z.
      app.keys('BSpace', 'BSpace', 'BSpace', 'BSpace')
      await app.send('typo')
      await app.waitFor('◌ sending in')
      app.keys('C-z')
      s = await app.waitFor(s => !s.includes('◌ sending in') && s.includes('[image 1] see this typo'))
      assert.match(s, /↩ Replying to Claude/)
      assert.equal(app.sent().length, 1)
      // Ctrl+Z with nothing held says so.
      app.keys('C-u')
      app.keys('C-z')
      await app.waitFor('Nothing to take back')
      // Sent for real now: the image, and the note says what it replies to.
      app.type('[image 1] see this typo')
      app.keys('Enter')
      await app.waitFor('I got 1 image(s).', 10_000)
      const last = app.sent().at(-1)!
      assert.equal(last.text, '[image 1] see this typo')
      assert.equal(last.images, 1)
      assert.match(last.note, /Echo: the first one/)
    }))

  test('/hold sets it, and quitting while a message is held sends it first', () =>
    withApp({ env: HOLD }, async app => {
      app.type('/hold')
      app.keys('Enter')
      await app.waitFor('Messages wait 3 s before they go')
      app.type('/hold soon')
      app.keys('Enter')
      await app.waitFor('Usage: /hold <seconds>')
      app.type('/hold 20')
      app.keys('Enter')
      await app.waitFor('Messages wait 20 s')
      await app.send('do not lose me')
      await app.waitFor('◌ sending in 20s')
      // Slash commands never wait: /reload quits at once, and the held message goes on its way first.
      app.type('/reload')
      app.keys('Enter')
      assert.equal(await app.waitExit(), 75)
      assert.deepEqual(app.sent().map(m => m.text), ['do not lose me'])
    }))
})

describe('deleting a message Claude has not read', () => {
  test('✓ sent, not taken in: Claude Code drops it from its queue and Claude never sees it', () =>
    withApp({}, async app => {
      await app.send('hold on')
      await app.waitFor('Slow work')
      await app.send('never mind this')
      await app.waitFor('⏸ queued: Claude reads it at its next step')
      await app.hover('never mind this', { area: 'chat' })
      await app.click('✕ delete', { area: 'chat' })
      let s = await app.waitFor('taken back before Claude read it')
      assert.match(s, /✕ deleted “never mind this” · taken back before Claude read it/)
      assert.ok(!s.includes('⏸ queued'))
      const cancel = await app.waitLog(e => e.type === 'control_request' && e.request?.subtype === 'cancel_async_message')
      const queued = app.claudeLog().filter(e => e.type === 'user').at(-1)
      assert.equal(cancel.request.message_uuid, queued.uuid)
      // Out of the panel, and no note to Claude: there is nothing to ignore.
      assert.doesNotMatch(rowOf(s, 'never mind this'), /^ {2}[▶⏳]/)
      app.release('slow')
      s = await app.waitFor('The slow work is done.')
      assert.ok(!s.includes('Also got: never mind this'))
      assert.ok(!app.sent().some(m => m.text.startsWith('The user deleted')))
    }))

  test('when Claude Code cannot drop it, Claude is told to ignore it', () =>
    withApp({ env: { FAKE_NO_CANCEL: '1' } }, async app => {
      await app.send('hold on')
      await app.waitFor('Slow work')
      await app.send('scrap that')
      await app.waitFor('⏸ queued')
      await app.hover('scrap that', { area: 'chat' })
      await app.click('✕ delete', { area: 'chat' })
      let s = await app.waitFor('Claude was told to ignore it')
      assert.match(s, /✕ deleted “scrap that” · Claude was told to ignore it/)
      const note = await app.waitLog(e => e.type === 'user' && String(e.message.content).startsWith('The user deleted'))
      assert.equal(note.message.content, 'The user deleted their message T2 (“scrap that”) before you read it: ignore it. Don\'t answer it, act on it or mention it.')
      // The note itself is not drawn, and the message is out of the panel.
      assert.ok(!s.includes('The user deleted'))
      app.release('slow')
      s = await app.waitFor('The slow work is done.')
      assert.ok(!s.includes('│ scrap that │'))
    }))
})

describe('holding a message while Claude works', () => {
  const QUEUE = { CLUED_QUEUE: '' }

  test('a message sent while Claude works waits in the app, then gets a turn of its own', () =>
    withApp({ env: QUEUE }, async app => {
      await app.send('hold on')
      await app.waitFor('Slow work')
      await app.send('next please')
      let s = await app.waitFor('⏳ in queue: goes when Claude finishes · ➤ send now · ✎ edit · ✕ delete')
      // Not written to Claude Code: in queue in the panel, after the message Claude is on.
      assert.deepEqual(app.sent().map(m => m.text), ['hold on'])
      assert.match(rowOf(s, '⏳ next please'), /⏳ next please +in queue│/)
      assert.ok(s.indexOf('hold on') < s.indexOf('⏳ next please'), 'after the message Claude is on')
      assert.match(s, /Claude is working… your next message is queued ↓/)
      app.release('slow')
      s = await app.waitFor('Echo: next please')
      // Answered in its own turn, not folded into the slow one.
      assert.ok(!s.includes('Also got: next please'))
      assert.ok(!s.includes('⏳ in queue'))
      const sent = app.sent()
      assert.deepEqual(sent.map(m => m.text), ['hold on', 'next please'])
      assert.match(sent[1]!.note, /This message is topic T2\./)
      // Its own turn, taken in at once: ✓✓, not queued.
      await app.waitLog(e => e.type === 'user' && e.message?.content?.[0]?.text === 'next please')
      assert.match(app.read('home/.clued/sent.log'), /held \{"session":"s1","text":"next please","ms":0,"queued":true\}/)
    }))

  test('two held go in order, one per turn; one is deleted and one edited while they wait', () =>
    withApp({ env: QUEUE }, async app => {
      await app.send('hold on')
      await app.waitFor('Slow work')
      for (const m of ['first in line', 'drop this one', 'second in line', 'edit me later']) await app.send(m)
      await app.waitFor(s => s.split('⏳ in queue').length === 5)
      await app.click('✕ delete', { area: 'chat', nth: 1 })
      await app.waitFor('Deleted. It never went to Claude.')
      app.keys('C-z')
      await app.waitFor(s => s.includes('│ edit me later') && s.split('⏳ in queue').length === 3)
      app.keys('C-u')
      app.release('slow')
      await app.waitFor('Echo: first in line')
      await app.waitFor('Echo: second in line')
      assert.deepEqual(app.sent().map(m => m.text), ['hold on', 'first in line', 'second in line'])
      // The second went only after the first one's turn: each its own turn, nothing folded in.
      assert.ok(!app.screen().includes('Also got:'))
    }))

  test('a reply to the running work goes at once, to steer it; ➤ send now sends a queued one', () =>
    withApp({ env: QUEUE }, async app => {
      await app.send('hold on')
      await app.waitFor('Slow work')
      await app.send('not about that')
      await app.waitFor('⏳ in queue')
      await app.hover('hold on', { area: 'chat' })
      await app.click('↩ reply', { area: 'chat' })
      await app.send('faster please')
      // Written at once: Claude Code has it, for Claude's next step.
      await app.waitLog(e => e.type === 'user' && e.message?.content?.[0]?.text === 'faster please')
      await app.waitFor('⏸ queued: Claude reads it at its next step')
      assert.deepEqual(app.sent().map(m => m.text), ['hold on', 'faster please'])
      await app.click('➤ send now', { area: 'chat' })
      await app.waitLog(e => e.type === 'user' && e.message?.content?.[0]?.text === 'not about that')
      app.release('slow')
      const s = await app.waitFor('Also got: faster please')
      assert.match(s, /Also got: not about that/)
    }))

  test('/queue off sends at once; /reload keeps what waits and sends it after the restart', async () => {
    let kept = ''
    await withApp({ env: QUEUE }, async app => {
      app.type('/queue off')
      app.keys('Enter')
      await app.waitFor('Messages go at once, even while Claude works')
      assert.match(app.read('home/.clued/panel.json'), /"queue":false/)
      app.type('/queue nope')
      app.keys('Enter')
      await app.waitFor('Usage: /queue on | off')
      await app.send('hold on')
      await app.waitFor('Slow work')
      await app.send('goes at once')
      await app.waitFor('⏸ queued: Claude reads it at its next step')
      app.type('/queue')
      app.keys('Enter')
      await app.waitFor('waits for its turn to end')
      await app.send('after the restart')
      await app.waitFor('⏳ in queue')
      app.type('/reload')
      app.keys('Enter')
      assert.equal(await app.waitExit(), 75)
      assert.deepEqual(app.sent().map(m => m.text), ['hold on', 'goes at once'])
      kept = app.read('home/.clued/sessions/s1.json')
      assert.match(kept, /"held":\[\{"text":"after the restart"/)
    })
    await withApp({ env: QUEUE, args: ['--resume', 's1'], setup: ({ home, work }) => {
      writeSession(home, work, 's1', [{ type: 'user', timestamp: '2026-01-01T10:00:00Z', message: { content: 'hold on' } }])
      mkdirSync(join(home, '.clued', 'sessions'), { recursive: true })
      writeFileSync(join(home, '.clued', 'sessions', 's1.json'), kept)
    } }, async app => {
      // Held again, then sent: Claude is free.
      await app.waitFor('Echo: after the restart')
      assert.deepEqual(app.sent().map(m => m.text), ['after the restart'])
      await app.waitFor(() => !app.read('home/.clued/sessions/s1.json').includes('"held"'))
    })
  })
})

describe('↑ in an empty box takes your last message back', () => {
  test('within the hold: back in the box, cursor at its end, and nothing reaches Claude', () =>
    withApp({ env: HOLD }, async app => {
      await app.send('fix the tpyo')
      await app.waitFor('◌ sending in')
      app.keys('Up')
      let s = await app.waitFor('Took back your message: edit it and press Enter.')
      assert.match(s, /│ fix the tpyo/)
      assert.ok(!s.includes('◌ sending in'))
      app.type(' now')
      await app.waitFor('│ fix the tpyo now')
      await sleep(3300)
      assert.equal(app.sent().length, 0)
      assert.match(app.read('home/.clued/sent.log'), /edit \{"session":"[^"]*","text":"fix the tpyo","held":true\}/)
    }))

  test('with its image and what it replied to', () =>
    withApp({ env: HOLD }, async app => {
      app.type('/hold 0')
      app.keys('Enter')
      await app.waitFor('Messages go at once.')
      await app.send('the first one')
      await app.waitFor('Echo: the first one')
      app.type('/hold 3')
      app.keys('Enter')
      await app.waitFor('Messages wait 3 s before they go')
      await app.hover('Echo: the first one', { area: 'chat' })
      await app.click('↩ reply', { area: 'chat' })
      await app.waitFor('↩ Replying to Claude')
      writeFileSync(join(app.dir, 'clip.png'), PNG)
      app.keys('C-v')
      await app.waitFor('│ [image 1]')
      await app.send('look here')
      let s = await app.waitFor('◌ sending in')
      assert.ok(!s.includes('↩ Replying to Claude'))
      app.keys('Up')
      s = await app.waitFor('↩ Replying to Claude')
      assert.match(s, /│ \[image 1\] look here/)
      assert.ok(!s.includes('◌ sending in'))
      // Sent again: the image and the reply go with it.
      app.keys('Enter')
      await app.waitFor('I got 1 image(s).', 10_000)
      const last = app.sent().at(-1)!
      assert.equal(last.text, '[image 1] look here')
      assert.equal(last.images, 1)
      assert.match(last.note, /Echo: the first one/)
    }))

  test('in queue while Claude works: taken back, it never goes', () =>
    withApp({ env: { CLUED_QUEUE: '' } }, async app => {
      await app.send('hold on')
      await app.waitFor('Slow work')
      await app.send('next please')
      await app.waitFor('⏳ in queue')
      app.keys('Up')
      const s = await app.waitFor('Took back your message')
      assert.match(s, /│ next please/)
      assert.ok(!s.includes('⏳ in queue'))
      app.keys('C-u')
      app.release('slow')
      await app.waitFor('The slow work is done.')
      await sleep(300)
      assert.deepEqual(app.sent().map(m => m.text), ['hold on'])
    }))

  test('queued in Claude Code, not taken in: Claude Code drops it, and it is back as if never sent', () =>
    withApp({}, async app => {
      await app.send('hold on')
      await app.waitFor('Slow work')
      writeFileSync(join(app.dir, 'clip.png'), PNG)
      app.keys('C-v')
      await app.waitFor('│ [image 1]')
      await app.send('never mind this')
      await app.waitFor('⏸ queued: Claude reads it at its next step')
      app.keys('Up')
      let s = await app.waitFor('Took back your message')
      assert.match(s, /│ \[image 1\] never mind this/)
      // No turn left: no bubble, no deleted line, nothing queued.
      assert.ok(!s.includes('⏸ queued'))
      assert.ok(!s.includes('✕ deleted'))
      assert.ok(!s.includes('│ [image 1] never mind this │'))
      const cancel = await app.waitLog(e => e.type === 'control_request' && e.request?.subtype === 'cancel_async_message')
      assert.equal(cancel.request.message_uuid, app.claudeLog().filter(e => e.type === 'user').at(-1).uuid)
      app.release('slow')
      s = await app.waitFor('The slow work is done.')
      assert.ok(!s.includes('Also got: never mind this'))
      assert.ok(!app.sent().some(m => m.text.startsWith('The user deleted')))
      // Sent again: it takes the topic number the taken-back one had, with its image.
      app.keys('Enter')
      await app.waitFor(s => s.includes('I got 1 image(s).'), 10_000)
      const last = app.sent().at(-1)!
      assert.equal(last.text, '[image 1] never mind this')
      assert.match(last.note, /This message is topic T2\./)
    }))

  test('when Claude Code cannot drop it, it stays and ↑ says so', () =>
    withApp({ env: { FAKE_NO_CANCEL: '1' } }, async app => {
      await app.send('hold on')
      await app.waitFor('Slow work')
      await app.send('too late for this')
      await app.waitFor('⏸ queued')
      app.keys('Up')
      const s = await app.waitFor('Already with Claude: can\'t be edited.')
      // Still Claude's, still queued, and the box stays empty.
      assert.match(s, /⏸ queued/)
      assert.match(s, /│ Claude is working… you can still send a message/)
      assert.ok(!app.sent().some(m => m.text.startsWith('The user deleted')))
      app.release('slow')
      await app.waitFor('Also got: too late for this')
    }))

  test('taken in already: ↑ says so once, and goes through your earlier messages as before', () =>
    withApp({ env: { CLUED_TOAST_MS: '800' } }, async app => {
      await app.send('first thing')
      await app.waitFor('Echo: first thing')
      await app.send('second thing')
      await app.waitFor('Echo: second thing')
      app.keys('Up')
      let s = await app.waitFor('Already with Claude: can\'t be edited.')
      assert.match(s, /│ second thing/)
      // Not empty now: ↑ goes on through history, as today.
      app.keys('Up')
      await app.waitFor('│ first thing')
      // ↓ back to an empty box, then ↑: history again, without saying it twice.
      app.keys('Down', 'Down')
      await app.waitFor('│ Message Claude')
      await app.waitGone('Already with Claude')
      app.keys('Up')
      s = await app.waitFor('│ second thing')
      assert.ok(!s.includes('Already with Claude'))
      assert.equal(app.sent().length, 2)
    }))
})
