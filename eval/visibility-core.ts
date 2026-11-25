// The deterministic half of eval/visibility.ts: arm A replayed through the app's own code and drawn
// as the app draws it, arm B drawn as Claude Code's terminal, the ground truth's rules, and the scores.
// No model calls and no files written here (tests/unit/visibility.test.ts covers it).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Claude } from '../app/claude.ts'
import type { ClaudeEvent } from '../app/claude.ts'
import { chatLines } from '../app/chat.ts'
import { assignParts, hasMarks, inbox, preview, stripMarks } from '../app/inbox.ts'
import type { Inbox, MessageState } from '../app/inbox.ts'
import { panelLines } from '../app/panel.ts'
import { newTurn } from '../app/session.ts'
import type { Kept, Turn } from '../app/session.ts'
import type { Line } from '../app/text.ts'
import { emptyBoard, raiseTopic, settleTurn, stripTag } from '../hooks/model.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
// ---- Inputs -------------------------------------------------------------------------

export type Expect = { name: string; re: string; about?: string }
export type Message = { id: string; send: string; text: string; about?: string; quote?: { who: 'me' | 'claude'; of: string }; expect: Expect[] }
export type Scenario = { id: string; set: string; about: string; messages: Message[] }
export type Sent = { id: string; t: number; text: string; shown: string; topicId?: string; quoted?: string; midTurn: boolean }
export type SavedRun = {
  scenario: string; set: string; arm: 'A' | 'B'; rep: number; startedAt: string
  sent: Sent[]; texts: { t: number; text: string; sub: boolean }[]; results: { t: number; text: string }[]
  score: { messages: { id: string; addressedFinal: boolean; addressedAny: boolean; reacted?: string; checksOk?: boolean }[] }
  judge?: { verdict?: { messages?: { id: string; answered: number; correct: boolean; clear: number }[] } }
}

export function loadScenarios(): Scenario[] {
  const read = (f: string, set: string) => (JSON.parse(readFileSync(join(HERE, f), 'utf8')).scenarios as Scenario[]).map(s => ({ ...s, set }))
  return [...read('scenarios-hard.json', 'hard'), ...read('scenarios.json', 'baseline')]
}

export type Ev = { t: number; e: any }
export function readRaw(dir: string, run: SavedRun): Ev[] {
  const f = join(dir, `${run.scenario}-${run.arm}-r${run.rep}.jsonl`)
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => {
    const { t, ...e } = JSON.parse(l)
    return { t: Number(t), e }
  })
}

// ---- Arm A: the app's own logic, driven as app/main.ts drives it --------------------------

/** What the app holds at a moment: its turns, what it keeps, whether Claude is working. */
export type AppState = { turns: Turn[]; kept: Kept; isWorking: boolean }

/** app/main.ts submit(), for a message without request or agent view; `quote` is what the user replied to. */
export function submit(S: AppState, text: string, now: number, quote?: { who: 'me' | 'claude'; text: string; key?: string; topics?: string[] }) {
  const turn = newTurn(text, now)
  const quoted = quote?.topics ?? []
  const asked = S.kept.board.topics.filter(t => t.status === 'me')
  const answered = new Set(quoted.length ? quoted : asked.length === 1 && !/\?\s*$/.test(text) ? [asked[0]!.id] : [])
  S.kept.board = { ...S.kept.board, topics: S.kept.board.topics.map(t => (t.status === 'me' && answered.has(t.id) ? { ...t, status: 'claude' as const, updatedAt: now } : t)) }
  const raised = raiseTopic(S.kept.board, { text, key: turn.key, replyTo: null }, now)
  turn.topicId = raised.topicId
  S.kept.board = raised.board
  if (quote?.key) S.kept.links[turn.key] = { key: quote.key, who: quote.who, text: preview(quote.text, 60) }
  for (const t of S.turns.filter(x => !x.isDone)) {
    turn.pending = t.pending
    turn.queued = true
    t.pending = ''
    t.live = ''
    t.isDone = true
    t.continued = true
    t.durationMs = now - t.at
  }
  S.turns.push(turn)
  S.isWorking = true
  return turn
}

