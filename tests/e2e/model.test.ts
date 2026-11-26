// /model: a card of Claude Code's models (its answer to initialize), as Claude Code's own /model.
// Enter switches the running Claude Code (set_model) and ←/→ its effort (apply_flag_settings): no
// restart, the conversation goes on. The choice holds for the session, after a /reload too.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rowOf, withApp, writeSession } from './harness.ts'

/** The arguments of each Claude Code the app started, oldest first. */
const starts = (app: { claudeLog: () => any[] }) => app.claudeLog().filter(e => Array.isArray(e.args)).map(e => e.args as string[])
const after = (args: string[], flag: string) => (args.includes(flag) ? args[args.lastIndexOf(flag) + 1] : undefined)
/** The control requests of one kind the app sent. */
const requests = (app: { claudeLog: () => any[] }, subtype: string) => app.claudeLog().filter(e => e.type === 'control_request' && e.request?.subtype === subtype).map(e => e.request)
const kept = (home: string, id: string) => (existsSync(join(home, '.clued', 'sessions', `${id}.json`)) ? JSON.parse(readFileSync(join(home, '.clued', 'sessions', `${id}.json`), 'utf8')) : {})

describe('/model', () => {
  test('opens a picker of the models; Enter switches the running Claude Code, with no restart', () =>
    withApp({}, async app => {
      await app.send('hello')
      await app.waitFor('Echo: hello')
      await app.send('/model')
      let s = await app.waitFor('Select model')
      // Each model with its description; the one in use marked; the effort Claude Code said it runs with.
      assert.match(rowOf(s, 'Default (recommended)'), /▸ 1\. Default \(recommended\) ✔ +Fake 1\.0 · for tests/)
      assert.match(rowOf(s, '2. Fake 1.0'), /2\. Fake 1\.0 +For everyday tests/)
      assert.match(rowOf(s, 'Opal 2.0'), /3\. Opal 2\.0 +For the hardest tests/)
      assert.match(rowOf(s, 'Quick 1.5'), /4\. Quick 1\.5 +Fastest for quick answers/)
      assert.match(rowOf(s, 'High effort'), /High effort +low +medium +\[high\] +max +← → to adjust/)
      assert.match(s, /↑↓ choose · ←→ effort · Enter switch · Esc cancel/)
      app.keys('Down', 'Down')
      await app.waitFor('▸ 3. Opal 2.0')
      app.keys('Enter')
      await app.waitFor('Model: Opal 2.0')
      await app.waitGone('Select model')
      // The status line has the new model; the same Claude Code goes on with the conversation.
      await app.waitFor(' Opal 2.0  s1')
      assert.deepEqual(requests(app, 'set_model'), [{ subtype: 'set_model', model: 'opal' }])
      await app.send('and now')
      await app.waitFor('Echo: and now')
      assert.equal(starts(app).length, 1, 'no restart')

      // ←/→: the effort, for the model picked; Enter sets it.
      await app.send('/model')
      s = await app.waitFor('Select model')
      assert.match(s, /▸ 3\. Opal 2\.0 ✔/)
      app.keys('Right')
      s = await app.waitFor('Max effort')
      assert.match(s, /\[max\]/)
      app.keys('Enter')
      await app.waitFor(() => requests(app, 'apply_flag_settings').length === 1)
      assert.deepEqual(requests(app, 'apply_flag_settings')[0].settings, { effortLevel: 'max' })
      await app.waitFor('Max effort')
      assert.equal(requests(app, 'set_model').length, 1, 'the same model is not switched again')

      // Esc leaves it as it was.
      await app.send('/model')
      await app.waitFor('Select model')
      app.keys('Escape')
      await app.waitGone('Select model')

      // A click on a row switches to it; a model with no effort levels says so.
      await app.send('/model')
      await app.waitFor('Select model')
      await app.click('Quick 1.5')
      await app.waitFor('Model: Quick 1.5')
      await app.waitFor(' Quick 1.5  s1')
      await app.send('/model')
      s = await app.waitFor('Select model')
      assert.match(s, /▸ 4\. Quick 1\.5 ✔/)
      assert.match(s, /This model has no effort levels\./)
      assert.doesNotMatch(s, /←→ effort/)
      app.keys('Left', 'Enter')
      await app.waitFor('Kept Quick 1.5.')
      assert.equal(starts(app).length, 1, 'still no restart')

      // Kept with the session, and each Claude Code from now on starts with it.
      await app.waitFor(() => kept(app.home, 's1').model === 'quick')
      assert.equal(kept(app.home, 's1').effort, 'max')
      await app.send('/clear')
      await app.waitFor(() => starts(app).length === 2)
      assert.equal(after(starts(app)[1]!, '--model'), 'quick')
      assert.equal(after(starts(app)[1]!, '--effort'), 'max')
    }))

  test('/model <name> switches the same way; the slash menu completes the names; an unknown one is refused', () =>
    withApp({}, async app => {
      await app.send('/model opal')
      await app.waitFor('Model: Opal 2.0')
      await app.waitFor(' Opal 2.0  s1')
      await app.send('/model nope')
      await app.waitFor('Claude Code has no model “nope”')
      await app.waitFor(' Opal 2.0  s1')
      app.type('/model q')
      const s = await app.waitFor('/model quick')
      assert.match(rowOf(s, '/model quick'), /Quick 1\.5 · Fastest for quick answers/)
      app.keys('Enter')
      await app.waitFor('Model: Quick 1.5')
      assert.deepEqual(requests(app, 'set_model').map(r => r.model), ['opal', 'nope', 'quick'])
      assert.equal(starts(app).length, 1, 'no restart')
    }))

  test('a Claude Code without set_model is started again on the session with --model and --effort', () =>
    withApp({ env: { FAKE_NO_SET_MODEL: '1' } }, async app => {
      await app.send('hello')
      await app.waitFor('Echo: hello')
      await app.send('/model')
      await app.waitFor('Select model')
      app.keys('Down', 'Down', 'Left', 'Enter')
      await app.waitFor('Model: Opal 2.0 · medium effort')
      await app.waitFor(() => starts(app).length === 2)
      const args = starts(app)[1]!
      assert.equal(after(args, '--resume'), 's1')
      assert.equal(after(args, '--model'), 'opal')
      assert.equal(after(args, '--effort'), 'medium')
      await app.waitFor(' Opal 2.0  s1')
      // Effort alone: Claude Code again too, with the new level.
      await app.send('/model')
      await app.waitFor('▸ 3. Opal 2.0 ✔')
      app.keys('Left', 'Enter')
      await app.waitFor(() => starts(app).length === 3)
      assert.equal(after(starts(app)[2]!, '--effort'), 'low')
      assert.equal(after(starts(app)[2]!, '--model'), 'opal')
    }))

  test('the session keeps its model and effort: Claude Code resumes it with them (as after a /reload)', () =>
    withApp({
      args: ['--resume', 'orig', '--model', 'quick'],
      ready: 'Opal 2.0',
      setup: a => {
        writeSession(a.home, a.work, 'orig', [{ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'pick a database' } }])
        mkdirSync(join(a.home, '.clued', 'sessions'), { recursive: true })
        writeFileSync(join(a.home, '.clued', 'sessions', 'orig.json'), JSON.stringify({ model: 'opal', effort: 'low' }))
      },
    }, async app => {
      const args = starts(app)[0]!
      assert.equal(after(args, '--model'), 'opal')
      assert.equal(after(args, '--effort'), 'low')
      assert.equal(args.filter(a => a === '--model').length, 1)
      await app.send('/model')
      const s = await app.waitFor('Select model')
      assert.match(s, /▸ 3\. Opal 2\.0 ✔/)
      assert.match(s, /Low effort +\[low\]/)
    }))

  test('with no models listed, /model says how to switch by name; Ctrl+C closes the picker', async () => {
    await withApp({ env: { FAKE_NO_MODELS: '1' } }, async app => {
      await app.send('/model')
      await app.waitFor('Claude Code has not listed its models yet. /model <name> switches')
      await app.send('/model opal')
      await app.waitFor(' Opal 2.0  s1')
    })
    await withApp({}, async app => {
      await app.send('/model')
      await app.waitFor('Select model')
      app.keys('C-c')
      await app.waitGone('Select model')
      assert.equal(requests(app, 'set_model').length, 0)
    })
  })
})
