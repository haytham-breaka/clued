import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// session.ts reads HOME when it loads: a temp one first, then the import.
const home = mkdtempSync(join(tmpdir(), 'clued-unit-'))
process.env.HOME = home
const S = await import('../../app/session.ts')
const { lostRepliesPrompt } = await import('../../app/inbox.ts')
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
  test('readAgentFile: steps, words and results; later messages to it are prompts, the first is skipped', () => {
    const dir = join(S.projectDir(CWD), 'sess', 'subagents')
    mkdirSync(dir, { recursive: true })
    const lines = [
      { type: 'user', message: { content: 'Do it.' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x1', content: [{ type: 'text', text: 'a.ts' }], is_error: true }] } },
      { type: 'user', isMeta: true, message: { content: 'meta' } },
      { type: 'user', message: { content: [{ type: 'text', text: 'Also this.' }] } },
      { type: 'user', message: { content: '  ' } },
    ]
    writeFileSync(join(dir, 'agent-ag.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n{"partial":')
    const { entries, next } = S.readAgentFile(CWD, 'sess', 'ag', 0)
    assert.deepEqual(entries, [
      { kind: 'text', text: 'On it.' },
      { kind: 'step', tool: { id: 'x1', name: 'Bash', input: { command: 'ls' } } },
      { kind: 'result', id: 'x1', text: 'a.ts', isError: true },
      { kind: 'prompt', text: 'Also this.' },
    ])
    // From where it left off, a message is a prompt (the first was read before).
    writeFileSync(join(dir, 'agent-ag.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n' + JSON.stringify({ type: 'user', message: { content: 'And that.' } }) + '\n')
    assert.deepEqual(S.readAgentFile(CWD, 'sess', 'ag', next).entries, [{ kind: 'prompt', text: 'And that.' }])
    assert.deepEqual(S.readAgentFile(CWD, 'sess', 'missing', 0), { entries: [], next: 0 })
  })
})