/** app/main.ts finishTurn() and autoLink(). */
export function finishTurn(S: AppState, resultText: string, isError: boolean, durationMs: number, now: number) {
  const open = S.turns.filter(t => !t.isDone)
  const last = open.at(-1)
  const raw = last?.pending || resultText
  for (const t of open) {
    t.isDone = true
    t.live = ''
    t.durationMs = now - t.at
  }
  if (last && raw) {
    last.answer = stripTag(raw)
    last.pending = ''
    if (isError) last.error = raw.slice(0, 200)
  }
  if (last) last.durationMs = durationMs || last.durationMs
  S.isWorking = false
  if (!raw) return
  S.kept.board = settleTurn(S.kept.board, raw, now, { flat: true }).board
  assignParts(S.turns, S.kept.board)
  const m = raw.match(/<(?:clued|threadline)>\s*(\{[\s\S]*\})\s*<\/(?:clued|threadline)>/)
  try {
    const react = m ? (JSON.parse(m[1]!) as { react?: unknown }).react : undefined
    const mine = S.turns.findLast(x => !x.reaction && !x.followUp)
    if (typeof react === 'string' && ['👀', '👍', '✅', '🎉'].includes(react) && mine && !S.kept.reactions[mine.key]?.some(r => r.by === 'claude'))
      S.kept.reactions[mine.key] = [...(S.kept.reactions[mine.key] ?? []), { emoji: react, by: 'claude' }]
  } catch {}
  if (!m) return
  let entries: { id?: unknown; about?: unknown; same_as?: unknown }[] = []
  try {
    entries = ((JSON.parse(m[1]!) as { topics?: unknown }).topics ?? []) as typeof entries
  } catch {
    return
  }
  if (!Array.isArray(entries)) return
  for (const e of entries) {
    const target = typeof e.about === 'string' ? e.about : typeof e.same_as === 'string' ? e.same_as : ''
    if (typeof e.id !== 'string' || !target || target === e.id) continue
    const at = S.turns.findLastIndex(t => t.topicId === e.id && !t.reaction)
    if (at < 0) continue
    const turn = S.turns[at]!
    if (S.kept.links[turn.key]) continue
    const topic = S.kept.board.topics.find(t => t.id === target)
    const earlier = S.turns.slice(0, at).findLast(t => !t.reaction && !t.followUp && (t.topicId === target || topic?.messageKeys.includes(t.key)))
    if (earlier) S.kept.links[turn.key] = { key: earlier.key, who: 'me', text: preview(earlier.text, 60), anchor: `me:${earlier.key}`, auto: true }
  }
}

/** app/main.ts onEvent(), for what these sessions hold (no agents ran in them). */
export function onEvent(S: AppState, ev: ClaudeEvent, now: number) {
  let t = S.turns.findLast(x => !x.isDone)
  if (!t && (ev.kind === 'text' || ev.kind === 'tool')) {
    // Claude writing with no message open: a follow-up turn on the latest message.
    t = newTurn('', now)
    t.key = `follow-${now.toString(36)}`
    t.followUp = S.turns.filter(x => !x.reaction && !x.followUp).slice(-1).map(x => x.key)
    S.turns.push(t)
    S.isWorking = true
  }
  switch (ev.kind) {
    case 'text':
      if (t) {
        t.pending = t.pending ? `${t.pending}\n\n${ev.text}` : ev.text
        t.live = ''
      }
      return
    case 'tool':
      if (!t) return
      if (hasMarks(t.pending)) {
        if (/<(?:clued|threadline)>[\s\S]*?<\/(?:clued|threadline)>/.test(t.pending)) {
          const was = S.kept.board.turnTopics
          S.kept.board = { ...settleTurn({ ...S.kept.board, turnTopics: [] }, t.pending, now, { flat: true }).board, turnTopics: was }
        }
        t.early = [...(t.early ?? []), stripTag(t.pending)]
        t.pending = ''
        assignParts(S.turns, S.kept.board)
      }
      t.steps.push({ tool: ev.tool, ...(t.pending ? { said: stripMarks(stripTag(t.pending)) } : {}) })
      t.pending = ''
      t.live = ''
      return
    case 'tool-result':
      for (const turn of S.turns) for (const s of turn.steps) if (s.tool.id === ev.id) { s.result = ev.text; s.isError = ev.isError }
      return
    case 'result':
      finishTurn(S, ev.text, ev.isError, ev.durationMs, now)
      return
  }
}

