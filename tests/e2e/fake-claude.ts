// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, for the e2e tests.
// It reads the app's stream-json lines on stdin, logs each one to $FAKE_DIR/claude.log, and answers
// each user message with a scenario chosen by words in it (see `scenario` below). A scenario that has
// to wait (streaming, a slow turn) waits for a file named release-<name> in $FAKE_DIR.

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
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
/** AskUserQuestion requests waiting for the app's answer: the whole response. */
const asks = new Map<string, (response: any) => void>()

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
/** `data`: the structured result Claude Code sends beside the text (tool_use_result). */
const toolResult = (id: string, content: unknown, isError = false, parent?: string, data?: unknown) =>
  out({ type: 'user', ...(parent ? { parent_tool_use_id: parent } : {}), message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, ...(data ? { tool_use_result: data } : {}) })
const init = () => out({ type: 'system', subtype: 'init', session_id: sessionId, model: MODEL, cwd: process.cwd(), tools: [], slash_commands: ['compact', 'cost'], permissionMode: 'default' })
const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5)
const result = (extra: Record<string, unknown> = {}) =>
  out({ type: 'result', subtype: 'success', is_error: false, result: '', usage, total_cost_usd: 0.0123, duration_ms: 1500, session_id: sessionId, modelUsage: { [MODEL]: { contextWindow: 200_000 } }, ...extra })

