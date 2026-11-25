#!/usr/bin/env node
// Compares two ways of driving Claude Code on the same conversations:
//   A  threadline: claude -p stream-json + --append-system-prompt APP_GUIDE + a hidden [threadline] note per message
//   B  plain:      the same claude -p stream-json process, no appended prompt, no notes
// Each run gets a fresh copy of a fixture project in a temp dir; claude runs only there.
//
//   node --no-warnings eval/run.ts [--set baseline|hard|all] [--reps 5] [--concurrency 3] [--model sonnet]
//        [--budget 25] [--judge] [--scenarios id,id] [--arms A,B] [--out eval/results/NAME]
//   node --no-warnings eval/run.ts --rescore eval/results/NAME [--judge]
//
// See eval/README.md.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
// Frozen copies of hooks/model.ts and app/inbox.ts, and APP_GUIDE from app/main.ts (see frozen/SOURCES.txt).
import { emptyBoard, flatBrief, FLAT_GUIDE, keyOf, parseTag, raiseTopic, settleTurn, stripTag } from './frozen/model.ts'
import { hasMarks, preview, questionsOf, REPLY_GUIDE, splitAnswer, stripMarks } from './frozen/inbox.ts'
import { APP_GUIDE } from './frozen/guide.ts'
import type { Board } from '../types/index.d.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const FROZEN = Object.fromEntries(['model.ts', 'inbox.ts', 'guide.ts'].map(f => [f, sha(readFileSync(join(HERE, 'frozen', f), 'utf8'))]))

// ---- Options -----------------------------------------------------------------------

