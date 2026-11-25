import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Claude } from '../../app/claude.ts'
import type { ClaudeEvent } from '../../app/claude.ts'

// A `claude` on PATH that prints these events (with junk between), logs what it reads, and exits 2.
const dir = mkdtempSync(join(tmpdir(), 'clued-claude-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const events = [
  { type: 'system', subtype: 'init', session_id: 's9', model: 'm', cwd: '/tmp/w', slash_commands: ['compact', 7], permissionMode: 'plan' },
  { type: 'system', subtype: 'init', session_id: 's9', model: 'm', cwd: '/tmp/w' },
  { type: 'system', subtype: 'status', status: 'compacting' },
  { type: 'system', subtype: 'status', status: null },
  { type: 'system', subtype: 'compact_boundary' },
  { type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'a1', description: 'Look' },
  { type: 'system', subtype: 'task_progress', task_id: 't1', last_tool_name: 'Grep' },
  { type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'Found' },
  { type: 'system', subtype: 'task_notification' },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } },
  { type: 'stream_event', parent_tool_use_id: 'a1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub' } } },
  { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 12 } } },
  { type: 'stream_event', event: { type: 'message_start' } },
  { type: 'assistant', message: { usage: { input_tokens: 3 }, content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: '' }, { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'ls' } }, { type: 'tool_use', id: 'u2', name: 'Read' }] } },
  { type: 'assistant', message: {} },
  { type: 'assistant', parent_tool_use_id: 'a1', message: { content: [{ type: 'tool_use', id: 's1', name: 'Grep' }, { type: 'text', text: 'agent says' }, { type: 'text', text: '' }] } },
  { type: 'assistant', parent_tool_use_id: 'a1', message: {} },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'out' }, { type: 'tool_result', tool_use_id: 'u2', content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }], is_error: true }, { type: 'tool_result', tool_use_id: 'u3' }, { type: 'text', text: 'not a result' }] } },
  { type: 'user', parent_tool_use_id: 'a1', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'hit' }] } },
  { type: 'user', message: { content: 'plain' } },
  { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: {} } },
  { type: 'rate_limit_event' },
  { type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm x' } } },
  { type: 'control_request', request_id: 'p2', request: { subtype: 'can_use_tool', tool_name: 'Read' } },
  { type: 'control_request', request_id: 'h1', request: { subtype: 'hook_callback' } },
  { type: 'result', result: 'done', is_error: false, usage: { input_tokens: 1 }, total_cost_usd: 0.5, duration_ms: 9, session_id: 's9', modelUsage: { a: { contextWindow: 200000 }, b: { contextWindow: 1000000 }, c: {} } },
  { type: 'result', result: 7, is_error: true },
  { type: 'something_new' },
]
const replay = join(dir, 'events.jsonl')
writeFileSync(replay, events.map(e => JSON.stringify(e)).join('\nnot json\n\n') + '\n')
const fake = join(dir, 'fake.mjs')
writeFileSync(fake, `
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const dir = ${JSON.stringify(dir)}
appendFileSync(dir + '/args.json', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), entry: process.env.CLAUDE_CODE_ENTRYPOINT }))
const text = readFileSync(dir + '/events.jsonl', 'utf8')
// Split mid-line, so the app has to join chunks.
const cut = Math.floor(text.length / 2)
process.stdout.write(text.slice(0, cut))
setTimeout(() => process.stdout.write(text.slice(cut)), 50)
createInterface({ input: process.stdin }).on('line', l => appendFileSync(dir + '/stdin.jsonl', l + '\\n')).on('close', () => {
  process.stderr.write('x'.repeat(5000) + 'last words\\n')
  setTimeout(() => process.exit(2), 50)
})
`)
writeFileSync(join(dir, 'claude'), `#!/bin/sh\nexec node ${JSON.stringify(fake)} "$@"\n`)
chmodSync(join(dir, 'claude'), 0o755)