let previous = ''
/** Every message's topic so far, oldest first. */
const topics: string[] = []
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
  // A burst answered at once: a short part for every message so far, one long, and one that asks.
  if (t.includes('short answers')) {
    const parts = topics.map((id, i) => `<<reply ${id}>>\nShort answer ${i + 1}.`)
    parts.push(`<<reply ${m.topic}>>\n${Array.from({ length: 4 }, (_, i) => `Long line ${i + 1} of the last answer.`).join('\n\n')}`)
    say(`${parts.join('\n\n')}\n${tag([...topics.map(id => ({ id, status: 'done' })), { id: m.topic, status: 'done' }])}`)
    return result()
  }
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
  // AskUserQuestion: Claude Code asks the app for permission to run it, and the answers come back
  // in the tool's input.
  if (t.includes('offer choices')) {
    const id = `ask-${Date.now()}`
    const questions = [
      { question: 'Which database should we use?', header: 'Database', multiSelect: false, options: [
        { label: 'Postgres', description: 'Relational, the usual pick' }, { label: 'SQLite', description: 'One file, no server' },
      ] },
      { question: 'Which extras do you want?', header: 'Extras', multiSelect: true, options: [
        { label: 'Backups', description: '' }, { label: 'Metrics', description: 'Dashboards' }, { label: 'Logs', description: '' },
      ] },
    ]
    tool('askq-1', 'AskUserQuestion', { questions })
    out({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions } } })
    const r = await new Promise<any>(res => asks.set(id, res))
    if (r?.behavior !== 'allow') {
      toolResult('askq-1', r?.message ?? 'denied', true)
      return finish(m, `No answer: ${r?.message}`)
    }
    const answers: Record<string, string> = r.updatedInput?.answers ?? {}
    toolResult('askq-1', Object.entries(answers).map(([q, a]) => `"${q}"="${a}"`).join(', '))
    return finish(m, `You chose: ${Object.values(answers).join(' / ')}`)
  }
  // Scheduled jobs, in the shapes Claude Code 2.1 streams: a recurring cron, a /loop wakeup, and a
  // one-off reminder an agent sets up. On release-fire the cron fires: a command_lifecycle event,
  // then a turn of Claude's own with no user message.
  if (t.includes('schedule jobs')) {
    const now = Date.now()
    const next = Math.floor(now / 300_000) * 300_000 + 300_000 + 13_000
    tool('cron-1', 'CronCreate', { cron: '*/5 * * * *', recurring: true, prompt: 'Check the deploy and tell me if it is green.' })
    toolResult('cron-1', `Scheduled recurring job a1b2c3d4 (Every 5 minutes). Next run: ${hhmm(next)}. Session-only (not written to disk, dies when Claude exits). Auto-expires after 30 days. Use CronDelete to cancel sooner.`, false, undefined,
      { id: 'a1b2c3d4', humanSchedule: 'Every 5 minutes', recurring: true, durable: false, nextFireAt: next, maxAgeMs: 2_592_000_000 })
    const wake = now + 600_000
    tool('wake-1', 'ScheduleWakeup', { delaySeconds: 600, prompt: 'Look at the build again.', reason: 'waiting for CI to finish', noop: false })
    toolResult('wake-1', `Next wakeup scheduled for ${hhmm(wake)}:00 (in 600s). If you owe the user a status update this tick, write it now as ordinary response text; then end the turn — the harness re-invokes you when the wakeup fires or a task-notification arrives.`, false, undefined,
      { scheduledFor: wake, clampedDelaySeconds: 600, wasClamped: false })
    tool('agent-s', 'Agent', { description: 'Plan the release', subagent_type: 'Plan', prompt: 'Plan the release.' })
    const at = new Date(now + 3 * 3_600_000)
    tool('cron-2', 'CronCreate', { cron: `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *`, recurring: false, prompt: 'Remind the user to tag the release.' }, 'agent-s')
    toolResult('cron-2', `Scheduled one-shot job e5f6a7b8. Next run: ${hhmm(at.getTime())}. Session-only (not written to disk, dies when Claude exits).`, false, 'agent-s',
      { id: 'e5f6a7b8', humanSchedule: 'Once', recurring: false, durable: false, nextFireAt: at.getTime() })
    toolResult('agent-s', 'Planned the release.')
    finish(m, 'Scheduled them.')
    if (await release('fire', 60_000)) {
      out({ type: 'command_lifecycle', command_uuid: 'cmd-1', state: 'started', wakeup_source: 'schedule_wakeup' })
      init()
      say('The deploy is green.')
      result()
      out({ type: 'command_lifecycle', command_uuid: 'cmd-1', state: 'completed' })
    }
    return
  }
  // Asked to cancel one (the job view's ✕ cancel): CronDelete, as Claude would.
  const cancel = t.match(/cancel the scheduled job ([0-9a-z]+)/)
  if (cancel) {
    tool('del-1', 'CronDelete', { id: cancel[1] })
    toolResult('del-1', `Cancelled job ${cancel[1]}.`, false, undefined, { id: cancel[1] })
    return finish(m, `Deleted job ${cancel[1]}.`)
  }
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
    // Claude Code streams none of its steps: it writes them to the agent's own transcript.
    const file = `${process.env.HOME}/.claude/projects/${process.cwd().replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}/subagents/agent-bg-42.jsonl`
    mkdirSync(dirname(file), { recursive: true })
    const line = (o: unknown) => appendFileSync(file, JSON.stringify(o) + '\n')
    line({ type: 'user', isSidechain: true, message: { content: 'Do the long job.' } })
    line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'Checking the build first.' }, { type: 'tool_use', id: 'bg-s1', name: 'Bash', input: { command: 'make build', description: 'Build the project' } }] } })
    line({ type: 'user', isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: 'bg-s1', content: 'build ok' }] } })
    await release('bg', 20_000)
    out({ type: 'system', subtype: 'task_notification', task_id: 'bg-42', status: 'completed', summary: 'Long job finished' })
    say(`<<reply ${m.topic}>>\nThe background job is done.\n${tag([{ id: m.topic, status: 'done' }])}`)
    return result()
  }
  // One background agent, three tasks: the Agent call, a SendMessage while it runs (queued until its
  // transcript shows it arriving), and one after it finished (which continues it). It keeps a to-do list.
  if (t.includes('agent tasks')) {
    const file = `${process.env.HOME}/.claude/projects/${process.cwd().replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}/subagents/agent-at-77.jsonl`
    mkdirSync(dirname(file), { recursive: true })
    const line = (o: unknown) => appendFileSync(file, JSON.stringify(o) + '\n')
    const step = (id: string, name: string, input: unknown, res: string) => {
      line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', id, name, input }] } })
      line({ type: 'user', isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: id, content: res }] } })
    }
    const todo = (lint: string) => ({ todos: [
      { content: 'Read the error', status: 'completed', activeForm: 'Reading the error' },
      { content: 'Fix the import', status: lint === 'pending' ? 'in_progress' : 'completed', activeForm: 'Fixing the import' },
      { content: 'Run the linter', status: lint, activeForm: 'Running the linter' },
    ] })
    tool('at-1', 'Agent', { description: 'Fix the build', subagent_type: 'general-purpose', prompt: 'Fix the build.', run_in_background: true })
    toolResult('at-1', 'Async agent launched successfully. agentId: at-77')
    line({ type: 'user', isSidechain: true, message: { content: 'Fix the build.' } })
    step('at-s1', 'TodoWrite', todo('pending'), 'Todos have been modified successfully.')
    tool('sm-1', 'SendMessage', { to: 'at-77', summary: 'Also run the linter', message: 'Also run the linter and fix what it finds.' })
    toolResult('sm-1', 'Message queued for delivery to at-77 at its next tool round.')
    finish(m, 'Started it and sent it more work.', 'claude')
    await release('task2')
    line({ type: 'user', isSidechain: true, message: { content: 'Also run the linter and fix what it finds.' } })
    step('at-s2', 'Bash', { command: 'npm run lint', description: 'Run the linter' }, 'lint ok')
    step('at-s3', 'TodoWrite', todo('in_progress'), 'Todos have been modified successfully.')
    await release('done1')
    out({ type: 'system', subtype: 'task_notification', task_id: 'at-77', status: 'completed', summary: 'Build fixed, lint clean' })
    tool('sm-2', 'SendMessage', { to: 'at-77', message: 'Now write the release notes for this fix, as a short list.' })
    toolResult('sm-2', 'Agent at-77 was stopped; resumed it in the background with your message.')
    line({ type: 'user', isSidechain: true, message: { content: 'Now write the release notes for this fix, as a short list.' } })
    step('at-s4', 'Write', { file_path: `${cwd}/NOTES.md`, content: '- fixed the build' }, 'ok')
    say('Sent it one more task.')
    result()
    await release('done2')
    out({ type: 'system', subtype: 'task_notification', task_id: 'at-77', status: 'completed', summary: 'Release notes written' })
    say(`<<reply ${m.topic}>>\nAll three tasks are done.\n${tag([{ id: m.topic, status: 'done' }])}`)
    return result()
  }
  // Claude says it will do it later (its tag says it still owes work), and nothing works on it; on
  // release-later it goes on by itself with an agent for it.
  if (t.includes('do it later')) {
    finish(m, "OK, I'll get to it after the current work.", 'claude')
    if (!(await release('later'))) return
    tool('lt-1', 'Agent', { description: 'Do the later work', subagent_type: 'general-purpose', prompt: 'Do the work.' })
    await release('later-agent')
    toolResult('lt-1', 'Did the work.')
    say(`<<reply ${m.topic}>>\nThe later work is done.\n${tag([{ id: m.topic, status: 'done' }])}`)
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
    topics.push(m.topic)
  }
  busy = false
}

// The tag in "about earlier" names the previous topic, so the app links the two.
const aboutTag = (m: Msg) => (m.text.toLowerCase().includes('about earlier') && previous ? previous : undefined)

init()

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
    asks.get(id)?.(e.response?.response)
    asks.delete(id)
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
