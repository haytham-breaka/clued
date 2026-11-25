// /btw: a side question, answered by a Claude Code of its own forked from the session, shown aside.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chatRowsWith, rowOf, withApp, writeSession } from './harness.ts'

const sessionFile = (a: { home: string; work: string }, id: string) => join(a.home, '.claude', 'projects', a.work.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)
const sideLog = (app: { read: (rel: string) => string }) => app.read('side.log').split('\n').filter(Boolean).map(l => JSON.parse(l))
const history = (a: { home: string; work: string }) =>
  writeSession(a.home, a.work, 'old-b', [
    { type: 'user', timestamp: new Date(Date.now() - 60_000).toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'set up the helper agents' }, { type: 'text', text: '[clued] This message is topic T1.' }] } },
    { type: 'assistant', timestamp: new Date(Date.now() - 50_000).toISOString(), message: { content: [{ type: 'text', text: 'Set up two helper agents.' }] } },
  ])

describe('/btw', () => {
  test('answers aside while Claude works, from a fork of the session, and leaves the session alone', () =>
    withApp({ setup: history, args: ['--resume', 'old-b'], unfocused: true }, async app => {
      await app.waitFor('Set up two helper agents.')
      const before = readFileSync(sessionFile(app, 'old-b'), 'utf8')
      await app.send('stream this')
      await app.waitFor('Streaming the answer')
      await app.send('/btw what is a helper agent?')
      // Answered: its words come before its result, which brings ⧉ copy.
      let s = await app.waitFor(s => s.includes('I can see 1 messages of old-b.') && s.includes('⧉ copy · ✕ close'))
      // Marked as a side answer, the app's own markup gone; Claude is still at work on the main turn.
      assert.match(rowOf(s, '╭ btw'), /╭ btw · what is a helper agent\?/)
      assert.match(s, /a side answer: not part of the conversation · ⧉ copy · ✕ close/)
      assert.doesNotMatch(s, /<clued>|topics/)
      assert.doesNotMatch(s, /Streaming the answer slowly, now finished/)
      // Its own Claude Code: forked from the session, the same model and folder, no tools, no file of its own; gone once it answered.
      const [start] = sideLog(app)
      for (const [flag, value] of [['--resume', 'old-b'], ['--tools', ''], ['--model', 'claude-fake-1-0'], ['--settings', '{"disableAllHooks":true}']])
        assert.equal(start.args[start.args.indexOf(flag) + 1], value, flag)
      for (const flag of ['--fork-session', '--no-session-persistence', '--strict-mcp-config']) assert.ok(start.args.includes(flag), flag)
      assert.equal(start.cwd, app.work)
      await app.waitFor(() => sideLog(app).some(e => 'exit' in e))
      // The main session never got the question.
      assert.deepEqual(app.sent().map(m => m.text), ['stream this'])
      // Claude finishes its turn; the aside stays where it was asked, outside any topic.
      app.release('stream')
      s = await app.waitFor('Streaming the answer slowly, now finished.')
      assert.ok(app.find('I can see 1 messages', { area: 'chat' })!.row > app.find('stream this', { area: 'chat' })!.row, 'the aside sits after the message it was asked after')
      assert.equal(chatRowsWith(s, '╭ btw'), 1)
      assert.doesNotMatch(app.read('home/.clued/sessions/old-b.json'), /helper agent\?/)
      assert.ok(!app.find('what is a helper', { area: 'panel' }), 'not in the panel')
      // A message sent now comes after it.
      await app.send('and next')
      await app.waitFor('Echo: and next')
      const row = (text: string) => app.find(text, { area: 'chat' })?.row ?? -1
      assert.ok(row('╭ btw') > 0 && row('and next') > row('╭ btw'), 'the next message comes after it')
      // The session file is as it was.
      assert.equal(readFileSync(sessionFile(app, 'old-b'), 'utf8'), before)
      // ⧉ copy takes the answer, ✕ closes it.
      await app.click('⧉ copy', { area: 'chat' })
      await app.waitClipboard('Side answer to “what is a helper agent?”: I can see 1 messages of old-b.')
      await app.click('✕ close', { area: 'chat' })
      await app.waitGone('╭ btw')
    }))

  test('with no session yet it asks a fresh Claude Code; Esc closes the latest; a failure says so', () =>
    withApp({}, async app => {
      // Typed alone, it says how.
      await app.send('/btw')
      await app.waitFor('Usage: /btw <question>')
      await app.send('/btw what is 2+2?')
      let s = await app.waitFor('there is no conversation yet.')
      assert.match(s, /a side answer, with no conversation yet to see/)
      // The fake Claude Code has a session id but no file: nothing to fork.
      assert.ok(!sideLog(app)[0].args.includes('--resume'))
      assert.deepEqual(app.sent(), [])
      // One still thinking shows so; it is refused nothing and ends when closed.
      await app.send('/btw answer slowly')
      s = await app.waitFor('thinking about it aside…')
      app.keys('Escape')
      await app.waitGone('thinking about it aside…')
      assert.match(app.screen(), /what is 2\+2\?/)
      await app.send('/btw fail please')
      s = await app.waitFor(s => /The side question stopped before answering: Side question failed on\s.*purpose\./s.test(s))
      app.keys('Escape')
      await app.waitGone('fail please')
      app.keys('Escape')
      await app.waitGone('what is 2+2?')
      // Back to the empty chat's hello.
      await app.waitFor(/clued {2}on Claude Code/)
    }))
})
