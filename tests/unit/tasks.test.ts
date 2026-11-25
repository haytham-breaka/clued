import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { keyOf } from '../../hooks/model.ts'
import { agentLines, tasksBlock, todoLines } from '../../app/chat.ts'
import type { ChatCtx } from '../../app/chat.ts'
import { notStarted, panelLines, waited } from '../../app/panel.ts'
import type { Agent, PanelCtx } from '../../app/panel.ts'
import type { Step, Turn } from '../../app/session.ts'
import {
  agentFor, agentIdOf, agentsFromTurns, canContinue, continueText, currentTask, cutLabel, endRun, firstTask, isQuiet, messageText, notifiedFor, nudgeText, pulseOf, QUIET_MS, resume, sendFailed, sendTask, taskArrived, taskTitle, todosOf, touch, workedFor, workingFor,
} from '../../app/tasks.ts'
import { newShells, onShellCall } from '../../app/shells.ts'
import { C } from '../../app/text.ts'
import type { Line } from '../../app/text.ts'
import type { Pulse } from '../../app/tasks.ts'

const NOW = 1_700_000_000_000
const noop = () => {}
const plain = (l: Line) => l.map(s => s.text).join('')

function agent(extra: Partial<Agent> = {}): Agent {
  return {
    id: 'a1', name: 'Fix the build', type: 'general-purpose', isBackground: true, for: ['k1'], startedAt: NOW, state: 'running', steps: 0, last: '',
    prompt: 'Fix the build.', log: [], tasks: [firstTask({ description: 'Fix the build', prompt: 'Fix the build.' }, NOW, ['k1'], 'a1')], taskId: 'ag-1', ...extra,
  }
}
const step = (id: string, name: string, input: Record<string, unknown>, extra: Partial<Step> = {}): Step => ({ tool: { id, name, input }, ...extra })
const turn = (text: string, extra: Partial<Turn> = {}): Turn => ({ key: keyOf(text), text, at: NOW, steps: [], live: '', pending: '', isDone: true, isOpen: false, ...extra })

describe('tasks: titles, ids and lookups', () => {
  test('a SendMessage\'s title is its summary, else the start of its message', () => {
    assert.equal(taskTitle({ summary: ' Land the PR ', message: 'long words' }), 'Land the PR')
    assert.equal(taskTitle({ message: 'Now **write** the release notes.' }), 'Now write the release notes.')
    assert.equal(taskTitle({ message: { type: 'stop' } }), '{"type":"stop"}')
    assert.equal(taskTitle({}), 'a message')
    assert.equal(messageText(undefined), '')
  })
  test('the first task is the Agent call: its description, else its type', () => {
    const t = firstTask({ subagent_type: 'Explore', prompt: 'Look.' }, 5, ['k'])
    assert.deepEqual(t, { title: 'Explore', text: 'Look.', at: 5, for: ['k'], state: 'running', logAt: 0, isSeen: true })
    assert.equal(firstTask({}, 5, []).title, 'agent')
  })
  test('agentIdOf: the structured result, the launch text, or (strict) only "agentId:"', () => {
    assert.equal(agentIdOf('x', { agentId: 'd-1' }), 'd-1')
    assert.equal(agentIdOf('Started. agent id: bg-42'), 'bg-42')
    assert.equal(agentIdOf('The agent identified two bugs.', undefined, true), undefined)
    assert.equal(agentIdOf('Done.\nagentId: f-9 (for resuming)', undefined, true), 'f-9')
    assert.equal(agentIdOf(undefined), undefined)
  })
  test('agentFor: by agent id, call id, name given, or description', () => {
    const a = agent({ alias: 'fixer' })
    for (const to of ['ag-1', 'a1', 'fixer', 'Fix the build']) assert.equal(agentFor([a], to), a)
    assert.equal(agentFor([a], 'nobody'), undefined)
    assert.equal(agentFor([a], ''), undefined)
  })
  test('workedFor: an agent\'s latest task\'s messages, a command\'s own, one an agent ran its agent\'s', () => {
    const a = agent()
    sendTask(a, { to: 'ag-1', message: 'And the docs.' }, NOW + 1, ['k2'], 'sm-1')
    const sh = newShells()
    onShellCall(sh, { id: 'b1', name: 'Bash', input: { command: 'npm test', run_in_background: true } }, NOW, { for: ['k3'] })
    onShellCall(sh, { id: 'b2', name: 'Bash', input: { command: 'make', run_in_background: true } }, NOW, { by: 'a1', for: ['k1'] })
    onShellCall(sh, { id: 'b3', name: 'Bash', input: { command: 'ls', run_in_background: true } }, NOW, { for: [] })
    sh.list[0]!.taskId = 'bsh-1'
    // By its task id or its call's id.
    for (const id of ['ag-1', 'a1']) assert.deepEqual(workedFor([a], sh.list, id), ['k2'])
    for (const id of ['bsh-1', 'b1']) assert.deepEqual(workedFor([a], sh.list, id), ['k3'])
    assert.deepEqual(workedFor([a], sh.list, 'b2'), ['k2'])
    // Its agent gone from the list: the command's own.
    assert.deepEqual(workedFor([], sh.list, 'b2'), ['k1'])
    // No message, unknown, no id.
    assert.equal(workedFor([a], sh.list, 'b3'), undefined)
    assert.equal(workedFor([a], sh.list, 'nobody'), undefined)
    assert.equal(workedFor([a], sh.list, ''), undefined)
    assert.deepEqual(workedFor([agent({ tasks: [] })], [], 'a1'), ['k1'])
  })
  test('notifiedFor: the messages all the ended ones worked for; none when they differ or one is unknown', () => {
    const a = agent()
    const b = agent({ id: 'a2', taskId: 'ag-2', for: ['k1', 'k2'], tasks: [firstTask({}, NOW, ['k1', 'k2'])] })
    const c = agent({ id: 'a3', taskId: 'ag-3', for: ['k2', 'k1'], tasks: [firstTask({}, NOW, ['k2', 'k1'])] })
    assert.deepEqual(notifiedFor([a, b, c], [], ['ag-1']), ['k1'])
    assert.deepEqual(notifiedFor([a, b, c], [], ['ag-2', 'ag-3']), ['k1', 'k2'])
    assert.equal(notifiedFor([a, b, c], [], ['ag-1', 'ag-2']), undefined)
    assert.equal(notifiedFor([a, b, c], [], ['ag-1', 'nobody']), undefined)
    assert.equal(notifiedFor([a, b, c], [], []), undefined)
  })
})