type Arm = 'A' | 'B'
type SetName = 'baseline' | 'hard'
type Opts = {
  rescore?: string; set: SetName | 'all'; reps: number; concurrency: number; seed: number
  model: string; budget: number; runCap: number; maxTurns: number; scenarios?: string[]; arms: Arm[]
  judge: boolean; out: string; keepTmp: boolean; quietMs: number; timeoutMs: number
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = { set: 'hard', reps: 1, concurrency: 1, seed: 1, model: 'sonnet', budget: 3, runCap: 1, maxTurns: 12, arms: ['A', 'B'], judge: false, out: '', keepTmp: false, quietMs: 6000, timeoutMs: 12 * 60 * 1000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const v = () => argv[++i] ?? ''
    if (a === '--model') o.model = v()
    else if (a === '--set') o.set = v() as Opts['set']
    else if (a === '--reps') o.reps = Number(v())
    else if (a === '--concurrency') o.concurrency = Number(v())
    else if (a === '--seed') o.seed = Number(v())
    else if (a === '--budget') o.budget = Number(v())
    else if (a === '--run-cap') o.runCap = Number(v())
    else if (a === '--max-turns') o.maxTurns = Number(v())
    else if (a === '--scenarios') o.scenarios = v().split(',').filter(Boolean)
    else if (a === '--arms') o.arms = v().split(',').filter((x): x is Arm => x === 'A' || x === 'B')
    else if (a === '--judge') o.judge = true
    else if (a === '--out') o.out = v()
    else if (a === '--keep-tmp') o.keepTmp = true
    else if (a === '--quiet-ms') o.quietMs = Number(v())
    else if (a === '--timeout-min') o.timeoutMs = Number(v()) * 60 * 1000
    else if (a === '--rescore') o.rescore = v()
    else throw new Error(`unknown option ${a}`)
  }
  if (!o.out && o.rescore) o.out = o.rescore
  if (!o.out) o.out = join(HERE, 'results', `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)
  return o
}

// ---- Scenarios -----------------------------------------------------------------------

/** A fact a reply must contain. `about`: words that name its subject, for telling in plain text which message a passage answers. */
type Expect = { name: string; re: string; about?: string }
/** `quote`: the message replies to an earlier one, as the app's ↩ does: Claude's reply to `of`, or the user's own message `of`. */
type Message = { id: string; send: 'start' | 'idle' | 'afterTool' | 'after'; delayMs?: number; text: string; about?: string; quote?: { who: 'me' | 'claude'; of: string }; expect: Expect[] }
/** A check on the project afterwards: a regex on a file, a command, or Python code run in the project. `msg`: the message it judges. */
type Check = { name: string; msg?: string; file?: string; re?: string; absent?: boolean; cmd?: string[]; py?: string }
type Scenario = { id: string; set: SetName; about: string; fixture: string; messages: Message[]; checks: Check[] }

function loadScenarios(): Scenario[] {
  const read = (file: string, set: SetName, fixture: string) =>
    (JSON.parse(readFileSync(join(HERE, file), 'utf8')).scenarios as Scenario[]).map(s => ({ ...s, set, fixture: s.fixture ?? fixture }))
  return [...read('scenarios-hard.json', 'hard', 'fixture-hard'), ...read('scenarios.json', 'baseline', 'fixture')]
}

// ---- One run ---------------------------------------------------------------------------

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
type Call = { id: string; t: number; sub: boolean; input: number; cacheRead: number; cacheCreate: number; output: number; context: number }
type Result = { t: number; text: string; isError: boolean; subtype: string; usage: Usage; costUsd: number; durationMs: number; durationApiMs: number; numTurns: number; contextWindow?: number; modelUsage: Record<string, unknown> }
/** `shown`: the message as B sends it and as the judge reads it (a quote as "> " lines, then the text). */
type Sent = { id: string; t: number; text: string; shown: string; note?: string; topicId?: string; quoted?: string; midTurn: boolean }
type TextBlock = { t: number; text: string; sub: boolean }
type Perm = { t: number; tool: string; allow: boolean; why?: string; input: string }

export type Run = {
  scenario: string; set: SetName; arm: Arm; rep: number; slot: number; model?: string; dir: string; startedAt: string
  wallMs: number; timedOut: boolean; exitCode: number | null; stderr: string
  sent: Sent[]; texts: TextBlock[]; tools: { t: number; name: string; sub: boolean }[]; calls: Call[]; results: Result[]; perms: Perm[]
  checks: { name: string; msg?: string; ok: boolean; detail?: string }[]
  board?: Board; costUsd: number
}

const NET = /\b(curl|wget|ssh|scp|rsync|nc|ncat|telnet|ftp|pip3?\s+install|npm\s+(i|install|publish)|npx|apt(-get)?|brew|git\s+(push|fetch|pull|clone))\b/

/** The permission policy (the same for both arms): file tools inside the project, Bash without network. */
function decide(dir: string, tool: string, input: Record<string, unknown>): { allow: boolean; why?: string } {
  const inside = (p: unknown) => {
    if (typeof p !== 'string') return true
    const abs = isAbsolute(p) ? p : resolve(dir, p)
    return abs === dir || abs.startsWith(dir + sep)
  }
  if (['WebFetch', 'WebSearch'].includes(tool)) return { allow: false, why: 'no network in the eval' }
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read'].includes(tool))
    return inside(input.file_path ?? input.notebook_path) ? { allow: true } : { allow: false, why: 'outside the project' }
  if (tool === 'Bash') return NET.test(String(input.command ?? '')) ? { allow: false, why: 'network command' } : { allow: true }
  return { allow: true }
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|AI_AGENT)/.test(k)) env[k] = v
  // As app/claude.ts does when started from a plain terminal.
  env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
  return env
}

/** Flags both arms share. User settings, plugins, hooks and MCP servers stay out: see the README. */
function baseArgs(o: Opts, cap: number) {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    // `host` alone never sends the host a can_use_tool request in 2.1.331: the SDK's stdio prompt tool and initialize do.
    '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio',
    '--model', o.model, '--max-turns', String(o.maxTurns), '--max-budget-usd', cap.toFixed(2),
    '--no-session-persistence', '--setting-sources', 'project,local',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disallowed-tools', 'WebFetch,WebSearch',
  ]
}

/** Claude Code's own folders for a project dir: ~/.claude/projects/<dir> (auto-memory) and <tmp>/claude-<uid>/<dir> (task output). */
function removeClaudeFolders(dir: string, prefix: string) {
  const name = dir.replace(/[^a-zA-Z0-9]/g, '-')
  if (!name.startsWith(`-tmp-${prefix}`)) return
  for (const p of [join(homedir(), '.claude', 'projects', name), join(tmpdir(), `claude-${process.getuid?.() ?? ''}`, name)])
    if (existsSync(p)) rmSync(p, { recursive: true, force: true })
}

const clip600 = (s: string) => (s.length > 600 ? `${s.slice(0, 600)}…` : s)
const asQuote = (s: string) => clip600(s).replace(/^/gm, '> ')
const paragraphs = (s: string) => s.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean)

/** What the user quotes when replying to Claude's answer to message `of`. A: the reply part (bubble) the app shows; B: the paragraphs of the answer with that message's facts. */
function quoteFor(run: Run, sc: Scenario, of: string): { text: string; topics?: string[] } {
  const target = run.sent.find(s => s.id === of)
  const ofMsg = sc.messages.find(m => m.id === of)
  if (!target || !ofMsg) return { text: '' }
  const finals = run.results.filter(r => r.t >= target.t)
  if (run.arm === 'A' && target.topicId) {
    const part = replyParts(run).parts.filter(p => p.to.includes(target.topicId!) && p.t >= target.t).at(-1)
    if (part) return { text: stripTag(part.text), topics: part.to }
  }
  const answer = stripMarks(stripTag(finals[0]?.text ?? ''))
  const hits = paragraphs(answer).filter(p => ofMsg.expect.some(e => new RegExp(e.re, 'i').test(p)))
  return { text: hits.length ? hits.join('\n\n') : answer }
}

async function runOne(sc: Scenario, arm: Arm, rep: number, slot: number, o: Opts, cap: number): Promise<Run> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tl-eval-')))
  cpSync(join(HERE, sc.fixture), dir, { recursive: true })
  const args = [...baseArgs(o, cap), ...(arm === 'A' ? ['--append-system-prompt', APP_GUIDE] : [])]
  const t0 = Date.now()
  const run: Run = { scenario: sc.id, set: sc.set, arm, rep, slot, dir, startedAt: new Date(t0).toISOString(), wallMs: 0, timedOut: false, exitCode: null, stderr: '', sent: [], texts: [], tools: [], calls: [], results: [], perms: [], checks: [], costUsd: 0 }
  const raw: string[] = []
  const proc = spawn('claude', args, { cwd: dir, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
  let lastEventAt = Date.now()
  let lastType = ''
  let exited = false
  const callsById = new Map<string, Call>()
  let board: Board = emptyBoard()
  let toolSinceSend = false

  const write = (obj: unknown) => proc.stdin.writable && proc.stdin.write(JSON.stringify(obj) + '\n')
  const addCall = (id: string, t: number, sub: boolean, u: Usage) => {
    const c: Call = { id, t, sub, input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheCreate: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0, context: 0 }
    c.context = c.input + c.cacheRead + c.cacheCreate
    callsById.set(id, c)
    run.calls.push(c)
  }

  const onEvent = (e: any) => {
    const t = Date.now() - t0
    lastEventAt = Date.now()
    if (!(e.type === 'stream_event' && e.event?.type === 'content_block_delta')) raw.push(JSON.stringify({ t, ...e }))
    const sub = !!e.parent_tool_use_id
    if (e.type !== 'stream_event' && e.type !== 'rate_limit_event') lastType = e.type
    switch (e.type) {
      case 'system':
        if (e.subtype === 'init') run.model = e.model
        return
      case 'stream_event': {
        const ev = e.event
        if (ev?.type === 'message_start') addCall(ev.message?.id ?? String(callsById.size), t, sub, ev.message?.usage ?? {})
        else if (ev?.type === 'message_delta' && ev.usage) {
          const c = run.calls.filter(x => x.sub === sub).at(-1)
          if (c && typeof ev.usage.output_tokens === 'number') c.output = ev.usage.output_tokens
        }
        return
      }
      case 'assistant': {
        for (const b of e.message?.content ?? []) {
          if (b.type === 'text' && b.text) run.texts.push({ t, text: b.text, sub })
          else if (b.type === 'tool_use') {
            run.tools.push({ t, name: b.name, sub })
            if (!sub) toolSinceSend = true
          }
        }
        // Calls without stream events (subagents): take usage from the message itself.
        const id = e.message?.id
        if (id && !callsById.has(id) && e.message?.usage) addCall(id, t, sub, e.message.usage)
        return
      }
      case 'result': {
        const sizes = Object.values(e.modelUsage ?? {}).map((u: any) => Number(u?.contextWindow) || 0).filter(n => n > 0)
        const r: Result = {
          t, text: typeof e.result === 'string' ? e.result : '', isError: !!e.is_error, subtype: String(e.subtype ?? ''),
          usage: e.usage ?? {}, costUsd: Number(e.total_cost_usd ?? 0), durationMs: Number(e.duration_ms ?? 0), durationApiMs: Number(e.duration_api_ms ?? 0),
          numTurns: Number(e.num_turns ?? 0), modelUsage: e.modelUsage ?? {}, ...(sizes.length ? { contextWindow: Math.max(...sizes) } : {}),
        }
        run.results.push(r)
        // As app/main.ts finishTurn(): the answer's tag settles the topics.
        if (arm === 'A' && r.text) board = settleTurn(board, r.text, Date.now(), { flat: true }).board
        return
      }
      case 'control_request': {
        if (e.request?.subtype === 'can_use_tool') {
          const input = e.request.input ?? {}
          const d = decide(dir, e.request.tool_name, input)
          run.perms.push({ t, tool: e.request.tool_name, allow: d.allow, ...(d.why ? { why: d.why } : {}), input: JSON.stringify(input).slice(0, 300) })
          write({ type: 'control_response', response: { subtype: 'success', request_id: e.request_id, response: d.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: `The eval harness denied this: ${d.why}.` } } })
        } else write({ type: 'control_response', response: { subtype: 'success', request_id: e.request_id, response: {} } })
        return
      }
    }
  }

  let buf = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      try {
        onEvent(JSON.parse(line))
      } catch {}
    }
  })
  proc.stderr.on('data', (c: Buffer) => (run.stderr = (run.stderr + c.toString()).slice(-4000)))
  const exit = new Promise<void>(res => proc.on('exit', code => { run.exitCode = code; exited = true; res() }))
  // As the Agent SDK does: tells Claude Code a host is here to answer permission prompts.
  write({ type: 'control_request', request_id: `init-${t0}`, request: { subtype: 'initialize', hooks: null } })

  const send = (m: Message) => {
    const now = Date.now()
    const midTurn = run.sent.length > 0 && lastType !== 'result'
    const q = m.quote ? (m.quote.who === 'me' ? { text: run.sent.find(s => s.id === m.quote!.of)?.text ?? '' } : quoteFor(run, sc, m.quote.of)) : undefined
    let note: string | undefined
    let topicId: string | undefined
    if (arm === 'A') {
      // As app/main.ts submit(): quoting a reply answers its question; else a plain answer to the one open question does.
      const quotedTopics = q?.topics ?? []
      const asked = board.topics.filter(t => t.status === 'me')
      const answered = new Set(quotedTopics.length ? quotedTopics : asked.length === 1 && !/\?\s*$/.test(m.text) ? [asked[0]!.id] : [])
      const guess = !quotedTopics.length ? { answerGuessed: true as const } : {}
      board = { ...board, topics: board.topics.map(t => (t.status === 'me' && answered.has(t.id) ? { ...t, status: 'claude' as const, updatedAt: now, ...guess } : t)) }
      const raised = raiseTopic(board, { text: m.text, key: keyOf(m.text), replyTo: null }, now)
      topicId = raised.topicId
      note = flatBrief(raised.board, raised.topicId, q ? [{ who: m.quote!.who, text: q.text, ...(q.topics ? { topics: q.topics } : {}) }] : [])
      const qs = questionsOf(m.text)
      if (qs.length) note = `${note}\nIt asks ${qs.length} things: ${qs.map((x, i) => `${raised.topicId}.${i + 1} "${preview(x, 80)}"`).join('; ')}.`
      board = raised.board
    }
    // B gets the same quote as prose: what a CLI user pastes above their reply.
    const shown = q ? `${asQuote(q.text)}\n\n${m.text}` : m.text
    const content = arm === 'A' ? (note ? [{ type: 'text', text: m.text }, { type: 'text', text: note }] : m.text) : shown
    write({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' })
    run.sent.push({ id: m.id, t: now - t0, text: m.text, shown, ...(note ? { note } : {}), ...(topicId ? { topicId } : {}), ...(q ? { quoted: q.text } : {}), midTurn })
    lastType = 'sent'
    lastEventAt = Date.now()
    toolSinceSend = false
  }

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  const deadline = t0 + o.timeoutMs
  const until = async (cond: () => boolean) => {
    while (!cond() && !exited && Date.now() < deadline) await sleep(100)
  }
  const idle = (quiet: number) => () => lastType === 'result' && Date.now() - lastEventAt >= quiet

  for (const m of sc.messages) {
    if (m.send === 'idle') await until(idle(1500))
    else if (m.send === 'afterTool') await until(() => toolSinceSend || lastType === 'result')
    if (m.delayMs) await sleep(m.delayMs)
    if (exited || Date.now() >= deadline) break
    send(m)
  }
  await until(idle(o.quietMs))
  run.timedOut = !exited && Date.now() >= deadline
  run.wallMs = Date.now() - t0
  proc.stdin.end()
  const killer = setTimeout(() => proc.kill('SIGTERM'), 3000)
  await exit
  clearTimeout(killer)

  // In stream-json mode total_cost_usd on a result is cumulative for the process; usage and num_turns are per turn (README).
  run.costUsd = Math.max(0, ...run.results.map(r => r.costUsd))
  if (arm === 'A') run.board = board

  for (const c of sc.checks) {
    const base = { name: c.name, ...(c.msg ? { msg: c.msg } : {}) }
    if (c.cmd || c.py) {
      const [cmd, ...rest] = c.py ? ['python3', '-c', c.py] : c.cmd!
      const r = spawnSync(cmd!, rest, { cwd: dir, encoding: 'utf8', timeout: 30000 })
      run.checks.push({ ...base, ok: r.status === 0, ...(r.status === 0 ? {} : { detail: (r.stderr || r.stdout || '').slice(-300) }) })
    } else if (c.file && c.re) {
      const p = join(dir, c.file)
      const text = existsSync(p) ? readFileSync(p, 'utf8') : ''
      const hit = new RegExp(c.re, 'im').test(text)
      run.checks.push({ ...base, ok: c.absent ? !hit : hit })
    }
  }
  mkdirSync(join(o.out, 'raw'), { recursive: true })
  writeFileSync(join(o.out, 'raw', `${sc.id}-${arm}-r${rep}.jsonl`), raw.join('\n') + '\n')
  if (!o.keepTmp && dir.startsWith(realpathSync(tmpdir()) + sep) && dir.includes('tl-eval-')) {
    rmSync(dir, { recursive: true, force: true })
    // Claude Code makes folders per project dir even without session files: an empty auto-memory one, and task output.
    removeClaudeFolders(dir, 'tl-eval-')
  }
  return run
}

// ---- Scoring ------------------------------------------------------------------------

/** Arm A's reply structure for a message: own part, a marked part naming several, unmarked text for several, someone else's part, or none. */
type Attribution = 'own' | 'grouped' | 'shared' | 'other' | 'missing'
export type MessageScore = {
  id: string
  topicId?: string
  midTurn: boolean
  /** Arm A: the turn answering this message replied with a reaction only (no text): the app shows it on the message. */
  reacted?: string
  /** Every expected fact is in some final answer after the message. */
  addressedFinal: boolean
  /** ... anywhere in Claude's text after the message, narration included. */
  addressedAny: boolean
  /**
   * Every fact is placed where a reader can tell it answers this message (both arms, plain text, marks removed):
   * the turn answered only this message, or the fact sits in a paragraph/bullet that also names its subject.
   */
  attributed: boolean
  facts: { name: string; final: boolean; any: boolean; attributed: boolean; attribution?: Attribution }[]
  attribution?: Attribution
  named?: boolean
  inTag?: boolean
  /** Checks on the project that belong to this message, all passing (undefined: none). */
  checksOk?: boolean
}
/** badTagIds: topic ids in a tag that no message has (Claude made one up, e.g. "T1-discount"). */
export type RunScore = { messages: MessageScore[]; marks: number; badMarks: string[]; badTagIds: string[]; tags: number; results: number; checksOk: number; checksTotal: number }

const worst = (xs: Attribution[]): Attribution => (['missing', 'other', 'shared', 'grouped', 'own'] as Attribution[]).find(a => xs.includes(a)) ?? 'missing'
const MARK = /^[ \t]*<<reply\s+([^>]*)>>[ \t]*$/gim

/** `marked`: the part starts at a <<reply>> mark (else it is unmarked text, replying to every message since the last answer). */
type ReplyPart = { to: string[]; text: string; subs?: string[]; t: number; marked: boolean }

/**
 * Arm A: the reply parts of every answer, as app/inbox.ts assignParts() splits them: unmarked text
 * replies to every message since the previous answer; marked text written mid-turn counts too (the
 * app keeps it as an early reply).
 */
function replyParts(run: Run): { parts: ReplyPart[]; marks: number; badMarks: string[]; markIds: Set<string> } {
  const main = run.texts.filter(x => !x.sub)
  const parts: ReplyPart[] = []
  let marks = 0
  const badMarks: string[] = []
  const known = new Set(run.sent.map(s => s.topicId).filter(Boolean) as string[])
  const markIds = new Set<string>()
  if (run.arm !== 'A') return { parts, marks, badMarks, markIds }
  let since: string[] = []
  let si = 0
  let prevT = -1
  for (const r of run.results) {
    while (si < run.sent.length && run.sent[si]!.t <= r.t) since.push(run.sent[si++]!.topicId!)
    const early = main.filter(x => x.t > prevT && x.t < r.t && hasMarks(x.text) && !r.text.includes(x.text.trim())).map(x => x.text)
    const full = [...early, r.text].filter(Boolean).join('\n\n')
    for (const m of full.matchAll(MARK)) {
      marks++
      for (const id of m[1]!.split(/[\s,]+/).filter(Boolean)) {
        const b = id.toUpperCase().split('.')[0]!
        markIds.add(b)
        if (!known.has(b)) badMarks.push(id)
      }
    }
    const body = stripTag(full)
    const first = body.search(/^[ \t]*<<reply\s+[^>]*>>[ \t]*$/im)
    const leadsUnmarked = first < 0 || body.slice(0, first).trim().length > 0
    splitAnswer(full, since.length ? since : run.sent.filter(s => s.t <= r.t).slice(-1).map(s => s.topicId!)).forEach((p, i) => parts.push({ ...p, t: r.t, marked: !(i === 0 && leadsUnmarked) }))
    since = []
    prevT = r.t
  }
  return { parts, marks, badMarks, markIds }
}

/** Plain text as both arms' readers get it: no tag, no marks, no topic ids. */
const plain = (s: string) => stripMarks(stripTag(s)).replace(/\s*\((T\d+(\.\d+)?(,\s*)?)+\)/g, '').replace(/\bT\d+(\.\d+)?\b:?\s*/g, '')
/**
 * Paragraphs, bullets and headed blocks: the units a reader matches to a message. A bullet carries the
 * lead line above its list ("**Test fixes:**"), since that is what tells a reader what the bullet is about.
 */
function segments(s: string): string[] {
  const out: string[] = []
  for (const para of plain(s).split(/\n\s*\n/)) {
    const pieces = para.split(/\n(?=\s*(?:[-*+]|\d+[.)]|#{1,6})\s)/).map(x => x.trim()).filter(Boolean)
    const lead = pieces[0] && !/^\s*(?:[-*+]|\d+[.)])\s/.test(pieces[0]) ? pieces[0] : ''
    for (const p of pieces) out.push(p === lead || !lead ? p : `${lead}\n${p}`)
  }
  // A list right after its lead paragraph ("Your other requests:" then a blank line and bullets) keeps it too.
  return out.map((seg, i) => (/^\s*(?:[-*+]|\d+[.)])\s/.test(seg) && i > 0 && /:\**\s*$/.test(out[i - 1]!) ? `${out[i - 1]}\n${seg}` : seg))
}
/** A's tag reaction on a turn whose visible text is empty: the reaction is the whole reply (APP_GUIDE allows "✅"). */
const reactionOnly = (text: string) => {
  if (plain(text)) return undefined
  try {
    const react = JSON.parse(text.match(/<threadline>\s*(\{[\s\S]*\})\s*<\/threadline>/)?.[1] ?? '{}').react
    return typeof react === 'string' ? react : undefined
  } catch {
    return undefined
  }
}

export function score(sc: Scenario, run: Run): RunScore {
  const main = run.texts.filter(x => !x.sub)
  const finals = run.results
  const { parts, marks, badMarks, markIds } = replyParts(run)
  // Which messages each final answer answers: the ones sent since the previous answer.
  const groupOf = new Map<string, number>()
  {
    let gi = 0
    for (const s of run.sent) {
      while (gi < finals.length && finals[gi]!.t < s.t) gi++
      groupOf.set(s.id, gi)
    }
  }
  const groupSize = (g: number) => [...groupOf.values()].filter(x => x === g).length
  const messages = sc.messages.map(m => {
    const s = run.sent.find(x => x.id === m.id)
    if (!s) return { id: m.id, midTurn: false, addressedFinal: false, addressedAny: false, attributed: false, facts: m.expect.map(e => ({ name: e.name, final: false, any: false, attributed: false })) } as MessageScore
    const after = main.filter(x => x.t >= s.t).map(x => plain(x.text)).join('\n')
    const laterFinals = finals.filter(x => x.t >= s.t)
    const fin = laterFinals.map(x => plain(x.text)).join('\n')
    const g = groupOf.get(m.id)!
    const own = finals[g]
    const facts = m.expect.map(e => {
      const re = new RegExp(e.re, 'i')
      const about = e.about ?? m.about
      const final = re.test(fin)
      const alone = !!own && groupSize(g) === 1 && re.test(plain(own.text))
      const cued = !!about && laterFinals.some(r => segments(r.text).some(seg => re.test(seg) && new RegExp(about, 'i').test(seg)))
      const f: MessageScore['facts'][number] = { name: e.name, final, any: re.test(after), attributed: final && (alone || cued || (!about && final)) }
      if (run.arm === 'A' && s.topicId) {
        const mine = parts.filter(p => p.to.includes(s.topicId!) && p.t >= s.t && re.test(plain(p.text)))
        const other = parts.filter(p => p.t >= s.t && !p.to.includes(s.topicId!) && re.test(plain(p.text)))
        f.attribution = mine.some(p => p.to.length === 1) ? 'own' : mine.some(p => p.marked) ? 'grouped' : mine.length ? 'shared' : other.length ? 'other' : 'missing'
      }
      return f
    })
    const out: MessageScore = { id: m.id, midTurn: s.midTurn, addressedFinal: facts.every(f => f.final), addressedAny: facts.every(f => f.any), attributed: facts.every(f => f.attributed), facts }
    if (s.topicId) out.topicId = s.topicId
    const reacted = own && groupSize(g) === 1 ? reactionOnly(own.text) : undefined
    if (reacted) out.reacted = reacted
    const mine = run.checks.filter(c => c.msg === m.id)
    if (mine.length) out.checksOk = mine.every(c => c.ok)
    if (run.arm === 'A' && s.topicId) {
      out.attribution = worst(facts.map(f => f.attribution!))
      out.named = markIds.has(s.topicId)
      out.inTag = finals.some(r => r.t >= s.t && (parseTag(r.text)?.topics ?? []).some(t => t.id === s.topicId || t.same_as === s.topicId))
    }
    return out
  })
  const known = new Set(run.sent.map(x => x.topicId).filter(Boolean) as string[])
  const badTagIds = run.arm === 'A' ? finals.flatMap(r => (parseTag(r.text)?.topics ?? []).map(t => t.id).filter(id => !known.has(id))) : []
  return { messages, marks, badMarks, badTagIds, tags: finals.filter(r => parseTag(r.text)).length, results: finals.length, checksOk: run.checks.filter(c => c.ok).length, checksTotal: run.checks.length }
}

// ---- Blind judge (optional) -------------------------------------------------------------

/** Both arms rendered the same way: the user's messages as B sends them, Claude's text in order with marks, tags and topic ids removed. */
function transcript(run: Run): string {
  const items: { t: number; line: string }[] = run.sent.map((s, i) => ({ t: s.t, line: `[U${i + 1}] user${s.midTurn ? ' (sent while the assistant was working)' : ''}:\n${s.shown}` }))
  for (const x of run.texts.filter(x => !x.sub)) {
    const text = plain(x.text)
    if (text) items.push({ t: x.t, line: `assistant:\n${text}` })
    else {
      // What the user sees of a reaction-only reply: the emoji on their message.
      const react = reactionOnly(x.text)
      if (react) items.push({ t: x.t, line: `assistant reacted to the user's last message with ${react} (no text)` })
    }
  }
  return items.sort((a, b) => a.t - b.t).map(x => x.line).join('\n\n')
}

