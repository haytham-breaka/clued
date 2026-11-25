#!/usr/bin/env node
// Can you see what was answered? For every message the user sent, at several moments of a recorded
// session: was it answered, by which reply, and is anything still open (on Claude, or on the user)?
//
// It re-uses the recorded streams of a run (results.json + raw/*.jsonl); no session is run again.
//   A, clued: the stream goes through the app's own code (app/claude.ts's parser, app/inbox.ts
//             assignParts() and inbox(), hooks/model.ts settleTurn()), as app/main.ts drives it, and the
//             screen is drawn with app/panel.ts panelLines() and app/chat.ts chatLines().
//   B, plain: the same stream drawn as Claude Code's terminal shows it (prompts, text, one line a tool).
// A busy reader (a small model) glances at one screen of each arm, and at the end reads the whole chat;
// both are scored against one ground truth: a careful judge that reads each whole transcript, checked
// against rules built from the scenario facts. The deterministic half is in visibility-core.ts.
//
//   node --no-warnings eval/visibility.ts [--in eval/results/hard] [--raw <dir>] [--out eval/results/visibility]
//        [--truth-judge | --truth-from <results.json>] [--glance] [--full] [--budget 3] [--dry] [--run <scenario>-<arm>-r<rep> [--screens]]
//
// See eval/README.md ("Visibility") and eval/RESULTS.md ("Can you see what was answered?").

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preview } from '../app/inbox.ts'
import { blocksOf, compare, factsOf, hits, judgeTranscript, loadScenarios, needsJudge, norm, panelClaim, rates, readRaw, replayA, framesB, ruleTruth, SCREEN, stateAt, sum, mean, TRUTH_SYSTEM } from './visibility-core.ts'
import type { Block, Frame, Pair, Rates, SavedRun, Scenario, State, Truth, Verdict } from './visibility-core.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

// ---- Model calls: claude -p, a budget, a ledger and a cache (both under raw/, never committed) --------------

type Ledger = { at: string; kind: string; key: string; model: string; costUsd: number }

class Budget {
  spent: number
  file: string
  cap: number
  constructor(file: string, cap: number) {
    this.file = file
    this.cap = cap
    this.spent = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).reduce((n, l) => n + (JSON.parse(l) as Ledger).costUsd, 0) : 0
  }
  add(l: Omit<Ledger, 'at'>) {
    this.spent += l.costUsd
    writeFileSync(this.file, JSON.stringify({ at: new Date().toISOString(), ...l }) + '\n', { flag: 'a' })
  }
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|AI_AGENT)/.test(k)) env[k] = v
  env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
  return env
}