describe('tasks: states', () => {
  test('sent while it runs, a task is queued; when its message arrives it runs; the run\'s end makes both done', () => {
    const a = agent()
    const t = sendTask(a, { to: 'ag-1', summary: 'Also lint', message: 'Also run the linter.' }, NOW + 1, ['k2'], 's1')
    assert.equal(t.state, 'queued')
    assert.equal(t.logAt, undefined)
    assert.deepEqual(a.for, ['k1', 'k2'])
    assert.equal(currentTask(a), 0)
    assert.deepEqual(workingFor(a), ['k1'])
    a.log.push({ text: 'working' })
    assert.equal(taskArrived(a, '<msg>Also run the linter.</msg>'), t)
    assert.equal(t.state, 'running')
    assert.equal(t.logAt, 1)
    assert.equal(currentTask(a), 1)
    assert.deepEqual(workingFor(a), ['k1', 'k2'])
    // Nothing more to arrive.
    assert.equal(taskArrived(a, 'again'), undefined)
    endRun(a, 'done', NOW + 9)
    assert.deepEqual(a.tasks.map(x => x.state), ['done', 'done'])
    assert.equal(a.endedAt, NOW + 9)
    assert.equal(currentTask(a), 1)
    assert.deepEqual(workingFor(a), ['k1', 'k2'])
  })
  test('sent to an agent that finished, a task continues it and runs from now', () => {
    const a = agent()
    a.log.push({ text: 'first run' })
    endRun(a, 'done', NOW + 5)
    a.result = 'Fixed.'
    const t = sendTask(a, { message: 'Write the notes.' }, NOW + 10, ['k3'])
    assert.equal(t.state, 'running')
    assert.equal(t.logAt, 1)
    assert.equal(a.state, 'running')
    assert.equal(a.startedAt, NOW + 10)
    assert.equal(a.endedAt, undefined)
    assert.equal(a.result, undefined)
    // Its own arrival later only marks where it is.
    a.log.push({ text: 'more' })
    taskArrived(a, 'Write the notes.')
    assert.equal(t.logAt, 2)
    endRun(a, 'failed', NOW + 20)
    assert.deepEqual(a.tasks.map(x => x.state), ['done', 'failed'])
  })
  test('a queued message seen only after the run ended: that run covered it', () => {
    const a = agent()
    const t = sendTask(a, { message: 'Also this.' }, NOW + 1, ['k1'])
    endRun(a, 'done', NOW + 2)
    assert.equal(t.state, 'queued')
    taskArrived(a, 'something else entirely')
    assert.equal(t.state, 'done')
    const b = agent()
    const u = sendTask(b, { message: 'Also that.' }, NOW + 1, ['k1'])
    endRun(b, 'stopped', NOW + 2)
    assert.deepEqual(b.tasks.map(x => x.state), ['stopped', 'queued'])
    taskArrived(b, 'Also that.')
    assert.equal(u.state, 'stopped')
  })
  test('the agent continued with a queued task: resume starts it', () => {
    const a = agent()
    sendTask(a, { message: 'Next.' }, NOW + 1, ['k1'])
    endRun(a, 'done', NOW + 2)
    resume(a, NOW + 3)
    assert.deepEqual(a.tasks.map(x => [x.state, x.logAt]), [['done', 0], ['running', 0]])
    assert.equal(currentTask(a), 1)
    // Nothing queued: resume changes no task.
    resume(a, NOW + 4)
    assert.deepEqual(a.tasks.map(x => x.state), ['done', 'running'])
  })
  test('a SendMessage that failed: its task failed, and an agent it alone continued ends again', () => {
    const a = agent()
    endRun(a, 'done', NOW + 1)
    sendTask(a, { message: 'More.' }, NOW + 2, ['k1'], 's1')
    sendFailed(a, 's1', NOW + 3)
    assert.equal(a.tasks[1]!.state, 'failed')
    assert.equal(a.state, 'done')
    // Unknown calls, and tasks already ended, change nothing.
    sendFailed(a, 'nope', NOW + 4)
    sendFailed(a, 's1', NOW + 4)
    const b = agent()
    sendTask(b, { message: 'Queued.' }, NOW + 2, ['k1'], 's2')
    sendFailed(b, 's2', NOW + 3)
    assert.equal(b.state, 'running')
    assert.deepEqual(b.tasks.map(x => x.state), ['running', 'failed'])
  })
  test('currentTask: the newest running one, else the last it had, else the first', () => {
    const a = agent()
    a.tasks[0]!.state = 'queued'
    assert.equal(currentTask(a), 0)
  })
})

