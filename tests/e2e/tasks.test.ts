// An agent's tasks: the Agent call, then each SendMessage to it. Under Agents, "· N tasks" and the
// task it is on; in its view, the Tasks block (queued, running, done), its own to-do list, a click to
// where a task starts and to the message it is for; and the tasks again on resume.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rowOf, withApp, writeSession } from './harness.ts'

const SPIN = '[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]'

/** A saved panel width (prefs), wide enough for agent rows in full. */
const widePanel = ({ home }: { home: string }) => {
  mkdirSync(join(home, '.clued'), { recursive: true })
  writeFileSync(join(home, '.clued', 'panel.json'), JSON.stringify({ width: 56 }))
}

describe('agent tasks', () => {
  test('one agent, three tasks: queued, then running, then done; the panel says which it is on', () =>
    withApp({ setup: widePanel, width: 160, height: 50 }, async app => {
      await app.send('give the agent tasks')
      let s = await app.waitFor('Started it and sent it more work.')
      // Under Agents: how many tasks, and the one it is on.
      s = await app.waitFor('↳ task 1 of 2: Fix the build')
      assert.match(s, /◐ James \(implementer\) · 2 tasks · Fix the build bg/)
      // Its view: the Tasks block, the first running, the second queued; its to-do list.
      await app.click('2 tasks', { area: 'panel' })
      s = await app.waitFor('To-do  1 of 3 done')
      assert.match(s, /Tasks {2}2 · 1 running · 1 queued/)
      assert.match(s, new RegExp(`${SPIN} 1\\. Fix the build +\\d\\d:\\d\\d · T1`))
      assert.match(s, /◌ 2\. Also run the linter +\d\d:\d\d · T1/)
      assert.match(s, /☑ Read the error/)
      assert.match(s, /◐ Fix the import/)
      assert.match(s, /☐ Run the linter/)
      assert.match(s, /◌ task 2 · queued: it gets it after this run/)
      assert.match(s, /✻ Claude asked · task 1/)
      // The message arrives in its transcript: the second task runs, and starts there in the log.
      app.release('task2')
      s = await app.waitFor(new RegExp(`${SPIN} 2\\. Also run the linter`))
      assert.match(s, /Tasks {2}2 · 2 running/)
      s = await app.waitFor('✻ Claude sent task 2')
      assert.match(s, /\$ Run the linter/)
      s = await app.waitFor('◐ Run the linter')
      assert.match(s, /To-do {2}2 of 3 done/)
      s = await app.waitFor('↳ task 2 of 2: Also run the linter')
      // The run ends: both tasks it covered are done. Claude sends one more, which continues it.
      app.release('done1')
      s = await app.waitFor('↳ task 3 of 3: Now write the release notes')
      assert.match(s, /◐ James \(implementer\) · 3 tasks · Fix the build/)
      s = await app.waitFor(new RegExp(`${SPIN} 3\\. Now write the release notes for this fix`))
      assert.match(s, /✓ 1\. Fix the build/)
      assert.match(s, /✓ 2\. Also run the linter/)
      assert.match(s, /Tasks {2}3 · 1 running · 2 done/)
      app.release('done2')
      s = await app.waitFor('Tasks  3 · 3 done')
      assert.match(s, /✓ 3\. Now write the release notes/)
      assert.match(s, /✓ handed back to Claude/)
      assert.match(s, /Release notes written/)
      s = await app.waitFor(/✓ James \(implementer\) · 3 tasks/)
      assert.match(rowOf(s, '↳ task 3 of 3'), /Now write the release notes/)
      // A task's topic id goes to your message in the chat.
      await app.click('T1', { area: 'chat', nth: 0 })
      s = await app.waitGone('Tasks  3 · 3 done')
      assert.match(s, /All three tasks are done\./)
    }))

  test('a click on a task goes to where it starts in the log', () =>
    withApp({ setup: widePanel, width: 160, height: 30 }, async app => {
      await app.send('give the agent tasks')
      await app.waitFor('Started it and sent it more work.')
      app.release('task2')
      app.release('done1')
      app.release('done2')
      await app.waitFor('All three tasks are done.')
      await app.click('3 tasks', { area: 'panel' })
      // The view opens at its end; the Tasks block is at its top.
      let s = await app.waitFor('✓ handed back to Claude')
      for (let i = 0; i < 6 && !s.includes('Tasks  3 · 3 done'); i++) {
        app.keys('PageUp')
        await new Promise(r => setTimeout(r, 150))
        s = await app.waitFor(() => true)
      }
      assert.match(s, /Tasks {2}3 · 3 done/)
      await app.click('3. Now write the release notes', { area: 'chat' })
      s = await app.waitFor('✻ Claude sent task 3')
      assert.ok(!s.includes('Tasks  3 · 3 done'), 'scrolled down to it')
      assert.match(s, /✎ Wrote NOTES\.md/)
    }))

  test('an agent stopped mid-step: the interruption line is no message to it, so the queued task waits for its own', () =>
    withApp({ setup: widePanel, width: 160, height: 50 }, async app => {
      await app.send('give the agent tasks, interrupted')
      await app.waitFor('Started it and sent it more work.')
      await app.click('2 tasks', { area: 'panel' })
      let s = await app.waitFor('To-do  1 of 3 done')
      assert.match(s, /Clean the build/)
      assert.match(s, /Tasks {2}2 · 1 running · 1 queued/)
      assert.match(s, /◌ 2\. Also run the linter/)
      app.release('task2')
      s = await app.waitFor(new RegExp(`${SPIN} 2\\. Also run the linter`))
      assert.match(s, /Tasks {2}2 · 2 running/)
      await app.waitFor('✻ Claude sent task 2')
    }))

  test('a fork: Claude\'s Agent call that started it is not its step, and a message Claude sends it arrives', () =>
    withApp({ setup: widePanel, width: 160, height: 50 }, async app => {
      await app.send('start a fork agent')
      await app.waitFor('Started a fork and sent it more.')
      await app.click('2 tasks', { area: 'panel' })
      let s = await app.waitFor('Reading the docs.')
      assert.match(s, /Read README\.md/)
      assert.ok(!s.includes('Agent: Check the docs'), 'the call that started it is Claude\'s, not its step')
      assert.match(s, /◌ 2\. Also check the changelog/)
      app.release('fork-msg')
      s = await app.waitFor(new RegExp(`${SPIN} 2\\. Also check the changelog`))
      assert.match(s, /Tasks {2}2 · 2 running/)
      s = await app.waitFor('Read CHANGELOG.md')
      assert.match(s, /✻ Claude sent task 2/)
      assert.ok(!s.includes('Agent: Check the docs'))
    }))

  test('on resume, the tasks come back from the session file and the agent\'s own transcript', async () => {
    const t0 = Date.now() - 90_000
    const iso = (ms: number) => new Date(t0 + ms).toISOString()
    const note = (id: string, summary: string) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`
    const setup = (a: { home: string; work: string }) => {
      widePanel(a)
      writeSession(a.home, a.work, 'old-a', [
        { type: 'user', timestamp: iso(0), message: { role: 'user', content: [{ type: 'text', text: 'fix the build please' }, { type: 'text', text: '[clued] This message is topic T4.' }] } },
        { type: 'assistant', timestamp: iso(1000), message: { content: [{ type: 'tool_use', id: 'tu-a', name: 'Agent', input: { description: 'Fix the build', subagent_type: 'general-purpose', prompt: 'Fix the build.', run_in_background: true } }] } },
        { type: 'user', timestamp: iso(1100), message: { content: [{ type: 'tool_result', tool_use_id: 'tu-a', content: 'Async agent launched successfully. agentId: rs-9' }] } },
        { type: 'assistant', timestamp: iso(2000), message: { content: [{ type: 'tool_use', id: 'tu-s1', name: 'SendMessage', input: { to: 'rs-9', summary: 'Also run the linter', message: 'Also run the linter.' } }] } },
        { type: 'user', timestamp: iso(2100), message: { content: [{ type: 'tool_result', tool_use_id: 'tu-s1', content: 'Message queued.' }] } },
        { type: 'assistant', timestamp: iso(3000), message: { content: [{ type: 'text', text: 'Started it.' }] } },
        { type: 'user', timestamp: iso(30_000), message: { role: 'user', content: note('rs-9', 'Build fixed') } },
        { type: 'assistant', timestamp: iso(31_000), message: { content: [{ type: 'tool_use', id: 'tu-s2', name: 'SendMessage', input: { to: 'rs-9', message: 'Now write the release notes.' } }] } },
        { type: 'user', timestamp: iso(31_100), message: { content: [{ type: 'tool_result', tool_use_id: 'tu-s2', content: 'Resumed.' }] } },
        { type: 'user', timestamp: iso(60_000), message: { role: 'user', content: note('rs-9', 'Notes written') } },
        { type: 'assistant', timestamp: iso(61_000), message: { content: [{ type: 'text', text: 'All done with the build.' }] } },
      ])
      const sub = join(a.home, '.claude', 'projects', a.work.replace(/[^a-zA-Z0-9]/g, '-'), 'old-a', 'subagents')
      mkdirSync(sub, { recursive: true })
      writeFileSync(join(sub, 'agent-rs-9.jsonl'), [
        { type: 'user', isSidechain: true, message: { content: 'Fix the build.' } },
        // As Claude Code writes them: a compaction's summary (no message to it), then each message
        // Claude sent, hidden.
        { type: 'system', subtype: 'compact_boundary', isSidechain: true, content: 'Conversation compacted' },
        { type: 'user', isSidechain: true, isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { content: 'This session is being continued from a previous conversation that ran out of context.' } },
        { type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', id: 'r1', name: 'TodoWrite', input: { todos: [{ content: 'Fix the import', status: 'completed' }, { content: 'Lint', status: 'in_progress' }] } }] } },
        { type: 'user', isSidechain: true, isMeta: true, origin: { kind: 'coordinator' }, message: { content: 'The coordinator sent a message while you were working:\nAlso run the linter.\n\nAddress this before completing your current task.' } },
        { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'Linting now.' }] } },
        { type: 'user', isSidechain: true, isMeta: true, origin: { kind: 'coordinator' }, message: { content: 'The coordinator sent a message while you were working:\nNow write the release notes.\n\nAddress this before completing your current task.' } },
        { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'Writing the notes.' }] } },
      ].map(l => JSON.stringify(l)).join('\n') + '\n')
    }
    await withApp({ setup, args: ['--resume', 'old-a'], width: 160, height: 50 }, async app => {
      let s = await app.waitFor('All done with the build.')
      s = await app.waitFor('↳ task 3 of 3: Now write the release notes.')
      assert.match(s, /✓ James \(implementer\) · 3 tasks · Fix/)
      await app.click('3 tasks', { area: 'panel' })
      s = await app.waitFor('Tasks  3 · 3 done')
      assert.match(s, /✓ 1\. Fix the build +\d\d:\d\d · T4/)
      assert.match(s, /✓ 2\. Also run the linter +\d\d:\d\d · T4/)
      assert.match(s, /✓ 3\. Now write the release notes\. +\d\d:\d\d · T4/)
      s = await app.waitFor('To-do  1 of 2 done')
      assert.match(s, /◐ Lint/)
      assert.match(s, /Notes written/)
      s = await app.waitFor('✻ Claude sent task 3')
      assert.match(s, /✻ Claude sent task 2/)
      assert.match(s, /Linting now\./)
      // Each starts where its message arrived: task 2 after the plan, task 3 after the linting.
      assert.ok(s.indexOf('Updated the plan') < s.indexOf('✻ Claude sent task 2'), 'task 2 starts after the plan')
      assert.ok(s.indexOf('Linting now.') < s.indexOf('✻ Claude sent task 3'), 'task 3 starts after the linting')
    })
  })
})

describe('not started', () => {
  test('a request Claude owes with nothing on it: listed until an agent starts for it', () =>
    withApp({ setup: widePanel, width: 160, height: 44 }, async app => {
      await app.send('please do it later')
      let s = await app.waitFor('Not started')
      assert.match(rowOf(s, 'Not started'), /Not started +1│/)
      assert.match(rowOf(s, '▷ Topic T1'), /▷ Topic T1 +▶ start \d+s│/)
      // A click opens its request.
      await app.click('Topic T1', { area: 'panel' })
      s = await app.waitFor('▣ Request T1')
      app.keys('Escape')
      await app.waitGone('▣ Request T1')
      // Claude goes on by itself with an agent for it: the row leaves.
      app.release('later')
      s = await app.waitFor('Do the later work')
      assert.ok(!s.includes('Not started'), 'gone while an agent is on it')
      assert.match(s, /◐ James \(implementer\) · Do the later work/)
      assert.match(s, /↳ “please do it later”/)
      app.release('later-agent')
      s = await app.waitFor('The later work is done.')
      assert.ok(!s.includes('Not started'), 'done now')
    }))

  test('▶ start asks Claude, in the chat, to start on it now', () =>
    withApp({ setup: widePanel, width: 160, height: 44 }, async app => {
      await app.send('please do it later')
      await app.waitFor('▷ Topic T1')
      await app.click('▶ start', { area: 'panel' })
      // Sent as part of that request, and Claude's turn is on it now: the row leaves.
      let s = await app.waitFor('↳ “Please start on T1 now.”')
      assert.ok(!s.includes('Not started'))
      assert.match(s, /↩ you: “please do it later”/)
      assert.equal(app.sent().at(-1)!.text, 'Please start on T1 now.')
      assert.match(app.sent().at(-1)!.note, /request T1/)
      app.release('started')
      app.release('later')
      app.release('later-agent')
      s = await app.waitFor('The later work is done.')
    }))

  test('while Claude works on something else, "+ queue" instead of ▶ start: the request waits its turn', () =>
    withApp({ setup: widePanel, width: 160, height: 44 }, async app => {
      await app.send('please do it later')
      let s = await app.waitFor('▷ Topic T1')
      assert.match(rowOf(s, '▷ Topic T1'), /▶ start/)
      // Claude busy with another message: it can't start now.
      await app.send('hold on')
      s = await app.waitFor(/▷ Topic T1 +\+ queue \d+s│/)
      assert.ok(!rowOf(s, '▷ Topic T1').includes('▶ start'))
      await app.click('+ queue', { area: 'panel' })
      // Claude is still on "hold on": the start request waits in queue until Claude Code takes it in.
      s = await app.waitFor(/⏳ Please start on T1 now\. +in queue/)
      // Claude hasn't taken it in yet: its row is on "hold on" alone.
      assert.match(s, /↳ “hold on”(?! \+)/)
      assert.equal(app.sent().at(-1)!.text, 'Please start on T1 now.')
      app.release('slow')
      app.release('started')
      app.release('later')
      app.release('later-agent')
    }))

  test('an agent just ended: its request is not "Not started" while Claude follows up on its result', () =>
    withApp({ setup: widePanel, width: 160, height: 44 }, async app => {
      await app.send('hand back please')
      await app.waitFor(/◐ James \(implementer\) · Short job bg/)
      app.release('bg-end')
      // Ended, Claude idle, its follow-up not written yet: still worked on, no ▶ start.
      let s = await app.waitFor(/✓ James \(implementer\) · Short job bg +done/)
      await new Promise(r => setTimeout(r, 1500))
      s = app.screen()
      assert.ok(!s.includes('Not started'), 'not "Not started" in the gap')
      assert.ok(!s.includes('▶ start'))
      app.release('gap')
      s = await app.waitFor('The short job is done.')
      assert.ok(!s.includes('Not started'))
      // The follow-up ended: the grace ends with it, and its tag settles the request.
      await app.waitFor(/✓ hand back please/)
    }))

  test('an agent ended and no follow-up came: past the grace, its request is Not started again', () =>
    withApp({ setup: widePanel, width: 160, height: 44, env: { CLUED_HANDBACK_MS: '2000' } }, async app => {
      await app.send('hand back please')
      await app.waitFor(/◐ James \(implementer\) · Short job bg/)
      app.release('bg-end')
      await app.waitFor(/✓ James \(implementer\) · Short job bg +done/)
      assert.ok(!app.screen().includes('Not started'))
      const s = await app.waitFor(/▷ Topic T1 +▶ start/)
      assert.match(s, /Not started/)
    }))

  test('Claude asking you (its questions, or a permission) is "waiting on you", never working or quiet', () =>
    withApp({ setup: widePanel, width: 160, height: 44, env: { CLUED_QUIET_MS: '1500' } }, async app => {
      await app.send('offer choices')
      let s = await app.waitFor(/✻ Claude \(lead\).* +waiting on you│/)
      // Past the quiet time, and past when a tool's name would show: still waiting on you.
      await new Promise(r => setTimeout(r, 2500))
      s = app.screen()
      assert.match(rowOf(s, '✻ Claude (lead)'), /waiting on you│/)
      assert.doesNotMatch(s, /quiet \d|running AskUserQuestion/)
      app.keys('Escape')
      await app.waitFor('No answer:')
      await app.send('need permission')
      s = await app.waitFor(/✻ Claude \(lead\).* +waiting on you│/)
      await new Promise(r => setTimeout(r, 2500))
      assert.doesNotMatch(app.screen(), /quiet \d/)
      app.keys('y')
      s = await app.waitFor('Permission was allowed.')
      assert.doesNotMatch(s, /waiting on you│/)
    }))

  test('a running agent: the tool it waits on, then quiet once nothing comes; ▶ continue asks Claude to check on it', () =>
    withApp({ setup: ({ home }) => {
      mkdirSync(join(home, '.clued'), { recursive: true })
      writeFileSync(join(home, '.clued', 'panel.json'), JSON.stringify({ width: 68 }))
    }, height: 44, width: 150, env: { CLUED_QUIET_MS: '2500' } }, async app => {
      await app.send('quiet agent please')
      await app.waitFor('Started the evals in the background.')
      // A long tool run is not quiet: it says what it waits on, however long.
      let s = await app.waitFor(/◐ James \(implementer\) · Run the evals bg +running Bash \d+s/)
      await app.waitFor(/running Bash [3-9]s/)
      assert.doesNotMatch(app.screen(), /quiet \d/)
      // Its result comes, then nothing more: quiet.
      app.release('tool')
      s = await app.waitFor(/Run the evals bg +last step \ds ago/)
      s = await app.waitFor(/Run the evals bg +quiet \ds/)
      await app.click('James (implementer)', { area: 'panel' })
      s = await app.waitFor(/◌ no new steps for \ds: it may be stuck\. +▶ continue/)
      assert.match(s, /working for \S+ · 1 step so far · last step \ds ago/)
      await app.click('▶ continue', { area: 'chat' })
      await app.waitFor('I will check on it.')
      assert.match(app.sent().at(-1)!.text, /^James \(agent qa-9\) seems to have gone quiet: no new steps for \ds\. Check on it, and if it has stopped, use SendMessage to it to continue its work\.$/)
    }))
})
