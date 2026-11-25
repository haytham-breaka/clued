import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// session.ts reads HOME when it loads: a temp one first, then the import.
const home = mkdtempSync(join(tmpdir(), 'clued-unit-'))
process.env.HOME = home
const S = await import('../../app/session.ts')
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
    ])
    const turns = S.loadHistory(CWD, 'full')
    assert.deepEqual(turns.map(t => t.text), ['Fix the bug', 'And this too', 'array prompt', '[clued reaction] 👍 on your message'])
    const [fix, also, arr, react] = turns as [any, any, any, any]
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
})
