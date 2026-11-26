import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeEvent, Options } from '../../app/claude.ts'
import type { Line } from '../../app/text.ts'

// session.ts (which btw.ts asks where sessions live) reads HOME when it loads: a temp one first.
const home = mkdtempSync(join(tmpdir(), 'clued-btw-'))
process.env.HOME = home
after(() => rmSync(home, { recursive: true, force: true }))
const { BTW_NOTE, Btw, btwArgs, cleanAnswer } = await import('../../app/btw.ts')
const { projectDir } = await import('../../app/session.ts')

const CWD = '/tmp/btw work'
const text = (l: Line) => l.map(s => s.text).join('')

/** A Btw whose side Claude Codes are stubs: what they were started with, got, and how they end. */
function harness() {
  const sides: { opts: Options; emit: (e: ClaudeEvent) => void; sent: [string, string | undefined][]; uuid?: string; closed: number; answers: unknown[] }[] = []
  let draws = 0
  const btw = new Btw(
    () => draws++,
    (opts, emit) => {
      const side = { opts, emit, sent: [] as [string, string | undefined][], uuid: undefined as string | undefined, closed: 0, answers: [] as unknown[] }
      sides.push(side)
      return {
        send: (t: string, hidden?: string, _images?: unknown, uuid?: string) => {
          side.sent.push([t, hidden])
          if (uuid) side.uuid = uuid
        },
        close: () => void side.closed++,
        answerPermission: (id: string, allow: boolean) => void side.answers.push(['permission', id, allow]),
        answerAsk: (id: string, _input: Record<string, unknown>, dismissed?: string) => void side.answers.push(['ask', id, dismissed]),
      }
    },
  )
  return { btw, sides, draws: () => draws }
}

const draw = { copy: () => {}, spin: '⠋' }
const result = (text: string, isError = false): ClaudeEvent => ({ kind: 'result', text, isError, usage: {}, costUsd: 0, durationMs: 1, sessionId: 'x' })