/** The stream parsed by app/claude.ts's own dispatch (no process: it only emits events). */
export function parser(emit: (ev: ClaudeEvent) => void): (e: any) => void {
  const c = Object.create(Claude.prototype) as { onEvent: (ev: ClaudeEvent) => void; write: (o: unknown) => void; dispatch: (e: any) => void }
  c.onEvent = emit
  c.write = () => {}
  return e => c.dispatch(e)
}

export const lineText = (l: Line) => l.map(s => s.text).join('').replace(/\s+$/, '')
export const noop = () => {}

/** One screen of clued, as text: the panel on the left, the end of the chat on the right. */
export const SCREEN = { cols: 120, rows: 40, panel: 38 }

export function screenA(S: AppState, box: Inbox, now: number): { panel: string[]; chat: string[] } {
  const messages = box.messages
  const panel = panelLines({
    isResultsOnly: false, isWorking: S.isWorking, spin: '⠋', isFolded: false, hscroll: 0, results: noop, fold: noop, side: noop, box,
    openPart: noop, dismiss: noop, openMessage: noop, openWork: noop, picked: '', query: null, search: noop, isLegend: false,
    legend: noop, next: noop, readParts: noop, unreadParts: noop, readList: [], isReadTab: false, readTab: noop, work: 'folded',
    setWork: noop, agents: [],
    main: S.isWorking ? { for: S.turns.filter(x => !x.isDone && !x.reaction).flatMap(x => x.followUp ?? [x.key]), last: 'working' } : undefined,
    turnOf: key => S.turns.findLast(x => x.key === key), openAgent: noop, agentView: '', jumpTo: noop, openRequest: noop,
    requestView: '', scroll: {}, height: SCREEN.rows, jobs: [], openJob: noop, jobView: '',
  }, SCREEN.panel)
  const lost = new Set(messages.filter(m => m.state === 'lost').map(m => m.turn))
  const replyBy = new Map(messages.filter(m => m.replyId).map(m => [m.turn, m.replyId!]))
  const chat = chatLines({
    turns: S.turns, kept: S.kept, isResultsOnly: false, picked: '', cwd: '/tmp/project', now, spin: '⠋', toggle: noop, reply: noop,
    replying: new Set(), react: noop, jump: noop, copy: noop, hover: '', unread: new Set(box.unread.map(p => p.id)),
    waiting: new Set(box.waiting.map(p => p.id)),
    messageOf: (id, answering) => {
      const before = S.turns.slice(0, S.turns.indexOf(answering) + 1)
      const own = before.findLast(t => t.topicId === id) ?? S.turns.find(t => t.topicId === id)
      if (own) return own
      const keys = new Set(S.kept.board.topics.find(t => t.id === id)?.messageKeys ?? [])
      return before.findLast(t => keys.has(t.key)) ?? S.turns.find(t => keys.has(t.key))
    },
    replyOf: t => replyBy.get(t), isLost: t => lost.has(t), chainOf: () => 0, openChain: noop, askAgain: noop, work: 'folded',
    poke: noop, isWorking: S.isWorking, agentName: () => undefined, openAgent: noop, setRead: noop, dismiss: noop,
  }, SCREEN.cols - SCREEN.panel - 3).lines
  return { panel: panel.lines.map(lineText), chat: chat.map(lineText) }
}

/** What the panel says about one message at a moment. */
export type PanelView = { id: string; state: MessageState; stale: boolean; replyText?: string; reacted: boolean }