const JUDGE_SYSTEM = [
  'You grade a chat between a user and a coding assistant. Reply with JSON only, no prose, no code fence.',
  'For each user message U1..Un give {"id":"U1","answered":0|1|2,"correct":true|false,"clear":0|1|2,"misattributed":true|false,"note":"<=15 words"}.',
  'answered: 2 fully, 1 partly, 0 not at all (a request counts as answered when the assistant reports doing it).',
  'correct: what the assistant says agrees with the facts given (and, for a reference like "the second thing I asked",',
  'that it resolved the reference to the right earlier message). clear: 2 a reader can tell at once which passage answers',
  'this message, 1 with some effort, 0 not at all. misattributed: the assistant treated this message as being about',
  'something else, or answered another message\'s question in its place.',
  'Then "corrections_followed": true|false|null (null when no message corrects an earlier one).',
  'Output: {"messages":[...],"corrections_followed":...}',
].join(' ')

type Judge = { verdict?: any; costUsd: number; error?: string; transcriptSha?: string }

/** Asynchronous: a blocking call here would stall the other runs' timers and event handling (it did, in the first big run). */
async function judge(sc: Scenario, run: Run, o: Opts): Promise<Judge> {
  const facts = sc.messages.map((m, i) => `U${i + 1}: ${m.expect.map(e => e.name).join('; ') || '(no fixed facts)'}`).join('\n')
  const chat = transcript(run)
  const prompt = `Facts the right answers contain:\n${facts}\n\nThe chat:\n\n${chat}`
  const transcriptSha = sha(chat)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tl-eval-judge-')))
  try {
    const stdout = await new Promise<string>(res => {
      const p = spawn('claude', ['-p', '--model', o.model, '--output-format', 'json', '--tools', '', '--system-prompt', JUDGE_SYSTEM, '--no-session-persistence', '--setting-sources', 'project,local', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--max-turns', '1', '--max-budget-usd', '0.20'], { cwd: dir, env: cleanEnv(), stdio: ['pipe', 'pipe', 'ignore'] })
      let out = ''
      p.stdout.setEncoding('utf8')
      p.stdout.on('data', (c: string) => (out += c))
      const timer = setTimeout(() => p.kill('SIGTERM'), 180000)
      p.on('exit', () => { clearTimeout(timer); res(out) })
      p.stdin.end(prompt)
    })
    const out = JSON.parse(stdout || '{}')
    const costUsd = Number(out.total_cost_usd ?? 0)
    const text = String(out.result ?? '').replace(/^```(json)?\s*|\s*```$/g, '')
    try {
      return { verdict: JSON.parse(text), costUsd, transcriptSha }
    } catch {
      return { costUsd, error: `unparsed: ${text.slice(0, 200)}`, transcriptSha }
    }
  } catch (err) {
    return { costUsd: 0, error: String(err) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    removeClaudeFolders(dir, 'tl-eval-judge-')
  }
}

// ---- Totals and statistics -----------------------------------------------------------------

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : NaN)
const sd = (xs: number[]) => (xs.length > 1 ? Math.sqrt(sum(xs.map(x => (x - mean(xs)) ** 2)) / (xs.length - 1)) : 0)
const rate = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : NaN)

export function totals(run: Run) {
  const calls = run.calls
  const input = sum(calls.map(c => c.input))
  const cacheRead = sum(calls.map(c => c.cacheRead))
  const cacheCreate = sum(calls.map(c => c.cacheCreate))
  const output = sum(calls.map(c => c.output))
  const main = calls.filter(c => !c.sub)
  const all = input + cacheRead + cacheCreate
  return {
    calls: calls.length, input, cacheRead, cacheCreate, output, allInput: all, cacheRatio: all ? cacheRead / all : 0,
    firstContext: main[0]?.context ?? 0, lastContext: main.at(-1)?.context ?? 0, maxContext: Math.max(0, ...main.map(c => c.context)),
    resultUsage: {
      input_tokens: sum(run.results.map(r => r.usage.input_tokens ?? 0)), cache_read_input_tokens: sum(run.results.map(r => r.usage.cache_read_input_tokens ?? 0)),
      cache_creation_input_tokens: sum(run.results.map(r => r.usage.cache_creation_input_tokens ?? 0)), output_tokens: sum(run.results.map(r => r.usage.output_tokens ?? 0)),
    },
    numTurns: sum(run.results.map(r => r.numTurns)), contextWindow: run.results.at(-1)?.contextWindow,
    costUsd: run.costUsd, wallMs: run.wallMs, turnMs: sum(run.results.map(r => r.durationMs)), results: run.results.length,
  }
}

type Row = { sc: Scenario; run: Run; score: RunScore; judge?: Judge }

/** Per-run values the summary compares. */
function metrics(r: Row) {
  const t = totals(r.run)
  const ms = r.score.messages
  const jm: any[] = r.judge?.verdict?.messages ?? []
  const mid = ms.filter(m => m.midTurn)
  return {
    cost: t.costUsd, allInput: t.allInput, output: t.output, cacheRatio: t.cacheRatio, turnS: t.turnMs / 1000, wallS: t.wallMs / 1000, calls: t.calls,
    lastContext: t.lastContext,
    addressed: rate(ms.map(m => m.addressedFinal)), attributed: rate(ms.map(m => m.attributed)),
    answeredOrReacted: rate(ms.map(m => m.addressedFinal || !!m.reacted)), reactedOnly: ms.filter(m => m.reacted).length,
    midAddressed: mid.length ? rate(mid.map(m => m.addressedFinal)) : NaN,
    checks: r.score.checksTotal ? r.score.checksOk / r.score.checksTotal : NaN,
    judgeAnswered: jm.length ? rate(jm.map(x => x.answered === 2)) : NaN, judgeCorrect: jm.length ? rate(jm.map(x => x.correct === true)) : NaN,
    judgeClear: jm.length ? rate(jm.map(x => x.clear === 2)) : NaN, judgeMisattributed: jm.length ? jm.filter(x => x.misattributed === true).length : NaN,
    judgeCorrections: r.judge?.verdict?.corrections_followed === true ? 1 : r.judge?.verdict?.corrections_followed === false ? 0 : NaN,
  }
}
type Metric = keyof ReturnType<typeof metrics>

/** A seeded RNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

/**
 * A − B, stratified by scenario: the mean over scenarios of (mean A − mean B), and a two-sided
 * permutation p-value that shuffles the arm labels within each scenario (5,000 shuffles).
 */
function compare(rows: Row[], key: Metric): { diff: number; p: number; n: number } {
  const strata = [...new Set(rows.map(r => r.sc.id))].map(id => rows.filter(r => r.sc.id === id).map(r => ({ arm: r.run.arm, v: metrics(r)[key] })).filter(x => Number.isFinite(x.v)))
    .filter(s => s.some(x => x.arm === 'A') && s.some(x => x.arm === 'B'))
  const stat = (ss: { arm: Arm; v: number }[][]) => mean(ss.map(s => mean(s.filter(x => x.arm === 'A').map(x => x.v)) - mean(s.filter(x => x.arm === 'B').map(x => x.v))))
  if (!strata.length) return { diff: NaN, p: NaN, n: 0 }
  const observed = stat(strata)
  const rand = rng(12345)
  let extreme = 0
  const N = 5000
  for (let i = 0; i < N; i++) {
    const perm = strata.map(s => {
      const arms = shuffle(s.map(x => x.arm), rand)
      return s.map((x, j) => ({ arm: arms[j]!, v: x.v }))
    })
    if (Math.abs(stat(perm)) >= Math.abs(observed) - 1e-12) extreme++
  }
  return { diff: observed, p: (extreme + 1) / (N + 1), n: sum(strata.map(s => s.length)) }
}

// ---- Summary ----------------------------------------------------------------------

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-')
const pc = (x: number) => (Number.isFinite(x) ? `${Math.round(100 * x)}%` : '-')
const ms = (xs: number[], fmt: (x: number) => string) => {
  const v = xs.filter(Number.isFinite)
  return v.length ? `${fmt(mean(v))} ± ${fmt(sd(v))}` : '-'
}

function summary(rows: Row[], o: Opts, spent: number, stopped: string): string {
  const L: string[] = []
  L.push('# Run summary', '', `model ${o.model}, reps ${o.reps}, max-turns ${o.maxTurns}, spent $${spent.toFixed(4)} of $${o.budget}${stopped ? `; STOPPED: ${stopped}` : ''}`, '')
  L.push(`Frozen sources (sha256): ${Object.entries(FROZEN).map(([k, v]) => `${k} ${v.slice(0, 12)}`).join(', ')}; APP_GUIDE ${APP_GUIDE.length} chars.`, '')
  const fmtMoney = (x: number) => x.toFixed(4)
  const fmtInt = (x: number) => Math.round(x).toLocaleString('en-US')
  for (const set of ['hard', 'baseline'] as SetName[]) {
    const rs = rows.filter(r => r.sc.set === set)
    if (!rs.length) continue
    L.push(`## Set: ${set} (${rs.length} runs)`, '')
    L.push('Mean ± sd per run, over every run of the set (scenarios pooled).', '')
    L.push('| metric | A threadline | B plain | A − B (stratified by scenario) | permutation p |')
    L.push('|---|---|---|---|---|')
    const line = (label: string, key: Metric, fmt: (x: number) => string) => {
      const a = rs.filter(r => r.run.arm === 'A').map(r => metrics(r)[key])
      const b = rs.filter(r => r.run.arm === 'B').map(r => metrics(r)[key])
      const c = compare(rs, key)
      L.push(`| ${label} | ${ms(a, fmt)} | ${ms(b, fmt)} | ${Number.isFinite(c.diff) ? fmt(c.diff) : '-'} | ${f(c.p, 3)} |`)
    }
    line('cost $', 'cost', fmtMoney)
    line('input tokens (all)', 'allInput', fmtInt)
    line('output tokens', 'output', fmtInt)
    line('cache ratio', 'cacheRatio', pc)
    line('API calls', 'calls', x => x.toFixed(1))
    line('last context', 'lastContext', fmtInt)
    line('turn time s', 'turnS', x => x.toFixed(1))
    line('wall time s', 'wallS', x => x.toFixed(1))
    line('messages answered (final, regex)', 'addressed', pc)
    line('... or answered by a reaction only (A)', 'answeredOrReacted', pc)
    line('reaction-only replies per run', 'reactedOnly', x => x.toFixed(2))
    line('messages attributed (plain-text rubric)', 'attributed', pc)
    line('mid-turn messages answered', 'midAddressed', pc)
    line('project checks passed', 'checks', pc)
    line('judge: answered fully', 'judgeAnswered', pc)
    line('judge: correct', 'judgeCorrect', pc)
    line('judge: clear which reply answers it', 'judgeClear', pc)
    line('judge: misattributed messages per run', 'judgeMisattributed', x => x.toFixed(2))
    line('judge: corrections followed', 'judgeCorrections', pc)
    const aMs = rs.filter(r => r.run.arm === 'A').flatMap(r => r.score.messages)
    const counts: Record<string, number> = {}
    for (const m of aMs) counts[m.attribution ?? 'none'] = (counts[m.attribution ?? 'none'] ?? 0) + 1
    const aRuns = rs.filter(r => r.run.arm === 'A')
    L.push('', `A reply structure over ${aMs.length} messages: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}; tags on ${sum(aRuns.map(r => r.score.tags))}/${sum(aRuns.map(r => r.score.results))} final answers; ${sum(aRuns.map(r => r.score.badMarks.length))} marks naming unknown ids; ${sum(aRuns.map(r => r.score.badTagIds?.length ?? 0))} tag entries with made-up ids (${[...new Set(aRuns.flatMap(r => r.score.badTagIds ?? []))].slice(0, 8).join(', ')}).`)
    L.push('', '### Per scenario (mean ± sd)', '')
    L.push('| scenario | arm | n | cost $ | input | output | turn s | answered | attributed | checks | judge clear | judge misattr. |')
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const id of [...new Set(rs.map(r => r.sc.id))])
      for (const arm of ['A', 'B'] as Arm[]) {
        const xs = rs.filter(r => r.sc.id === id && r.run.arm === arm).map(metrics)
        if (!xs.length) continue
        const col = (k: Metric, fmt: (x: number) => string) => ms(xs.map(x => x[k]), fmt)
        L.push(`| ${id} | ${arm} | ${xs.length} | ${col('cost', fmtMoney)} | ${col('allInput', fmtInt)} | ${col('output', fmtInt)} | ${col('turnS', x => x.toFixed(1))} | ${col('addressed', pc)} | ${col('attributed', pc)} | ${col('checks', pc)} | ${col('judgeClear', pc)} | ${col('judgeMisattributed', x => x.toFixed(1))} |`)
      }
    // Overhead: first call of each run, A − B (same history except APP_GUIDE and the first note).
    const firsts = (arm: Arm) => rs.filter(r => r.run.arm === arm).map(r => totals(r.run).firstContext)
    const notes = aRuns.flatMap(r => r.run.sent.map(s => s.note?.length ?? 0))
    const tagChars = aRuns.flatMap(r => r.run.results.map(x => x.text.match(/<threadline>[\s\S]*?<\/threadline>/)?.[0].length ?? 0))
    L.push('', '### Arm A overhead', '')
    const byScenario = [...new Set(rs.map(r => r.sc.id))].map(id => {
      const a = rs.filter(r => r.sc.id === id && r.run.arm === 'A').map(r => totals(r.run).firstContext)
      const b = rs.filter(r => r.sc.id === id && r.run.arm === 'B').map(r => totals(r.run).firstContext)
      return a.length && b.length ? mean(a) - mean(b) : NaN
    }).filter(Number.isFinite)
    L.push(`- first-call context: A ${ms(firsts('A'), fmtInt)}, B ${ms(firsts('B'), fmtInt)}; A − B per scenario ${byScenario.map(x => Math.round(x)).join(', ')}`)
    L.push(`- notes: ${notes.length} sent, ${f(mean(notes), 0)} chars on average (max ${Math.max(0, ...notes)}), ~${f(mean(notes) / 3.1, 0)} tokens each`)
    L.push(`- tags: ${f(mean(tagChars), 0)} chars per final answer on average, ~${f(mean(tagChars) / 3.1, 0)} output tokens`)
  }
  return L.join('\n') + '\n'
}

