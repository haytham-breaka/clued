// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, for the e2e tests.
// It reads the app's stream-json lines on stdin, logs each one to $FAKE_DIR/claude.log, and answers
// each user message with a scenario chosen by words in it (see `scenario` below). A scenario that has
// to wait (streaming, a slow turn) waits for a file named release-<name> in $FAKE_DIR.

import { appendFileSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'

const dir = process.env.FAKE_DIR ?? '.'
const args = process.argv.slice(2)
const log = (o: unknown) => appendFileSync(`${dir}/claude.log`, JSON.stringify(o) + '\n')
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const resumeAt = args.indexOf('--resume')
const sessionId = resumeAt >= 0 ? args[resumeAt + 1]! : 's1'
const MODEL = 'claude-fake-1-0'
log({ args, cwd: process.cwd() })

type Msg = { text: string; topic: string; images: number }
let interrupted = false
const permissions = new Map<string, (allow: boolean) => void>()

/** Waits for release-<name> (or an interrupt); false on timeout or interrupt. */
async function release(name: string, ms = 30_000): Promise<boolean> {
  const until = Date.now() + ms
  while (!existsSync(`${dir}/release-${name}`)) {
    if (interrupted || Date.now() > until) return false
    await sleep(40)
  }
  return true
}

const usage = { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 }
const tag = (topics: { id: string; status: string; title?: string; about?: string }[], extra: Record<string, unknown> = {}) =>
  `<clued>${JSON.stringify({ topics: topics.map(t => ({ title: `Topic ${t.id}`, ...t })), ...extra })}</clued>`
const say = (text: string) => out({ type: 'assistant', message: { content: [{ type: 'text', text }], usage } })
const tool = (id: string, name: string, input: Record<string, unknown>, parent?: string) =>
  out({ type: 'assistant', ...(parent ? { parent_tool_use_id: parent } : {}), message: { content: [{ type: 'tool_use', id, name, input }], ...(parent ? {} : { usage }) } })
const toolResult = (id: string, content: unknown, isError = false, parent?: string) =>
  out({ type: 'user', ...(parent ? { parent_tool_use_id: parent } : {}), message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } })
const result = (extra: Record<string, unknown> = {}) =>
  out({ type: 'result', subtype: 'success', is_error: false, result: '', usage, total_cost_usd: 0.0123, duration_ms: 1500, session_id: sessionId, modelUsage: { [MODEL]: { contextWindow: 200_000 } }, ...extra })

let previous = ''
/** Messages that arrived while a turn ran: Claude Code folds them into it, and the answer covers them. */
let joined: Msg[] = []
let busy = false
const queue: Msg[] = []

/** The answer's end: replies to any message that joined the turn, then the tag. */
function finish(m: Msg, text: string, status = 'done', extra: Record<string, unknown> = {}) {
  const also = joined.map(j => `\n\n<<reply ${j.topic}>>\nAlso got: ${j.text}`).join('')
  const topics = [{ id: m.topic, status }, ...joined.map(j => ({ id: j.topic, status: 'done' }))]
  joined = []
  say(`${text}${also}\n${tag(topics, extra)}`)
  result()
}