describe('tasks: the agent\'s own to-do list', () => {
  test('TodoWrite gives the whole list; TaskCreate adds, TaskUpdate changes or deletes', () => {
    const log = [
      { text: 'hi' },
      { step: step('t1', 'TodoWrite', { todos: [{ content: 'Read', status: 'completed', activeForm: 'Reading' }, { content: 'Fix', status: 'weird' }] }) },
      { step: step('t2', 'TaskCreate', { subject: 'Test', activeForm: 'Testing' }, { result: 'Task #3 created successfully: Test' }) },
      { step: step('t3', 'TaskCreate', { description: 'Push' }) },
      { step: step('t4', 'TaskUpdate', { taskId: '3', status: 'in_progress', subject: 'Test it', activeForm: 'Testing it' }) },
      { step: step('t5', 'TaskUpdate', { taskId: '2', status: 'deleted' }) },
      { step: step('t6', 'TaskUpdate', { taskId: '99', status: 'completed' }) },
      { step: step('t7', 'TaskUpdate', { taskId: '4' }) },
      { step: step('t8', 'Bash', { command: 'ls' }) },
    ]
    assert.deepEqual(todosOf(log), [
      { content: 'Read', status: 'completed', activeForm: 'Reading' },
      { content: 'Test it', status: 'in_progress', activeForm: 'Testing it' },
      { content: 'Push', status: 'pending' },
    ])
    assert.deepEqual(todosOf([]), [])
  })
  test('drawn ☑ ◐ ☐, wrapped under itself', () => {
    const rows = todoLines([{ content: 'done', status: 'completed' }, { content: 'now', status: 'in_progress' }, { content: 'a long thing to do later', status: 'pending' }], 16, 2).map(plain)
    assert.deepEqual(rows, ['  ☑ done', '  ◐ now', '  ☐ a long thing', '    to do later'])
  })
})