/** Where each arm fell short, with the text, for the report. */
function failures(rows: Row[]) {
  const out: any[] = []
  for (const r of rows) {
    const jm: any[] = r.judge?.verdict?.messages ?? []
    r.score.messages.forEach((m, i) => {
      const j = jm.find(x => x.id === `U${i + 1}`)
      const why: string[] = []
      if (!m.addressedFinal) why.push(`${m.reacted ? `reaction-only reply (${m.reacted}); ` : ''}missing facts: ${m.facts.filter(x => !x.final).map(x => x.name).join(', ')}`)
      else if (!m.attributed) why.push(`facts not tied to this message: ${m.facts.filter(x => !x.attributed).map(x => x.name).join(', ')}`)
      if (m.checksOk === false) why.push(`checks failed: ${r.run.checks.filter(c => c.msg === m.id && !c.ok).map(c => c.name).join(', ')}`)
      if (r.run.arm === 'A' && m.attribution && !['own', 'grouped'].includes(m.attribution)) why.push(`A structure: ${m.attribution}`)
      if (j && (j.misattributed || j.clear === 0 || j.answered === 0 || j.correct === false)) why.push(`judge: ${JSON.stringify(j)}`)
      if (!why.length) return
      const s = r.run.sent.find(x => x.id === m.id)
      const reply = s ? r.run.results.find(x => x.t >= s.t)?.text ?? '' : ''
      out.push({ scenario: r.sc.id, arm: r.run.arm, rep: r.run.rep, msg: m.id, text: s?.text, midTurn: m.midTurn, why, reply: plain(reply).slice(0, 700) })
    })
    for (const c of r.run.checks.filter(c => !c.ok && !c.msg)) out.push({ scenario: r.sc.id, arm: r.run.arm, rep: r.run.rep, msg: '-', why: [`check failed: ${c.name}`], detail: c.detail })
  }
  return out
}