async function claudeCall(model: string, system: string, prompt: string, cap: number): Promise<{ text: string; costUsd: number }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tl-vis-')))
  try {
    const stdout = await new Promise<string>(res => {
      const p = spawn('claude', ['-p', '--model', model, '--output-format', 'json', '--tools', '', '--system-prompt', system, '--no-session-persistence', '--setting-sources', 'project,local', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--max-turns', '1', '--max-budget-usd', cap.toFixed(2)], { cwd: dir, env: cleanEnv(), stdio: ['pipe', 'pipe', 'ignore'] })
      let out = ''
      p.stdout.setEncoding('utf8')
      p.stdout.on('data', (c: string) => (out += c))
      const timer = setTimeout(() => p.kill('SIGTERM'), 180000)
      p.on('exit', () => { clearTimeout(timer); res(out) })
      p.stdin.end(prompt)
    })
    const out = JSON.parse(stdout || '{}')
    return { text: String(out.result ?? '').replace(/^```(json)?\s*|\s*```$/g, ''), costUsd: Number(out.total_cost_usd ?? 0) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    const name = dir.replace(/[^a-zA-Z0-9]/g, '-')
    for (const p of [join(process.env.HOME ?? '', '.claude', 'projects', name), join(tmpdir(), `claude-${process.getuid?.() ?? ''}`, name)])
      if (name.startsWith('-tmp-tl-vis-') && existsSync(p)) rmSync(p, { recursive: true, force: true })
  }
}

class Caller {
  private worst = new Map<string, number>()
  private cacheDir: string
  private budget: Budget
  constructor(cacheDir: string, budget: Budget) {
    this.cacheDir = cacheDir
    this.budget = budget
    mkdirSync(cacheDir, { recursive: true })
  }
  stopped = ''
  /** A cached answer if this exact prompt was asked before; else a call, if the budget allows it. */
  async ask(kind: string, key: string, model: string, system: string, prompt: string, est: number): Promise<string | undefined> {
    const file = join(this.cacheDir, `${kind}-${key}-${sha(model + system + prompt).slice(0, 12)}.json`)
    if (existsSync(file)) return (JSON.parse(readFileSync(file, 'utf8')) as { text: string }).text
    const guess = Math.max(est, (this.worst.get(kind) ?? 0) * 1.5)
    if (this.stopped || this.budget.spent + guess > this.budget.cap) {
      this.stopped ||= `budget: $${this.budget.spent.toFixed(4)} spent, the next ${kind} call might pass the $${this.budget.cap} cap`
      return undefined
    }
    const r = await claudeCall(model, system, prompt, Math.max(0.05, guess * 4))
    this.budget.add({ kind, key, model, costUsd: r.costUsd })
    this.worst.set(kind, Math.max(this.worst.get(kind) ?? 0, r.costUsd))
    writeFileSync(file, JSON.stringify({ text: r.text, costUsd: r.costUsd }))
    return r.text
  }
}

/** Model calls at once: kept low, so the eval doesn't swamp the machine. */
const CALLS = 2

async function pool<T>(xs: T[], n: number, f: (x: T) => Promise<void>) {
  let i = 0
  await Promise.all(Array.from({ length: n }, async () => { while (i < xs.length) await f(xs[i++]!) }))
}

const parseJson = (s: string | undefined): any => {
  if (!s) return undefined
  try {
    return JSON.parse(s)
  } catch {
    const m = s.match(/\{[\s\S]*\}/)
    try {
      return m ? JSON.parse(m[0]) : undefined
    } catch {
      return undefined
    }
  }
}

// ---- The glance ------------------------------------------------------------------------

type Reading = { status: State | 'unknown'; answer: string }

const GLANCE_SYSTEM = [
  'You are a busy developer glancing at your terminal for a few seconds, not scrolling. Reply with JSON only, no prose, no code fence.',
  'You sent the messages listed to a coding assistant, Claude. From this one screen only, say for each message:',
  '"status": "done" (Claude answered it, or did it, and wants nothing from you), "waiting" (Claude answered by asking you something',
  'about it that you have not answered yet), "working" (no answer to it yet, or Claude is still on it), or "unknown" (the screen does not show);',
  '"answer": the answer or result the screen shows for it, at most 12 words, or "" if none is visible.',
  'Output: {"messages":[{"id":"m1","status":"...","answer":"..."}]}',
].join(' ')

const LEGEND = {
  A: 'The screen is the clued app. Left, its panel: "Unread" lists new replies, "Waiting on you" lists questions for you, and "Your recent messages" lists your messages newest first with a mark: ⏳ Claude is on it, no reply yet; ▶ replied, still owes work; ⠋ in progress: being worked on; ✋ waiting on you; ✓ done; ✕ failed; ○ not answered; ⚠ reply lost. Right, the end of the chat: your messages, and Claude\'s replies as bubbles headed with ↩ and the message each answers.',
  B: 'The screen is Claude Code in a terminal: lines starting with ">" are your messages; lines starting with "⏺" are Claude\'s text and its tool calls (⎿ the tool\'s result).',
}

function glancePrompt(arm: 'A' | 'B', run: SavedRun, f: Frame, full = false): string {
  const mine = run.sent.filter(s => f.sentIds.includes(s.id)).map(s => `${s.id}: ${s.shown.replace(/\n+/g, ' ')}`).join('\n')
  const what = full ? `The whole chat, scrolled through from the top (Claude has stopped)${arm === 'A' ? '; the panel first, then the chat' : ''}` : `The screen now${f.label === 'end' ? ' (Claude has stopped)' : ''}`
  return `${LEGEND[arm]}\n\nYour messages, oldest first:\n${mine}\n\n${what}:\n\n${full ? f.full : f.screen}`
}

/** The full read: the same reader, told it may read everything. */
const FULL_SYSTEM = GLANCE_SYSTEM.replace('glancing at your terminal for a few seconds, not scrolling', 'reading back through your whole terminal session').replace('From this one screen only', 'From what you read')

// ---- Summary ---------------------------------------------------------------------------

const pc = (x: number) => (Number.isFinite(x) ? `${Math.round(100 * x)}%` : '-')
const pv = (p: number) => (!Number.isFinite(p) ? '-' : p < 0.001 ? '<0.001' : p.toFixed(3))

function summaryOf(out: any): string {
  const L: string[] = ['# Can you see what was answered? (summary)', '']
  L.push(`${out.input.runs} recorded runs; screen ${out.screen.cols}×${out.screen.rows} (clued: panel ${out.screen.panel} columns); glance ${out.models.glance}, truth ${out.models.truth}; spent $${out.spentUsd.toFixed(4)} of $${out.cap}${out.stopped ? `; STOPPED: ${out.stopped}` : ''}.`, '')
  L.push(`Truth pairs (moment × message): A ${JSON.stringify(out.truthCounts.A)}, B ${JSON.stringify(out.truthCounts.B)}. Rules and judge name the same answering block for ${out.truthSources.rulesVsJudge.same}/${out.truthSources.rulesVsJudge.msgs} messages.`, '')
  for (const set of ['all', 'end', 'hard', 'no offers']) {
    L.push(`## ${({ all: 'Every moment', end: 'At the end only', hard: 'Hard set, every moment', 'no offers': 'Every moment, offers without a question left out' } as Record<string, string>)[set]}`, '')
    L.push('| reader | pairs | answered or not | still open | exact state | answer found | which reply (when it said answered) | can\'t tell | not answered, looked answered | open, looked done | done, looked open |')
    L.push('|---|---|---|---|---|---|---|---|---|---|---|')
    for (const [name, v] of Object.entries(out.scores as Record<string, Record<string, Rates>>)) {
      const r = v[set]!
      if (!r.n) continue
      L.push(`| ${name} | ${r.n} | ${pc(r.answered)} | ${pc(r.open)} | ${pc(r.state)} | ${pc(r.found)} | ${pc(r.link)} (${r.linkN}) | ${pc(r.unknown)} | ${r.falseAnswered}/${r.notAnswered} | ${r.falseDone}/${r.openTruth} | ${r.falseOpen}/${r.n - r.openTruth} |`)
    }
    L.push('')
  }
  L.push('## Comparisons (per-run means; mean over scenarios of X − Y; permutation p, labels shuffled within scenario, 5,000 shuffles)', '')
  L.push('| X vs Y | answered or not | still open | exact state | answer found | not answered, looked answered (per run) | open, looked done (per run) | done, looked open (per run) |')
  L.push('|---|---|---|---|---|---|---|---|')
  for (const [k, c] of Object.entries(out.comparisons as Record<string, Record<string, { diff: number; p: number }>>)) {
    const f = (m: string, pct = true) => `${pct ? `${c[m]!.diff >= 0 ? '+' : ''}${Math.round(100 * c[m]!.diff)} pt` : c[m]!.diff.toFixed(2)} (p ${pv(c[m]!.p)})`
    L.push(`| ${k} | ${f('answered')} | ${f('open')} | ${f('state')} | ${f('found')} | ${f('falseAnswered', false)} | ${f('falseDone', false)} | ${f('falseOpen', false)} |`)
  }
  L.push('', '## Per scenario, every moment (answered or not / still open / answer found)', '')
  const names = Object.keys(out.scores)
  L.push(`| scenario | ${names.join(' | ')} |`, `|---|${names.map(() => '---').join('|')}|`)
  for (const [sc, v] of Object.entries(out.perScenario as Record<string, Record<string, Rates>>))
    L.push(`| ${sc} | ${names.map(n => (v[n]?.n ? `${pc(v[n]!.answered)} / ${pc(v[n]!.open)} / ${pc(v[n]!.found)}` : '-')).join(' | ')} |`)
  L.push('', '## Waiting on you, by how Claude asked (pairs seen as open / looked done / all)', '')
  for (const [name, v] of Object.entries(out.waitingSplit as Record<string, Record<string, { n: number; seenOpen: number; lookedDone: number }>>))
    L.push(`- ${name}: asked with "?": ${v.direct!.seenOpen}/${v.direct!.lookedDone}/${v.direct!.n}; offered without one: ${v.offer!.seenOpen}/${v.offer!.lookedDone}/${v.offer!.n}`)
  L.push('', `Reading: ${JSON.stringify(out.reading)}`, '', `Spend: ${JSON.stringify(out.spend)}`, '')
  return L.join('\n')
}

// ---- Main ------------------------------------------------------------------------------


async function main() {
  const args = process.argv.slice(2)
  const get = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
  const inDir = resolve(get('--in', join(HERE, 'results', 'hard'))!)
  const rawDir = resolve(get('--raw', join(inDir, 'raw'))!)
  const outDir = resolve(get('--out', join(HERE, 'results', 'visibility'))!)
  const glanceModel = get('--glance-model', 'haiku')!
  const truthModel = get('--truth-model', 'sonnet')!
  const budget = new Budget(join(outDir, 'raw', 'ledger.jsonl'), Number(get('--budget', '3')))
  mkdirSync(join(outDir, 'raw'), { recursive: true })
  const caller = new Caller(join(outDir, 'raw', 'cache'), budget)
  const saved = JSON.parse(readFileSync(join(inDir, 'results.json'), 'utf8'))
  const all = loadScenarios()
  const runs = (saved.runs as SavedRun[]).filter(r => !get('--scenarios') || get('--scenarios')!.split(',').includes(r.scenario))
  const keyOf = (r: SavedRun) => `${r.scenario}-${r.arm}-r${r.rep}`
  const only = get('--run')

  type Prepared = { run: SavedRun; sc: Scenario; frames: Frame[]; blocks: Block[]; tools: { t: number; line: string }[]; truth: Truth[]; flags: string[]; rules: Truth[] }
  const prepared: Prepared[] = []
  for (const run of runs) {
    if (only && keyOf(run) !== only) continue
    const sc = all.find(s => s.id === run.scenario && s.set === run.set)!
    const events = readRaw(rawDir, run)
    const frames = run.arm === 'A' ? replayA(run, events) : framesB(run, events)
    const { blocks, tools } = blocksOf(run, events)
    const rules = ruleTruth(sc, run, blocks)
    const flags = needsJudge(run, blocks, rules)
    prepared.push({ run, sc, frames, blocks, tools, truth: rules, flags, rules })
    if (only) {
      console.log(judgeTranscript(run, blocks, tools))
      console.log(JSON.stringify(rules), flags)
      for (const f of frames) {
        console.log(`==== ${f.label}`)
        if (f.panel) console.log(f.panel.map(p => `${p.id} ${p.state}${p.stale ? ' stale' : ''}${p.reacted ? ' reacted' : ''} ${p.replyText ? JSON.stringify(preview(p.replyText, 60)) : ''}`).join('\n'))
        if (args.includes('--screens')) console.log(f.screen)
      }
    }
  }
  console.log(`${prepared.length} runs; ${prepared.filter(p => p.flags.length).length} need the careful judge (A ${prepared.filter(p => p.flags.length && p.run.arm === 'A').length}, B ${prepared.filter(p => p.flags.length && p.run.arm === 'B').length}); spent so far $${budget.spent.toFixed(4)} of $${budget.cap}`)
  if (args.includes('--dry')) return

  // 1. Ground truth: the careful judge where the rules can't settle it, and on a sample where they can (to check the rules).
  // Every run, so both arms get the same kind of truth; the rules are the check on the judge.
  const agree = { msgs: 0, same: 0, flaggedMsgs: 0, flaggedSame: 0 }
  if (args.includes('--truth-judge'))
    await pool(prepared, CALLS, async p => {
      const facts = p.sc.messages.map((m, i) => `U${i + 1}: ${m.expect.map(e => e.name).join('; ') || '(no fixed facts)'}`).join('\n')
      const prompt = `Facts the right answers contain (from the test):\n${facts}\n\nThe chat:\n\n${judgeTranscript(p.run, p.blocks, p.tools)}`
      const v = parseJson(await caller.ask('truth', keyOf(p.run), truthModel, TRUTH_SYSTEM, prompt, 0.04))
      const jm: any[] = v?.messages ?? []
      if (!jm.length) return
      const at = (id: unknown) => p.blocks.find(b => b.id === id)
      const sentAt = (id: unknown) => typeof id === 'string' ? p.run.sent[Number(id.slice(1)) - 1]?.t : undefined
      const judged: Truth[] = p.sc.messages.map((m, i) => {
        const x = jm.find(y => y.id === `U${i + 1}`) ?? {}
        const a = at(x.answered_in)
        const q = at(x.asks_user_in)
        const r = sentAt(x.resolved_by)
        return { id: m.id, ...(a ? { answeredIn: a.id, answeredAt: a.t } : {}), ...(q ? { asksIn: q.id, asksAt: q.t } : {}), ...(q && r != null ? { resolvedBy: String(x.resolved_by), resolvedAt: r } : {}), source: 'judge' as const }
      })
      for (const [i, j] of judged.entries()) {
        const same = j.answeredIn === p.rules[i]!.answeredIn
        if (!same && args.includes('--verbose')) console.log(`differs: ${keyOf(p.run)} ${j.id} rules ${p.rules[i]!.answeredIn ?? '-'} judge ${j.answeredIn ?? '-'}`)
        agree.msgs++
        if (same) agree.same++
        if (p.flags.length) {
          agree.flaggedMsgs++
          if (same) agree.flaggedSame++
        }
      }
      p.truth = judged
    })
  // Or the truth saved by an earlier run (its ids; the times come from the blocks): scoring a change
  // to the app again with no model calls.
  const truthFrom = get('--truth-from')
  if (truthFrom) {
    const savedTruth = JSON.parse(readFileSync(resolve(truthFrom), 'utf8')).truth as Record<string, { id: string; answeredIn?: string; asksIn?: string; resolvedBy?: string; source: 'judge' | 'rules' }[]>
    for (const p of prepared) {
      const ts = savedTruth[keyOf(p.run)]
      if (!ts) continue
      const at = (id?: string) => (id ? p.blocks.find(b => b.id === id) : undefined)
      const sentAt = (id?: string) => (id ? p.run.sent[Number(id.slice(1)) - 1]?.t : undefined)
      p.truth = ts.map(x => {
        const a = at(x.answeredIn)
        const q = at(x.asksIn)
        const r = sentAt(x.resolvedBy)
        return { id: x.id, ...(a ? { answeredIn: a.id, answeredAt: a.t } : {}), ...(q ? { asksIn: q.id, asksAt: q.t } : {}), ...(q && r != null ? { resolvedBy: x.resolvedBy!, resolvedAt: r } : {}), source: x.source }
      })
    }
  }
  console.log(`truth: the judge and the rules name the same answering block for ${agree.same}/${agree.msgs} messages; spent $${budget.spent.toFixed(4)}`)

  // 2. Pairs (frame × message) with their truth, and arm A's panel read directly (no model).
  const pairs: { p: Pair; frame: Frame; prep: Prepared }[] = []
  const verdicts = new Map<string, Map<string, Verdict>>() // reader → pair key → verdict
  const reader = (name: string) => verdicts.get(name) ?? (verdicts.set(name, new Map()), verdicts.get(name)!)
  const pk = (p: Pair) => `${p.run}|${p.frame}|${p.msg}`
  for (const prep of prepared)
    for (const f of prep.frames)
      for (const id of f.sentIds) {
        const tr = prep.truth.find(t => t.id === id)!
        const m = prep.sc.messages.find(x => x.id === id)!
        const truth = stateAt(tr, f.label === 'end' ? Infinity : f.t)
        const block = prep.blocks.find(b => b.id === tr.answeredIn)
        const ask = prep.blocks.find(b => b.id === tr.asksIn)
        const p: Pair = { run: keyOf(prep.run), scenario: prep.sc.id, arm: prep.run.arm, rep: prep.run.rep, frame: f.label, msg: id, truth, checkable: !!block && (!!block.react || hits(m, block.plain)), byReaction: !!block?.react, ...(truth === 'waiting' ? { direct: !!ask && ask.plain.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '').includes('?') } : {}) }
        pairs.push({ p, frame: f, prep })
        if (f.panel) {
          const pv = f.panel.find(x => x.id === id)!
          const claim = panelClaim(pv)
          let link: boolean | undefined
          if (block?.react) link = pv.reacted
          else if (block && pv.replyText) {
            const r = norm(pv.replyText)
            const b = norm(block.plain)
            // The answering block itself, or a later reply that states the answer too (the panel links the latest reply naming it).
            link = ((b.includes(r) || r.includes(b)) && (!hits(m, block.plain) || hits(m, pv.replyText))) || hits(m, pv.replyText)
          } else if (block) link = false
          reader('A panel').set(pk(p), { claim, ...(link !== undefined ? { link } : {}) })
        }
      }

  // 3. The glance: one call per frame and arm.
  if (args.includes('--glance')) {
    const frames = prepared.flatMap(prep => prep.frames.map(f => ({ prep, f })))
    const which = get('--frames', 'all')
    const chosen = frames.filter(x => which === 'all' || (which === 'end' && x.f.label === 'end'))
    await pool(chosen, CALLS, async ({ prep, f }) => {
      const v = parseJson(await caller.ask('glance', `${keyOf(prep.run)}-${f.label.replace(/\s+/g, '')}`, glanceModel, GLANCE_SYSTEM, glancePrompt(prep.run.arm, prep.run, f), 0.004))
      score(prep, f, v, `${prep.run.arm} glance`)
    })
  }
  // The full read, at the end only: what a reader gets who scrolls through everything.
  if (args.includes('--full')) {
    await pool(prepared, CALLS, async prep => {
      const f = prep.frames.at(-1)!
      const v = parseJson(await caller.ask('full', keyOf(prep.run), glanceModel, FULL_SYSTEM, glancePrompt(prep.run.arm, prep.run, f, true), 0.006))
      score(prep, f, v, `${prep.run.arm} full read`)
    })
  }
  function score(prep: Prepared, f: Frame, v: any, name: string) {
      if (!v?.messages) return
      for (const id of f.sentIds) {
        const x = (v.messages as any[]).find(y => y.id === id)
        const status = ['done', 'waiting', 'working', 'unknown'].includes(x?.status) ? x.status : 'unknown'
        const pair = pairs.find(q => q.prep === prep && q.p.frame === f.label && q.p.msg === id)!
        const m = prep.sc.messages.find(y => y.id === id)!
        const answer = String(x?.answer ?? '')
        const link = pair.p.checkable ? (hits(m, answer) || (pair.p.byReaction && /✅|react/i.test(answer))) : undefined
        reader(name).set(pk(pair.p), { claim: status, ...(link !== undefined ? { link } : {}) })
      }
  }
  if (caller.stopped) console.log(`STOPPED: ${caller.stopped}`)

  // 4. Scores per run and reader, comparisons, and the files.
  const readers = [...verdicts.keys()]
  const perRun = (name: string, filter: (p: Pair) => boolean = () => true) => {
    const v = verdicts.get(name)!
    const byRun = new Map<string, { scenario: string; arm: 'A' | 'B'; r: Rates }>()
    for (const run of [...new Set(pairs.map(x => x.p.run))]) {
      const ps = pairs.filter(x => x.p.run === run && filter(x.p)).map(x => ({ p: x.p, v: v.get(pk(x.p))! })).filter(x => x.v)
      if (ps.length) byRun.set(run, { scenario: ps[0]!.p.scenario, arm: ps[0]!.p.arm, r: rates(ps) })
    }
    return byRun
  }
  const pooled = (name: string, filter: (p: Pair) => boolean = () => true) => {
    const v = verdicts.get(name)!
    return rates(pairs.filter(x => filter(x.p)).map(x => ({ p: x.p, v: v.get(pk(x.p))! })).filter(x => x.v))
  }
  const metricsList = ['answered', 'open', 'state', 'link', 'found', 'unknown', 'falseAnswered', 'falseDone', 'falseOpen'] as const
  const comparisons: Record<string, Record<string, { diff: number; p: number }>> = {}
  const pairsOf = (x: string, y: string, filter?: (p: Pair) => boolean) => {
    const out: Record<string, { diff: number; p: number }> = {}
    const X = perRun(x, filter)
    const Y = perRun(y, filter)
    for (const k of metricsList)
      out[k] = compare([...[...X.values()].map(r => ({ scenario: r.scenario, side: 'X' as const, v: r.r[k] })), ...[...Y.values()].map(r => ({ scenario: r.scenario, side: 'Y' as const, v: r.r[k] }))])
    return out
  }
  const sets = {
    all: (_: Pair) => true,
    end: (p: Pair) => p.frame === 'end',
    hard: (p: Pair) => all.find(s => s.id === p.scenario)?.set === 'hard',
    // A stricter truth: an offer without a question ("I can fix that if you like") is not waiting on you.
    'no offers': (p: Pair) => !(p.truth === 'waiting' && p.direct === false),
  }
  for (const [x, y] of [['A glance', 'B glance'], ['A panel', 'B glance'], ['A full read', 'B full read'], ['A glance', 'B full read']] as const)
    if (verdicts.has(x) && verdicts.has(y))
      for (const [sn, sf] of Object.entries(sets)) if (!(x + y).includes('full') || sn === 'end') comparisons[`${x} vs ${y} (${sn})`] = pairsOf(x, y, sf)

  const scores: Record<string, Record<string, Rates>> = {}
  for (const name of readers) scores[name] = Object.fromEntries(Object.entries(sets).map(([sn, sf]) => [sn, pooled(name, sf)]))
  const perScenario: Record<string, Record<string, Rates>> = {}
  for (const sc of [...new Set(pairs.map(x => x.p.scenario))])
    perScenario[sc] = Object.fromEntries(readers.map(n => [n, pooled(n, p => p.scenario === sc)]))
  // Where readers got a pair wrong, by kind (ids and states only: no text).
  const misses = readers.flatMap(name => pairs.flatMap(({ p }) => {
    const v = verdicts.get(name)!.get(pk(p))
    const badLink = v?.link === false && p.truth === 'done' && (v.claim === 'done' || v.claim === 'waiting')
    if (!v || (v.claim === p.truth && !badLink)) return []
    return [{ reader: name, run: p.run, frame: p.frame, msg: p.msg, truth: p.truth, claim: v.claim, ...(badLink ? { link: false } : {}) }]
  }))
  // Waiting on you, split by how Claude asked: did each reader see it as open?
  const waitingSplit = Object.fromEntries(readers.map(name => [name, Object.fromEntries((['direct', 'offer'] as const).map(k => {
    const xs = pairs.filter(x => x.p.truth === 'waiting' && x.p.direct === (k === 'direct')).map(x => verdicts.get(name)!.get(pk(x.p))).filter((v): v is Verdict => !!v)
    return [k, { n: xs.length, seenOpen: xs.filter(v => v.claim === 'waiting' || v.claim === 'working').length, lookedDone: xs.filter(v => v.claim === 'done').length }]
  }))]))
  const truthCounts = Object.fromEntries((['A', 'B'] as const).map(arm => [arm, Object.fromEntries((['done', 'waiting', 'working'] as State[]).map(s => [s, pairs.filter(x => x.p.arm === arm && x.p.truth === s).length]))]))
  const reading = Object.fromEntries((['A', 'B'] as const).map(arm => {
    const fs = prepared.filter(p => p.run.arm === arm).flatMap(p => p.frames)
    const words = (t: string) => t.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length
    return [arm, { frames: fs.length, screenWords: Math.round(mean(fs.map(f => words(f.screen)))), fullWordsAtEnd: Math.round(mean(prepared.filter(p => p.run.arm === arm).map(p => words(p.frames.at(-1)!.full ?? '')))), screenChars: Math.round(mean(fs.map(f => f.screenChars))), fullCharsAtEnd: Math.round(mean(prepared.filter(p => p.run.arm === arm).map(p => p.frames.at(-1)!.fullChars))) }]
  }))
  const ledger = existsSync(join(outDir, 'raw', 'ledger.jsonl')) ? readFileSync(join(outDir, 'raw', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Ledger) : []
  const spend = Object.fromEntries([...new Set(ledger.map(l => `${l.kind} (${l.model})`))].map(k => [k, { calls: ledger.filter(l => `${l.kind} (${l.model})` === k).length, usd: Number(sum(ledger.filter(l => `${l.kind} (${l.model})` === k).map(l => l.costUsd)).toFixed(4)) }]))
  const truthSources = { judged: prepared.filter(p => p.truth[0]?.source === 'judge').map(p => keyOf(p.run)), why: Object.fromEntries(prepared.filter(p => p.flags.length).map(p => [keyOf(p.run), p.flags])), rulesVsJudge: agree }
  const out = {
    about: 'Can you see what was answered? Ids, states, counts and scores only: no transcript text (that stays in raw/, which is never committed).',
    input: { results: relative(join(HERE, '..'), join(inDir, 'results.json')), runs: prepared.length }, screen: SCREEN, models: { glance: glanceModel, truth: truthModel },
    spentUsd: Number(budget.spent.toFixed(4)), cap: budget.cap, spend, stopped: caller.stopped, truthSources, truthCounts, reading,
    scores, comparisons, perScenario, waitingSplit,
    perRun: Object.fromEntries(readers.map(n => [n, Object.fromEntries([...perRun(n).entries()].map(([k, v]) => [k, v.r]))])),
    truth: Object.fromEntries(prepared.map(p => [keyOf(p.run), p.truth.map(({ id, answeredIn, asksIn, resolvedBy, source }) => ({ id, answeredIn, asksIn, resolvedBy, source }))])),
    panel: Object.fromEntries(prepared.filter(p => p.run.arm === 'A').map(p => [keyOf(p.run), Object.fromEntries(p.frames.map(f => [f.label, f.panel!.map(x => `${x.id}:${x.stale ? 'stale' : x.state}`).join(' ')]))])),
    misses,
  }
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(out, null, 2) + '\n')
  writeFileSync(join(outDir, 'summary.md'), summaryOf(out))
  console.log(JSON.stringify({ spent: out.spentUsd, truthCounts, reading, scores: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v.all])) }, null, 1))
  for (const [k, v] of Object.entries(comparisons)) console.log(k, Object.entries(v).map(([m, c]) => `${m} ${c.diff.toFixed(3)} p=${c.p.toFixed(3)}`).join('; '))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