/** A frame: what each arm shows at a moment. */
export type Frame = { t: number; label: string; sentIds: string[]; panel?: PanelView[]; screen: string; screenChars: number; fullChars: number; full?: string }

/** The moments to look at: just before each message after the first (what is open when you add one), and the end. */
export function moments(run: SavedRun): { t: number; label: string; sentIds: string[] }[] {
  const out = run.sent.slice(1).map((s, i) => ({ t: s.t, label: `before ${s.id}`, sentIds: run.sent.slice(0, i + 1).map(x => x.id) }))
  out.push({ t: Infinity, label: 'end', sentIds: run.sent.map(x => x.id) })
  return out
}

export const plainText = (s: string) => stripMarks(stripTag(s)).replace(/\s*\((T\d+(\.\d+)?(,\s*)?)+\)/g, '').replace(/\bT\d+(\.\d+)?\b:?\s*/g, '')

export function replayA(run: SavedRun, events: Ev[]): Frame[] {
  const S: AppState = { turns: [], kept: { board: emptyBoard(), reactions: {}, links: {} }, isWorking: false }
  // Clock times as the app had them: the run's start plus each event's offset (the panel shows "2m ago").
  const base = Date.parse(run.startedAt)
  let now = base
  const feed = parser(ev => onEvent(S, ev, now))
  const frames: Frame[] = []
  const snap = (m: { t: number; label: string; sentIds: string[] }) => {
    const at = Number.isFinite(m.t) ? base + m.t : now
    const reacted = new Set(Object.entries(S.kept.reactions).filter(([, l]) => l.some(r => r.by === 'claude')).map(([k]) => k))
    const box = inbox(S.turns, S.kept.board, new Set(), { isWorking: S.isWorking, busy: new Set(), now: at, reacted })
    const parts = S.turns.flatMap(t => (t.parts ?? []).map((p, i) => ({ id: p.id ?? `${t.key}:${i}`, text: p.text })))
    const panel: PanelView[] = []
    for (const s of run.sent.filter(x => m.sentIds.includes(x.id))) {
      const ref = box.messages.find(x => x.topicId === s.topicId)
      if (!ref) throw new Error(`${run.scenario} ${run.arm} r${run.rep}: no panel row for ${s.id} (${s.topicId})`)
      const replyText = ref.replyId ? parts.find(p => p.id === ref.replyId)?.text : undefined
      panel.push({ id: s.id, state: ref.state, stale: !!ref.stale, ...(replyText ? { replyText } : {}), reacted: reacted.has(ref.turn.key) })
    }
    const { panel: p, chat } = screenA(S, box, at)
    const chatRows = SCREEN.rows - 3 // the input box and status line take the rest
    const tail = chat.slice(-chatRows)
    const rows = Array.from({ length: Math.max(p.length, tail.length) }, (_, i) => `${(p[i] ?? '').padEnd(SCREEN.panel)} │ ${tail[i] ?? ''}`)
    const screen = rows.join('\n')
    const full = `${p.join('\n')}\n\n${chat.join('\n')}`
    frames.push({ ...m, t: at - base, panel, screen, screenChars: screen.length, fullChars: full.length, ...(m.label === 'end' ? { full } : {}) })
  }
  const sends = [...run.sent]
  const todo = moments(run)
  const quoteOf = (s: Sent) => {
    const msg = sends.find(x => x.id === s.id)
    if (!s.quoted || !msg) return undefined
    const mine = run.sent.find(x => x.text === s.quoted)
    if (mine) return { who: 'me' as const, text: s.quoted, key: S.turns.find(t => t.topicId === mine.topicId)?.key }
    const q = stripTag(s.quoted).trim()
    for (const t of S.turns) for (const p of t.parts ?? []) if (stripTag(p.text).trim() === q) return { who: 'claude' as const, text: s.quoted, key: t.key, topics: p.to }
    return { who: 'claude' as const, text: s.quoted }
  }
  let ei = 0
  for (const s of sends) {
    while (ei < events.length && events[ei]!.t < s.t) {
      now = base + events[ei]!.t
      feed(events[ei++]!.e)
    }
    while (todo.length && todo[0]!.t <= s.t) snap(todo.shift()!)
    now = base + s.t
    const turn = submit(S, s.text, now, quoteOf(s))
    if (s.topicId && turn.topicId !== s.topicId) throw new Error(`${run.scenario} A r${run.rep}: replay gave ${s.id} ${turn.topicId}, the run gave ${s.topicId}`)
  }
  while (ei < events.length) {
    now = base + events[ei]!.t
    feed(events[ei++]!.e)
  }
  for (const m of todo) snap(m)
  return frames
}