function save(o: Opts, rows: Row[], spent: number, stopped: string) {
  rows.sort((a, b) => a.sc.id.localeCompare(b.sc.id) || a.run.rep - b.run.rep || a.run.arm.localeCompare(b.run.arm))
  writeFileSync(join(o.out, 'results.json'), JSON.stringify({
    options: o, frozen: { sha256: FROZEN, sources: readFileSync(join(HERE, 'frozen', 'SOURCES.txt'), 'utf8'), APP_GUIDE, FLAT_GUIDE, REPLY_GUIDE }, spentUsd: spent, stopped,
    runs: rows.map(r => ({ ...r.run, score: r.score, judge: r.judge, totals: totals(r.run), metrics: metrics(r) })),
    failures: failures(rows),
  }, null, 2))
  writeFileSync(join(o.out, 'summary.md'), summary(rows, o, spent, stopped))
}

/** Scores saved runs again (and judges unjudged ones with --judge) without starting new sessions. */
async function rescore(o: Opts, all: Scenario[]) {
  const saved = JSON.parse(readFileSync(join(o.rescore!, 'results.json'), 'utf8'))
  let spent = Number(saved.spentUsd ?? 0)
  const rows: Row[] = (saved.runs as (Run & { judge?: Judge })[]).flatMap(run => {
    const sc = all.find(s => s.id === run.scenario && (!run.set || s.set === run.set))
    if (!sc) return []
    run.set = sc.set
    run.rep ??= 1
    for (const s of run.sent) s.shown ??= s.text
    return [{ sc, run, score: score(sc, run), ...(run.judge ? { judge: run.judge } : {}) }]
  })
  if (o.judge)
    for (const row of rows) {
      // Judged already, on the same transcript (old results have no hash: judged before reaction rendering existed).
      if (row.judge?.verdict && (row.judge.transcriptSha ? row.judge.transcriptSha === sha(transcript(row.run)) : !transcript(row.run).includes('assistant reacted'))) continue
      if (o.budget - spent <= 0.1) break
      row.judge = await judge(row.sc, row.run, o)
      spent += row.judge.costUsd
    }
  save({ ...saved.options, ...o, reps: saved.options?.reps ?? o.reps }, rows, spent, saved.stopped ?? '')
  console.log(`rescored ${rows.length} runs; total $${spent.toFixed(4)}`)
}

