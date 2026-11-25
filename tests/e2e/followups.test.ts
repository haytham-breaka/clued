// The turns Claude starts by itself (an agent's or command's end, a job firing) get the same keys
// live as from the session file on resume, so the replies in them keep their ids and what you read
// stays read after a /reload. Every tag in a text settles its messages, in order.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { keyOf } from '../../hooks/model.ts'
import { withApp, writeSession } from './harness.ts'

const note = (id: string) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Done</summary>\n</task-notification>`
/** A part's fingerprint, as the app keeps it for one read (partPrints in app/inbox.ts). */
const printOf = (words: string) => `${keyOf(words)}.${words.length.toString(36)}`

describe('follow-ups', () => {
  test('live and on resume, every turn Claude starts by itself has the same key, and its replies the same ids', () =>
    withApp({ unfocused: true }, async app => {
      await app.send('hello')
      await app.waitFor('Echo: hello')
      await app.send('follow-up kinds')
      await app.waitFor('The job ran.', 30_000)
      await app.click('mark all read', { area: 'panel' })
      await app.waitFor(t => /Unread  Read +none│/.test(t))
      const keptNow = () => JSON.parse(app.read('home/.clued/sessions/s1.json') || '{}')
      await app.waitFor(() => (keptNow().read ?? []).some((id: string) => id.startsWith('fired-')))
      const kept = keptNow()
      const own = (ids: string[]) => ids.filter(id => /^(?:follow|fired)-/.test(id)).sort()
      const live = own(kept.read)

      // The session file read as on resume, in this process (with the app's HOME).
      process.env.HOME = app.home
      const { loadHistory } = await import('../../app/session.ts')
      const { assignParts } = await import('../../app/inbox.ts')
      const turns = loadHistory(app.work, 's1')
      assignParts(turns, kept.board)
      const keys = turns.filter(t => /^(?:follow|fired)-/.test(t.key)).map(t => t.key)
      // An end told mid-turn has no turn of its own; one told after the turn, does; two told at once, one.
      assert.deepEqual(keys.slice(0, 4), ['follow-bfk2', 'follow-afk1', 'follow-afk1.2', 'follow-afk1.3'])
      assert.match(keys[4] ?? '', /^fired-/)
      assert.equal(keys.length, 5)
      assert.deepEqual(own(turns.flatMap(t => (t.parts ?? []).map(p => p.id!))), live)
      assert.equal(live.length, 5)

      // Both tags of the two-part reply settled their messages: the second one's question waits on you.
      const status = (id: string) => kept.board.topics.find((t: { id: string }) => t.id === id)?.status
      assert.equal(status('T1'), 'me')
      assert.equal(status('T2'), 'done')
    }))

  test('what you read before ids were the same stays read: by the time it began, and by its words', () => {
    const at = Date.now() - 3_600_000
    const iso = (ms: number) => new Date(ms).toISOString()
    return withApp({
      unfocused: true,
      args: ['--resume', 'old'],
      setup: ({ home, work }) => {
        writeSession(home, work, 'old', [
          { type: 'user', timestamp: iso(at), message: { content: [{ type: 'text', text: 'build it' }, { type: 'text', text: '[clued] This message is topic T1.' }] } },
          { type: 'assistant', timestamp: iso(at + 1000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '<<reply T1>>\nStarted.\n<clued>{"topics":[{"id":"T1","status":"claude"}]}</clued>' }] } },
          // Read live as follow-<its time>: found again by that time.
          { type: 'user', timestamp: iso(at + 60_000), message: { content: note('bq1') } },
          { type: 'assistant', timestamp: iso(at + 61_000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '<<reply T1>>\nThe build passed.' }] } },
          // Read under another id: found again by its words.
          { type: 'user', timestamp: iso(at + 600_000), message: { content: note('bq2') } },
          { type: 'assistant', timestamp: iso(at + 601_000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '<<reply T1>>\nThe docs are up.' }] } },
          // Never read: stays unread.
          { type: 'user', timestamp: iso(at + 900_000), message: { content: note('bq3') } },
          { type: 'assistant', timestamp: iso(at + 901_000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '<<reply T1>>\nThe build passed.' }] } },
        ])
        mkdirSync(join(home, '.clued', 'sessions'), { recursive: true })
        writeFileSync(join(home, '.clued', 'sessions', 'old.json'), JSON.stringify({
          board: { topics: [{ id: 'T1', title: 'Build', threadId: 0, status: 'claude', messageKeys: [keyOf('build it')], updatedAt: at }], threads: [], answers: [], nextTopic: 2, turnTopics: [], replies: {} },
          reactions: {},
          links: {},
          readInit: true,
          readIds: 2,
          read: [`${keyOf('build it')}:0`, `follow-${(at + 62_000).toString(36)}:0`],
          readPrints: [printOf('The docs are up.')],
        }))
      },
    }, async app => {
      // Only the last update is unread (its words are the first one's, but it is a second time).
      // Only the last update is unread (its words are the first one's, but it is a second time).
      await app.waitFor('1 next ▸')
      await app.waitFor(() => JSON.parse(app.read('home/.clued/sessions/old.json')).readIds === 3)
      const kept = JSON.parse(app.read('home/.clued/sessions/old.json'))
      assert.deepEqual(kept.read.filter((id: string) => id.startsWith('follow-b')).sort(), ['follow-bq1:0', 'follow-bq2:0'])
      assert.ok(kept.readPrints.includes(printOf('The build passed.')))
      assert.ok(!kept.readPrints.includes(`${printOf('The build passed.')}~1`))
      assert.equal(kept.starts.length, 1)
    })
  })

  test('a reply whose text block Claude Code drops, streamed over a message taken in mid-stream, still shows and its tag settles', () =>
    withApp({}, async app => {
      await app.send('hello')
      await app.waitFor('Echo: hello')
      await app.send('block dropped mid-echo')
      await app.waitFor('Make it')
      await app.send('meanwhile')
      await app.waitFor('⏸ queued')
      app.release('ds')
      const s = await app.waitFor('Also got: meanwhile')
      assert.match(s, /That earlier one needs your pick: red or blue\?/)
      await app.waitFor(() => JSON.parse(app.read('home/.clued/sessions/s1.json') || '{}').board?.topics?.find((t: { id: string }) => t.id === 'T1')?.status === 'me')
    }))
})
