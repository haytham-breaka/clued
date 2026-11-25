// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, for the e2e tests.
// It reads the app's stream-json lines on stdin, logs each one to $FAKE_DIR/claude.log, and answers
// each user message with a scenario chosen by words in it (see `scenario` below). A scenario that has
// to wait (streaming, a slow turn) waits for a file named release-<name> in $FAKE_DIR.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

const dir = process.env.FAKE_DIR ?? '.'
const args = process.argv.slice(2)

/**
 * `claude plugin …` (/plugin runs Claude Code's own CLI): its plugins kept in $FAKE_DIR/plugins.json,
 * never the real ones. Each call is logged to plugin.log. FAKE_PLUGIN_BROKEN=1: list fails; a name
 * with "fail" in it fails to install; "slow" waits for release-plugin.
 */
if (args[0] === 'plugin' || args[0] === 'plugins') {
  appendFileSync(`${dir}/plugin.log`, JSON.stringify({ args: args.slice(1), cwd: process.cwd() }) + '\n')
  const file = `${dir}/plugins.json`
  type P = { id: string; version: string; scope: string; enabled: boolean }
  const all: P[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [{ id: 'figma@fake-market', version: '2.2.0', scope: 'user', enabled: true }, { id: 'old-tool@local', version: '0.1.0', scope: 'project', enabled: false }]
  const save = () => writeFileSync(file, JSON.stringify(all))
  const fail = (text: string) => (process.stderr.write(`✘ ${text}\n`), process.exit(1))
  const [verb, name = ''] = args.slice(1)
  const find = () => all.find(p => p.id === name || p.id.split('@')[0] === name)
  if (verb === 'list') {
    if (process.env.FAKE_PLUGIN_BROKEN) fail('Failed to read the plugin settings: boom')
    process.stdout.write(JSON.stringify(all, null, 2) + '\n')
  } else if (verb === 'marketplace') process.stdout.write(JSON.stringify([{ name: 'fake-market', source: 'github', repo: 'example/fake-market' }]) + '\n')
  else if (verb === 'install') {
    if (name.includes('fail')) fail(`Failed to install plugin "${name}": Plugin "${name}" not found in any marketplace`)
    if (name.includes('slow')) while (!existsSync(`${dir}/release-plugin`)) await new Promise(r => setTimeout(r, 40))
    all.push({ id: name.includes('@') ? name : `${name}@fake-market`, version: '1.0.0', scope: 'user', enabled: true })
    save()
    process.stdout.write(`\x1b[32m✔\x1b[0m Successfully installed plugin: ${name} (scope: user)\n`)
  } else if (verb === 'enable' || verb === 'disable') {
    const p = find()
    if (!p) fail(`Failed to ${verb} plugin "${name}": Plugin "${name}" not found in any editable settings scope. Use plugin@marketplace format.`)
    p!.enabled = verb === 'enable'
    save()
    process.stdout.write(`✔ Successfully ${verb}d plugin: ${p!.id} (scope: ${p!.scope})\n`)
  } else if (verb === 'uninstall') {
    const p = find()
    if (!p) fail(`Failed to uninstall plugin "${name}": Plugin "${name}" is not installed`)
    all.splice(all.indexOf(p!), 1)
    save()
    process.stdout.write(`✔ Successfully uninstalled plugin: ${p!.id} (scope: ${p!.scope})\n`)
  } else fail(`unknown command ${verb}`)
  process.exit(0)
}
/**
 * A /btw side question (app/btw.ts): no tools (`--tools ""`), forked from the session when there is
 * one. It logs to side.log, so claude.log stays the main session's, and answers once (see `sideAnswer`).
 */
const isSide = args[args.indexOf('--tools') + 1] === '' && args.includes('--tools')
const log = (o: unknown) => appendFileSync(`${dir}/${isSide ? 'side' : 'claude'}.log`, JSON.stringify(o) + '\n')
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const resumeAt = args.indexOf('--resume')
const resumed = resumeAt >= 0 ? args[resumeAt + 1]! : ''
// --fork-session: a new id for the copy, as Claude Code gives it (the one --session-id names, when given).
const isFork = !!resumed && args.includes('--fork-session')
const named = args.includes('--session-id') ? args[args.indexOf('--session-id') + 1]! : ''
const sessionId = named || (isFork ? `fork-of-${resumed}` : resumed || 's1')
// A fork's session file starts as a copy of the original's (none with --no-session-persistence, as /btw runs).
const sessionFile = (id: string) => `${process.env.HOME}/.claude/projects/${process.cwd().replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`
if (isFork && !args.includes('--no-session-persistence') && existsSync(sessionFile(resumed)))
  writeFileSync(sessionFile(sessionId), readFileSync(sessionFile(resumed), 'utf8').replaceAll(`"sessionId":"${resumed}"`, `"sessionId":"${sessionId}"`))
const MODEL = 'claude-fake-1-0'
log({ args, cwd: process.cwd() })
// A side question's Claude Code says when it ends (the app closes it once it has answered).
if (isSide) process.on('exit', code => log({ exit: code }))

type Msg = { text: string; topic: string; images: number; raw?: any }
/**
 * With --replay-user-messages, Claude Code echoes each message once it takes it in (as seen with a
 * real one): at once when idle; one sent mid-turn only at Claude's next step, after a tool result.
 * FAKE_NO_ECHO=1 keeps them (a message still "sent").
 */
const replays = args.includes('--replay-user-messages') && !process.env.FAKE_NO_ECHO
let unechoed: Msg[] = []
const echo = (m: Msg) => {
  if (replays && m.raw) out({ type: 'user', message: m.raw.message, session_id: sessionId, parent_tool_use_id: null, ...(m.raw.uuid ? { uuid: m.raw.uuid } : {}), timestamp: new Date().toISOString(), isReplay: true })
}
const echoJoined = () => {
  for (const m of unechoed) echo(m)
  unechoed = []
}
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
/**
 * How Claude Code writes an agent's own transcript (subagents/agent-<id>.jsonl), as seen in real ones:
 * a message Claude sends it while it runs (SendMessage), hidden and in Claude Code's words; what a
 * compaction writes (a boundary, a summary shown only in the transcript, a hidden reminder); and the
 * line written when you stop it mid-step.
 */
const agentLines = {
  sent: (message: string) => ({ type: 'user', isSidechain: true, isMeta: true, origin: { kind: 'coordinator' }, message: { role: 'user', content: `The coordinator sent a message while you were working:\n${message}\n\nAddress this before completing your current task.` } }),
  compaction: () => [
    { type: 'system', subtype: 'compact_boundary', isSidechain: true, content: 'Conversation compacted', isMeta: false, compactMetadata: { trigger: 'auto' } },
    { type: 'user', isSidechain: true, isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. The task: fix the build.' } },
    { type: 'user', isSidechain: true, isMeta: true, message: { role: 'user', content: '<system-reminder>\n<tools-used-before-summary>\nBash\n</tools-used-before-summary>\n</system-reminder>' } },
  ],
  interrupted: (toolId: string) => [
    { type: 'user', isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: "The user doesn't want to proceed with this tool use. The tool use was rejected.", is_error: true }] } },
    { type: 'user', isSidechain: true, rowSource: 'harness', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
  ],
}
/** `data`: the structured result Claude Code sends beside the text (tool_use_result). */
const toolResult = (id: string, content: unknown, isError = false, parent?: string, data?: unknown) => {
  out({ type: 'user', ...(parent ? { parent_tool_use_id: parent } : {}), message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, ...(data ? { tool_use_result: data } : {}) })
  // Claude's next step: the messages that came meanwhile reach it now.
  if (!parent) echoJoined()
}
const VERSION = '9.9.9-fake'
const init = () =>
  out({
    type: 'system', subtype: 'init', session_id: sessionId, model: MODEL, cwd: process.cwd(), tools: [], slash_commands: ['compact', 'cost'], permissionMode: 'default',
    claude_code_version: VERSION, apiKeySource: 'none', output_style: 'default',
    mcp_servers: [{ name: 'fake-docs', status: 'connected' }, { name: 'fake-mail', status: 'needs-auth' }],
  })
