import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// session.ts reads HOME when it loads: a temp one first, then the import.
const home = mkdtempSync(join(tmpdir(), 'clued-unit-'))
process.env.HOME = home
const S = await import('../../app/session.ts')
const { deletedAsked, deletedPrompt, lostRepliesPrompt } = await import('../../app/inbox.ts')
const CWD = '/tmp/some project'

const write = (id: string, lines: unknown[], mtime?: number) => {
  const d = S.projectDir(CWD)
  mkdirSync(d, { recursive: true })
  const p = join(d, `${id}.jsonl`)
  writeFileSync(p, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n')
  if (mtime) utimesSync(p, mtime / 1000, mtime / 1000)
}
const user = (content: unknown, extra = {}) => ({ type: 'user', timestamp: '2026-01-01T10:00:00Z', message: { content }, ...extra })
const assistant = (content: unknown[], extra = {}) => ({ type: 'assistant', message: { content, usage: { input_tokens: 5 } }, ...extra })

after(() => rmSync(home, { recursive: true, force: true }))

describe('newTurn and projectDir', () => {
  test('a new turn is open and empty', () => {
    const t = S.newTurn('hi', 5)
    assert.deepEqual({ ...t, key: '' }, { key: '', text: 'hi', at: 5, steps: [], live: '', pending: '', isDone: false, isOpen: false })
  })
  test('projectDir is Claude Code\'s folder name for the cwd', () => {
    assert.equal(S.projectDir('/tmp/a b.c'), `${home}/.claude/projects/-tmp-a-b-c`)
  })
})

describe('kept state', () => {
  test('saveKept writes after a moment; loadKept reads it back and drops old notices', async () => {
    const kept = { board: { ...(await import('../../hooks/model.ts')).emptyBoard(), nextTopic: 7 }, reactions: { k: [{ emoji: '👍', by: 'me' as const }] }, links: {}, work: 'all' as const }
    S.saveKept('sess-1', kept)
    S.saveKept('sess-1', kept) // the second call replaces the first timer
    await new Promise(r => setTimeout(r, 450))
    const file = join(home, '.clued', 'sessions', 'sess-1.json')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), kept)
    writeFileSync(file, JSON.stringify({ ...kept, notices: [1, 2] }))
    const back = S.loadKept('sess-1', CWD)
    assert.equal(back.board.nextTopic, 7)
    assert.equal(back.work, 'all')
    assert.equal('notices' in back, false)
  })
  test('nothing kept: the classic mod\'s threads for this project, else empty', () => {
    assert.deepEqual(S.loadKept('none', CWD).board.topics, [])
    const store = join(home, '.claude', 'plugins', 'store')
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'clued_x.json'), JSON.stringify({ [`board:${CWD}`]: { value: { threads: [{ id: 1, name: 'old' }], topics: [] } } }))
    assert.equal(S.loadKept('none', CWD).board.threads[0]!.name, 'old')
    writeFileSync(join(store, 'clued_x.json'), JSON.stringify({ [`board:${CWD}`]: { topics: [] } }))
    assert.deepEqual(S.loadKept('none', CWD).board.threads, [])
    rmSync(store, { recursive: true })
  })
})