// ---- Arm B: Claude Code's terminal, drawn from the same stream ---------------------------

export function wrapText(text: string, width: number, first: string, rest: string): string[] {
  const out: string[] = []
  text.split('\n').forEach((para, pi) => {
    let line = ''
    const words = para.split(/(\s+)/)
    const lead = () => (out.length === 0 && pi === 0 ? first : rest)
    for (const w of words) {
      if ((lead() + line + w).length > width && line.trim()) {
        out.push(lead() + line.trimEnd())
        line = w.trimStart()
      } else line += w
    }
    out.push(lead() + line.trimEnd())
  })
  return out
}

export function toolLine(name: string, input: Record<string, unknown>): string {
  const arg = String(input.command ?? input.file_path ?? input.pattern ?? (Array.isArray(input.questions) ? (input.questions as { question?: string }[])[0]?.question : '') ?? '')
  const one = arg.replace(/\/tmp\/tl-eval-[^/\s]+\/?/g, '').replace(/\s+/g, ' ').trim()
  return `⏺ ${name}(${one.length > 90 ? `${one.slice(0, 89)}…` : one})`
}

/** Claude Code's chat: "> " your prompts, "⏺" Claude's text and one line per tool with the first line of its result. */
export function cliLines(run: SavedRun, events: Ev[], until: number, width: number): string[] {
  const items: { t: number; lines: string[] }[] = []
  for (const s of run.sent.filter(x => x.t < until)) items.push({ t: s.t, lines: ['', ...wrapText(s.shown, width, '> ', '  ')] })
  const results = new Map<string, string>()
  for (const { t, e } of events) {
    if (t >= until || e.parent_tool_use_id) continue
    if (e.type === 'user')
      for (const b of e.message?.content ?? [])
        if (b.type === 'tool_result') {
          const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x: any) => x.text ?? '').join('\n')
          results.set(b.tool_use_id, text)
        }
  }
  for (const { t, e } of events) {
    if (t >= until || e.type !== 'assistant' || e.parent_tool_use_id) continue
    for (const b of e.message?.content ?? []) {
      if (b.type === 'text' && b.text?.trim()) items.push({ t, lines: ['', ...wrapText(b.text.trim(), width, '⏺ ', '  ')] })
      else if (b.type === 'tool_use') {
        const r = results.get(b.id)
        const first = r ? r.split('\n').find(x => x.trim()) ?? '' : ''
        const more = r ? r.split('\n').length - 1 : 0
        items.push({ t, lines: ['', toolLine(b.name, b.input ?? {}), ...(r !== undefined ? [`  ⎿  ${preview(first.replace(/\/tmp\/tl-eval-[^/\s]+\/?/g, ''), width - 20)}${more > 0 ? ` … +${more} lines` : ''}`] : [])] })
      }
    }
  }
  return items.sort((a, b) => a.t - b.t).flatMap(x => x.lines)
}

export function framesB(run: SavedRun, events: Ev[]): Frame[] {
  const end = (events.at(-1)?.t ?? 0) + 1
  return moments(run).map(m => {
    const until = Number.isFinite(m.t) ? m.t : end
    const all = cliLines(run, events, until, SCREEN.cols - 2)
    const screen = all.slice(-(SCREEN.rows - 3)).join('\n')
    const full = all.join('\n')
    return { ...m, t: until, screen, screenChars: screen.length, fullChars: full.length, ...(m.label === 'end' ? { full } : {}) }
  })
}