/** The answer to the app's initialize request, as a real Claude Code gives it (the parts the app reads). */
const hello = {
  commands: [
    { name: 'compact', description: 'Clear conversation history but keep a summary in context', argumentHint: '<optional custom summarization instructions>' },
    { name: 'cost', description: 'Show the total cost and duration of the current session', argumentHint: '' },
    { name: 'clear', description: 'Clear conversation history and free up context', argumentHint: '' },
  ],
  account: { email: 'you@example.com', subscriptionType: 'Claude Max', apiProvider: 'firstParty' },
  claude_code_version: VERSION,
  output_style: 'default',
  models: [{ value: 'default', resolvedModel: MODEL, displayName: 'Default', description: 'Fake 1.0 · for tests' }],
}
const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5)
const result = (extra: Record<string, unknown> = {}) => {
  echoJoined()
  out({ type: 'result', subtype: 'success', is_error: false, result: '', usage, total_cost_usd: 0.0123, duration_ms: 1500, session_id: sessionId, modelUsage: { [MODEL]: { contextWindow: 200_000 } }, ...extra })
}

let previous = ''
/** Every message's topic so far, oldest first. */
const topics: string[] = []
const textOf = new Map<string, string>()
/** Messages that arrived while a turn ran: Claude Code folds them into it, and the answer covers them. */
let joined: Msg[] = []
let busy = false
/** Claude is writing its last words (no more tool rounds): a message now waits for a turn of its own. */
let late = false
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
  // A reply drafted only in thinking: the tag settles the message, but no text for it arrives.
  if (t.includes('think it only')) {
    say(tag([{ id: m.topic, status: 'done' }]))
    return result()
  }
  // The app asking again for replies that never arrived: each written now.
  if (t.includes('never reached the app')) {
    // "lose my reply" stays lost: its reply goes astray again.
    const ids = (m.text.match(/T\d+/g) ?? []).filter(id => !textOf.get(id)?.includes('lose my reply'))
    if (!ids.length) {
      say(`<<reply T999>>\nThis names the wrong message again.\n${tag([])}`)
      return result()
    }
    say(`${ids.map(id => `<<reply ${id}>>\nHere is the reply to ${id} again.`).join('\n\n')}\n${tag(ids.map(id => ({ id, status: 'done' })))}`)
    return result()
  }
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
  // The last tool round is over, Claude is writing its answer: a message sent now isn't folded into
  // this turn. Claude Code runs it as a turn of its own after this one (echoed when it starts).
  if (t.includes('wrap up late')) {
    tool('wrap-1', 'Bash', { command: 'make', description: 'Build it' })
    toolResult('wrap-1', 'ok')
    late = true
    await release('wrap')
    late = false
    return finish(m, 'Wrapped up the build.')
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
    // "later": the card comes once the test writes release-ask.
    if (t.includes('later')) while (!existsSync(`${dir}/release-ask`)) await sleep(40)
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
  // Claude thinks a while, then starts an agent: a message sent meanwhile isn't Claude's yet (not
  // echoed), so the agent isn't working for it.
  if (t.includes('delegate after a wait')) {
    await release('delegate', 20_000)
    tool('dl-1', 'Agent', { description: 'Delegated job', subagent_type: 'general-purpose', prompt: 'Do it.', run_in_background: true })
    toolResult('dl-1', 'Async agent launched successfully. agentId: dl-9')
    return finish(m, 'Delegated it.', 'claude')
  }
  // A helper agent that runs and finishes in the turn; then another message of yours. On
  // release-nudge Claude, in a turn of its own (no message of yours), sends the helper more to do.
  if (t.startsWith('start helper one')) {
    tool('hp-1', 'Agent', { description: 'Helper one', subagent_type: 'general-purpose', prompt: 'Help.' })
    toolResult('hp-1', 'Helped. agentId: helper-one')
    return finish(m, 'Helper one finished.', 'claude')
  }
  if (t.startsWith('meanwhile, an unrelated note')) {
    finish(m, 'Noted.', 'done')
    if (!(await release('nudge', 20_000))) return
    tool('nudge-1', 'SendMessage', { to: 'helper-one', message: 'One more thing for you.' })
    toolResult('nudge-1', 'Message sent to helper-one.')
    say('Sent helper one more to do.')
    return result()
  }
  // A background agent for this message; the next message runs a quick background command of its own.
  // On release-wj-end the agent ends and Claude, in a turn of its own, writes about it without a
  // <<reply>> line, then a part with one for the quick command's message.
  if (t.startsWith('start a watched job')) {
    tool('wj-1', 'Agent', { description: 'Watched job', subagent_type: 'general-purpose', prompt: 'Watch the job.', run_in_background: true })
    toolResult('wj-1', 'Async agent launched successfully. agentId: wj-7')
    return finish(m, 'Started the watched job.', 'claude')
  }
  if (t.startsWith('meanwhile, a quick command')) {
    const watched = topics.at(-1)!
    tool('qc-1', 'Bash', { command: 'true', description: 'Quick check', run_in_background: true })
    toolResult('qc-1', 'Command running in background with ID: bqc1. Output is being written to: /tmp/bqc1.output.', false, undefined, { backgroundTaskId: 'bqc1' })
    out({ type: 'system', subtype: 'task_notification', task_id: 'bqc1', tool_use_id: 'qc-1', status: 'completed', summary: 'Background command "Quick check" completed (exit code 0)' })
    // Claude is told of its end with its next step's result.
    tool('qc-2', 'Read', { file_path: `${cwd}/README.md` })
    toolResult('qc-2', '# Readme')
    finish(m, 'Ran the quick check.')
    if (!(await release('wj-end', 20_000))) return
    out({ type: 'system', subtype: 'task_notification', task_id: 'wj-7', tool_use_id: 'wj-1', status: 'completed', summary: 'Watched job finished' })
    say(`The watched job is done.\n\n<<reply ${m.topic}>>\nThe quick check passed too.\n${tag([{ id: watched, status: 'done' }])}`)
    return result()
  }
  // A background shell command, as Claude Code runs one: the Bash call, its task_started, the result
  // naming its id and output file; output appended on release-bsh-more; on release-bsh-end its last
  // line, task_updated and task_notification, and Claude's follow-up in a turn of its own.
  // A reply streamed while a message you sent meanwhile is taken in (its echo comes mid-stream), whose
  // whole text block Claude Code then drops before the next tool call: only the deltas carry it.
  if (t.includes('block dropped mid-echo')) {
    tool('ds-1', 'Bash', { command: 'make', description: 'Make it' })
    await release('ds', 20_000)
    // The echo of the message sent meanwhile: held back until the reply has begun streaming.
    const held = unechoed
    unechoed = []
    toolResult('ds-1', 'ok')
    const delta = (text: string) => out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
    delta(`<<reply ${previous}>>\nThat earlier one `)
    await sleep(80)
    unechoed = held
    echoJoined()
    await sleep(80)
    delta(`needs your pick: red or blue?\n${tag([{ id: previous, status: 'me' }])}`)
    await sleep(80)
    tool('ds-2', 'Read', { file_path: `${cwd}/README.md` })
    toolResult('ds-2', '# Readme')
    return finish(m, `<<reply ${m.topic}>>\nMade it.`)
  }
  // Every kind of turn Claude starts by itself, streamed and also written to the session file as
  // Claude Code writes it, so a test can resume and compare: an end told mid-turn (with a tool
  // result: no turn of its own), one that came after the last tool result (its own turn once this one
  // ends), an agent's and a command's ends told at once while idle, that agent continued and ending
  // again with nothing new to say (a turn with no text), then again with two parts and their tags,
  // and a scheduled job firing.
  if (t.includes('follow-up kinds')) {
    mkdirSync(dirname(sessionFile(sessionId)), { recursive: true })
    const rec = (o: Record<string, unknown>) => appendFileSync(sessionFile(sessionId), JSON.stringify({ sessionId, isSidechain: false, timestamp: new Date().toISOString(), ...o }) + '\n')
    const recUser = (content: unknown, extra: Record<string, unknown> = {}) => rec({ type: 'user', message: { role: 'user', content }, ...extra })
    const recSaid = (content: unknown[], stop: string) => rec({ type: 'assistant', message: { role: 'assistant', content, stop_reason: stop } })
    const notice = (task: string, toolUse: string, summary: string) => `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>${toolUse}</tool-use-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`
    const ended = (task: string, toolUse: string, summary: string) => out({ type: 'system', subtype: 'task_notification', task_id: task, tool_use_id: toolUse, status: 'completed', summary })
    const call = (id: string, name: string, input: Record<string, unknown>, text: string, data?: unknown) => {
      tool(id, name, input)
      recSaid([{ type: 'tool_use', id, name, input }], 'tool_use')
      toolResult(id, text, false, undefined, data)
      recUser([{ type: 'tool_result', tool_use_id: id, content: text }])
    }
    const words = (text: string) => {
      say(text)
      recSaid([{ type: 'text', text }], 'end_turn')
    }
    recUser(m.raw.message.content)
    call('fk-a', 'Agent', { description: 'Helper', subagent_type: 'general-purpose', prompt: 'Help.', run_in_background: true }, 'Async agent launched successfully.\nagentId: afk1')
    out({ type: 'system', subtype: 'task_started', task_id: 'afk1', tool_use_id: 'fk-a', description: 'Helper', task_type: 'local_agent', is_backgrounded: true })
    for (const n of [1, 2, 3]) {
      tool(`fk-s${n}`, 'Bash', { command: `step ${n}`, description: `Step ${n}`, run_in_background: true })
      recSaid([{ type: 'tool_use', id: `fk-s${n}`, name: 'Bash', input: { command: `step ${n}`, description: `Step ${n}`, run_in_background: true } }], 'tool_use')
      out({ type: 'system', subtype: 'task_started', task_id: `bfk${n}`, tool_use_id: `fk-s${n}`, description: `Step ${n}`, task_type: 'local_bash', is_backgrounded: true })
      const started = `Command running in background with ID: bfk${n}. Output is being written to: /tmp/bfk${n}.output.`
      toolResult(`fk-s${n}`, started, false, undefined, { backgroundTaskId: `bfk${n}` })
      recUser([{ type: 'tool_result', tool_use_id: `fk-s${n}`, content: started }])
    }
    // Step 1 ends mid-turn: told with the next tool result.
    ended('bfk1', 'fk-s1', 'Background command "Step 1" completed (exit code 0)')
    call('fk-r', 'Read', { file_path: `${cwd}/README.md` }, '# Readme')
    rec({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: notice('bfk1', 'fk-s1', 'Background command "Step 1" completed (exit code 0)') } })
    // Step 2 ends after the last tool result: told once this turn ends, in a turn of its own.
    ended('bfk2', 'fk-s2', 'Background command "Step 2" completed (exit code 0)')
    words(`<<reply ${m.topic}>>\nStarted the work.\n${tag([{ id: m.topic, status: 'claude' }])}`)
    result()
    await sleep(150)
    recUser(notice('bfk2', 'fk-s2', 'Background command "Step 2" completed (exit code 0)'))
    words(`<<reply ${m.topic}>>\nStep 2 finished.\n${tag([{ id: m.topic, status: 'claude' }])}`)
    result()
    await sleep(150)
    // The agent and step 3 end while Claude is idle: one notification tells both.
    ended('afk1', 'fk-a', 'Helper finished')
    ended('bfk3', 'fk-s3', 'Background command "Step 3" completed (exit code 0)')
    recUser(`${notice('afk1', 'fk-a', 'Helper finished')}\n${notice('bfk3', 'fk-s3', 'Background command "Step 3" completed (exit code 0)')}`)
    words(`<<reply ${m.topic}>>\nThe helper and step 3 are done.\n${tag([{ id: m.topic, status: 'claude' }])}`)
    result()
    await sleep(150)
    // Continued, the agent ends again: nothing new, so no text at all.
    ended('afk1', 'fk-a', 'Helper finished again')
    recUser(notice('afk1', 'fk-a', 'Helper finished again'))
    recSaid([{ type: 'thinking', thinking: '' }], 'end_turn')
    result()
    await sleep(150)
    // And again: two parts, each with its own tag; the second settles the message before this one.
    ended('afk1', 'fk-a', 'Helper finished a third time')
    recUser(notice('afk1', 'fk-a', 'Helper finished a third time'))
    words(`<<reply ${m.topic}>>\nThe helper's third run is in.\n${tag([{ id: m.topic, status: 'claude' }])}\n\n<<reply ${previous}>>\nWhich name do you want?\n${tag([{ id: previous, status: 'me' }])}`)
    result()
    await sleep(150)
    // A job fires, not near a minute's end (its turn is keyed by the minute, live and from the file).
    while (Date.now() % 60_000 > 55_000) await sleep(100)
    recUser('Check the build.', { isMeta: true, turnOrigin: 'scheduled' })
    out({ type: 'command_lifecycle', command_uuid: 'cmd-fk', state: 'started', wakeup_source: 'schedule_wakeup' })
    words(`<<reply ${m.topic}>>\nThe job ran.\n${tag([{ id: m.topic, status: 'done' }])}`)
    result()
    return
  }
  if (t.includes('start a background command')) {
    const file = `${dir}/tasks/bsh42.output`
    mkdirSync(dirname(file), { recursive: true })
    tool('bc-1', 'Bash', { command: 'npm test -- --slow', description: 'Run the slow tests', run_in_background: true })
    out({ type: 'system', subtype: 'task_started', task_id: 'bsh42', tool_use_id: 'bc-1', description: 'Run the slow tests', task_type: 'local_bash', is_backgrounded: true })
    writeFileSync(file, 'test 1 ok\n')
    toolResult('bc-1', `Command running in background with ID: bsh42. Output is being written to: ${file}. You will be notified when it completes. To check interim output, use Read on that file path.`, false, undefined, { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: 'bsh42' })
    finish(m, 'Started the slow tests in the background.', 'claude')
    if (!(await release('bsh-more', 20_000))) return
    appendFileSync(file, 'test 2 ok\nprogress 10%\rprogress 100%\n')
    if (!(await release('bsh-end', 20_000))) return
    appendFileSync(file, 'all 2 passed\n')
    out({ type: 'system', subtype: 'task_updated', task_id: 'bsh42', patch: { status: 'completed', end_time: Date.now() } })
    out({ type: 'system', subtype: 'task_notification', task_id: 'bsh42', tool_use_id: 'bc-1', description: 'Run the slow tests', status: 'completed', output_file: file, summary: 'Background command "Run the slow tests" completed (exit code 0)' })
    say(`<<reply ${m.topic}>>\nThe slow tests passed.\n${tag([{ id: m.topic, status: 'done' }])}`)
    return result()
  }
  // Background commands that end otherwise: one fails (exit 2), one with no description is stopped
  // (TaskStop), a foreground one runs past its timeout and is moved to the background, and one the
  // user refused never runs.
  if (t.includes('more commands')) {
    const file = (id: string) => `${dir}/tasks/${id}.output`
    mkdirSync(`${dir}/tasks`, { recursive: true })
    const started = (id: string) => `Command running in background with ID: ${id}. Output is being written to: ${file(id)}. You will be notified when it completes.`
    tool('bf-1', 'Bash', { command: 'make lint', description: 'Lint everything', run_in_background: true })
    writeFileSync(file('bfail1'), 'lint: 3 errors\n')
    toolResult('bf-1', started('bfail1'), false, undefined, { backgroundTaskId: 'bfail1' })
    tool('bs-1', 'Bash', { command: 'npm run dev', run_in_background: true })
    writeFileSync(file('bstop2'), 'listening on 3000\n')
    toolResult('bs-1', started('bstop2'))
    tool('bm-1', 'Bash', { command: 'sleep 999', description: 'Wait a long time' })
    toolResult('bm-1', `Command did not complete within its 120s timeout and was moved to the background (ID: bmove3). Output is being written to: ${file('bmove3')}. You will be notified when it completes.`)
    tool('be-1', 'Bash', { command: 'rm -rf build', description: 'Clean the build', run_in_background: true })
    toolResult('be-1', 'The user refused this.', true)
    out({ type: 'system', subtype: 'task_notification', task_id: 'bfail1', tool_use_id: 'bf-1', status: 'failed', output_file: file('bfail1'), summary: 'Background command "Lint everything" failed with exit code 2' })
    tool('ts-1', 'TaskStop', { task_id: 'bstop2' })
    toolResult('ts-1', JSON.stringify({ message: 'Successfully stopped task: bstop2 (npm run dev)', task_id: 'bstop2', task_type: 'local_bash' }))
    return finish(m, 'The lint failed, and I stopped the dev server.')
  }
  // An agent's own background command (its step, streamed with the agent's id) that fails, then the agent ends.
  if (t.includes('agent runs a command')) {
    const file = `${dir}/tasks/bagent9.output`
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'build broke\n')
    tool('ar-1', 'Agent', { description: 'Build helper', subagent_type: 'general-purpose', prompt: 'Build the app.' })
    out({ type: 'system', subtype: 'task_started', task_id: 'ar-task', tool_use_id: 'ar-1', description: 'Build helper' })
    tool('ar-b1', 'Bash', { command: 'make build', description: 'Build the app', run_in_background: true }, 'ar-1')
    toolResult('ar-b1', `Command running in background with ID: bagent9. Output is being written to: ${file}. You will be notified when it completes.`, false, 'ar-1', { backgroundTaskId: 'bagent9' })
    out({ type: 'system', subtype: 'task_notification', task_id: 'bagent9', tool_use_id: 'ar-b1', status: 'failed', output_file: file, summary: 'Background command "Build the app" failed with exit code 1' })
    toolResult('ar-1', 'The build failed.')
    return finish(m, 'The build helper says the build failed.')
  }
  // A background agent's own background commands, as Claude Code 2.1 shows them: each one's
  // task_started (owned by the agent, its parent), but the end of the first reaches only the agent,
  // written in its transcript as a mid-turn attachment. The second it leaves running when it ends:
  // Claude Code still lists it as live.
  if (t.includes('agent waits on ci')) {
    tool('aw-1', 'Agent', { description: 'Merge helper', subagent_type: 'general-purpose', prompt: 'Merge it after CI.', run_in_background: true })
    out({ type: 'system', subtype: 'task_started', task_id: 'aw-3', tool_use_id: 'aw-1', description: 'Merge helper', task_type: 'local_agent', is_backgrounded: true })
    toolResult('aw-1', 'Async agent launched successfully. agentId: aw-3')
    finish(m, 'Started the merge helper.', 'claude')
    const file = `${process.env.HOME}/.claude/projects/${process.cwd().replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}/subagents/agent-aw-3.jsonl`
    mkdirSync(dirname(file), { recursive: true })
    const line = (o: unknown) => appendFileSync(file, JSON.stringify(o) + '\n')
    const output = (id: string) => `${dir}/tasks/${id}.output`
    mkdirSync(`${dir}/tasks`, { recursive: true })
    line({ type: 'user', isSidechain: true, message: { content: 'Merge it after CI.' } })
    for (const [id, task, command, description] of [['aw-b1', 'bci1', 'gh pr checks 7 --watch', 'Wait for CI'], ['aw-b2', 'bsrv2', 'npm run serve', 'Serve the docs']] as const) {
      writeFileSync(output(task), '')
      line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description, run_in_background: true } }] } })
      out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'aw-3', task_type: 'local_agent', description: 'Merge helper' }, { task_id: 'bci1', task_type: 'local_bash', description: 'Wait for CI', parent_task_id: 'aw-3' }, ...(task === 'bsrv2' ? [{ task_id: 'bsrv2', task_type: 'local_bash', description: 'Serve the docs', parent_task_id: 'aw-3' }] : [])] })
      out({ type: 'system', subtype: 'task_started', task_id: task, tool_use_id: id, description, task_type: 'local_bash', is_backgrounded: true, owned_by_subagent: true, parent_task_id: 'aw-3' })
      line({ type: 'user', isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${task}. Output is being written to: ${output(task)}. You will be notified when it completes.` }] } })
    }
    // The agent ends (its own end is streamed), and leaves both running.
    await release('aw-agent', 20_000)
    line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'Waiting on CI.' }] } })
    out({ type: 'system', subtype: 'task_notification', task_id: 'aw-3', tool_use_id: 'aw-1', status: 'completed', summary: 'Waiting on CI.' })
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bci1', task_type: 'local_bash', description: 'Wait for CI', parent_task_id: 'aw-3' }, { task_id: 'bsrv2', task_type: 'local_bash', description: 'Serve the docs', parent_task_id: 'aw-3' }] })
    // CI is green: only the agent's transcript says so.
    await release('aw-ci', 20_000)
    appendFileSync(output('bci1'), 'All checks were successful\n\n[exited with code 0]\n')
    line({ type: 'attachment', isSidechain: true, attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: `<task-notification>\n<task-id>bci1</task-id>\n<tool-use-id>aw-b1</tool-use-id>\n<output-file>${output('bci1')}</output-file>\n<status>completed</status>\n<summary>Background command "Wait for CI" completed (exit code 0)</summary>\n</task-notification>` } })
    return
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
  // A background agent that ends on release-bg-end; Claude follows up on release-gap, a moment later
  // (as Claude Code hands the result to Claude in a turn of its own).
  if (t.includes('hand back')) {
    tool('hb-1', 'Agent', { description: 'Short job', subagent_type: 'general-purpose', prompt: 'Do the short job.', run_in_background: true })
    toolResult('hb-1', 'Async agent launched successfully. agentId: hb-7')
    finish(m, 'Started it in the background.', 'claude')
    const file = `${process.env.HOME}/.claude/projects/${process.cwd().replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}/subagents/agent-hb-7.jsonl`
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'Do the short job.' } }) + '\n')
    await release('bg-end', 20_000)
    out({ type: 'system', subtype: 'task_notification', task_id: 'hb-7', status: 'completed', summary: 'Short job finished' })
    if (!(await release('gap', 20_000))) return
    say(`<<reply ${m.topic}>>\nThe short job is done.\n${tag([{ id: m.topic, status: 'done' }])}`)
    return result()
  }
  // A background agent that runs a long tool (its result comes on release-tool), then goes quiet;
  // asked to check on it, Claude says so.
  if (t.includes('quiet agent')) {
    const file = `${process.env.HOME}/.claude/projects/${process.cwd().replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}/subagents/agent-qa-9.jsonl`
    mkdirSync(dirname(file), { recursive: true })
    const line = (o: unknown) => appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), ...(o as object) }) + '\n')
    tool('qa-1', 'Agent', { description: 'Run the evals', subagent_type: 'general-purpose', prompt: 'Run the evals.', run_in_background: true })
    toolResult('qa-1', 'Async agent launched successfully. agentId: qa-9')
    line({ type: 'user', isSidechain: true, message: { content: 'Run the evals.' } })
    line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', id: 'qa-s1', name: 'Bash', input: { command: 'npm run eval', description: 'Run the evals' } }] } })
    finish(m, 'Started the evals in the background.', 'claude')
    await release('tool', 20_000)
    line({ type: 'user', isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: 'qa-s1', content: 'evals done' }] } })
    return
  }
  if (t.includes('gone quiet')) return finish(m, 'I will check on it.')
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
    // Before its to-do list: stopped mid-step ("interrupted" in your message), else a compaction.
    if (t.includes('interrupted')) {
      line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', id: 'at-s0', name: 'Bash', input: { command: 'rm -rf build', description: 'Clean the build' } }] } })
      for (const l of agentLines.interrupted('at-s0')) line(l)
    } else for (const l of agentLines.compaction()) line(l)
    step('at-s1', 'TodoWrite', todo('pending'), 'Todos have been modified successfully.')
    tool('sm-1', 'SendMessage', { to: 'at-77', summary: 'Also run the linter', message: 'Also run the linter and fix what it finds.' })
    toolResult('sm-1', 'Message queued for delivery to at-77 at its next tool round.')
    finish(m, 'Started it and sent it more work.', 'claude')
    await release('task2')
    line(agentLines.sent('Also run the linter and fix what it finds.'))
    step('at-s2', 'Bash', { command: 'npm run lint', description: 'Run the linter' }, 'lint ok')
    step('at-s3', 'TodoWrite', todo('in_progress'), 'Todos have been modified successfully.')
    await release('done1')
    out({ type: 'system', subtype: 'task_notification', task_id: 'at-77', status: 'completed', summary: 'Build fixed, lint clean' })
    tool('sm-2', 'SendMessage', { to: 'at-77', message: 'Now write the release notes for this fix, as a short list.' })
    toolResult('sm-2', 'Agent at-77 was stopped; resumed it in the background with your message.')
    line(agentLines.sent('Now write the release notes for this fix, as a short list.'))
    step('at-s4', 'Write', { file_path: `${cwd}/NOTES.md`, content: '- fixed the build' }, 'ok')
    say('Sent it one more task.')
    result()
    await release('done2')
    out({ type: 'system', subtype: 'task_notification', task_id: 'at-77', status: 'completed', summary: 'Release notes written' })
    say(`<<reply ${m.topic}>>\nAll three tasks are done.\n${tag([{ id: m.topic, status: 'done' }])}`)
    return result()
  }
  // A fork (subagent_type "fork"): its transcript starts as Claude Code writes a fork's, with a
  // reference to Claude's context and Claude's own Agent call (its prompt is in that call's result),
  // not with a first message. Claude sends it more (queued); it arrives on release-fork-msg.
  if (t.includes('fork agent')) {
    const file = `${process.env.HOME}/.claude/projects/${process.cwd().replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}/subagents/agent-fk-5.jsonl`
    mkdirSync(dirname(file), { recursive: true })
    const line = (o: unknown) => appendFileSync(file, JSON.stringify(o) + '\n')
    const input = { description: 'Check the docs', subagent_type: 'fork', prompt: 'Check the docs for the flag.', run_in_background: true }
    tool('fk-1', 'Agent', input)
    toolResult('fk-1', 'Async agent launched successfully.\nagentId: fk-5 (Use SendMessage with to: \'fk-5\' to continue this agent.)')
    line({ type: 'fork-context-ref', agentId: 'fk-5', parentSessionId: sessionId, contextLength: 12 })
    line({ type: 'assistant', parentUuid: null, isSidechain: true, message: { content: [{ type: 'tool_use', id: 'fk-1', name: 'Agent', input }] } })
    line({ type: 'user', isSidechain: true, message: { content: [
      { type: 'tool_result', tool_use_id: 'fk-1', content: [{ type: 'text', text: 'Fork started — that fork is you.' }] },
      { type: 'text', text: '<fork-boilerplate>\nYou are a worker fork. Execute one directive, then stop.\n</fork-boilerplate>\n\nCheck the docs for the flag.' },
    ] } })
    line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'Reading the docs.' }, { type: 'tool_use', id: 'fk-s1', name: 'Read', input: { file_path: `${cwd}/README.md` } }] } })
    line({ type: 'user', isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: 'fk-s1', content: 'the docs' }] } })
    tool('fk-sm', 'SendMessage', { to: 'fk-5', summary: 'Also check the changelog', message: 'Also check the changelog.' })
    toolResult('fk-sm', 'Message queued for delivery to fk-5 at its next tool round.')
    finish(m, 'Started a fork and sent it more.', 'claude')
    await release('fork-msg')
    line(agentLines.sent('Also check the changelog.'))
    line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', id: 'fk-s2', name: 'Read', input: { file_path: `${cwd}/CHANGELOG.md` } }] } })
    return
  }
  // Claude says it will do it later (its tag says it still owes work), and nothing works on it; on
  // release-later it goes on by itself with an agent for it.
  // Asked to continue an agent an exit stopped: SendMessage resumes it, as Claude Code does.
  const cont = m.text.match(/^Continue .*? \(agent ([\w-]+)\): it was stopped/)
  if (cont) {
    tool('cont-1', 'SendMessage', { to: cont[1], message: 'Go on from where you stopped.' })
    toolResult('cont-1', `Agent ${cont[1]} was stopped; resumed it in the background with your message.`)
    return finish(m, `Resumed ${cont[1]}.`, 'claude')
  }
  // Asked to start on a request now: Claude works on it until release-started.
  if (/^please start on \S+ now\./.test(t)) {
    await release('started', 20_000)
    return finish(m, 'Started on it.', 'claude')
  }
  if (t.includes('do it later')) {
    finish(m, "OK, I'll get to it after the current work.", 'claude')
    // Idle after that turn: the next message is taken in at once while this one waits to go on.
    void (async () => {
      if (!(await release('later'))) return
      tool('lt-1', 'Agent', { description: 'Do the later work', subagent_type: 'general-purpose', prompt: 'Do the work.' })
      await release('later-agent')
      toolResult('lt-1', 'Did the work.')
      say(`<<reply ${m.topic}>>\nThe later work is done.\n${tag([{ id: m.topic, status: 'done' }])}`)
      result()
    })()
    return
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
  // The last text is a reply part with its tag, and the result repeats it (as Claude Code's does).
  if (t.includes('end on a part')) {
    const text = `<<reply ${m.topic}>>\nThe only part.\n${tag([{ id: m.topic, status: 'done' }])}`
    say(text)
    return result({ result: text })
  }
  // A reply part finished while a message waits in queue, and a while before the next step.
  if (t.includes('part then pause')) {
    tool('pause-1', 'Bash', { command: 'true', description: 'First step' })
    toolResult('pause-1', '')
    await release('part')
    say(`<<reply ${m.topic}>>\nThe part written before the pause.\n${tag([{ id: m.topic, status: 'done' }])}`)
    await release('pause')
    tool('pause-2', 'Bash', { command: 'true', description: 'Next step' })
    toolResult('pause-2', '')
    return finish(m, 'Finished after the pause.')
  }
  // Two held steps: a message sent during the first is taken in (echoed) at its end, while the second runs.
  if (t.includes('two steps')) {
    tool('two-1', 'Bash', { command: 'sleep 1', description: 'First step' })
    await release('step1')
    toolResult('two-1', 'ok')
    tool('two-2', 'Bash', { command: 'sleep 2', description: 'Second step' })
    await release('step2')
    toolResult('two-2', 'ok')
    return finish(m, 'Both steps are done.')
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
  // Claude Code compacts the conversation (as /compact or an automatic one does), then answers.
  if (t.includes('compact now')) {
    out({ type: 'system', subtype: 'status', status: 'compacting' })
    out({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 100000 } })
    return finish(m, 'Compacted.')
  }
  // The tag settles the message, but the only reply names another id: the app shows it as lost.
  if (t.includes('lose my reply')) {
    say(`<<reply T999>>\nThis names the wrong message.\n${tag([{ id: m.topic, status: 'done' }])}`)
    return result()
  }
  // An image in a reply ($FAKE_DIR/chart.png, a test writes it), a remote one, and a Mermaid diagram.
  if (t.includes('show me a chart'))
    return finish(m, `Here is the chart.\n\n![sales by month](${dir}/chart.png)\n\nA remote one stays a link: ![logo](https://example.com/logo.png)`)
  if (t.includes('draw a diagram')) return finish(m, ['The flow:', '', '```mermaid', 'graph TD', '  A --> B', '```', '', 'That is it.'].join('\n'))
  // Arabic in, Arabic out: a reply in Arabic, with English words, inline code and a number in it.
  if (t.includes('بالعربية'))
    return finish(m, ['أهلاً بك! هذا رد بالعربية.', '', 'شغّل `npm test` ثم افتح app/main.ts في 3 دقائق.'].join('\n'))
  return finish(m, `Echo: ${m.text}`)
}

async function run() {
  if (busy) return
  busy = true
  while (queue.length) {
    const m = queue.shift()!
    echo(m)
    await scenario(m)
    if (!m.text.toLowerCase().includes('please split')) previous = m.topic
    topics.push(m.topic)
    textOf.set(m.topic, m.text)
  }
  busy = false
}

/**
 * A side question's answer: what it can see (the resumed session's messages, read from its file as
 * Claude Code would), streamed, then said. "slowly" waits for release-btw; "fail" exits without one.
 */
async function sideAnswer(m: Msg) {
  if (m.text.includes('fail')) {
    process.stderr.write('Side question failed on purpose\n')
    process.exit(3)
  }
  if (m.text.includes('slowly')) await release('btw')
  const file = `${process.env.HOME}/.claude/projects/${process.cwd().replace(/[^a-zA-Z0-9]/g, '-')}/${resumed}.jsonl`
  const seen = resumed && existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(l => l.includes('"type":"user"')).length : 0
  const text = resumed ? `Side answer to “${m.text}”: I can see ${seen} messages of ${resumed}.` : `Side answer to “${m.text}”: there is no conversation yet.`
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Side answer ' } } })
  await sleep(60)
  // The app's own markup, which a side answer must not show.
  say(`${text}\n<clued>{"topics":[]}</clued>`)
  result({ result: text })
}

// The tag in "about earlier" names the previous topic, so the app links the two.
const aboutTag = (m: Msg) => (m.text.toLowerCase().includes('about earlier') && previous ? previous : undefined)

// A real Claude Code says init with the first message; the fake says it at once, unless FAKE_LATE_INIT=1.
let isInit = !process.env.FAKE_LATE_INIT
if (isInit) init()

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
    // As /reload-plugins does; FAKE_RELOAD_BUSY=1 plays one refused mid-turn. Each enabled plugin brings a command.
    if (e.request?.subtype === 'reload_plugins') {
      const on = (existsSync(`${dir}/plugins.json`) ? JSON.parse(readFileSync(`${dir}/plugins.json`, 'utf8')) : []).filter((p: any) => p.enabled)
      out({ type: 'control_response', response: process.env.FAKE_RELOAD_BUSY || busy ? { subtype: 'error', request_id: e.request_id, error: 'Cannot reload plugins while a turn is running' } : { subtype: 'success', request_id: e.request_id, response: { commands: [...hello.commands, ...on.map((p: any) => ({ name: p.id.split('@')[0], description: `From the ${p.id} plugin` }))], plugins: on, mcpServers: [], error_count: 0 } } })
    }
    if (e.request?.subtype === 'initialize') out({ type: 'control_response', response: { subtype: 'success', request_id: e.request_id, response: hello } })
    // Taking back a message not taken in yet (as a real Claude Code does): it leaves the queue unread.
    // FAKE_NO_CANCEL=1 plays a Claude Code that can't.
    if (e.request?.subtype === 'cancel_async_message') {
      const uuid = e.request.message_uuid
      const isQueued = (m: Msg) => m.raw?.uuid === uuid
      const can = !process.env.FAKE_NO_CANCEL && (unechoed.some(isQueued) || queue.some(isQueued))
      if (can) {
        unechoed = unechoed.filter(m => !isQueued(m))
        joined = joined.filter(m => !isQueued(m))
        queue.splice(0, queue.length, ...queue.filter(m => !isQueued(m)))
      }
      out({ type: 'control_response', response: process.env.FAKE_NO_CANCEL ? { subtype: 'error', request_id: e.request_id, error: 'cancel_async_message is not supported' } : { subtype: 'success', request_id: e.request_id, response: can ? { cancelled: true, message_uuid: uuid } : { cancelled: false } } })
    }
    if (e.request?.subtype === 'set_permission_mode') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: e.request_id, response: { mode: e.request.mode } } })
      out({ type: 'system', subtype: 'status', status: null, permissionMode: e.request.mode })
    }
    return
  }
  if (e.type !== 'user') return
  if (!isInit) {
    isInit = true
    init()
  }
  if (isSide) {
    const c = e.message?.content
    const texts = (Array.isArray(c) ? c : [{ type: 'text', text: String(c) }]).filter((b: any) => b.type === 'text').map((b: any) => String(b.text))
    void sideAnswer({ text: texts[0] ?? '', topic: '', images: 0, raw: e })
    return
  }
  const c = e.message?.content
  const blocks: any[] = Array.isArray(c) ? c : [{ type: 'text', text: String(c) }]
  const texts = blocks.filter(b => b.type === 'text').map(b => String(b.text))
  const m: Msg = { text: texts[0] ?? '', topic: (texts.join('\n').match(/This message is topic (T\d+)/) ?? [])[1] ?? 'T0', images: blocks.filter(b => b.type === 'image').length, raw: e }
  const about = aboutTag(m)
  if (about) {
    echo(m)
    // Answered at once, with "about" in its tag.
    say(`Linked to your earlier message.\n${tag([{ id: m.topic, status: 'done', about }])}`)
    result()
    previous = m.topic
    return
  }
  if (busy && !late) {
    joined.push(m)
    unechoed.push(m)
  } else queue.push(m)
  void run()
})