describe('tasks: from the session file', () => {
  test('the Agent call, SendMessage calls to it, and task notifications rebuild its tasks', () => {
    const ask = turn('fix it', { topicId: 'T1' })
    ask.steps = [
      step('ag', 'Agent', { description: 'Fix', subagent_type: 'general-purpose', prompt: 'Fix.', run_in_background: true, name: 'fixer' }, { result: 'Launched. agentId: bg-1', at: NOW + 1 }),
      step('s1', 'SendMessage', { to: 'fixer', summary: 'Lint too', message: 'Lint too.' }, { at: NOW + 2 }),
      step('s0', 'SendMessage', { to: 'nobody', message: 'x' }),
    ]
    ask.agentEnds = [{ taskId: 'bg-1', status: 'completed', summary: 'Fixed', at: NOW + 3, after: 3 }, { taskId: 'zz', status: 'completed', at: NOW + 3, after: 3 }]
    const follow = turn('', { key: 'follow-1', followUp: [ask.key], at: NOW + 4, durationMs: 50 })
    follow.steps = [
      step('s2', 'SendMessage', { to: 'bg-1', message: 'Notes.' }, { at: NOW + 5 }),
      step('s3', 'SendMessage', { to: 'bg-1', message: 'Bad.' }, { at: NOW + 6, isError: true, result: 'no' }),
    ]
    follow.agentEnds = [{ taskId: 'bg-1', status: 'failed', at: NOW + 7, after: 2 }]
    const [a, ...rest] = agentsFromTurns([ask, follow])
    assert.equal(rest.length, 0)
    assert.equal(a!.alias, 'fixer')
    assert.equal(a!.taskId, 'bg-1')
    assert.equal(a!.isPast, true)
    assert.deepEqual(a!.tasks.map(t => [t.title, t.state, t.at, t.for]), [
      ['Fix', 'done', NOW + 1, [ask.key]],
      ['Lint too', 'done', NOW + 2, [ask.key]],
      ['Notes.', 'failed', NOW + 5, [ask.key]],
      ['Bad.', 'failed', NOW + 6, [ask.key]],
    ])
    assert.equal(a!.state, 'failed')
    assert.equal(a!.endedAt, NOW + 7)
  })
  test('a foreground agent ends with its result; one with no end seen was stopped with its Claude Code', () => {
    const t = turn('go')
    t.steps = [
      step('f1', 'Task', { description: 'Look', prompt: 'Look.' }, { result: 'Found it.\nagentId: fg-1' }),
      step('f2', 'Agent', { subagent_type: 'Plan' }, { result: 'boom', isError: true }),
      step('f3', 'Agent', { description: 'Long', run_in_background: true }),
    ]
    t.agentEnds = [{ taskId: '', toolUseId: 'f3', status: 'killed', at: NOW + 1, after: 3 }]
    const later = turn('more', { at: NOW + 100 })
    later.steps = [step('f4', 'Agent', { description: 'Open', run_in_background: true }, { result: 'Launched. agentId: o-1' }), step('f5', 'SendMessage', { to: 'o-1', message: 'And.' })]
    const [look, plan, long, open] = agentsFromTurns([t, later])
    assert.deepEqual([look!.state, look!.result, look!.taskId], ['done', 'Found it.\nagentId: fg-1', 'fg-1'])
    assert.deepEqual([plan!.state, plan!.name, plan!.tasks[0]!.state], ['failed', 'Plan', 'failed'])
    // Stopped by Claude (killed): not by an exit, so nothing to continue.
    assert.deepEqual([long!.state, long!.tasks[0]!.state, long!.cut], ['stopped', 'stopped', undefined])
    assert.equal(canContinue(long!), false)
    // Still running when the session ended: Claude Code's exit stopped it, and it can go on.
    assert.deepEqual([open!.state, open!.cut, open!.endedAt, open!.tasks.map(x => x.state)], ['stopped', 'exit', NOW + 100, ['stopped', 'stopped']])
    assert.equal(cutLabel(open!), 'stopped when Claude Code exited')
    assert.equal(canContinue(open!), true)
    open!.cut = 'reload'
    assert.equal(continueText(open!, 'James'), "Continue James's work (agent o-1): it was stopped when the app reloaded. Use SendMessage to it to resume.")
    // A foreground one, or one with no id, can't be messaged.
    assert.equal(canContinue({ ...open!, isBackground: false }), false)
    assert.equal(canContinue({ ...open!, taskId: undefined }), false)
    // Continued: it runs again, and the stop is behind it.
    sendTask(open!, { message: 'Go on.' }, NOW + 200, [])
    assert.deepEqual([open!.state, open!.cut, canContinue(open!)], ['running', undefined, false])
  })
})

// ---- Drawn: the panel row, the Tasks block, the agent's view ------------------------------------