test('Claude: spawns claude headless, reads every kind of event, writes messages and answers', async () => {
  process.env.PATH = `${dir}:${process.env.PATH}`
  const got: ClaudeEvent[] = []
  let claude!: Claude
  const exited = new Promise<void>(resolve => {
    claude = new Claude({ args: ['--model', 'x'], cwd: dir, appendSystemPrompt: 'GUIDE' }, e => {
      got.push(e)
      if (e.kind === 'exit') resolve()
    })
  })
  // Wait for the last event, then talk back.
  while (!got.some(e => e.kind === 'result' && e.isError)) await new Promise(r => setTimeout(r, 20))
  claude.send('plain')
  claude.send('with note', 'hidden note', [{ media: 'image/png', data: 'AAAA' }])
  claude.interrupt()
  claude.answerPermission('p1', true, { command: 'rm x' })
  claude.answerPermission('p2', false, {})
  claude.close()
  await exited
  // Writing after the end is a no-op, not an error.
  claude.send('too late')

  const kinds = got.map(e => e.kind)
  assert.deepEqual(kinds, [
    'init', 'init', 'status', 'status', 'task', 'task', 'task', 'task', 'text-delta', 'output-tokens',
    'usage', 'text', 'tool', 'tool', 'agent-step', 'agent-text', 'tool-result', 'tool-result', 'tool-result',
    'agent-tool-result', 'rate', 'rate', 'permission', 'permission', 'result', 'result', 'exit',
  ])
  const by = <K extends ClaudeEvent['kind']>(k: K, n = 0) => got.filter(e => e.kind === k)[n] as Extract<ClaudeEvent, { kind: K }>
  assert.deepEqual(by('init'), { kind: 'init', sessionId: 's9', model: 'm', cwd: '/tmp/w', commands: ['compact', '7'], permissionMode: 'plan' })
  assert.deepEqual(by('init', 1).commands, [])
  assert.deepEqual(by('status', 1), { kind: 'status', text: 'compacted' })
  assert.deepEqual(by('task'), { kind: 'task', phase: 'started', taskId: 't1', toolUseId: 'a1', text: 'Look' })
  assert.deepEqual(by('task', 1), { kind: 'task', phase: 'progress', taskId: 't1', lastTool: 'Grep' })
  assert.deepEqual(by('task', 2), { kind: 'task', phase: 'done', taskId: 't1', status: 'completed', text: 'Found' })
  assert.deepEqual(by('task', 3), { kind: 'task', phase: 'done', taskId: '' })
  assert.deepEqual(by('text-delta'), { kind: 'text-delta', text: 'Hel' })
  assert.deepEqual(by('output-tokens'), { kind: 'output-tokens', tokens: 12 })
  assert.deepEqual(by('tool', 1), { kind: 'tool', tool: { id: 'u2', name: 'Read', input: {} } })
  assert.deepEqual(by('agent-step'), { kind: 'agent-step', parent: 'a1', tool: { id: 's1', name: 'Grep', input: {} } })
  assert.deepEqual(by('tool-result', 1), { kind: 'tool-result', id: 'u2', text: 'a\nb', isError: true })
  assert.deepEqual(by('tool-result', 2), { kind: 'tool-result', id: 'u3', text: '', isError: false })
  assert.deepEqual(by('agent-tool-result'), { kind: 'agent-tool-result', parent: 'a1', id: 's1', text: 'hit', isError: false })
  assert.deepEqual(by('rate', 1), { kind: 'rate', info: {} })
  assert.deepEqual(by('permission', 1), { kind: 'permission', requestId: 'p2', tool: 'Read', input: {} })
  assert.deepEqual(by('result'), { kind: 'result', text: 'done', isError: false, usage: { input_tokens: 1 }, costUsd: 0.5, durationMs: 9, sessionId: 's9', contextWindow: 1000000 })
  assert.deepEqual(by('result', 1), { kind: 'result', text: '', isError: true, usage: {}, costUsd: 0, durationMs: 0, sessionId: undefined })
  const exit = by('exit')
  assert.equal(exit.code, 2)
  assert.equal(exit.stderr.length, 4000)
  assert.ok(exit.stderr.endsWith('last words\n'))

  const { args, cwd, entry } = JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8'))
  assert.deepEqual(args.slice(0, 5), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json'])
  assert.deepEqual(args.slice(-4), ['--append-system-prompt', 'GUIDE', '--model', 'x'])
  assert.ok(args.includes('--permission-prompt-tool'))
  assert.equal(cwd, dir)
  assert.equal(entry, 'sdk-ts')

  assert.ok(existsSync(join(dir, 'stdin.jsonl')))
  const sent = readFileSync(join(dir, 'stdin.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(sent[0].request.subtype, 'initialize')
  // The hook callback it doesn't handle gets an empty success.
  assert.deepEqual(sent[1], { type: 'control_response', response: { subtype: 'success', request_id: 'h1', response: {} } })
  assert.equal(sent[2].message.content, 'plain')
  assert.deepEqual(sent[3].message.content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'text', text: 'with note' },
    { type: 'text', text: 'hidden note' },
  ])
  assert.equal(sent[4].request.subtype, 'interrupt')
  assert.deepEqual(sent[5].response.response, { behavior: 'allow', updatedInput: { command: 'rm x' } })
  assert.deepEqual(sent[6].response.response, { behavior: 'deny', message: 'The user denied this.' })
  assert.equal(sent.length, 7)
})