async function scenario(m: Msg) {
  const t = m.text.toLowerCase()
  const cwd = process.cwd()
  if (t.includes('please split')) {
    say(`<<reply ${previous}>>\nMore about your first message: part one.\n\n<<reply ${m.topic}>>\nAnd this part answers the split request.\n${tag([{ id: previous, status: 'done' }, { id: m.topic, status: 'done' }])}`)
    return result()
  }
  if (t.includes('stream')) {
    for (const piece of ['Streaming ', 'the answer ', 'slowly']) {
      out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } })
      await sleep(60)
    }
    out({ type: 'stream_event', parent_tool_use_id: 'x', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'agent words' } } })
    out({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 77 } } })
    await release('stream')
    return finish(m, 'Streaming the answer slowly, now finished.')
  }
  if (t.includes('run a tool')) {
    tool('tool-1', 'Bash', { command: 'echo hi\necho there', description: 'Say hi' })
    toolResult('tool-1', 'hi\nthere')
    say('Now reading the readme.')
    tool('tool-2', 'Read', { file_path: `${cwd}/README.md` })
    toolResult('tool-2', [{ type: 'text', text: '# Readme' }])
    tool('tool-3', 'Grep', { pattern: 'TODO' })
    toolResult('tool-3', 'no matches', true)
    for (const [i, [name, input]] of ([
      ['Glob', { pattern: '**/*.ts' }], ['WebFetch', { url: 'https://example.com' }], ['WebSearch', { query: 'clued' }],
      ['TodoWrite', { todos: [] }], ['Skill', { skill: 'review' }], ['mcp__github__get_issue', { n: 1 }],
    ] as const).entries()) {
      tool(`tool-x${i}`, name, input)
      toolResult(`tool-x${i}`, 'ok')
    }
    return finish(m, 'Ran the tools.')
  }
  if (t.includes('edit a file')) {
    tool('edit-1', 'Edit', { file_path: `${cwd}/notes.txt`, old_string: 'old line\nkeep me', new_string: 'new line\nkeep me' })
    toolResult('edit-1', 'ok')
    tool('edit-2', 'Write', { file_path: `${cwd}/fresh.txt`, content: 'brand new file' })
    toolResult('edit-2', 'ok')
    tool('edit-3', 'MultiEdit', { file_path: `${cwd}/multi.txt`, edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] })
    toolResult('edit-3', 'ok')
    tool('edit-4', 'NotebookEdit', { notebook_path: `${cwd}/nb.ipynb`, new_source: 'print(1)' })
    toolResult('edit-4', 'ok')
    const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
    tool('edit-5', 'Bash', { command: 'seq 60', description: 'Count to sixty' })
    toolResult('edit-5', long)
    return finish(m, 'Edited the files.')
  }
  if (/need (long )?permission/.test(t)) {
    const id = `perm-${Date.now()}`
    // "long": a command too long to show whole.
    const command = t.includes('long') ? Array.from({ length: 30 }, (_, i) => `echo line ${i}`).join('\n') : 'rm -rf /tmp/fake-target'
    out({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command, description: 'Remove the fake target' } } })
    const allow = await new Promise<boolean>(r => permissions.set(id, r))
    return finish(m, allow ? 'Permission was allowed.' : 'Permission was denied.')
  }
  if (t.includes('ask me')) return finish(m, 'I can do it two ways. Which one do you want?', 'me')
  if (t.includes('start agents')) {
    tool('agent-1', 'Agent', { description: 'Explore the code', subagent_type: 'Explore', prompt: 'Look around the code.' })
    out({ type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'agent-1', description: 'Explore the code' })
    tool('sub-1', 'Grep', { pattern: 'main' }, 'agent-1')
    out({ type: 'assistant', parent_tool_use_id: 'agent-1', message: { content: [{ type: 'text', text: 'Looking for main.' }] } })
    toolResult('sub-1', 'app/main.ts', false, 'agent-1')
    out({ type: 'system', subtype: 'task_progress', task_id: 'task-1', last_tool_name: 'Grep' })
    await release('agents', 20_000)
    toolResult('agent-1', 'Found the main file.')
    return finish(m, 'The agent found the main file.')
  }
  if (t.includes('background agent')) {
    tool('bg-1', 'Agent', { description: 'Long job', subagent_type: 'general-purpose', prompt: 'Do the long job.', run_in_background: true })
    toolResult('bg-1', 'Started in the background. agentId: bg-42')
    finish(m, 'Started it in the background.', 'claude')
    await release('bg', 20_000)
    out({ type: 'system', subtype: 'task_notification', task_id: 'bg-42', status: 'completed', summary: 'Long job finished' })
    say(`<<reply ${m.topic}>>\nThe background job is done.\n${tag([{ id: m.topic, status: 'done' }])}`)
    return result()
  }
  if (t.includes('rate limit')) {
    out({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1_900_000_000 } } } })
    out({ type: 'system', subtype: 'status', status: 'compacting' })
    out({ type: 'system', subtype: 'compact_boundary' })
    return finish(m, 'Here is the rate limit.')
  }
  if (m.images) return finish(m, `I got ${m.images} image(s).`)
  if (t.includes('please fail')) return result({ is_error: true, result: 'Something went wrong on purpose' })
  if (t.includes('crash now')) {
    process.stderr.write('fatal: fake crash\n')
    process.exit(3)
  }
  if (t.includes('react to this')) return finish(m, 'Done, nothing more to say.', 'done', { react: '✅' })
  if (t.includes('early reply')) {
    say(`<<reply ${m.topic}>>\nHere is an early answer.\n${tag([{ id: m.topic, status: 'claude' }])}`)
    tool('early-1', 'Bash', { command: 'sleep 1', description: 'Wait a bit' })
    toolResult('early-1', '')
    return finish(m, 'All finished after the early answer.')
  }
  // A reply written early that only streams: its words come as deltas, but its whole text block never
  // does (Claude Code sometimes drops a text block written just before a tool call).
  if (t.includes('deltas only')) {
    const text = `<<reply ${m.topic}>>\nAn early part that only streamed.\n${tag([{ id: m.topic, status: 'claude' }])}`
    for (let i = 0; i < text.length; i += 12) {
      out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: text.slice(i, i + 12) } } })
      await sleep(10)
    }
    tool('streamed-1', 'Bash', { command: 'sleep 1', description: 'Wait a bit' })
    toolResult('streamed-1', '')
    // The end settles the message but has no reply of its own: the streamed part is the only one.
    say(tag([{ id: m.topic, status: 'done' }]))
    return result()
  }
  if (t.includes('hold on')) {
    say('Starting the slow work.')
    tool('slow-1', 'Bash', { command: 'sleep 100', description: 'Slow work' })
    const ok = await release('slow')
    toolResult('slow-1', ok ? 'slept' : 'interrupted', !ok)
    if (interrupted) {
      interrupted = false
      joined = []
      return result({ result: 'Interrupted.' })
    }
    return finish(m, 'The slow work is done.')
  }
  if (t.includes('long answer'))
    return finish(m, [
      '# A heading', '', 'Some **bold**, *italic*, `code` and a [link](https://example.com).', '',
      '- one', '- two', '  - nested', '1. first', '- [x] done item', '', '> a quote', '> more quote', '',
      '```ts', 'const x = 1', '```', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', '---', 'The end.',
    ].join('\n'))
  // The tag settles the message, but the only reply names another id: the app shows it as lost.
  if (t.includes('lose my reply')) {
    say(`<<reply T999>>\nThis names the wrong message.\n${tag([{ id: m.topic, status: 'done' }])}`)
    return result()
  }
  return finish(m, `Echo: ${m.text}`)
}