function threeTasks(): { a: Agent; turns: Turn[] } {
  const t1 = turn('fix the build', { topicId: 'T1' })
  const t2 = turn('and lint it', { topicId: 'T2' })
  const a = agent({ for: [t1.key] })
  a.tasks[0]!.for = [t1.key]
  a.log.push({ text: 'Fixing.' })
  sendTask(a, { message: 'Lint it.', summary: 'Lint it' }, NOW + 60_000, [t1.key, t2.key, 'gone'])
  taskArrived(a, 'Lint it.')
  a.log.push({ step: step('s', 'TodoWrite', { todos: [{ content: 'Lint', status: 'in_progress' }] }) })
  sendTask(a, { message: 'Then the notes.' }, NOW + 120_000, ['nothing'])
  return { a, turns: [t1, t2] }
}

function ctx(turns: Turn[], extra: Partial<ChatCtx> = {}): ChatCtx {
  return {
    turns, kept: { board: { threads: [], topics: [], turnTopics: [] } as any, reactions: {}, links: {} }, isResultsOnly: false, cwd: '/tmp/w', now: NOW + 200_000, spin: '⠋',
    toggle: noop, reply: noop, replying: new Set(), react: noop, jump: noop, copy: noop, hover: '', unread: new Set(), waiting: new Set(),
    messageOf: () => undefined, replyOf: () => undefined, isLost: () => false, chainOf: () => 0, openChain: noop, askAgain: noop, work: 'folded', poke: noop,
    isWorking: false, agentName: () => undefined, openAgent: noop, setRead: noop, dismiss: noop, ...extra,
  }
}

describe('tasks: drawn', () => {
  test('under Agents: "· N tasks running" on its row (or "· N tasks"), and the task it is on under it, within the panel', () => {
    const { a, turns } = threeTasks()
    const p = {
      isResultsOnly: false, isWorking: false, isFolded: false, hscroll: 0, results: noop, fold: noop, side: noop,
      box: { unread: [], waiting: [], messages: [] }, openPart: noop, dismiss: noop, openMessage: noop, openWork: noop,
      picked: '', query: null, search: noop, isLegend: false, legend: noop, next: noop, readParts: noop, unreadParts: noop,
      readList: [], isReadTab: false, readTab: noop, work: 'folded', setWork: noop, agents: [a], turnOf: (k: string) => turns.find(t => t.key === k),
      openAgent: noop, agentView: '', jumpTo: noop, openRequest: noop, requestView: '', jobs: [], openJob: noop, jobView: '', scroll: {}, height: 60,
      main: { for: [], last: 'thinking' },
    } as PanelCtx
    for (const width of [60, 30]) {
      const lines = panelLines(p, width).lines.map(plain)
      assert.ok(lines.every(l => l.length <= width), `within ${width}`)
      const at = lines.findIndex(l => l.includes('James'))
      // Two of its three tasks run now: how many run.
      if (width === 60) assert.match(lines[at]!, /◐ James \(implementer\) · 2 tasks running · Fix the/)
      assert.match(lines[at + 1]!, /↳ task 2 of 3: Lint/)
    }
    // One task: the message it is on, as before.
    const one = agent()
    const l1 = panelLines({ ...p, agents: [one], turnOf: () => turns[0] }, 60).lines.map(plain)
    assert.ok(!l1.some(l => l.includes('tasks')))
    assert.ok(l1.some(l => l.includes('↳ “fix the build”')))
  })
  test('the Tasks block: marks, titles, when sent, the topic ids; clicks go to the task and the message', () => {
    const { a, turns } = threeTasks()
    a.tasks[0]!.state = 'done'
    a.tasks.push({ ...a.tasks[2]!, title: 'Broke', state: 'failed', for: [] })
    a.tasks.push({ ...a.tasks[2]!, title: 'Cut off', state: 'stopped', for: [] })
    const jumped: string[] = []
    const opened: Turn[] = []
    const lines = tasksBlock(a, ctx(turns, { jump: x => jumped.push(x), openMessage: t => opened.push(t) }), 80)
    const text = lines.map(plain)
    assert.match(text[1]!, /^ {2}Tasks {2}5 · 1 running · 1 queued · 1 done · 1 stopped · 1 failed$/)
    assert.match(text[2]!, /^ {4}✓ 1\. Fix the build {2}\d\d:\d\d · T1$/)
    assert.match(text[3]!, /^ {4}⠋ 2\. Lint it {2}\d\d:\d\d · T1 T2$/)
    assert.match(text[4]!, /^ {4}◌ 3\. Then the notes\. {2}\d\d:\d\d$/)
    assert.match(text[5]!, /^ {4}✕ 4\. Broke/)
    // Cut off by a reload or an exit: stopped, not failed.
    assert.match(text[6]!, /^ {4}■ 5\. Cut off/)
    assert.equal(lines[2]![1]!.style?.fg, C.green)
    lines[3]!.find(s => s.text === 'Lint it')!.action!()
    lines[3]!.find(s => s.text === 'T2')!.action!()
    assert.deepEqual(jumped, ['task:1'])
    assert.deepEqual(opened, [turns[1]])
    // A message with no topic id: a short quote. More than four: "+N".
    const b = threeTasks().a
    const many = Array.from({ length: 6 }, (_, i) => turn(`message number ${i}`))
    b.tasks[1]!.for = many.map(t => t.key)
    const row = plain(tasksBlock(b, ctx(many), 120)[3]!)
    assert.match(row, /(“message numbe…” ){4}\+2$/)
    // One task: no block.
    assert.deepEqual(tasksBlock(agent(), ctx([]), 80), [])
  })
  test('the agent\'s view: Tasks and To-do at the top, each later task where it starts, queued ones after, anchors to each', () => {
    const { a, turns } = threeTasks()
    const { lines, anchors } = agentLines(a, [], ctx(turns), 100)
    const text = lines.map(plain)
    const at = (re: RegExp) => text.findIndex(l => re.test(l))
    assert.ok(at(/Tasks {2}3/) < at(/To-do {2}0 of 1 done/))
    assert.ok(at(/To-do/) < at(/✻ Claude asked · task 1/))
    assert.ok(at(/Fixing\./) < at(/✻ Claude sent task 2/))
    assert.ok(at(/✻ Claude sent task 2/) < at(/Updated the plan/))
    assert.ok(at(/working · 1 step so far/) < at(/◌ task 3 · queued/))
    assert.equal(anchors['task:0'], at(/✻ Claude asked · task 1/))
    assert.equal(anchors['task:1'], at(/✻ Claude sent task 2/))
    assert.equal(anchors['task:2'], at(/◌ task 3 · queued/))
    // A task that starts after the last entry: drawn after the log.
    const b = agent()
    endRun(b, 'done', NOW + 1)
    sendTask(b, { message: 'Again.' }, NOW + 2, ['k1'])
    const t2 = agentLines(b, [], ctx([]), 100).lines.map(plain)
    assert.ok(t2.some(l => /✻ Claude sent task 2/.test(l)))
  })
})