describe('session files', () => {
  before(() => {
    write('titled', [{ type: 'ai-title', title: 'An "AI" title' }, user('first words')], 3000)
    write('plain', [user('hi', { isMeta: true }), user('<command>'), user([{ type: 'text', text: 'Hello there\nsecond line' }])], 2000)
    write('empty', ['not json'], 1000)
    writeFileSync(join(S.projectDir(CWD), 'notes.txt'), 'ignored')
  })
  test('listSessions: newest first, with Claude Code\'s title or your first words', () => {
    assert.deepEqual(S.listSessions(CWD).map(s => [s.id, s.title]), [['titled', 'An "AI" title'], ['plain', 'Hello there'], ['empty', '(untitled)']])
    assert.deepEqual(S.listSessions('/tmp/nowhere'), [])
  })
  test('loadHistory and lastUsage on a missing session', () => {
    assert.deepEqual(S.loadHistory(CWD, 'missing'), [])
    assert.equal(S.lastUsage(CWD, 'missing'), undefined)
  })
  test('loadHistory: a scheduled job firing is a turn of its own, and a structured tool result is kept', () => {
    write('sched', [
      user('ping me every minute', { timestamp: '2026-11-25T10:45:23.000Z' }),
      assistant([{ type: 'tool_use', id: 'c1', name: 'CronCreate', input: { cron: '* * * * *', prompt: 'PING' } }]),
      user([{ type: 'tool_result', tool_use_id: 'c1', content: 'Scheduled recurring job 72deb24a (Every minute).' }], { toolUseResult: { id: '72deb24a', nextFireAt: 5 } }),
      assistant([{ type: 'text', text: 'Scheduled.' }]),
      user('PING', { isMeta: true, turnOrigin: 'scheduled', wakeupSource: 'schedule_wakeup', timestamp: '2026-11-25T10:46:13.000Z' }),
      assistant([{ type: 'text', text: 'PONG' }]),
      user([{ type: 'text', text: 'PING' }], { isMeta: true, turnOrigin: 'scheduled', timestamp: '2026-11-25T10:47:13.000Z' }),
      // Other hidden messages are still skipped.
      user('hidden', { isMeta: true }),
    ])
    const turns = S.loadHistory(CWD, 'sched')
    assert.equal(turns.length, 3)
    assert.deepEqual(turns[0]!.steps[0]!.data, { id: '72deb24a', nextFireAt: 5 })
    assert.equal(turns[1]!.key, S.firedKey(Date.parse('2026-11-25T10:46:13.000Z')))
    assert.deepEqual(turns[1]!.fired, { prompt: 'PING', source: 'schedule_wakeup' })
    assert.deepEqual(turns[1]!.followUp, [turns[0]!.key])
    assert.equal(turns[1]!.answer, 'PONG')
    assert.deepEqual(turns[2]!.fired, { prompt: 'PING' })
  })
  test('loadHistory rebuilds turns: steps, results, queued messages, early replies and reactions', () => {
    write('full', [
      'garbage line',
      user('Caveat: noise'),
      user([{ type: 'text', text: 'Fix the bug' }, { type: 'text', text: '[clued] This message is topic T4.' }]),
      assistant([{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'ls' } }]),
      user([{ type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'text', text: 'a.ts' }], is_error: true }, { type: 'tool_result', tool_use_id: 'zz', content: 'x' }]),
      assistant([{ type: 'text', text: '<<reply T4>>\nEarly part.' }, { type: 'tool_use', id: 'u2', name: 'Read' }]),
      user([{ type: 'tool_result', tool_use_id: 'u2', content: 'file text' }]),
      { type: 'attachment', attachment: { type: 'queued_command', prompt: 'And this too\n[clued] This message is topic T5.' } },
      assistant([{ type: 'text', text: 'Fixed both. <clued>{"topics":[]}</clued>' }]),
      { type: 'attachment', attachment: { type: 'queued_command', prompt: [{ type: 'text', text: '[clued] noise' }] } },
      { type: 'attachment', attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'array prompt' }] } },
      assistant([{ type: 'text', text: 'Sidechain' }], { isSidechain: true }),
      user('[clued reaction] 👍 on your message'),
      assistant([{ type: 'text', text: 'Thanks.' }], { message: { content: [{ type: 'text', text: 'Thanks.' }], usage: { input_tokens: 42 } } }),
      user(lostRepliesPrompt(['T4', 'T5'])),
    ])
    const turns = S.loadHistory(CWD, 'full')
    assert.deepEqual(turns.map(t => t.text), ['Fix the bug', 'And this too', 'array prompt', '[clued reaction] 👍 on your message', lostRepliesPrompt(['T4', 'T5'])])
    const [fix, also, arr, react, again] = turns as [any, any, any, any, any]
    // The app's own ask for lost replies is that again, not a message of yours.
    assert.equal(again.reaction, '↻')
    assert.deepEqual(again.retry, ['T4', 'T5'])
    assert.equal(fix.topicId, 'T4')
    assert.equal(fix.continued, true)
    assert.deepEqual(fix.steps.map((s: any) => [s.tool.name, s.said, s.result, s.isError]), [['Bash', 'Looking.', 'a.ts', true], ['Read', undefined, 'file text', false]])
    assert.deepEqual(fix.early, ['<<reply T4>>\nEarly part.'])
    assert.equal(also.queued, true)
    assert.equal(also.topicId, 'T5')
    assert.equal(also.answer, undefined)
    assert.equal(arr.answer, 'Fixed both.')
    assert.equal(react.reaction, '👍')
    assert.equal(react.answer, 'Thanks.')
    assert.ok(turns.every(t => t.isDone && !t.pending))
    assert.deepEqual(S.lastUsage(CWD, 'full'), { input_tokens: 42 })
  })
  test('loadHistory: task notifications are kept on the turn, after the steps before them; steps have their time', () => {
    const note = '<task-notification>\n<task-id>bg-1</task-id>\n<tool-use-id>tu-1</tool-use-id>\n<status>failed</status>\n<summary>It broke</summary>\n</task-notification>'
    write('notes', [
      user('start it', { timestamp: '2026-11-25T10:00:00.000Z' }),
      assistant([{ type: 'tool_use', id: 'tu-1', name: 'Agent', input: {} }], { timestamp: '2026-11-25T10:00:01.000Z' }),
      user(note, { timestamp: '2026-11-25T10:05:00.000Z' }),
      { type: 'attachment', timestamp: '2026-11-25T10:06:00.000Z', attachment: { type: 'queued_command', prompt: [{ type: 'text', text: '<task-notification><task-id>bg-2</task-id></task-notification><task-notification><status>x</status></task-notification>' }] } },
      user([{ type: 'text', text: 'no notification here' }]),
      assistant([{ type: 'text', text: 'It failed.' }]),
    ])
    const [t, next] = S.loadHistory(CWD, 'notes')
    assert.equal(t!.steps[0]!.at, Date.parse('2026-11-25T10:00:01.000Z'))
    assert.deepEqual(t!.agentEnds, [
      { taskId: 'bg-1', toolUseId: 'tu-1', status: 'failed', summary: 'It broke', at: Date.parse('2026-11-25T10:05:00.000Z'), after: 1 },
      { taskId: 'bg-2', status: 'completed', at: Date.parse('2026-11-25T10:06:00.000Z'), after: 1 },
    ])
    assert.equal(next!.text, 'no notification here')
    assert.equal(next!.agentEnds, undefined)
  })
  test('loadHistory: Claude answering an agent after its turn ended is a follow-up turn keyed by the agent, as live', async () => {
    const note = (id: string) => `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>tu-${id}</tool-use-id>\n<status>completed</status>\n<summary>Done</summary>\n</task-notification>`
    write('follow', [
      user('run it in the background', { timestamp: '2026-11-25T10:00:00.000Z' }),
      assistant([{ type: 'tool_use', id: 'tu-bg-42', name: 'Agent', input: { run_in_background: true } }], { message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu-bg-42', name: 'Agent', input: { run_in_background: true } }] } }),
      user([{ type: 'tool_result', tool_use_id: 'tu-bg-42', content: 'Started. agentId: bg-42' }]),
      { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Started it.' }] } },
      // Claude had finished: its answer to the agent is a turn of its own.
      user(note('bg-42'), { timestamp: '2026-11-25T10:05:00.000Z' }),
      { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The job is done.' }] } },
      // The same agent again (continued): a key of its own.
      user(note('bg-42'), { timestamp: '2026-11-25T10:09:00.000Z' }),
      { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done again.' }] } },
      // Mid-turn (Claude still at work): the news stays on that turn.
      user('next thing', { timestamp: '2026-11-25T10:10:00.000Z' }),
      { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'g1', name: 'Grep', input: {} }] } },
      user([{ type: 'tool_result', tool_use_id: 'g1', content: 'x' }]),
      user(note('bg-7'), { timestamp: '2026-11-25T10:11:00.000Z' }),
      { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Both done.' }] } },
    ])
    const turns = S.loadHistory(CWD, 'follow')
    assert.deepEqual(turns.map(t => [t.key.startsWith('follow-') ? t.key : t.text, t.answer]), [
      ['run it in the background', 'Started it.'],
      ['follow-bg-42', 'The job is done.'],
      ['follow-bg-42.2', 'Done again.'],
      ['next thing', 'Both done.'],
    ])
    assert.deepEqual(turns[1]!.followUp, [turns[0]!.key])
    assert.equal(turns[0]!.agentEnds?.[0]?.taskId, 'bg-42')
    assert.equal(turns[3]!.agentEnds?.[0]?.taskId, 'bg-7')
    // Their reply ids: the ones the app gives them live.
    const { assignParts } = await import('../../app/inbox.ts')
    const { emptyBoard } = await import('../../hooks/model.ts')
    assignParts(turns, emptyBoard())
    assert.deepEqual(turns.slice(1, 3).map(t => t.parts?.map(p => p.id)), [['follow-bg-42:0'], ['follow-bg-42.2:0']])
  })
  test('loadHistory: after the app started Claude Code again, news starts a turn of its own, even if the one before stopped mid-turn', () => {
    const note = (id: string) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Done</summary>\n</task-notification>`
    write('restarted', [
      user('build it', { timestamp: '2026-11-25T10:00:00.000Z' }),
      { type: 'assistant', timestamp: '2026-11-25T10:00:05.000Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Started.' }] } },
      // Claude starts on the agent's news, and a /reload stops it before it writes anything.
      user(note('a9'), { timestamp: '2026-11-25T10:05:00.000Z' }),
      // The Claude Code started again is told again: live, a turn of its own (and the app counted the first).
      user(note('a9'), { timestamp: '2026-11-25T10:06:00.000Z' }),
      { type: 'assistant', timestamp: '2026-11-25T10:06:05.000Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The agent is done.' }] } },
      // Your message, then a restart mid-turn: what comes next isn't that turn's.
      user('and test it', { timestamp: '2026-11-25T10:07:00.000Z' }),
      { type: 'assistant', timestamp: '2026-11-25T10:07:05.000Z', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'g1', name: 'Grep', input: {} }] } },
      user(note('a9'), { timestamp: '2026-11-25T10:09:00.000Z' }),
      { type: 'assistant', timestamp: '2026-11-25T10:09:05.000Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Again done.' }] } },
    ])
    const keys = (starts?: number[]) => S.loadHistory(CWD, 'restarted', starts).map(t => [t.key.startsWith('follow-') ? t.key : t.text, t.answer ?? ''])
    assert.deepEqual(keys([Date.parse('2026-11-25T10:05:30.000Z'), Date.parse('2026-11-25T10:08:00.000Z')]), [
      ['build it', 'Started.'],
      ['follow-a9', ''],
      ['follow-a9.2', 'The agent is done.'],
      ['and test it', ''],
      ['follow-a9.3', 'Again done.'],
    ])
    // Without the app's starts: told twice in a row is one turn, and news mid-turn stays on that turn.
    assert.deepEqual(keys(), [
      ['build it', 'Started.'],
      ['follow-a9', 'The agent is done.'],
      ['and test it', 'Again done.'],
    ])
  })
  test('loadHistory: a turn a notification started follows up on what the ended agent or command worked for, not your latest message', async () => {
    const note = (...ids: string[]) => ids.map(id => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Done</summary>\n</task-notification>`).join('\n')
    const ended = (text: string, at: string) => ({ type: 'assistant', timestamp: at, message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } })
    const call = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } })
    write('notified', [
      user('run the suite', { timestamp: '2026-11-25T10:00:00.000Z' }),
      call('tu-b1', 'Bash', { command: 'npm test', run_in_background: true }),
      user([{ type: 'tool_result', tool_use_id: 'tu-b1', content: 'Command running in background with ID: rb1. Output is being written to: /tmp/rb1.output.' }]),
      ended('Started it.', '2026-11-25T10:00:01.000Z'),
      user('fix the docs', { timestamp: '2026-11-25T10:01:00.000Z' }),
      call('tu-a1', 'Agent', { description: 'Docs', run_in_background: true }),
      user([{ type: 'tool_result', tool_use_id: 'tu-a1', content: 'Started. agentId: ag-1' }]),
      ended('On it.', '2026-11-25T10:01:01.000Z'),
      user('something else', { timestamp: '2026-11-25T10:02:00.000Z' }),
      ended('Sure.', '2026-11-25T10:02:01.000Z'),
      // The suite's command ended: about "run the suite", the reply without a line and the one with its own.
      user(note('rb1'), { timestamp: '2026-11-25T10:03:00.000Z' }),
      ended('The suite passed.\n\n<<reply T9>>\nAnd the other one.', '2026-11-25T10:03:01.000Z'),
      user('and the readme', { timestamp: '2026-11-25T10:04:00.000Z' }),
      // Sent more for "and the readme": the agent's end is about that one now.
      call('sm-1', 'SendMessage', { to: 'ag-1', message: 'The readme too.' }),
      user([{ type: 'tool_result', tool_use_id: 'sm-1', content: 'Sent.' }]),
      ended('Asked it.', '2026-11-25T10:04:01.000Z'),
      user(note('ag-1'), { timestamp: '2026-11-25T10:05:00.000Z' }),
      ended('The docs and readme are fixed.', '2026-11-25T10:05:01.000Z'),
      // Two that worked for different messages: a guess, as before (the first one's Agent call).
      user(note('ag-1', 'rb1'), { timestamp: '2026-11-25T10:06:00.000Z' }),
      ended('Both again.', '2026-11-25T10:06:01.000Z'),
      // One the app knows nothing of: your latest message.
      user(note('who'), { timestamp: '2026-11-25T10:07:00.000Z' }),
      ended('Something ended.', '2026-11-25T10:07:01.000Z'),
    ])
    const turns = S.loadHistory(CWD, 'notified')
    const key = (text: string) => turns.find(t => t.text === text)!.key
    const follow = (answer: string) => turns.find(t => t.answer === answer)!.followUp
    assert.deepEqual(follow('The suite passed.\n\n<<reply T9>>\nAnd the other one.'), [key('run the suite')])
    assert.deepEqual(follow('The docs and readme are fixed.'), [key('and the readme')])
    assert.deepEqual(follow('Both again.'), [key('fix the docs')])
    assert.deepEqual(follow('Something ended.'), [key('and the readme')])
    const { assignParts } = await import('../../app/inbox.ts')
    const { emptyBoard } = await import('../../hooks/model.ts')
    const board = emptyBoard()
    board.topics.push({ id: 'T1', title: 'Suite', status: 'done', messageKeys: [key('run the suite')], updatedAt: 0 } as never)
    assignParts(turns, board)
    // The part with no line is for the command's message; the one with a line follows it.
    assert.deepEqual(turns.find(t => t.key === 'follow-rb1')!.parts!.map(p => [p.to, p.text]), [[['T1'], 'The suite passed.'], [['T9'], 'And the other one.']])
  })
  test('loadHistory: a compaction marks the turn it came in (what came before is left to the summary)', () => {
    write('compact', [
      user('first', { timestamp: '2026-11-25T10:00:00.000Z' }),
      assistant([{ type: 'text', text: 'One.' }]),
      { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', timestamp: '2026-11-25T10:01:00.000Z' },
      { type: 'system', subtype: 'compact_boundary', isSidechain: true },
      user('second', { timestamp: '2026-11-25T10:02:00.000Z' }),
      assistant([{ type: 'text', text: 'Two.' }]),
    ])
    const [a, b] = S.loadHistory(CWD, 'compact')
    assert.deepEqual([a!.text, a!.compacted, b!.text, b!.compacted], ['first', true, 'second', undefined])
  })
  test('readAgentFile: steps, words and results; later messages to it are prompts, the first is skipped', () => {
    const dir = join(S.projectDir(CWD), 'sess', 'subagents')
    mkdirSync(dir, { recursive: true })
    const lines = [
      { type: 'user', message: { content: 'Do it.' } },
      { type: 'assistant', timestamp: '2026-11-25T10:00:05.000Z', message: { content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x1', content: [{ type: 'text', text: 'a.ts' }], is_error: true }] } },
      { type: 'user', isMeta: true, message: { content: 'meta' } },
      { type: 'user', message: { content: [{ type: 'text', text: 'Also this.' }] } },
      { type: 'user', message: { content: '  ' } },
    ]
    writeFileSync(join(dir, 'agent-ag.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n{"partial":')
    const { entries: all, next } = S.readAgentFile(CWD, 'sess', 'ag', 0)
    // When: the transcript's time, else when the file last changed.
    const mtime = statSync(join(dir, 'agent-ag.jsonl')).mtimeMs
    assert.deepEqual(all.map(e => e.at), [Date.parse('2026-11-25T10:00:05.000Z'), Date.parse('2026-11-25T10:00:05.000Z'), mtime, mtime])
    const entries = all.map(({ at: _, ...e }) => e)
    assert.deepEqual(entries, [
      { kind: 'text', text: 'On it.' },
      { kind: 'step', tool: { id: 'x1', name: 'Bash', input: { command: 'ls' } } },
      { kind: 'result', id: 'x1', text: 'a.ts', isError: true },
      { kind: 'prompt', text: 'Also this.' },
    ])
    // From where it left off, a message is a prompt (the first was read before).
    writeFileSync(join(dir, 'agent-ag.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n' + JSON.stringify({ type: 'user', message: { content: 'And that.' } }) + '\n')
    assert.deepEqual(S.readAgentFile(CWD, 'sess', 'ag', next).entries.map(({ at: _, ...e }) => e), [{ kind: 'prompt', text: 'And that.' }])
    assert.deepEqual(S.readAgentFile(CWD, 'sess', 'missing', 0), { entries: [], next: 0 })
  })
  // As Claude Code writes them (seen in real agent transcripts).
  const sent = (message: string, extra = {}) => ({ type: 'user', isSidechain: true, isMeta: true, origin: { kind: 'coordinator' }, timestamp: '2026-11-25T10:01:00.000Z', message: { role: 'user', content: `The coordinator sent a message while you were working:\n${message}\n\nAddress this before completing your current task.` }, ...extra })
  const agentFile = (id: string, lines: unknown[]) => {
    const dir = join(S.projectDir(CWD), 'sess', 'subagents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `agent-${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    return S.readAgentFile(CWD, 'sess', id, 0).entries.map(({ at: _, ...e }) => e)
  }
  test('readAgentFile: a message Claude sent it is hidden, in Claude Code\'s words; it is a prompt, as sent', () => {
    const entries = agentFile('sent', [
      { type: 'user', message: { content: 'Do it.' } },
      sent('Also check the tests.\n\nThen report.'),
      // Not Claude's: another session's message, yours, a task notification.
      { type: 'user', isMeta: true, origin: { kind: 'peer', from: 'a1' }, message: { content: 'Another Claude session sent a message while you were working:\n<agent-message from="a1">\nHi.\n</agent-message>' } },
      { type: 'user', isMeta: true, origin: { kind: 'human' }, message: { content: 'The user sent a new message while you were working:\nhi' } },
      { type: 'user', isMeta: true, origin: { kind: 'task-notification' }, message: { content: '[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification></task-notification>' } },
      // Without its origin, its words still say what it is; as text blocks too.
      { type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'The coordinator sent a message while you were working:\nOne more.' }] } },
      sent('  '),
    ])
    assert.deepEqual(entries, [
      { kind: 'prompt', text: 'Also check the tests.\n\nThen report.' },
      { kind: 'prompt', text: 'One more.' },
    ])
    assert.equal(S.sentMessage('plain'), 'plain')
  })
  test("readAgentFile: task notifications given to it are task-ends (its background commands' ends), mid-turn or waking it", () => {
    const note = (id: string, tool: string, status: string, summary: string) =>
      `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>${tool}</tool-use-id>\n<output-file>/tmp/${id}.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`
    const entries = agentFile('ends', [
      { type: 'user', message: { content: 'Do it.' } },
      // Mid-turn: an attachment Claude Code adds to the agent's next step.
      { type: 'attachment', timestamp: '2026-11-25T10:02:00.000Z', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: note('b1', 'x1', 'completed', 'Background command "Run tests" completed (exit code 0)') } },
      // Waking it when it had finished: a hidden message, as text blocks too.
      { type: 'user', isMeta: true, origin: { kind: 'task-notification' }, message: { content: `[SYSTEM NOTIFICATION - NOT USER INPUT]\n${note('b2', 'x2', 'killed', 'Background command "Wait" was stopped')}` } },
      { type: 'user', isMeta: true, message: { content: [{ type: 'text', text: note('b3', 'x3', 'failed', 'Background command "Lint" failed with exit code 2') }] } },
      // Not one: Claude quoting one to it, a tool result that prints one, another kind of attachment.
      sent(note('b4', 'x4', 'completed', 'quoted')),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x9', content: note('b5', 'x5', 'completed', 'printed') }] } },
      { type: 'attachment', attachment: { type: 'queued_command', prompt: 'just a message' } },
      { type: 'attachment', attachment: { type: 'other', prompt: note('b6', 'x6', 'completed', 'other') } },
    ])
    assert.deepEqual(entries, [
      { kind: 'task-end', end: { taskId: 'b1', toolUseId: 'x1', status: 'completed', summary: 'Background command "Run tests" completed (exit code 0)', at: Date.parse('2026-11-25T10:02:00.000Z'), after: 0 } },
      { kind: 'task-end', end: { taskId: 'b2', toolUseId: 'x2', status: 'killed', summary: 'Background command "Wait" was stopped', at: (entries[1] as any).end.at, after: 0 } },
      { kind: 'task-end', end: { taskId: 'b3', toolUseId: 'x3', status: 'failed', summary: 'Background command "Lint" failed with exit code 2', at: (entries[2] as any).end.at, after: 0 } },
      { kind: 'prompt', text: note('b4', 'x4', 'completed', 'quoted') },
      { kind: 'result', id: 'x9', text: note('b5', 'x5', 'completed', 'printed'), isError: false },
    ])
  })
  test('readAgentFile: what a compaction writes, and an interruption line, are not messages to it', () => {
    const entries = agentFile('cut', [
      { type: 'user', message: { content: 'Do it.' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'The tool use was rejected.', is_error: true }] } },
      { type: 'user', rowSource: 'harness', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
      { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]\n' }] } },
      { type: 'user', message: { content: '[Request interrupted by user]' } },
      { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' },
      { type: 'attachment', attachment: { type: 'compact_file_reference' } },
      { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { content: 'This session is being continued from a previous conversation that ran out of context.\n\nSummary: the work.' } },
      { type: 'user', message: { content: 'This session is being continued from a previous conversation that ran out of context.' } },
      { type: 'user', isMeta: true, message: { content: '<system-reminder>\n<tools-used-before-summary>\nBash\n</tools-used-before-summary>\n</system-reminder>' } },
      { type: 'user', message: { content: 'A real later message.' } },
    ])
    assert.deepEqual(entries.filter(e => e.kind === 'prompt'), [{ kind: 'prompt', text: 'A real later message.' }])
    assert.deepEqual(entries.map(e => e.kind), ['step', 'result', 'prompt'])
  })
  test('readAgentFile: a fork has no first message to skip, and Claude\'s Agent call that started it is not its step', () => {
    const input = { description: 'Check', subagent_type: 'fork', prompt: 'Check the docs.' }
    const entries = agentFile('fork', [
      { type: 'fork-context-ref', agentId: 'fork', parentSessionId: 'sess', contextLength: 12 },
      { type: 'assistant', parentUuid: null, message: { content: [{ type: 'tool_use', id: 'parent-call', name: 'Agent', input }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'parent-call', content: [{ type: 'text', text: 'Fork started — that fork is you.' }] }, { type: 'text', text: '<fork-boilerplate>\nYou are a worker fork.\n</fork-boilerplate>\n\nCheck the docs.' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'f1', name: 'Read', input: { file_path: '/tmp/README.md' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'f1', content: 'docs' }] } },
      { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { content: 'This session is being continued from a previous conversation.' } },
      { type: 'user', message: { content: 'First plain message to it.' } },
      sent('Then the changelog.'),
    ])
    assert.deepEqual(entries, [
      { kind: 'text', text: 'Reading.' },
      { kind: 'step', tool: { id: 'f1', name: 'Read', input: { file_path: '/tmp/README.md' } } },
      { kind: 'result', id: 'f1', text: 'docs', isError: false },
      { kind: 'prompt', text: 'First plain message to it.' },
      { kind: 'prompt', text: 'Then the changelog.' },
    ])
    // An Agent call later in an agent's file is its own step; a fork's first entry that is no call is kept.
    assert.deepEqual(agentFile('fork2', [
      { type: 'fork-context-ref', agentId: 'fork2' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi.' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'g1', name: 'Agent', input }] } },
    ]).map(e => e.kind), ['text', 'step'])
  })
})

describe('saved messages', () => {
  test('toggleSaved saves, and unsaves the same anchor; the list survives saveKept and loadKept', async () => {
    const a = { anchor: 'me:k1', who: 'me' as const, text: 'one', at: 1 }
    const b = { anchor: 'part:k2:0', who: 'claude' as const, text: 'two', at: 2 }
    let list = S.toggleSaved([], a)
    list = S.toggleSaved(list, b)
    assert.deepEqual(list.map(x => x.anchor), ['me:k1', 'part:k2:0'])
    assert.deepEqual(S.toggleSaved(list, { ...a, at: 9 }).map(x => x.anchor), ['part:k2:0'])
    const { emptyBoard } = await import('../../hooks/model.ts')
    S.saveKept('saved-1', { board: emptyBoard(), reactions: {}, links: {}, saved: list })
    await new Promise(r => setTimeout(r, 450))
    assert.deepEqual(S.loadKept('saved-1', CWD).saved, list)
  })
})

describe('deleted messages', () => {
  test('the note telling Claude to ignore a message names it, and the session file keeps both deleted', () => {
    const note = deletedPrompt('T7', 'scrap that')
    assert.equal(note, 'The user deleted their message T7 (“scrap that”) before you read it: ignore it. Don\'t answer it, act on it or mention it.')
    assert.equal(deletedAsked(note), 'T7')
    assert.equal(deletedAsked('The user deleted nothing'), undefined)
    write('deleted', [
      user([{ type: 'text', text: 'hold on' }, { type: 'text', text: '[clued] This message is topic T6.' }]),
      { type: 'attachment', attachment: { type: 'queued_command', prompt: 'scrap that\n[clued] This message is topic T7.' } },
      { type: 'attachment', attachment: { type: 'queued_command', prompt: note } },
      assistant([{ type: 'text', text: 'Done.' }]),
      user([{ type: 'text', text: 'and this' }, { type: 'text', text: '[clued] This message is topic T8.' }]),
      user(deletedPrompt('T8', 'and this')),
    ])
    const turns = S.loadHistory(CWD, 'deleted')
    assert.deepEqual(turns.map(t => [t.text.slice(0, 12), t.deleted ?? '', t.deletes ?? '', t.reaction ?? '']), [
      ['hold on', '', '', ''],
      ['scrap that', 'told', '', ''],
      ['The user del', '', 'T7', '✕'],
      ['and this', 'told', '', ''],
      ['The user del', '', 'T8', '✕'],
    ])
  })
})