async function run() {
  if (busy) return
  busy = true
  while (queue.length) {
    const m = queue.shift()!
    await scenario(m)
    if (!m.text.toLowerCase().includes('please split')) previous = m.topic
  }
  busy = false
}

// The tag in "about earlier" names the previous topic, so the app links the two.
const aboutTag = (m: Msg) => (m.text.toLowerCase().includes('about earlier') && previous ? previous : undefined)

out({ type: 'system', subtype: 'init', session_id: sessionId, model: MODEL, cwd: process.cwd(), tools: [], slash_commands: ['compact', 'cost'], permissionMode: 'default' })

createInterface({ input: process.stdin }).on('line', line => {
  let e: any
  try {
    e = JSON.parse(line)
  } catch {
    return
  }
  log(e)
  if (e.type === 'control_response') {
    const id = e.response?.request_id
    permissions.get(id)?.(e.response?.response?.behavior === 'allow')
    permissions.delete(id)
    return
  }
  if (e.type === 'control_request') {
    if (e.request?.subtype === 'interrupt') interrupted = true
    if (e.request?.subtype === 'set_permission_mode') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: e.request_id, response: { mode: e.request.mode } } })
      out({ type: 'system', subtype: 'status', status: null, permissionMode: e.request.mode })
    }
    return
  }
  if (e.type !== 'user') return
  const c = e.message?.content
  const blocks: any[] = Array.isArray(c) ? c : [{ type: 'text', text: String(c) }]
  const texts = blocks.filter(b => b.type === 'text').map(b => String(b.text))
  const m: Msg = { text: texts[0] ?? '', topic: (texts.join('\n').match(/This message is topic (T\d+)/) ?? [])[1] ?? 'T0', images: blocks.filter(b => b.type === 'image').length }
  const about = aboutTag(m)
  if (about) {
    // Answered at once, with "about" in its tag.
    say(`Linked to your earlier message.\n${tag([{ id: m.topic, status: 'done', about }])}`)
    result()
    previous = m.topic
    return
  }
  if (busy) joined.push(m)
  else queue.push(m)
  void run()
})