// ---- Ground truth ------------------------------------------------------------------------

/** Claude's visible text, in order: `reply` is a final answer (no tool after it in its turn) or a marked part. */
export type Block = { id: string; t: number; plain: string; reply: boolean; react?: string; turn: string[] }

export function blocksOf(run: SavedRun, events: Ev[]): { blocks: Block[]; tools: { t: number; line: string }[] } {
  type Item = { t: number; kind: 'text' | 'tool' | 'result'; text?: string }
  const items: Item[] = []
  const tools: { t: number; line: string }[] = []
  for (const { t, e } of events) {
    if (e.parent_tool_use_id) continue
    if (e.type === 'assistant')
      for (const b of e.message?.content ?? []) {
        if (b.type === 'text' && b.text) items.push({ t, kind: 'text', text: b.text })
        else if (b.type === 'tool_use') {
          items.push({ t, kind: 'tool' })
          tools.push({ t, line: toolLine(b.name, b.input ?? {}).replace(/^⏺ /, '') })
        }
      }
    else if (e.type === 'result') items.push({ t, kind: 'result', text: typeof e.result === 'string' ? e.result : '' })
  }
  const blocks: Block[] = []
  let prevResult = -1
  items.forEach((it, i) => {
    if (it.kind === 'result') {
      prevResult = it.t
      return
    }
    if (it.kind !== 'text') return
    const rest = items.slice(i + 1)
    const end = rest.findIndex(x => x.kind === 'result')
    const isFinal = !rest.slice(0, end < 0 ? rest.length : end).some(x => x.kind === 'tool')
    const resultT = end < 0 ? Infinity : rest[end]!.t
    const plain = plainText(it.text!).trim()
    let react: string | undefined
    if (!plain) {
      try {
        react = JSON.parse(it.text!.match(/<(?:clued|threadline)>\s*(\{[\s\S]*\})\s*<\/(?:clued|threadline)>/)?.[1] ?? '{}').react
      } catch {}
      if (typeof react !== 'string') return
    }
    const turn = run.sent.filter(s => s.t > prevResult && s.t <= resultT).map(s => s.id)
    blocks.push({ id: `C${blocks.length + 1}`, t: it.t, plain, reply: isFinal || hasMarks(it.text!), ...(react ? { react } : {}), turn })
  })
  return { blocks, tools }
}

/** Per message: when it was answered (and by which block), when Claude asked the user about it, when the user answered that. */
export type Truth = { id: string; answeredIn?: string; answeredAt?: number; asksIn?: string; asksAt?: number; resolvedBy?: string; resolvedAt?: number; source: 'rules' | 'judge' }
export type State = 'done' | 'waiting' | 'working'

export function stateAt(tr: Truth, t: number): State {
  if (tr.asksAt != null && t > tr.asksAt && (tr.resolvedAt == null || t <= tr.resolvedAt)) return 'waiting'
  if (tr.answeredAt != null && t > tr.answeredAt) return 'done'
  return 'working'
}