describe('btw', () => {
  test('its Claude Code: forked when the session is on disk, no tools, no hooks, no file of its own', () => {
    assert.deepEqual(btwArgs('s1', 'opus'), ['--resume', 's1', '--fork-session', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}', '--model', 'opus'])
    assert.deepEqual(btwArgs('', ''), ['--no-session-persistence', '--tools', '', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}'])
    const { btw, sides } = harness()
    // A session id Claude Code hasn't written yet: nothing to fork.
    btw.ask('q1', { sessionId: 'new', model: 'm', cwd: CWD, after: '' })
    assert.ok(!sides[0]!.opts.args.includes('--resume'))
    assert.equal(btw.asides[0]!.forked, false)
    mkdirSync(projectDir(CWD), { recursive: true })
    writeFileSync(join(projectDir(CWD), 'old.jsonl'), '{}\n')
    btw.ask('q2', { sessionId: 'old', model: 'm', cwd: CWD, after: '' })
    assert.deepEqual(sides[1]!.opts.args.slice(0, 3), ['--resume', 'old', '--fork-session'])
    assert.equal(sides[1]!.opts.cwd, CWD)
    assert.equal(btw.asides[1]!.forked, true)
    // The question goes with a note the app doesn't show.
    assert.deepEqual(sides[1]!.sent, [['q2', BTW_NOTE]])
  })

  test('the answer streams, then settles; the app\'s markup goes; the Claude Code is closed', () => {
    const { btw, sides, draws } = harness()
    const a = btw.ask('what?', { sessionId: '', model: '', cwd: CWD, after: '' })
    const side = sides[0]!
    side.emit({ kind: 'text-delta', text: 'Part' })
    assert.equal(a.answer, 'Part')
    side.emit({ kind: 'status', text: 'ignored' })
    side.emit({ kind: 'permission', requestId: 'p1', tool: 'Bash', input: {} })
    side.emit({ kind: 'ask', requestId: 'a1', input: {} })
    assert.deepEqual(side.answers.map(x => (x as unknown[]).slice(0, 2)), [['permission', 'p1'], ['ask', 'a1']])
    side.emit({ kind: 'text', text: '<<reply T3>>\nThe answer.\n<clued>{"topics":[]}</clued>' })
    side.emit({ kind: 'text', text: 'More.' })
    assert.equal(a.answer, 'The answer.\n\nMore.')
    side.emit(result('ignored when said'))
    assert.equal(a.state, 'answered')
    assert.equal(side.closed, 1)
    // Late events change nothing.
    side.emit({ kind: 'exit', code: 0, stderr: '' })
    assert.equal(a.state, 'answered')
    assert.ok(draws() >= 4)
    assert.equal(cleanAnswer('a <clued>{"open'), 'a')
  })

  test('failures: an error result, an empty one, an exit before answering', () => {
    const { btw, sides } = harness()
    const at = { sessionId: '', model: '', cwd: CWD, after: '' }
    const a = btw.ask('1', at)
    sides[0]!.emit(result('Prompt is too long', true))
    assert.deepEqual([a.state, a.error], ['failed', 'Prompt is too long'])
    const b = btw.ask('2', at)
    sides[1]!.emit({ kind: 'received', uuid: sides[1]!.uuid! })
    sides[1]!.emit(result(''))
    assert.deepEqual([b.state, b.error], ['failed', 'No answer came back.'])
    const c = btw.ask('3', at)
    sides[2]!.emit({ kind: 'exit', code: 1, stderr: '' })
    assert.equal(c.error, 'The side question stopped before answering (exit 1).')
    const d = btw.ask('4', at)
    sides[3]!.emit({ kind: 'exit', code: 1, stderr: 'first\nNo conversation found\n' })
    assert.equal(d.error, 'The side question stopped before answering: No conversation found.')
    const lines = btw.lines(d, 60, draw).map(text)
    assert.ok(lines.some(l => l.includes('✕ The side question stopped')))
    assert.ok(!lines.some(l => l.includes('⧉ copy')))
  })

  test('a resumed session ending a turn of its own first (an agent end told to the fork) is not the answer', () => {
    const { btw, sides } = harness()
    const a = btw.ask('q', { sessionId: '', model: '', cwd: CWD, after: '' })
    assert.ok(sides[0]!.uuid, 'the question goes with an id, to know its echo')
    sides[0]!.emit(result(''))
    assert.equal(a.state, 'asking')
    // Another message's echo doesn't count.
    sides[0]!.emit({ kind: 'received', uuid: 'someone-else' })
    sides[0]!.emit(result(''))
    assert.equal(a.state, 'asking')
    sides[0]!.emit({ kind: 'received', uuid: sides[0]!.uuid! })
    sides[0]!.emit({ kind: 'text', text: 'The answer.' })
    sides[0]!.emit(result(''))
    assert.deepEqual([a.state, a.answer], ['answered', 'The answer.'])
  })

  test('asides go in after the message they were asked after; anchors and owners move with the lines', () => {
    const { btw, sides } = harness()
    const laid = { lines: [[{ text: 'm1' }], [{ text: 'r1' }], [{ text: 'm2' }], [{ text: 'r2' }]] as Line[], anchors: { 'me:k1': 0, 'claude:k1': 1, 'me:k2': 2, 'claude:k2': 3 }, owners: ['me:k1', 'claude:k1', 'me:k2', 'claude:k2'] }
    const keys = ['k1', 'k2']
    assert.equal(btw.into(laid, keys, 60, draw), laid, 'no asides: the same layout')
    btw.ask('after one', { sessionId: '', model: '', cwd: CWD, after: 'k1' })
    btw.ask('after one too', { sessionId: '', model: '', cwd: CWD, after: 'k1' })
    btw.ask('at the end', { sessionId: '', model: '', cwd: CWD, after: 'k2' })
    btw.ask('another session', { sessionId: '', model: '', cwd: CWD, after: 'gone' })
    sides[0]!.emit({ kind: 'text', text: 'Answer one.' })
    sides[0]!.emit(result(''))
    const out = btw.into(laid, keys, 60, draw)
    const rows = out.lines.map(text)
    const at = (s: string) => rows.findIndex(r => r.includes(s))
    assert.ok(at('r1') < at('after one') && at('after one') < at('after one too') && at('after one too') < at('m2'))
    assert.ok(at('at the end') > at('r2'))
    assert.equal(at('another session'), -1)
    assert.equal(rows[out.anchors['me:k2']!], 'm2')
    assert.equal(rows[out.anchors['claude:k2']!], 'r2')
    assert.equal(rows[out.anchors['me:k1']!], 'm1')
    assert.equal(out.owners[out.anchors['me:k2']!], 'me:k2')
    assert.equal(out.owners[at('after one')], '')
    // Marked as aside, dimmed; one still asking says so.
    assert.match(rows[at('after one')]!, /╭ \/btw after one/)
    assert.ok(rows.some(r => r.includes('⠋ thinking about it aside…')))
    assert.ok(rows.some(r => r.includes('a side answer, with no conversation yet to see · ⧉ copy · ✕ close')))
    const answer = out.lines.find(l => text(l).includes('Answer one.'))!
    assert.ok(answer.filter(s => s.text.trim() && s.text !== '│ ').every(s => s.style?.fg === 245))
    // ✕ closes one (and its Claude Code); Esc the latest; a new session all of them.
    out.lines[at('after one')]!.at(-1)!.action!()
    assert.deepEqual(btw.asides.map(a => a.question), ['after one too', 'at the end', 'another session'])
    assert.equal(btw.dismissLast(), true)
    btw.clear()
    assert.deepEqual(btw.asides, [])
    assert.equal(btw.dismissLast(), false)
    assert.ok(sides.slice(1).every(s => s.closed >= 1))
  })
})