describe('not started', () => {
  const ref = (text: string, extra: Record<string, unknown> = {}) => ({ turn: turn(text), state: 'progress' as const, updatedAt: NOW, event: 'sent' as const, ...extra })
  test('waited: its largest unit', () => {
    assert.deepEqual([waited(-5), waited(40_000), waited(12 * 60_000 + 5), waited(3 * 3_600_000), waited(2 * 86_400_000)], ['0s', '40s', '12m', '3h', '2d'])
  })
  test('requests in progress with nothing on them, longest waiting first', () => {
    const a = ref('a', { updatedAt: NOW + 5 })
    const b = ref('b', { updatedAt: NOW + 1 })
    const list = [a, b, ref('busy', { active: true }), ref('done', { state: 'done' }), ref('agent on it')]
    assert.deepEqual(notStarted(list, new Set([keyOf('agent on it')])).map(m => m.turn.text), ['b', 'a'])
  })
  test('one row per request: a follow-up merged into it is the same task, shown by its newest message', () => {
    const first = { ...ref('yes recreate the repo', { topicId: 'T150', homeId: 'T153' }), turn: { ...turn('yes recreate the repo'), at: NOW } }
    const later = { ...ref('are we ready to go public?', { topicId: 'T153', homeId: 'T153' }), turn: { ...turn('are we ready to go public?'), at: NOW + 9 } }
    assert.deepEqual(notStarted([first, later, ref('other', { topicId: 'T9', homeId: 'T9' })], new Set()).map(m => m.turn.text), ['are we ready to go public?', 'other'])
  })
  test('the section: title or preview, how long, ▶ start, a click opens the request; none when empty', () => {
    const owed = ref('please write the docs', { topicId: 'T7', updatedAt: Date.now() - 12 * 60_000 })
    const plainOne = ref('another owed thing', { updatedAt: Date.now() - 1000 })
    const started: unknown[] = []
    const opened: unknown[] = []
    const base = {
      isResultsOnly: false, isWorking: false, isFolded: false, hscroll: 0, results: noop, fold: noop, side: noop,
      openPart: noop, dismiss: noop, openMessage: noop, openWork: noop,
      picked: '', query: null, search: noop, isLegend: false, legend: noop, next: noop, readParts: noop, unreadParts: noop,
      readList: [], isReadTab: false, readTab: noop, work: 'folded', setWork: noop, agents: [], turnOf: () => undefined,
      openAgent: noop, agentView: '', jumpTo: noop, openRequest: (t: Turn) => opened.push(t), requestView: '', jobs: [], openJob: noop, jobView: '', scroll: {}, height: 60,
      topicTitle: (id: string) => (id === 'T7' ? 'Write the docs' : undefined), startRequest: (m: unknown) => started.push(m),
    }
    const p = { ...base, box: { unread: [], waiting: [], messages: [owed, plainOne] } } as unknown as PanelCtx
    const lines = panelLines(p, 44).lines
    const text = lines.map(plain)
    const at = text.findIndex(l => l.startsWith('Not started'))
    assert.match(text[at]!, /^Not started +2$/)
    assert.match(text[at + 1]!, /▷ Write the docs +▶ start 12m$/)
    assert.match(text[at + 2]!, /▷ another owed thing +▶ start 1s$/)
    lines[at + 1]!.find(sp => sp.text === '▶ start')!.action!()
    lines[at + 1]!.find(sp => sp.text.includes('Write the docs'))!.action!()
    assert.deepEqual(started, [owed])
    assert.deepEqual(opened, [owed.turn])
    // Claude busy: it can't start now, so "+ queue" sends it to wait its turn.
    const queueing = panelLines({ ...p, isWorking: true } as PanelCtx, 44).lines
    const qt = queueing.map(plain)
    const qa = qt.findIndex(l => l.startsWith('Not started'))
    assert.match(qt[qa + 1]!, /▷ Write the docs +\+ queue 12m$/)
    assert.ok(!qt.some(l => l.includes('▶ start')))
    queueing[qa + 1]!.find(sp => sp.text === '+ queue')!.action!()
    assert.deepEqual(started, [owed, owed])
    // Claude's turn on it (or on a message sent about it): not listed.
    const about = turn('go on', { aboutRequest: owed.turn.key })
    const busy = { ...p, main: { for: [about.key, plainOne.turn.key], last: '' }, turnOf: (k: string) => (k === about.key ? about : undefined) } as PanelCtx
    assert.ok(!panelLines(busy, 44).lines.map(plain).some(l => l.startsWith('Not started')))
    // A running agent for it: not listed either.
    const a = agent({ for: [owed.turn.key, plainOne.turn.key] })
    assert.ok(!panelLines({ ...p, agents: [a] }, 44).lines.map(plain).some(l => l.startsWith('Not started')))
  })
})