export const factsOf = (m: Message) => m.expect.filter(e => e.re !== '\\?')
/** Every fact is in the text. Markdown marks and underscores are ignored on both sides: the panel's previews drop them ("discountprice"). */
export const hits = (m: Message, text: string) => {
  const bare = text.replace(/[*_`~]+/g, '')
  return factsOf(m).length > 0 && factsOf(m).every(e => new RegExp(e.re, 'i').test(text) || new RegExp(e.re.replace(/_/g, ''), 'i').test(bare))
}

/** The rules: the first reply block after the message that states every fact (with the subject named, or in a turn that answers only it). */
export function ruleTruth(sc: Scenario, run: SavedRun, blocks: Block[]): Truth[] {
  return sc.messages.map(m => {
    const s = run.sent.find(x => x.id === m.id)
    if (!s) return { id: m.id, source: 'rules' as const }
    const isQuestion = /\?\s*$/.test(m.text)
    const after = blocks.filter(b => b.t >= s.t && (b.reply || isQuestion))
    const about = (e: Expect) => e.about ?? m.about
    let at: Block | undefined
    const facts = factsOf(m)
    if (facts.length) {
      const firsts = facts.map(e => after.find(b => new RegExp(e.re, 'i').test(b.plain) && (!about(e) || new RegExp(about(e)!, 'i').test(b.plain) || (b.turn.length === 1 && b.turn[0] === m.id))))
      if (firsts.every(Boolean)) at = firsts.sort((a, b) => a!.t - b!.t).at(-1)
    }
    // A reaction-only reply to a small request: the app puts the ✅ on the message itself.
    if (!at) at = after.find(b => b.react && b.turn.at(-1) === m.id)
    return { id: m.id, ...(at ? { answeredIn: at.id, answeredAt: at.t } : {}), source: 'rules' as const }
  })
}

/** Runs the rules can't settle: Claude asked the user something, or the old judge saw a message as not fully or not clearly answered. */
export function needsJudge(run: SavedRun, blocks: Block[], truth: Truth[]): string[] {
  const why: string[] = []
  const noCode = (s: string) => s.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
  if (blocks.some(b => b.plain && noCode(b.plain).includes('?'))) why.push('Claude asked a question')
  const jm = run.judge?.verdict?.messages ?? []
  if (jm.some(x => x.answered < 2 || !x.correct || x.clear < 2)) why.push('old judge: not fully, correctly or clearly answered')
  if (truth.some(t => !t.answeredIn)) why.push('rules found no answer')
  return why
}

/** The careful judge's transcript, the same for both arms: your messages, Claude's text blocks (numbered), its tool calls. */
export function judgeTranscript(run: SavedRun, blocks: Block[], tools: { t: number; line: string }[]): string {
  const items: { t: number; line: string }[] = run.sent.map((s, i) => ({ t: s.t, line: `[U${i + 1}] user, at ${(s.t / 1000).toFixed(1)} s${s.midTurn ? ' (sent while Claude was working)' : ''}:\n${s.shown}` }))
  for (const b of blocks)
    items.push({ t: b.t, line: b.react ? `[${b.id}] Claude, at ${(b.t / 1000).toFixed(1)} s: reacted ${b.react} to the user's latest message (no text)` : `[${b.id}] Claude, at ${(b.t / 1000).toFixed(1)} s, ${b.reply ? 'reply' : 'written between tool calls'}:\n${b.plain}` })
  for (const x of tools) items.push({ t: x.t, line: `(Claude used a tool: ${x.line})` })
  return items.sort((a, b) => a.t - b.t).map(x => x.line).join('\n\n')
}

export const TRUTH_SYSTEM = [
  'You set the ground truth for a chat between a user and a coding assistant (Claude). Reply with JSON only, no prose, no code fence.',
  'For each user message U1..Un give {"id":"U1","answered_in":"C3"|null,"asks_user_in":"C2"|null,"resolved_by":"U4"|null}.',
  'answered_in: the first Claude block after which this message is fully answered: what it asked is stated, or the work it asked for is',
  'reported done (a plan or "I will" is not enough). For a message that tells Claude to ask something first, the block that finally does',
  'the work. A reaction with no text counts as reporting a small request done. If the facts are spread over blocks, the last of them. null if never.',
  'asks_user_in: the first Claude block that asks the user a real question about this message, or about something its reply raised',
  '(a decision, a choice, whether to change something), not a courtesy like "anything else?". Give a question to the message whose reply',
  'first raised it, not to later messages whose replies only repeat it. null if none.',
  'resolved_by: the user message that answers that question, null if the user never does.',
  'Output: {"messages":[...]}',
].join(' ')

// ---- Scoring ---------------------------------------------------------------------------

/** `direct`: when it waits on you, Claude asked with a question mark (else it offered: "I can change that if you like"). */
export type Pair = { run: string; scenario: string; arm: 'A' | 'B'; rep: number; frame: string; msg: string; truth: State; checkable: boolean; byReaction: boolean; direct?: boolean }
export type Verdict = { claim: State | 'unknown'; link?: boolean }

export const isOpen = (s: State) => s !== 'done'
export const isAnswered = (s: State) => s !== 'working'

export function rates(ps: { p: Pair; v: Verdict }[]) {
  const n = ps.length
  const ok = (f: (x: { p: Pair; v: Verdict }) => boolean) => (n ? ps.filter(f).length / n : NaN)
  const linkable = ps.filter(x => x.p.truth === 'done' && x.p.checkable && (x.v.claim === 'done' || x.v.claim === 'waiting') && x.v.link !== undefined)
  return {
    n,
    answered: ok(x => x.v.claim !== 'unknown' && isAnswered(x.v.claim) === isAnswered(x.p.truth)),
    open: ok(x => x.v.claim !== 'unknown' && isOpen(x.v.claim) === isOpen(x.p.truth)),
    state: ok(x => x.v.claim === x.p.truth),
    link: linkable.length ? linkable.filter(x => x.v.link).length / linkable.length : NaN,
    linkN: linkable.length,
    /** Of the messages answered by then, the share whose answer the reader found (the panel: linked to the right reply), whatever it said of the rest. */
    found: (() => {
      const xs = ps.filter(x => x.p.truth === 'done' && x.p.checkable)
      return xs.length ? xs.filter(x => (x.v.claim === 'done' || x.v.claim === 'waiting') && x.v.link === true).length / xs.length : NaN
    })(),
    unknown: ok(x => x.v.claim === 'unknown'),
    /** Not answered yet, but it looked answered. */
    falseAnswered: ps.filter(x => x.p.truth === 'working' && x.v.claim !== 'unknown' && isAnswered(x.v.claim)).length,
    /** Still open (on Claude or on you), but it looked done. */
    falseDone: ps.filter(x => isOpen(x.p.truth) && x.v.claim === 'done').length,
    /** Done, but it looked open. */
    falseOpen: ps.filter(x => x.p.truth === 'done' && x.v.claim !== 'unknown' && isOpen(x.v.claim)).length,
    notAnswered: ps.filter(x => x.p.truth === 'working').length,
    openTruth: ps.filter(x => isOpen(x.p.truth)).length,
  }
}
export type Rates = ReturnType<typeof rates>

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
export const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : NaN)
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

/** As eval/run.ts compare(): the mean over scenarios of (mean X − mean Y) per run, and a permutation p that shuffles labels within each scenario. */
export function compare(rows: { scenario: string; side: 'X' | 'Y'; v: number }[]): { diff: number; p: number } {
  const strata = [...new Set(rows.map(r => r.scenario))].map(id => rows.filter(r => r.scenario === id && Number.isFinite(r.v))).filter(s => s.some(x => x.side === 'X') && s.some(x => x.side === 'Y'))
  const stat = (ss: { side: 'X' | 'Y'; v: number }[][]) => mean(ss.map(s => mean(s.filter(x => x.side === 'X').map(x => x.v)) - mean(s.filter(x => x.side === 'Y').map(x => x.v))))
  if (!strata.length) return { diff: NaN, p: NaN }
  const observed = stat(strata)
  const rand = rng(12345)
  let extreme = 0
  const N = 5000
  for (let i = 0; i < N; i++) {
    const perm = strata.map(s => {
      const sides = shuffle(s.map(x => x.side), rand)
      return s.map((x, j) => ({ side: sides[j]!, v: x.v }))
    })
    if (Math.abs(stat(perm)) >= Math.abs(observed) - 1e-12) extreme++
  }
  return { diff: observed, p: (extreme + 1) / (N + 1) }
}


// ---- Reading the panel ------------------------------------------------------------------

/** The panel's mark as a state: ✓ done, ✋ waiting on you, anything else still with Claude. */
export const panelClaim = (p: PanelView): State => (p.stale ? 'working' : p.state === 'done' ? 'done' : p.state === 'me' ? 'waiting' : 'working')
export const norm = (s: string) => plainText(s).replace(/\s+/g, ' ').trim()
