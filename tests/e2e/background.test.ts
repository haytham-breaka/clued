// Background shell commands (Bash run_in_background): listed under Background in the panel with
// how long they run and how they ended, a click opens the command and its output (followed while it
// runs), ✕ stop asks Claude to stop one, ↻ run again asks Claude to run a stopped or failed one again,
// and they come back from the session file on resume.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rowOf, withApp, writeSession } from './harness.ts'
import type { App } from './harness.ts'

/** A command's view, drawn whole: its input box (below everything else) names it. */
const inView = (app: App, name: string) => app.waitFor(`$ about the background command: ${name}`)

/** The panel row under a command's own row (its command, who ran it, ↻ run again). */
const subRowOf = (screen: string, text: string) => {
  const ls = screen.split('\n')
  return ls[ls.findIndex(l => l.includes(text)) + 1] ?? ''
}

/** Clicks ↻ run again on the row under a command's row in the panel. */
async function rerunFromPanel(app: App, text: string) {
  await app.settle()
  const ls = app.lines()
  const r = ls.findIndex(l => l.includes(text)) + 1
  const i = ls[r]!.indexOf('↻ run again')
  assert.ok(i >= 0 && i < app.divider(), `no ↻ run again under ${text}:\n${ls.join('\n')}`)
  await app.click({ row: r + 1, col: [...ls[r]!.slice(0, i)].length + 1 })
}

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
      assert.ok(!s.includes('↻ run again'), 'nothing to run again while it runs')

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
      assert.ok(!s.includes('↻ run again'), 'a command that ended done is not offered to run again, in its view or its row')
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
      // Failed and stopped: ↻ run again on their rows; not on the running one.
      assert.match(subRowOf(s, '✕ Lint everything'), /\$ make lint · ran \d+s +↻ run again/)
      assert.match(subRowOf(s, '■ npm run dev'), /ran \d+s +↻ run again/)
      assert.doesNotMatch(subRowOf(s, '◐ Wait a long time'), /run again/)

      await app.click('Lint everything', { area: 'panel' })
      await inView(app, 'Lint everything')
      s = await app.waitFor(/\$ Background command +bfail1 +· +failed \(exit 2\) +↻ run again/)
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
      s = await app.waitFor(/\$ Background command +bmove3 +· +running +✕ stop/)
      assert.ok(!s.includes(' ↻ run again '), 'a running command has ✕ stop, not ↻ run again')
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

  test('↻ run again asks Claude to run a failed or stopped command again: the whole command, its folder, its message', () =>
    withApp({ setup: widePanel, width: 160, height: 50 }, async app => {
      await app.send('now try more commands')
      await app.waitFor('The lint failed, and I stopped the dev server.')
      await app.waitFor(/Background +1 running/)

      // From the failed command's row in the panel.
      await rerunFromPanel(app, '✕ Lint everything')
      await app.waitLog(e => e.type === 'user' && JSON.stringify(e).includes('Please run the background command'))
      let sent = app.sent().at(-1)!
      assert.equal(sent.text, `Please run the background command “Lint everything” again: it failed (exit 2).\nCommand: make lint\nFolder: ${app.work}\nRun it in the background (run_in_background), as before.`)
      assert.match(sent.note, /The user sent this with ↻ run again on your background command "Lint everything" \(task bfail1, failed \(exit 2\); command "make lint"/)
      assert.match(sent.note, /The command was run for the user's message T\d+ \("now try more commands"\): this is part of that request \(use same_as T\d+\)\./)
      let s = await app.waitFor('Echo: Please run the background command “Lint everything” again')
      // Tied to the message it was run for: the bubble says what it is about.
      assert.match(s, /↩ about: “now try more commands”/)

      // From the stopped command's view: the message stays with the command.
      await app.click('npm run dev', { area: 'panel' })
      await inView(app, 'npm run dev')
      await app.waitFor(/\$ Background command +bstop2 +· +stopped +↻ run again/)
      await app.click('↻ run again', { area: 'chat' })
      await app.waitLog(e => e.type === 'user' && JSON.stringify(e).includes('“npm run dev” again'))
      sent = app.sent().at(-1)!
      assert.equal(sent.text, `Please run the background command “npm run dev” again: it was stopped by Claude (TaskStop).\nCommand: npm run dev\nFolder: ${app.work}\nRun it in the background (run_in_background), as before.`)
      assert.match(sent.note, /↻ run again on your background command "npm run dev" \(task bstop2, stopped/)
      s = await app.waitFor('Echo: Please run the background command “npm run dev” again')
      assert.match(s, /your messages about this command/)
    }))

  test('↻ run again on a command an agent ran asks Claude to have that agent run it again', () =>
    withApp({ setup: widePanel, width: 160, height: 50 }, async app => {
      await app.send('the agent runs a command')
      await app.waitFor('The build helper says the build failed.')
      const s = await app.waitFor(/✕ Build the app +failed \(exit 1\)/)
      assert.match(subRowOf(s, '✕ Build the app'), /\$ make build · by James \(implementer\) ·.* ↻ run again/)
      await app.click('Build the app', { area: 'panel' })
      await inView(app, 'Build the app')
      await app.waitFor(/\$ Background command +bagent9 +· +failed \(exit 1\) +↻ run again/)
      await app.click('↻ run again', { area: 'chat' })
      await app.waitLog(e => e.type === 'user' && JSON.stringify(e).includes('“Build the app” again'))
      const sent = app.sent().at(-1)!
      // An agent may work in another folder: none is named.
      assert.match(sent.text, /^Please run the background command “Build the app” again: it failed \(exit 1\)\.\nCommand: make build\nYour agent .+ \(agent ar-task\) ran it: if its work needs the result, have it run the command again \(SendMessage to it\); otherwise run it again yourself\.\nRun it in the background \(run_in_background\), as before\.$/)
    }))

  test("an agent's commands: one ends when only its transcript says so; one it leaves running stays running", () =>
    withApp({ setup: widePanel, width: 160, height: 50 }, async app => {
      await app.send('the agent waits on CI')
      await app.waitFor('Started the merge helper.')
      let s = await app.waitFor(/◐ Wait for CI +running/)
      assert.match(s, /◐ Serve the docs +running/)
      assert.match(s, /2 running/)
      // Who ran each: the agent Claude Code names as its parent; the call (from the transcript) gives the command.
      s = await app.waitFor(/\$ gh pr checks 7 --watch · by /)
      assert.doesNotMatch(subRowOf(s, 'Wait for CI'), /Claude \(lead\)/)
      // The agent ends: its commands are still running, as Claude Code still lists them.
      app.release('aw-agent')
      await app.settle()
      s = await app.waitFor(/◐ Serve the docs +running/)
      assert.match(s, /◐ Wait for CI +running/)
      // CI ends: no word of it in the stream, only in the agent's transcript.
      app.release('aw-ci')
      s = await app.waitFor(/✓ Wait for CI +done/)
      assert.match(s, /◐ Serve the docs +running/)
      assert.match(s, /1 running/)
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
        { type: 'assistant', timestamp: iso(2000), cwd: '/tmp/clued-watch', message: { content: [{ type: 'tool_use', id: 'tu-b2', name: 'Bash', input: { command: 'npm run watch', description: 'Watch the files', run_in_background: true } }] } },
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
      s = await app.waitFor(/\$ Background command +rb2 +· +stopped +↻ run again/)
      assert.match(s, /ended +stopped when Claude Code exited/)
      assert.match(s, /Its output file is gone/)
      // Stopped with its Claude Code: ↻ run again, in the folder the session file names.
      await app.click('↻ run again', { area: 'chat' })
      await app.waitLog(e => e.type === 'user' && JSON.stringify(e).includes('“Watch the files” again'))
      const sent = app.sent().at(-1)!
      assert.equal(sent.text, 'Please run the background command “Watch the files” again: it was stopped when Claude Code exited.\nCommand: npm run watch\nFolder: /tmp/clued-watch\nRun it in the background (run_in_background), as before.')
      assert.match(sent.note, /run for the user's message T2 \("run the suite and watch"\)/)
    })
  })
})

/** The quote on top of the reply bubble that starts with `text` (its last row with it: the panel lists replies too): what it answers. */
const quoteOf = (screen: string, text: string) => {
  const ls = screen.split('\n')
  return ls[ls.findLastIndex(l => l.includes(text)) - 1]?.match(/↩ (.*?) *─*╮/)?.[1] ?? ''
}

describe('Claude\'s own turn after an agent or command ended', () => {
  test('words with no <<reply>> line are about what the ended one worked for; a part with a line follows it', () =>
    withApp({ width: 120, height: 50 }, async app => {
      await app.send('start a watched job')
      await app.waitIdle('Started the watched job.')
      // Your latest message, with a command of its own that ended a moment ago.
      await app.send('meanwhile, a quick command')
      await app.waitIdle('Ran the quick check.')
      app.release('wj-end')
      const s = await app.waitIdle('The quick check passed too.')
      assert.equal(quoteOf(s, 'The watched job is done.'), '“start a watched job”')
      assert.equal(quoteOf(s, 'The quick check passed too.'), '“meanwhile, a quick command”')
      assert.match(s, /✓ start a watched job/)
    }))

  test('on resume too: a command\'s end is about its message, not your latest one', () => {
    const t0 = Date.now() - 3 * 60_000
    const iso = (ms: number) => new Date(t0 + ms).toISOString()
    const ask = (text: string, topic: string, at: number) => ({ type: 'user', timestamp: iso(at), message: { role: 'user', content: [{ type: 'text', text }, { type: 'text', text: `[clued] This message is topic ${topic}.` }] } })
    const said = (text: string, at: number) => ({ type: 'assistant', timestamp: iso(at), message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } })
    const setup = (a: { home: string; work: string }) =>
      writeSession(a.home, a.work, 'old-n', [
        ask('run the suite for me', 'T1', 0),
        { type: 'assistant', timestamp: iso(1000), message: { content: [{ type: 'tool_use', id: 'tu-n1', name: 'Bash', input: { command: 'npm test', description: 'Run the suite', run_in_background: true } }] } },
        { type: 'user', timestamp: iso(1100), message: { content: [{ type: 'tool_result', tool_use_id: 'tu-n1', content: 'Command running in background with ID: rn1. Output is being written to: /tmp/rn1.output.' }] }, toolUseResult: { backgroundTaskId: 'rn1' } },
        said('Started the suite.', 2000),
        ask('what is the port', 'T2', 30_000),
        said('It is 8137.', 31_000),
        { type: 'user', timestamp: iso(60_000), message: { role: 'user', content: '<task-notification>\n<task-id>rn1</task-id>\n<tool-use-id>tu-n1</tool-use-id>\n<status>completed</status>\n<summary>Background command "Run the suite" completed (exit code 0)</summary>\n</task-notification>' } },
        said('The suite passed.\n\n<<reply T2>>\nAnd the port is still 8137.', 61_000),
      ])
    return withApp({ setup, args: ['--resume', 'old-n'], ready: 'And the port is still 8137.', width: 120, height: 50 }, async app => {
      const s = app.screen()
      assert.equal(quoteOf(s, 'The suite passed.'), '“run the suite for me”')
      assert.equal(quoteOf(s, 'And the port is still 8137.'), '“what is the port”')
    })
  })
})