describe('tasks: working, or gone quiet', () => {
  test('pulseOf: the tool it waits on, else the time since its last step; quiet after QUIET_MS with nothing running', () => {
    const a = agent({ log: [{ step: step('s1', 'Read', {}, { at: NOW + 1000, result: 'ok' }) }] })
    assert.deepEqual(pulseOf(a, NOW + 2000), { kind: 'step', since: NOW })
    touch(a, NOW + 1500)
    touch(a, NOW + 1200) // never back in time
    assert.deepEqual(pulseOf(a, NOW + 2000), { kind: 'step', since: NOW + 1500 })
    assert.equal(pulseOf(a, NOW + 1500 + QUIET_MS).kind, 'quiet')
    assert.ok(isQuiet(a, NOW + 1500 + QUIET_MS))
    // A long tool run is not quiet: it waits on that tool, since the call.
    a.log.push({ step: step('s2', 'Bash', {}, { at: NOW + 3000 }) })
    assert.deepEqual(pulseOf(a, NOW + 10 * QUIET_MS), { kind: 'tool', tool: 'Bash', since: NOW + 3000 })
    assert.ok(!isQuiet(a, NOW + 10 * QUIET_MS))
    // A resumed run counts from its start.
    const b = agent({ startedAt: NOW + 9000, lastStepAt: NOW })
    assert.equal(pulseOf(b, NOW + 9000 + QUIET_MS - 1).kind, 'step')
    // Only a background agent with an id can be checked on (Claude sends it a message).
    assert.ok(!isQuiet(agent({ isBackground: false }), NOW + QUIET_MS))
    assert.ok(!isQuiet(agent({ taskId: undefined }), NOW + QUIET_MS))
    assert.ok(!isQuiet(agent({ state: 'done' }), NOW + QUIET_MS))
    assert.equal(nudgeText(a, 'James', '6m 0s'), 'James (agent ag-1) seems to have gone quiet: no new steps for 6m 0s. Check on it, and if it has stopped, use SendMessage to it to continue its work.')
  })

  test('drawn: the row says last step, the tool, or quiet (yellow); its view says so, with ▶ continue when quiet', () => {
    const base = {
      isResultsOnly: false, isWorking: false, isFolded: false, hscroll: 0, results: noop, fold: noop, side: noop,
      box: { unread: [], waiting: [], messages: [] }, openPart: noop, dismiss: noop, openMessage: noop, openWork: noop,
      picked: '', query: null, search: noop, isLegend: false, legend: noop, next: noop, readParts: noop, unreadParts: noop,
      readList: [], isReadTab: false, readTab: noop, work: 'folded', setWork: noop, agents: [], turnOf: () => undefined,
      openAgent: noop, agentView: '', jumpTo: noop, openRequest: noop, requestView: '', jobs: [], openJob: noop, jobView: '', scroll: {}, height: 60,
    } as unknown as PanelCtx
    const now = Date.now()
    const rowOf = (a: Agent, width: number, extra: Partial<PanelCtx> = {}) => {
      const out = panelLines({ ...base, agents: [a], ...extra }, width).lines
      return out.find(l => plain(l).includes('James'))!
    }
    const working = agent({ person: 'James', name: 'Fix', startedAt: now - 60_000, lastStepAt: now - 12_000 })
    assert.match(plain(rowOf(working, 60)), /◐ James \(implementer\) · Fix bg +last step 12s ago$/)
    // Narrow: the name keeps its room, the note goes short.
    assert.match(plain(rowOf(working, 40)), /◐ James \(implementer\) · Fix bg +12s$/)
    const running = agent({ person: 'James', name: 'Fix', startedAt: now - 600_000, log: [{ step: step('b', 'Bash', {}, { at: now - 360_000 }) }] })
    assert.match(plain(rowOf(running, 60)), /running Bash 6m 0s$/)
    assert.match(plain(rowOf(running, 46)), /Fix bg +Bash 6m 0s$/)
    assert.match(plain(rowOf(running, 40)), /Fix bg +6m 0s$/)
    const quiet = agent({ person: 'James', name: 'Fix', startedAt: now - 900_000, lastStepAt: now - 360_000 })
    const q = rowOf(quiet, 60)
    assert.match(plain(q), /quiet 6m 0s$/)
    assert.equal(q.at(-1)!.style?.fg, C.yellow)
    // Claude itself: working, its tool after a while, quiet.
    const lead = (pulse: Pulse) =>
      plain(panelLines({ ...base, main: { for: [], last: 'thinking', pulse } }, 60).lines.find(l => plain(l).includes('Claude'))!)
    assert.match(lead({ kind: 'step', since: now - 1000 }), /working$/)
    assert.match(lead({ kind: 'tool', tool: 'Bash', since: now - 2000 }), /working$/)
    assert.match(lead({ kind: 'tool', tool: 'Bash', since: now - 120_000 }), /running Bash 2m 0s$/)
    assert.match(lead({ kind: 'quiet', since: now - 400_000 }), /quiet 6m 40s$/)

    // Its view: how long it has worked, its last step or tool; quiet, with ▶ continue.
    let asked = ''
    const view = (a: Agent) => agentLines(a, [], ctx([], { now, continueAgent: (id: string) => (asked = id) }), 80).lines
    assert.ok(view(working).map(plain).some(l => /⠋ working for 1m 0s · 0 steps so far · last step 12s ago/.test(l)))
    assert.ok(view(running).map(plain).some(l => /working for 10m 0s · 0 steps so far · running Bash for 6m 0s/.test(l)))
    const lines = view(quiet)
    const note = lines.find(l => plain(l).includes('no new steps'))!
    assert.match(plain(note), /◌ no new steps for 6m 0s: it may be stuck\.  ▶ continue/)
    note.find(sp => sp.text.includes('continue'))!.action!()
    assert.equal(asked, quiet.id)
    assert.ok(!view(working).some(l => plain(l).includes('no new steps')))
  })
})
