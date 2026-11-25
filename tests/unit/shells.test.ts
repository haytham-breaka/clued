import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canRerun, newShells, onShellCall, onShellResult, onShellsExit, onShellTask, readOutput, rerunText, shellName, shellsFromTurns, shellState, shownShells, stopText, SHELL_CUT_KEEP_MS, SHELL_KEEP_MS } from '../../app/shells.ts'
import type { Shell } from '../../app/shells.ts'
import { panelLines } from '../../app/panel.ts'
import type { PanelCtx } from '../../app/panel.ts'
import { newTurn } from '../../app/session.ts'

const NOW = 1_700_000_000_000
const bash = (id: string, input: Record<string, unknown>) => ({ id, name: 'Bash', input })
const started = (id: string) => `Command running in background with ID: ${id}. Output is being written to: /tmp/tasks/${id}.output. You will be notified when it completes.`

describe('background commands from the stream', () => {
  test('a background Bash call is listed at once; its result gives its id and output file; its notification ends it', () => {
    const sh = newShells()
    onShellCall(sh, bash('u1', { command: 'npm test', description: 'Run tests', run_in_background: true }), NOW, { for: ['k1'] })
    // A foreground call is not listed, and a tool that is no shell's is not remembered.
    onShellCall(sh, bash('u2', { command: 'ls' }), NOW, { for: [] })
    onShellCall(sh, { id: 'r1', name: 'Read', input: {} }, NOW, { for: [] })
    assert.equal(sh.list.length, 1)
    assert.equal(sh.calls.has('r1'), false)
    const s = sh.list[0]!
    assert.deepEqual([s.state, s.command, s.description, s.for, s.startedAt], ['running', 'npm test', 'Run tests', ['k1'], NOW])
    // Called again (the same call seen twice): still one.
    onShellCall(sh, bash('u1', { run_in_background: true }), NOW, { for: [] })
    assert.equal(sh.list.length, 1)
    assert.equal(onShellTask(sh, { phase: 'started', taskId: 'b1', toolUseId: 'u1', type: 'local_bash', isBackgrounded: true }, NOW, { for: [] }), true)
    assert.equal(s.taskId, 'b1')
    onShellResult(sh, 'u1', started('b1'), false, undefined, NOW + 10)
    assert.equal(s.outputFile, '/tmp/tasks/b1.output')
    // The foreground call's plain result: nothing to list. A result for no call: nothing.
    onShellResult(sh, 'u2', 'file.txt', false, undefined, NOW)
    onShellResult(sh, 'nope', started('zz'), false, undefined, NOW)
    assert.equal(sh.list.length, 1)
    // Ended by task_updated first, then the notification brings the summary and exit code.
    onShellTask(sh, { phase: 'updated', taskId: 'b1', status: 'completed' }, NOW + 5000, { for: [] })
    assert.deepEqual([s.state, s.endedAt, s.note], ['done', NOW + 5000, undefined])
    onShellTask(sh, { phase: 'done', taskId: 'b1', status: 'completed', text: 'Background command "Run tests" completed (exit code 1: No matches found)', outputFile: '/tmp/other.output' }, NOW + 6000, { for: [] })
    assert.deepEqual([s.state, s.endedAt, s.exitCode, s.outputFile], ['done', NOW + 5000, 1, '/tmp/other.output'])
    assert.match(s.note!, /completed \(exit code 1/)
    assert.equal(shellState(s), 'done (exit 1)')
    // An agent's task is no shell's.
    assert.equal(onShellTask(sh, { phase: 'done', taskId: 'agent-9', toolUseId: 'a9', status: 'completed' }, NOW, { for: [] }), false)
  })

  test('ends: failed with its exit code, killed, stopped by TaskStop or KillShell (not when that failed)', () => {
    const sh = newShells()
    for (const id of ['f', 'k', 't', 'x', 'y']) {
      onShellCall(sh, bash(`u-${id}`, { command: `run ${id}`, run_in_background: true }), NOW, { for: [] })
      onShellResult(sh, `u-${id}`, `whatever`, false, { backgroundTaskId: `b-${id}` }, NOW)
    }
    const by = (id: string) => sh.list.find(s => s.taskId === `b-${id}`)!
    onShellTask(sh, { phase: 'done', taskId: 'b-f', status: 'failed', text: 'Background command "run f" failed with exit code 2' }, NOW + 1, { for: [] })
    assert.deepEqual([by('f').state, by('f').exitCode, shellState(by('f'))], ['failed', 2, 'failed (exit 2)'])
    onShellTask(sh, { phase: 'done', taskId: 'b-k', status: 'killed', text: 'Background command "run k" was stopped' }, NOW + 1, { for: [] })
    assert.equal(by('k').state, 'stopped')
    // A status the app doesn't know leaves it running.
    onShellTask(sh, { phase: 'updated', taskId: 'b-t', status: 'pending' }, NOW, { for: [] })
    assert.equal(by('t').state, 'running')
    onShellCall(sh, { id: 's1', name: 'TaskStop', input: { task_id: 'b-t' } }, NOW, { for: [] })
    onShellResult(sh, 's1', 'Successfully stopped task: b-t', false, undefined, NOW + 2)
    assert.deepEqual([by('t').state, by('t').note], ['stopped', 'stopped by Claude (TaskStop)'])
    onShellCall(sh, { id: 's2', name: 'KillShell', input: { shell_id: 'b-x' } }, NOW, { for: [], by: 'agent-1' })
    onShellResult(sh, 's2', 'Killed', false, undefined, NOW + 2)
    assert.deepEqual([by('x').state, by('x').note], ['stopped', 'stopped by its agent (KillShell)'])
    onShellCall(sh, { id: 's3', name: 'TaskStop', input: { task_id: 'b-y' } }, NOW, { for: [] })
    onShellResult(sh, 's3', 'No task found', true, undefined, NOW + 2)
    assert.equal(by('y').state, 'running')
    // Ended once: a later end changes nothing.
    onShellTask(sh, { phase: 'done', taskId: 'b-f', status: 'completed' }, NOW + 9, { for: [] })
    assert.deepEqual([by('f').state, by('f').endedAt], ['failed', NOW + 1])
    // Claude Code exits: what still runs went with it.
    onShellsExit(sh, NOW + 10)
    assert.deepEqual([by('y').state, by('y').isCut, by('y').note], ['stopped', true, 'stopped when Claude Code exited'])
    assert.equal(by('f').isCut, undefined)
  })

  test('a refused call never ran; a foreground one moved to the background is listed from its result', () => {
    const sh = newShells()
    onShellCall(sh, bash('u1', { command: 'rm -rf build', run_in_background: true }), NOW, { for: [] })
    onShellResult(sh, 'u1', 'The user refused this.', true, undefined, NOW)
    assert.equal(sh.list.length, 0)
    onShellCall(sh, bash('u2', { command: 'sleep 999', description: 'Wait' }), NOW, { for: ['k'] })
    onShellResult(sh, 'u2', 'Command did not complete within its 120s timeout and was moved to the background (ID: bm1). Output is being written to: /tmp/bm1.output.', false, undefined, NOW + 120_000)
    const s = sh.list[0]!
    assert.deepEqual([s.taskId, s.outputFile, s.startedAt, s.state, s.for], ['bm1', '/tmp/bm1.output', NOW, 'running', ['k']])
    assert.match(s.note!, /moved to the background/)
    // A background result with no id it can read: nothing more is known.
    onShellCall(sh, bash('u3', { command: 'x', run_in_background: true }), NOW, { for: [] })
    onShellResult(sh, 'u3', 'Started.', false, undefined, NOW)
    assert.equal(sh.list.find(x => x.id === 'u3')!.taskId, undefined)
  })

  test("one only Claude Code's event shows (an agent's): listed from it; a foreground task is not", () => {
    const sh = newShells()
    assert.equal(onShellTask(sh, { phase: 'started', taskId: 'b9', toolUseId: 'fg', type: 'local_bash', isBackgrounded: false }, NOW, { for: [] }), false)
    assert.equal(onShellTask(sh, { phase: 'started', taskId: 'b9', type: 'local_bash', isBackgrounded: true, text: 'Agent build' }, NOW, { for: ['k'] }), true)
    assert.deepEqual([sh.list[0]!.id, sh.list[0]!.description, sh.list[0]!.command, sh.list[0]!.for], ['task:b9', 'Agent build', '', ['k']])
    // An agent's Bash call, known before its task starts: listed with its command, by that agent.
    onShellCall(sh, bash('ag-1', { command: 'make', description: 'Build' }), NOW, { for: ['k'], by: 'agent-1' })
    onShellTask(sh, { phase: 'started', taskId: 'b10', toolUseId: 'ag-1', type: 'local_bash', isBackgrounded: true }, NOW, { for: [] })
    assert.deepEqual([sh.list[1]!.command, sh.list[1]!.by, sh.list[1]!.taskId], ['make', 'agent-1', 'b10'])
  })

  test('names, the stop message, and how long finished ones stay listed', () => {
    const s = (x: Partial<Shell>): Shell => ({ id: 'u', command: 'npm test\n--more', description: '', state: 'done', startedAt: NOW, for: [], ...x })
    assert.equal(shellName(s({})), 'npm test')
    assert.equal(shellName(s({ description: 'Run the tests' })), 'Run the tests')
    assert.equal(shellName(s({ command: '', taskId: 'b1' })), 'b1')
    assert.equal(shellName(s({ command: '' })), 'background command')
    assert.equal(shellName(s({ description: 'x'.repeat(100) }), 10), `${'x'.repeat(9)}…`)
    assert.equal(stopText(s({ description: 'Run', taskId: 'b1' })), 'Please stop the background command “Run” (task b1) with TaskStop.')
    assert.equal(stopText(s({ description: 'Run' })), 'Please stop the background command “Run” with TaskStop.')
    const sh = newShells()
    sh.list.push(
      s({ id: 'run', state: 'running' }),
      s({ id: 'fresh', endedAt: NOW - SHELL_KEEP_MS + 1000 }),
      s({ id: 'old', endedAt: NOW - SHELL_KEEP_MS - 1000 }),
      s({ id: 'cut', state: 'stopped', isCut: true, endedAt: NOW - SHELL_KEEP_MS - 1000 }),
      s({ id: 'cut-old', state: 'stopped', isCut: true, endedAt: NOW - SHELL_CUT_KEEP_MS - 1000 }),
    )
    assert.deepEqual(shownShells(sh, NOW).map(x => x.id), ['run', 'fresh', 'cut'])
  })

  test('↻ run again: only a stopped or failed one; its message names it, how it ended, the command, its folder, its agent', () => {
    const s = (x: Partial<Shell>): Shell => ({ id: 'u', command: 'make lint', description: 'Lint', state: 'failed', exitCode: 2, startedAt: NOW, for: [], ...x })
    assert.deepEqual((['running', 'done', 'failed', 'stopped'] as const).map(state => canRerun(s({ state }))), [false, false, true, true])
    const end = 'Run it in the background (run_in_background), as before.'
    assert.equal(rerunText(s({ cwd: '/tmp/w' })), `Please run the background command “Lint” again: it failed (exit 2).\nCommand: make lint\nFolder: /tmp/w\n${end}`)
    assert.equal(rerunText(s({ state: 'stopped', exitCode: undefined, note: 'stopped when Claude Code exited', isCut: true })), `Please run the background command “Lint” again: it was stopped when Claude Code exited.\nCommand: make lint\n${end}`)
    assert.equal(rerunText(s({ state: 'stopped', exitCode: undefined, note: 'Background command "Lint" was stopped', command: 'a &&\n  b' })), `Please run the background command “Lint” again: it was stopped.\nCommand:\na &&\n  b\n${end}`)
    assert.equal(rerunText(s({ state: 'failed', exitCode: undefined, command: '' })), `Please run the background command “Lint” again: it failed.\n${end}`)
    assert.match(rerunText(s({}), { name: 'Maya (tester)', taskId: 'a7', isRunning: true }), /\nYour agent Maya \(tester\) \(agent a7\) ran it and is still working: have it run the command again \(SendMessage to it\), or run it yourself if that fits better\.\n/)
    assert.match(rerunText(s({}), { name: 'Maya (tester)', taskId: 'a7', isRunning: false }), /\nYour agent Maya \(tester\) \(agent a7\) ran it: if its work needs the result, have it run the command again \(SendMessage to it\); otherwise run it again yourself\.\n/)
    assert.match(rerunText(s({}), { name: 'Maya (tester)', isRunning: true }), /\nYour agent Maya \(tester\) ran it, and can't be sent a message: run it again yourself\.\n/)
  })
})

describe('background commands from the session file', () => {
  test('calls, results and task notifications in order; one still running at the end went with its Claude Code', () => {
    const t1 = { ...newTurn('run them', NOW), key: 'k1' }
    t1.steps = [
      { tool: bash('u1', { command: 'npm test', description: 'Tests', run_in_background: true }), result: started('b1'), data: { backgroundTaskId: 'b1' }, at: NOW + 1000 },
      { tool: bash('u2', { command: 'npm run watch', run_in_background: true }), result: started('b2'), cwd: '/tmp/w' },
      { tool: { id: 'u3', name: 'Read', input: {} }, result: 'x' },
    ]
    t1.agentEnds = [{ taskId: 'b1', toolUseId: 'u1', status: 'failed', summary: 'Background command "Tests" failed with exit code 1', at: NOW + 5000, after: 2 }]
    const t2 = { ...newTurn('', NOW + 60_000), key: 'f1', followUp: ['k1'], durationMs: 2000 }
    t2.agentEnds = [{ taskId: 'zz', status: 'completed', at: NOW + 60_000, after: 0 }]
    const sh = shellsFromTurns([t1, t2])
    const [a, b] = sh.list
    assert.deepEqual([a!.state, a!.exitCode, a!.endedAt, a!.for, a!.startedAt], ['failed', 1, NOW + 5000, ['k1'], NOW + 1000])
    assert.deepEqual([b!.state, b!.isCut, b!.endedAt, b!.startedAt, b!.cwd, a!.cwd], ['stopped', true, NOW + 62_000, NOW, '/tmp/w', undefined])
  })
})

describe('its output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clued-shells-'))
  test('the file as a terminal left it, read again only when it changed; a gone file says so', () => {
    const f = join(dir, 'a.output')
    writeFileSync(f, 'one\r\ntwo 10%\rtwo 100%\n')
    const o = readOutput(f)
    assert.deepEqual(o, { text: 'one\ntwo 100%\n', size: 22, isTail: false })
    assert.equal(readOutput(f), o, 'unchanged: the same read')
    appendFileSync(f, 'three\n')
    assert.match((readOutput(f) as { text: string }).text, /three/)
    assert.deepEqual(readOutput(join(dir, 'gone.output')), { missing: true })
    assert.deepEqual(readOutput(dir), { missing: true }, 'a folder is no output')
  })
  test('a big file: only its last part, from a whole line', () => {
    const f = join(dir, 'big.output')
    writeFileSync(f, Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\n') + '\n')
    const o = readOutput(f) as { text: string; isTail: boolean }
    assert.equal(o.isTail, true)
    assert.match(o.text, /^line \d+\n/)
    assert.match(o.text, /line 19999\n$/)
    assert.ok(o.text.length <= 64 * 1024)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('the Background section', () => {
  const noop = () => {}
  const ctx = (extra: Partial<PanelCtx>): PanelCtx => ({
    isResultsOnly: false, isWorking: false, isFolded: false, hscroll: 0, results: noop, fold: noop, side: noop,
    box: { unread: [], waiting: [], messages: [] }, openPart: noop, dismiss: noop, openMessage: noop, openWork: noop,
    picked: '', query: null, search: noop, isLegend: false, legend: noop, next: noop, readParts: noop, unreadParts: noop,
    readList: [], isReadTab: false, readTab: noop, work: 'folded', setWork: noop, agents: [], turnOf: () => undefined,
    openAgent: noop, agentView: '', jumpTo: noop, openRequest: noop, requestView: '', jobs: [], openJob: noop, jobView: '', scroll: {}, height: 60, ...extra,
  })
  const now = Date.now()
  const s = (x: Partial<Shell>): Shell => ({ id: 'u', command: 'npm test', description: '', state: 'running', startedAt: now - 65_000, for: [], ...x })
  const text = (p: PanelCtx, width = 56) => panelLines(p, width).lines.map(l => l.map(x => x.text).join(''))

  test('a row each: running for how long, or how it ended; the command and who ran it under it; the open one marked', () => {
    let opened = ''
    const p = ctx({
      shells: [
        { shell: s({ id: 'a', description: 'Run the tests' }), by: 'Maya (tester)' },
        { shell: s({ id: 'b', state: 'failed', exitCode: 2, endedAt: now - 5000 }) },
        { shell: s({ id: 'c', state: 'stopped', endedAt: now - 5000 }) },
        { shell: s({ id: 'd', state: 'done', endedAt: now - 5000 }) },
      ],
      openShell: id => (opened = id),
      jobView: 'a',
    })
    const L = text(p)
    assert.match(L.find(l => l.includes('Background'))!, /Background +1 running/)
    assert.match(L.find(l => l.includes('Run the tests'))!, /▸◐ Run the tests +running 1m 5s/)
    assert.match(L.find(l => l.includes('by Maya'))!, /\$ npm test · by Maya \(tester\)/)
    assert.match(L.find(l => l.includes('✕ npm test'))!, /failed \(exit 2\) 5s ago/)
    assert.match(L.find(l => l.includes('■ npm test'))!, /stopped 5s ago/)
    assert.match(L.find(l => l.includes('✓ npm test'))!, /done 5s ago/)
    const row = panelLines(p, 56).lines.find(l => l.map(x => x.text).join('').includes('Run the tests'))!
    row.find(x => x.text.includes('Run the tests'))!.action!()
    assert.equal(opened, 'a')
    // All finished: so it says.
    assert.match(text(ctx({ shells: [{ shell: s({ state: 'done', endedAt: now }) }] })).find(l => l.includes('Background'))!, /all done/)
    // None: no section.
    assert.ok(!text(ctx({})).some(l => l.includes('Background')))
  })

  test('↻ run again on a stopped or failed row, when there is room; a click asks for that command', () => {
    let again = ''
    const shells = [
      { shell: s({ id: 'a' }) },
      { shell: s({ id: 'b', description: 'Lint', command: 'make lint', state: 'failed', exitCode: 2, endedAt: now - 5000 }) },
      { shell: s({ id: 'c', state: 'stopped', endedAt: now - 5000 }) },
      { shell: s({ id: 'd', state: 'done', endedAt: now - 5000 }) },
    ]
    const p = ctx({ shells, rerunShell: id => (again = id) })
    const L = text(p)
    assert.equal(L.filter(l => l.includes('↻ run again')).length, 2)
    assert.match(L.find(l => l.includes('$ make lint'))!, /\$ make lint · ran 1m 0s +↻ run again/)
    assert.match(L.find(l => l.includes('ran 1m') && !l.includes('make lint'))!, /ran 1m 0s +↻ run again/)
    const rows = panelLines(p, 56).lines
    rows.find(l => l.some(x => x.text === '↻ run again'))!.find(x => x.text === '↻ run again')!.action!()
    assert.equal(again, 'b')
    // Too narrow for it beside the rest: the command's view still has it.
    assert.ok(!text(p, 24).some(l => l.includes('↻ run again')))
    // No way to ask (a panel without it): no button.
    assert.ok(!text(ctx({ shells })).some(l => l.includes('↻ run again')))
    // A stopped one with nothing else to say under it: the button alone.
    const bare = text(ctx({ shells: [{ shell: s({ state: 'stopped' }) }], rerunShell: noop }))
    assert.match(bare.find(l => l.includes('↻ run again'))!, /^\W*\s+↻ run again/)
  })

  test('folded: how many run, and a click opens the first', () => {
    let opened = ''
    const p = ctx({ isFolded: true, shells: [{ shell: s({ id: 'x', state: 'done', endedAt: now }) }, { shell: s({ id: 'y' }) }], openShell: id => (opened = id) })
    const lines = panelLines(p, 10).lines
    const row = lines.find(l => l.some(x => x.text === '$'))!
    assert.match(row.map(x => x.text).join(''), /\$ +1/)
    row.find(x => x.text === '$')!.action!()
    assert.equal(opened, 'y')
    assert.ok(!panelLines(ctx({ isFolded: true, shells: [{ shell: s({ state: 'done', endedAt: now }) }] }), 10).lines.some(l => l.some(x => x.text === '$')))
  })
})
