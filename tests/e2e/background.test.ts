// Background shell commands (Bash run_in_background): listed under Background in the panel with
// how long they run and how they ended, a click opens the command and its output (followed while it
// runs), ✕ stop asks Claude to stop one, and they come back from the session file on resume.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rowOf, withApp, writeSession } from './harness.ts'
import type { App } from './harness.ts'

/** A command's view, drawn whole: its input box (below everything else) names it. */
const inView = (app: App, name: string) => app.waitFor(`$ about the background command: ${name}`)

/** A saved panel width (prefs), wide enough for the rows in full. */
const widePanel = ({ home }: { home: string }) => {
  mkdirSync(join(home, '.clued'), { recursive: true })
  writeFileSync(join(home, '.clued', 'panel.json'), JSON.stringify({ width: 56 }))
}

describe('background commands', () => {
  test('one row while it runs; its view follows the output; it ends done with its exit code, and Claude follows up', () =>
    withApp({ setup: widePanel, width: 160, height: 50 }, async app => {
      let s = await app.screen()
      assert.ok(!s.includes('Background'), 'no section without a command')
      await app.send('start a background command')
      await app.waitFor('Started the slow tests in the background.')
      s = await app.waitFor(/Background +1 running/)
      assert.match(rowOf(s, '◐ Run the slow tests'), /◐ Run the slow tests +running \d+s/)
      assert.match(s, /\$ npm test -- --slow/)

      // Its view: what it is, who ran it and for which message, the command and its output so far.
      await app.click('Run the slow tests', { area: 'panel' })
      await inView(app, 'Run the slow tests')
      s = await app.waitFor('Output so far')
      assert.match(s, /\$ Background · Run the slow tests +running/)
      assert.match(s, /\$ Background command +bsh42 +· +running +✕ stop/)
      assert.match(s, /run by +✻ Claude \(lead\)/)
      assert.match(s, /for +↳ “start a background command”/)
      assert.match(s, /bsh42\.output/)
      assert.match(s, /test 1 ok/)
      assert.match(s, /still running: the output follows as it comes/)
      assert.match(s, /\$ about the background command: Run the slow tests/)

      // More output: the view shows it without a click; a progress line keeps only what it last showed.
      app.release('bsh-more')
      s = await app.waitFor('test 2 ok')
      assert.match(s, /progress 100%/)
      assert.ok(!s.includes('progress 10%'), 'a rewritten line shows as the terminal left it')

      // It ends: done, exit code 0, Claude Code's summary; Claude follows up on it.
      app.release('bsh-end')
      // (Claude Code's task_updated ends it a moment before the notification brings its exit code.)
      s = await app.waitFor(/exit code +0/)
      assert.match(s, /\$ Background command +bsh42 +· +done/)
      assert.match(s, /all 2 passed/)
      assert.match(s, /ended +Background command "Run the slow tests" completed \(exit code 0\)/)
      assert.ok(!s.includes('✕ stop'), 'nothing to stop')
      assert.match(rowOf(s, '✓ Run the slow tests'), /done \d+s ago/)
      assert.match(s, /Background +all done/)
      app.keys('Escape')
      s = await app.waitFor('The slow tests passed.')
      assert.ok(!s.includes('Output so far'))
    }))

  test('a failed command, a stopped one, one moved to the background, one refused; ✕ stop asks Claude', () =>
    withApp({ setup: widePanel, width: 160, height: 50 }, async app => {
      await app.send('now try more commands')
      let s = await app.waitFor('The lint failed, and I stopped the dev server.')
      s = await app.waitFor(/Background +1 running/)
      assert.match(rowOf(s, '✕ Lint everything'), /failed \(exit 2\) \d+s ago/)
      // No description: the row shows its command.
      assert.match(rowOf(s, '■ npm run dev'), /stopped \d+s ago/)
      assert.match(rowOf(s, '◐ Wait a long time'), /running \d+s/)
      assert.ok(!/[◐✓✕■] Clean the build/.test(s), 'a call that never ran is not listed')

      await app.click('Lint everything', { area: 'panel' })
      await inView(app, 'Lint everything')
      s = await app.waitFor(/\$ Background command +bfail1 +· +failed \(exit 2\)/)
      assert.match(s, /exit code +2/)
      assert.match(s, /lint: 3 errors/)
      assert.match(s, /ended +Background command "Lint everything" failed with exit code 2/)

      await app.click('npm run dev', { area: 'panel' })
      await inView(app, 'npm run dev')
      s = await app.waitFor(/\$ Background command +bstop2 +· +stopped/)
      assert.match(s, /ended +stopped by Claude \(TaskStop\)/)
      assert.match(s, /listening on 3000/)

      // Moved to the background past its timeout; its output file is gone.
      await app.click('Wait a long time', { area: 'panel' })
      await inView(app, 'Wait a long time')
      s = await app.waitFor(/\$ Background command +bmove3 +· +running/)
      assert.match(s, /note +moved to the background when it ran past its timeout/)
      assert.match(s, /Its output file is gone/)
      assert.match(s, /Write below to ask Claude about this command\./)
      // ✕ stop asks Claude, from the command's view, and the message stays with it.
      await app.click('✕ stop', { area: 'chat' })
      await app.waitLog(e => e.type === 'user' && JSON.stringify(e).includes('Please stop the background command'))
      const sent = app.sent().at(-1)!
      assert.equal(sent.text, 'Please stop the background command “Wait a long time” (task bmove3) with TaskStop.')
      assert.match(sent.note, /from inside the view of your background command "Wait a long time" \(task bmove3, running; command "sleep 999"/)
      s = await app.waitFor('Echo: Please stop the background command')
      assert.match(s, /your messages about this command/)
    }))

  test('on resume, commands come back from the session file: ended as it says, or stopped with its Claude Code', async () => {
    const t0 = Date.now() - 3 * 60_000
    const iso = (ms: number) => new Date(t0 + ms).toISOString()
    const note = (id: string, tool: string, status: string, summary: string) =>
      `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>${tool}</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`
    const setup = (a: { home: string; work: string }) => {
      widePanel(a)
      const file = (id: string) => join(a.work, `${id}.output`)
      writeFileSync(file('rb1'), 'FAIL tests/a.test.ts\n')
      const started = (id: string) => `Command running in background with ID: ${id}. Output is being written to: ${file(id)}. You will be notified when it completes.`
      writeSession(a.home, a.work, 'old-b', [
        { type: 'user', timestamp: iso(0), message: { role: 'user', content: [{ type: 'text', text: 'run the suite and watch' }, { type: 'text', text: '[clued] This message is topic T2.' }] } },
        { type: 'assistant', timestamp: iso(1000), message: { content: [{ type: 'tool_use', id: 'tu-b1', name: 'Bash', input: { command: 'npm test', description: 'Run the suite', run_in_background: true } }] } },
        { type: 'user', timestamp: iso(1100), message: { content: [{ type: 'tool_result', tool_use_id: 'tu-b1', content: started('rb1') }] }, toolUseResult: { stdout: '', stderr: '', backgroundTaskId: 'rb1' } },
        { type: 'assistant', timestamp: iso(2000), message: { content: [{ type: 'tool_use', id: 'tu-b2', name: 'Bash', input: { command: 'npm run watch', description: 'Watch the files', run_in_background: true } }] } },
        { type: 'user', timestamp: iso(2100), message: { content: [{ type: 'tool_result', tool_use_id: 'tu-b2', content: started('rb2') }] }, toolUseResult: { backgroundTaskId: 'rb2' } },
        { type: 'assistant', timestamp: iso(3000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Started both.' }] } },
        { type: 'user', timestamp: iso(60_000), message: { role: 'user', content: note('rb1', 'tu-b1', 'failed', 'Background command "Run the suite" failed with exit code 1') } },
        { type: 'assistant', timestamp: iso(61_000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The suite failed.' }] } },
      ])
    }
    await withApp({ setup, args: ['--resume', 'old-b'], width: 160, height: 50 }, async app => {
      let s = await app.waitFor('The suite failed.')
      s = await app.waitFor(/Background +all done/)
      assert.match(rowOf(s, '✕ Run the suite'), /failed \(exit 1\) \d+m \d+s ago/)
      assert.match(rowOf(s, '■ Watch the files'), /stopped/)
      await app.click('Run the suite', { area: 'panel' })
      await inView(app, 'Run the suite')
      s = await app.waitFor(/\$ Background command +rb1 +· +failed \(exit 1\)/)
      assert.match(s, /FAIL tests\/a\.test\.ts/)
      assert.match(s, /for +↳ “run the suite and watch”/)
      await app.click('Watch the files', { area: 'panel' })
      await inView(app, 'Watch the files')
      s = await app.waitFor(/\$ Background command +rb2 +· +stopped/)
      assert.match(s, /ended +stopped when Claude Code exited/)
      assert.match(s, /Its output file is gone/)
    })
  })
})
