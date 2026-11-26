// /branch and /add-dir: Claude Code started again, as /model does: on a fork of the session
// (--resume <id> --fork-session --session-id <new>), or with --add-dir for another folder.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rowOf, withApp, writeSession } from './harness.ts'

const t0 = Date.now() - 120_000
const history = (a: { home: string; work: string }) =>
  writeSession(a.home, a.work, 'orig', [
    { type: 'user', timestamp: new Date(t0).toISOString(), message: { role: 'user', content: 'pick a database' } },
    { type: 'assistant', timestamp: new Date(t0 + 2000).toISOString(), message: { content: [{ type: 'text', text: 'Postgres, I would say.' }] } },
  ])
/** The arguments of each Claude Code the app started, oldest first. */
const starts = (app: { claudeLog: () => any[] }) => app.claudeLog().filter(e => Array.isArray(e.args)).map(e => e.args as string[])
/** The latest one's ([] before the first has started). */
const lastStart = (app: { claudeLog: () => any[] }) => starts(app).at(-1) ?? []
const after = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
const kept = (home: string, id: string) => (existsSync(join(home, '.clued', 'sessions', `${id}.json`)) ? JSON.parse(readFileSync(join(home, '.clued', 'sessions', `${id}.json`), 'utf8')) : {})

describe('/branch and /add-dir', () => {
  test('/branch forks the session; the branch keeps its own state, and /resume shows both', () =>
    withApp({ setup: history, args: ['--resume', 'orig'], unfocused: true }, async app => {
      await app.waitFor('Postgres, I would say.')
      await app.send('/branch try sqlite')
      await app.waitFor('Branched as “try sqlite”: a new session with the conversation so far.')
      // Claude Code again: the original resumed and forked, under an id the app chose.
      await app.waitFor(() => starts(app).some(a => a.includes('--fork-session')))
      const args = starts(app).find(a => a.includes('--fork-session'))!
      assert.equal(after(args, '--resume'), 'orig')
      const id = after(args, '--session-id')!
      assert.match(id, /^[0-9a-f-]{36}$/)
      // The conversation so far is still there; the app knows it is in the branch.
      await app.send('/status')
      let s = await app.waitFor('╭ status')
      assert.match(rowOf(s, 'Session'), new RegExp(id))
      assert.match(rowOf(s, 'Branch of'), /orig \(as “try sqlite”\)/)
      assert.match(s, /Postgres, I would say\./)
      app.keys('Escape')
      // What happens in the branch is kept with the branch.
      await app.send('in the branch')
      await app.waitFor('Echo: in the branch')
      await app.hover('in the branch', { area: 'chat' })
      await app.click('☆ save', { area: 'chat' })
      await app.waitFor(/★ Saved +1/)
      await app.waitFor(() => kept(app.home, id).saved?.length === 1)
      assert.equal(kept(app.home, id).forkOf.id, 'orig')
      assert.equal(kept(app.home, 'orig').saved, undefined)
      // The picker: the branch says what it branched from, the original that it has a branch.
      await app.send('/resume')
      s = await app.waitFor('Resume a session')
      assert.match(s, /⑂ try sqlite · pick a database {2}\(a branch of orig\)/)
      assert.match(s, /pick a database {2}\(⑂ 1 branch; orig\)/)
      // Back to the original: Claude Code resumes it, not the branch; the branch's saved message isn't there.
      const rows = s.split('\n')
      const at = rows.findIndex(l => l.includes('(⑂ 1 branch'))
      const branchAt = rows.findIndex(l => l.includes('(a branch of orig)'))
      app.keys(...Array(Math.max(0, at - branchAt)).fill('Down'))
      app.keys('Enter')
      await app.waitGone('Resume a session')
      await app.waitFor(() => after(lastStart(app), '--resume') === 'orig' && !lastStart(app).includes('--fork-session'))
      s = await app.waitFor('Postgres, I would say.')
      assert.ok(!app.find('★ Saved', { area: 'panel' }), 'the branch\'s saved message is not the original\'s')
      assert.doesNotMatch(s, /in the branch/)
      // The Claude Code before it ends, and that is not this one stopping.
      await new Promise(r => setTimeout(r, 2000))
      assert.doesNotMatch(app.screen(), /Claude Code stopped/)
      // And to the branch again: its saved message is back.
      await app.send('/resume')
      await app.waitFor('Resume a session')
      app.keys('Enter')
      await app.waitFor(() => after(lastStart(app), '--resume') === id)
      await app.waitFor(/★ Saved +1/)
    }))

  test('/branch needs a conversation, and waits for Claude to finish', () =>
    withApp({ setup: history, args: ['--resume', 'orig'] }, async app => {
      await app.send('hold on')
      await app.waitFor('Starting the slow work.')
      await app.send('/branch')
      await app.waitFor('Claude is working: /branch once its turn is over')
      app.release('slow')
      await app.waitFor('The slow work is done.')
      await app.send('/clear')
      await app.waitFor('New session.')
      await app.send('/branch')
      await app.waitFor('Nothing to branch yet: send a message first.')
      assert.ok(!starts(app).some(a => a.includes('--fork-session')))
    }))

  test('/add-dir starts Claude Code again with the folder, and every restart of the session keeps it', () =>
    // A Claude Code without set_model: /model starts it again (one with set_model switches in place).
    withApp({ env: { FAKE_LATE_INIT: '1', FAKE_NO_SET_MODEL: '1' }, ready: false, setup: ({ dir }) => (mkdirSync(join(dir, 'extra')), mkdirSync(join(dir, 'more'))) }, async app => {
      await app.waitFor('Message Claude')
      const extra = join(app.dir, 'extra')
      // Before the session has an id (a real Claude Code gives it with the first message).
      await app.send('/add-dir ../extra')
      await app.waitFor('Claude can work there too')
      // (Found by what it holds: the Claude Code before may log its start after this one.)
      await app.waitFor(() => starts(app).some(a => after(a, '--add-dir') === extra))
      await app.send('/add-dir ../extra')
      await app.waitFor('Claude can already work in')
      await app.send('/add-dir ../nowhere')
      await app.waitFor('Not a folder:')
      await app.send('hello')
      await app.waitFor('Echo: hello')
      await app.waitFor(() => kept(app.home, 's1').addDirs?.[0] === extra)
      // A second one: both go; /model starting Claude Code again keeps them.
      await app.send('/add-dir ../more')
      await app.waitFor(() => starts(app).some(a => a.filter(x => x === '--add-dir').length === 2))
      await app.send('/model opus')
      await app.waitFor(() => starts(app).some(a => after(a, '--model') === 'opus'))
      const last = starts(app).find(a => after(a, '--model') === 'opus')!
      assert.deepEqual(last.filter((_, i) => last[i - 1] === '--add-dir'), [extra, join(app.dir, 'more')])
      assert.equal(after(last, '--resume'), 's1')
      await app.send('/status')
      const s = await app.waitFor('╭ status')
      assert.match(rowOf(s, 'Added folders'), /\/extra$/)
      assert.match(s, /│ +.*\/more$/m)
      app.keys('Escape')
      await app.send('/add-dir')
      await app.waitFor('Usage: /add-dir <path>')
      // A new session has none.
      await app.send('/clear')
      const fresh = () => starts(app).slice(starts(app).findIndex(a => after(a, '--model') === 'opus') + 1).find(a => !a.includes('--resume'))
      await app.waitFor(() => !!fresh())
      assert.ok(!fresh()!.includes('--add-dir'))
    }))
})