// ---- Main -----------------------------------------------------------------------------

async function main() {
  const o = parseArgs(process.argv.slice(2))
  const all = loadScenarios()
  mkdirSync(o.out, { recursive: true })
  if (o.rescore) return rescore(o, all)
  let scs = all.filter(s => o.set === 'all' || s.set === o.set)
  if (o.scenarios) scs = scs.filter(s => o.scenarios!.includes(s.id))
  // Cheap first, so a partial result is still useful: fewer messages first, the hard set before the baseline.
  scs = [...scs].sort((a, b) => (a.set === b.set ? 0 : a.set === 'hard' ? -1 : 1) || a.messages.length - b.messages.length)
  const rand = rng(o.seed)
  type Task = { sc: Scenario; arm: Arm; rep: number; slot: number }
  const tasks: Task[] = []
  for (const sc of scs)
    for (let rep = 1; rep <= o.reps; rep++) shuffle(o.arms, rand).forEach((arm, slot) => tasks.push({ sc, arm, rep, slot }))

  let spent = 0
  let reserved = 0
  let stopped = ''
  const rows: Row[] = []
  const seen = new Map<string, number[]>()
  // A run's likely cost: the costliest so far of its scenario, else the dearest per-message cost so far times its messages.
  const estimate = (sc: Scenario) => {
    const own = seen.get(sc.id)
    if (own?.length) return Math.max(...own) * 1.15
    const per = [...seen.entries()].flatMap(([id, cs]) => cs.map(c => c / (all.find(s => s.id === id)?.messages.length ?? 1)))
    return (per.length ? Math.max(...per) * 1.5 : 0.08) * sc.messages.length + 0.03
  }
  console.log(`${tasks.length} runs planned; budget $${o.budget}; concurrency ${o.concurrency}`)
  let next = 0
  const worker = async () => {
    while (next < tasks.length && !stopped) {
      const task = tasks[next]!
      const est = estimate(task.sc)
      if (spent + reserved + est > o.budget) {
        if (reserved > 0) {
          await new Promise(r => setTimeout(r, 2000))
          continue
        }
        stopped = `budget: $${spent.toFixed(4)} spent; the next run (${task.sc.id} ${task.arm} r${task.rep}) might cost ~$${est.toFixed(3)}, over the $${o.budget} cap; ${tasks.length - next} runs not started`
        console.log(`STOP ${stopped}`)
        break
      }
      next++
      reserved += est
      const cap = Math.max(0.05, Math.min(o.runCap, o.budget - spent - reserved + est))
      console.log(`start ${task.sc.id} ${task.arm} r${task.rep} (est $${est.toFixed(3)}, spent $${spent.toFixed(4)})`)
      const run = await runOne(task.sc, task.arm, task.rep, task.slot, o, cap)
      const row: Row = { sc: task.sc, run, score: score(task.sc, run) }
      let cost = run.costUsd
      if (o.judge) {
        row.judge = await judge(task.sc, run, o)
        cost += row.judge.costUsd
      }
      reserved -= est
      spent += cost
      seen.set(task.sc.id, [...(seen.get(task.sc.id) ?? []), cost])
      rows.push(row)
      const s = row.score
      console.log(`done  ${task.sc.id} ${task.arm} r${task.rep} $${cost.toFixed(4)} ${(run.wallMs / 1000).toFixed(0)}s answered=${s.messages.filter(m => m.addressedFinal).length}/${s.messages.length} attributed=${s.messages.filter(m => m.attributed).length} checks=${s.checksOk}/${s.checksTotal}${run.timedOut ? ' TIMEOUT' : ''}${run.results.some(r => r.isError) ? ' ERROR:' + run.results.filter(r => r.isError).map(r => r.subtype).join(',') : ''}${row.judge?.error ? ' JUDGE:' + row.judge.error.slice(0, 60) : ''} | total $${spent.toFixed(4)}`)
      save(o, rows, spent, stopped)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker))
  save(o, rows, spent, stopped)
  console.log(`total $${spent.toFixed(4)}; ${rows.length} runs; results in ${o.out}${stopped ? `; stopped: ${stopped}` : ''}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
