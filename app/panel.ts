// The panel on the left: replies you haven't read, questions waiting on you, who is working on
// what, where your messages stand. Narrower than MIN_FULL (or folded) it is an icon view.

import { matches, preview } from './inbox.ts'
import type { Inbox, MessageRef, PartRef } from './inbox.ts'
import { jobMark, jobName, scheduleLine, stateLabel } from './scheduled.ts'
import type { Job } from './scheduled.ts'
import type { Step, Turn, Work } from './session.ts'
import { currentTask } from './tasks.ts'
import type { AgentTask } from './tasks.ts'
import { C, cells, clip } from './text.ts'
import type { Line, Span } from './text.ts'

export const MIN_FULL = 24

/** A subagent Claude started: what it is, which of your messages (turn keys) it works for, how it is going. */
export type Agent = {
  id: string
  name: string
  type: string
  isBackground: boolean
  for: string[]
  startedAt: number
  endedAt?: number
  state: 'running' | 'done' | 'failed' | 'stopped'
  steps: number
  last: string
  taskId?: string
  /** What Claude asked it to do, what it did and said, and what it handed back. */
  prompt: string
  log: AgentEntry[]
  result?: string
  /** Claude's own view: who asked (your messages) and what its answer is called. */
  asker?: string
  resultLabel?: string
  /** The name it goes by in the app (James, Jake…), given in the order agents start. */
  person?: string
  /** A background agent's own transcript: how far the app has read it (bytes). */
  fileAt?: number
  /** What Claude asked it, in order: the Agent call's prompt, then each SendMessage to it. */
  tasks: AgentTask[]
  /** The name the Agent call gave it, which SendMessage can use. */
  alias?: string
  /** Rebuilt from the session file: the Claude Code that ran it has stopped. */
  isPast?: boolean
}

const NAMES = ['James', 'Jake', 'Maya', 'Leo', 'Nora', 'Omar', 'Zoe', 'Ravi', 'Lina', 'Theo', 'Ivy', 'Sami', 'Ezra', 'Mia', 'Hugo', 'Yara', 'Finn', 'Aria', 'Kai', 'Rosa']
const ROLES: Record<string, string> = { explore: 'explorer', plan: 'planner', 'general-purpose': 'implementer', claude: 'implementer', fork: 'helper', 'web-fetch': 'researcher', 'statusline-setup': 'setup' }

/** What an agent of this type does, in a word: explorer, planner, implementer, reviewer… */
export function roleOf(type: string): string {
  const t = type.toLowerCase()
  if (ROLES[t]) return ROLES[t]!
  if (/review/.test(t)) return 'reviewer'
  if (/test/.test(t)) return 'tester'
  if (/simplif/.test(t)) return 'simplifier'
  if (/plan|architect/.test(t)) return 'planner'
  if (/explor|search/.test(t)) return 'explorer'
  return t ? t.split(':').pop()!.replace(/[-_]+/g, ' ') : 'implementer'
}

/** An agent as the app names it, "James (explorer)". The first time, it gets the next free name. */
export function who(a: Agent, all: Iterable<Agent>): string {
  if (!a.person) {
    const named = [...all].filter(x => x.person)
    const used = new Set(named.map(x => x.person))
    const n = named.length
    let name = NAMES[n % NAMES.length]!
    if (used.has(name)) name = `${name} ${Math.floor(n / NAMES.length) + 1}`
    a.person = name
  }
  return `${a.person} (${roleOf(a.type)})`
}

/** One thing in an agent's own chat: words it wrote, or a tool it used. */
export type AgentEntry = { text: string } | { step: Step }

/** Finished agents stay listed this long. */
const AGENT_KEEP_MS = 10 * 60 * 1000

const ago = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${Math.floor(ms / 3_600_000)}h`)
export const FOLDED = 7

export type PanelCtx = {
  isResultsOnly: boolean
  isWorking: boolean
  /** The spinner's frame, for messages something is working on now. */
  spin?: string
  isFolded: boolean
  hscroll: number
  results: () => void
  fold: (folded: boolean) => void
  side: (delta: number) => void
  /** Unread replies, questions waiting on you, your latest messages. */
  box: Inbox
  openPart: (id: string) => void
  /** Drops questions from Waiting on you without answering them (by part id). */
  dismiss: (ids: string[]) => void
  openMessage: (turn: Turn) => void
  /** Claude's own steps right now, in the chat. */
  openWork: () => void
  /** The message Alt+↑/↓ is on. */
  picked: string
  /** Searching your messages: the query (null when not searching), and how to start. */
  query: string | null
  search: () => void
  /** The key to the marks, shown under the header of your recent messages. */
  isLegend: boolean
  legend: () => void
  next: () => void
  /** Marks replies read (✓ on an unread row, or all of them), or unread again. */
  readParts: (ids: string[]) => void
  unreadParts: (ids: string[]) => void
  /** The Unread box can show the replies you read last instead (newest read first). */
  readList: PartRef[]
  isReadTab: boolean
  readTab: (on: boolean) => void
  /** How much of Claude's work the chat shows. */
  work: Work
  setWork: (w: Work) => void
  agents: Agent[]
  /** Claude itself, while it works: the messages it is on and its latest step. */
  main?: { for: string[]; last: string }
  turnOf: (key: string) => Turn | undefined
  /** Opens an agent's own chat; which one is open. */
  openAgent: (id: string) => void
  agentView: string
  /** A click on one of your messages: the chat jumps to it, and it is the one Alt+→ answers from. */
  jumpTo: (turn: Turn) => void
  /** Opens one of your messages as a request: its whole chain. */
  openRequest: (turn: Turn) => void
  requestView: string
  /** Scheduled jobs to list (with the agent's name when one set it up), opening one, and which one is open. */
  jobs: { job: Job; by?: string }[]
  openJob: (toolId: string) => void
  jobView: string
  /** A topic's title (Not started shows it), and asking Claude to start on a request now. */
  topicTitle?: (id: string) => string | undefined
  startRequest?: (m: MessageRef) => void
  /** Where each section's box is scrolled to (by section id), and the rows the panel has. */
  scroll: Record<string, number>
  height: number
}

/** Your recent messages show at most this many rows; each section scrolls inside its own box. */
export const RECENT_ROWS = 20

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "14:05" today, "Mon 14:05" this week, "12 Nov" before. */
function stamp(at: number, now: number): string {
  const d = new Date(at)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === new Date(now).toDateString()) return hm
  if (now - at < 6 * 24 * 60 * 60 * 1000) return `${DAYS[d.getDay()]} ${hm}`
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

const mark = { claude: '⏳', progress: '▶', me: '✋', done: '✓', failed: '✕', none: '○', lost: '⚠' } as const
const markFg = { claude: C.cyan, progress: C.cyan, me: C.yellow, done: C.faint, failed: C.red, none: C.faint, lost: C.red } as const

/** What the marks of your messages mean (the ? in their header). A click anywhere on it closes it. */
function legendLines(width: number, close: () => void): Line[] {
  const item = (m: string, fg: number, what: string): Line => row(width, [{ text: `  ${m} `, style: { fg }, action: close }, { text: what, style: { fg: C.gray }, action: close }])
  return [
    item(mark.claude, markFg.claude, 'Claude is on it, no reply yet'),
    item(mark.progress, markFg.progress, 'replied, still owes work'),
    item('⠋', C.cyan, 'in progress: being worked on'),
    item(mark.me, markFg.me, 'waiting on you'),
    item(mark.done, C.gray, 'done'),
    item(mark.failed, markFg.failed, 'failed'),
    item(mark.none, C.gray, 'not answered'),
    item('⚠', C.red, 'reply lost'),
    row(width, [{ text: '  ↩ ', style: { fg: C.faint }, action: close }, { text: 'replied  ', style: { fg: C.gray }, action: close }, { text: '↻ ', style: { fg: C.faint }, action: close }, { text: 'status', style: { fg: C.gray }, action: close }]),
    row(width, [{ text: '  mark: open chain · text: jump', style: { fg: C.faint }, action: close }]),
  ]
}

/** One row: `left` fitted to the room `right` leaves, `right` flush with the edge. */
function row(width: number, left: Span[], right: Span[] = []): Line {
  const rightW = right.reduce((n, sp) => n + cells(sp.text), 0)
  let room = Math.max(1, width - rightW - (rightW ? 1 : 0))
  const out: Span[] = []
  for (const sp of left) {
    if (room <= 0) break
    const w = cells(sp.text)
    if (w <= room) {
      out.push(sp)
      room -= w
    } else {
      out.push({ ...sp, text: clip(sp.text, room) })
      room = 0
    }
  }
  if (room > 0) out.push({ text: ' '.repeat(room) })
  if (rightW) out.push({ text: ' ' }, ...right)
  return out
}

const rule = (width: number): Line => [{ text: '─'.repeat(width), style: { fg: C.faint } }]

/** Drops the first `n` cells of a title when scrolled sideways. */
function slide(text: string, n: number): string {
  if (n <= 0) return text
  let skipped = 0
  const chars = [...text]
  let i = 0
  while (i < chars.length && skipped < n) skipped += cells(chars[i++]!)
  return '‹' + chars.slice(i).join('')
}

/** How long something has waited, in its largest unit: "40s", "12m", "3h", "2d". */
export function waited(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`
}

/**
 * Your requests Claude still owes work on with nothing on them right now: in progress, not active,
 * and not among the messages `onIt` (running agents', and Claude's turn's). Longest waiting first.
 */
export function notStarted(messages: MessageRef[], onIt: ReadonlySet<string>): MessageRef[] {
  return messages.filter(m => m.state === 'progress' && !m.active && !onIt.has(m.turn.key)).sort((a, b) => a.updatedAt - b.updatedAt)
}

export type PanelList = { start: number; end: number; total: number; max: number }

export function panelLines(p: PanelCtx, width: number): { lines: Line[]; head: number; lists?: Record<string, PanelList> } {
  if (p.isFolded || width < MIN_FULL) {
    const open = () => p.fold(false)
    const L: Line[] = [
      row(width, [{ text: '☰', style: { bold: true, fg: C.cyan }, action: open }], [
        p.isWorking ? { text: '●', style: { fg: C.cyan } } : { text: '○', style: { fg: C.faint } },
      ]),
      rule(width),
    ]
    if (p.box.unread.length) L.push(row(width, [{ text: '●', style: { fg: C.magenta }, action: p.next }], [{ text: String(p.box.unread.length), style: { fg: C.magenta, bold: true }, action: p.next }]))
    if (p.box.waiting.length) {
      const first = () => p.openPart(p.box.waiting[0]!.id)
      L.push(row(width, [{ text: '✋', action: first }], [{ text: String(p.box.waiting.length), style: { fg: C.yellow, bold: true }, action: first }]))
    }
    const running = p.agents.filter(a => a.state === 'running').length
    if (running) L.push(row(width, [{ text: '◐', style: { fg: C.cyan } }], [{ text: String(running), style: { fg: C.cyan, bold: true } }]))
    const live = p.jobs.filter(x => x.job.state === 'scheduled').length
    if (live) L.push(row(width, [{ text: '⏰', style: { fg: C.yellow }, action: () => p.openJob(p.jobs.find(x => x.job.state === 'scheduled')!.job.toolId) }], [{ text: String(live), style: { fg: C.yellow, bold: true } }]))
    if (p.box.unread.length || p.box.waiting.length || running || live) L.push(rule(width))
    return { lines: L, head: 2 }
  }

  const L: Line[] = []
  L.push(row(width, [{ text: '☰ Overview', style: { bold: true, fg: C.cyan }, action: () => p.fold(true) }], [
    p.isWorking ? { text: '● working', style: { fg: C.cyan } } : { text: '○ idle', style: { fg: C.faint } },
  ]))
  L.push(row(width, [
    { text: 'show ', style: { fg: C.gray } },
    { text: ' all ', style: p.isResultsOnly ? { fg: C.gray } : { bold: true, inverse: true }, action: p.results },
    { text: ' ' },
    { text: ' results ', style: p.isResultsOnly ? { bold: true, inverse: true } : { fg: C.gray }, action: p.results },
  ], [
    { text: '‹', style: { fg: p.hscroll > 0 ? C.cyan : C.faint, bold: true }, action: () => p.side(-6) },
    { text: ' ' },
    { text: '›', style: { fg: C.cyan, bold: true }, action: () => p.side(6) },
  ]))
  // Claude's work: one folded line, file changes as diffs, or every step with its output.
  const choice = (w: Work, label: string): Span => ({ text: ` ${label} `, style: p.work === w ? { bold: true, inverse: true } : { fg: C.gray }, action: () => p.setWork(w) })
  L.push(row(width, [{ text: 'work ', style: { fg: C.gray } }, choice('folded', 'folded'), { text: ' ' }, choice('edits', 'edits'), { text: ' ' }, choice('all', 'all')]))
  L.push(rule(width))
  const head = L.length

  // Every section scrolls on its own, inside a box no taller than it needs; the heights are fitted to
  // the panel so the panel itself never has to scroll. The wheel over a section moves that section.
  const iw = width - 1 // a section row: one column for its scrollbar, then this
  type Section = { id: string; header: Line[]; rows: Line[]; footer?: Line[]; cap: number }
  const sections: Section[] = []
  const now = Date.now()
  const { unread, waiting, messages } = p.box
  const item = (lead: Span, text: string, action: () => void, dim = false, right: Span[] = []): Line =>
    row(iw, [lead, { text: slide(text, p.hscroll), style: { dim }, action }], right)

  // ---- Replies you haven't read, or (its other tab) the ones you read last.
  const tabs: Span[] = [
    { text: 'Unread', style: p.isReadTab ? { fg: C.gray } : { bold: true, fg: unread.length ? C.magenta : undefined, underline: true }, action: () => (p.isReadTab ? p.readTab(false) : p.next()) },
    { text: '  ' },
    { text: 'Read', style: p.isReadTab ? { bold: true, underline: true } : { fg: C.gray }, action: () => p.readTab(true) },
  ]
  if (p.isReadTab)
    sections.push({
      id: 'read',
      cap: 6,
      header: [row(width, tabs, [{ text: p.readList.length ? 'newest first' : 'none yet', style: { fg: C.faint } }])],
      // A click opens it again; ● on the left makes it unread.
      rows: p.readList.map(r => row(iw, [
        { text: ' ●', style: { fg: C.faint }, action: () => p.unreadParts([r.id]) },
        { text: ' ✓ ', style: { fg: C.faint }, action: () => p.openPart(r.id) },
        { text: slide(r.preview, p.hscroll), style: { fg: C.gray }, action: () => p.openPart(r.id) },
      ], [{ text: stamp(r.turn.at + (r.turn.durationMs ?? 0), now), style: { fg: C.faint }, action: () => p.openPart(r.id) }])),
    })
  else sections.push({
    id: 'unread',
    cap: 6,
    header: [row(width, tabs,
      unread.length ? [{ text: `${unread.length} `, style: { fg: C.magenta, bold: true }, action: p.next }, { text: 'next ▸', style: { fg: C.magenta }, action: p.next }] : [{ text: 'none', style: { fg: C.faint } }])],
    // ✓ on the left marks one read, without opening it.
    rows: unread.map(u => row(iw, [
      { text: ' ✓', style: { fg: C.green }, action: () => p.readParts([u.id]) },
      { text: ' ● ', style: { fg: C.magenta }, action: () => p.openPart(u.id) },
      { text: slide(u.preview, p.hscroll), action: () => p.openPart(u.id) },
    ])),
    ...(unread.length > 1 ? { footer: [row(width, [{ text: '    mark all read', style: { fg: C.gray }, action: () => p.readParts(unread.map(u => u.id)) }])] } : {}),
  })

  // ---- Questions waiting on you.
  if (waiting.length)
    sections.push({
      id: 'waiting',
      cap: 5,
      header: [row(width, [{ text: 'Waiting on you', style: { bold: true, fg: C.yellow } }], [{ text: String(waiting.length), style: { fg: C.yellow, bold: true } }])],
      // ✕ on the left dismisses one: you won't answer it, and Claude is told not to wait.
      rows: waiting.map(w => row(iw, [
        { text: ' ✕', style: { fg: C.gray }, action: () => p.dismiss([w.id]) },
        { text: ' ✋ ', style: { fg: C.yellow }, action: () => p.openPart(w.id) },
        { text: slide(w.question, p.hscroll), action: () => p.openPart(w.id) },
      ])),
      ...(waiting.length > 1 ? { footer: [row(width, [{ text: '    dismiss all', style: { fg: C.gray }, action: () => p.dismiss(waiting.map(w => w.id)) }])] } : {}),
    })

  // ---- Who is working on what: Claude itself, then (a section of their own) the agents it started,
  // each with the messages it is on.
  const shownAgents = p.agents.filter(a => a.state === 'running' || now - (a.endedAt ?? now) < AGENT_KEEP_MS)
  /** Under each worker: the message it is on (a click goes to that message, for context) and its latest step. */
  const about = (rows: Line[], keys: string[], last: string, dim: boolean, openLast: () => void) => {
    const turns = keys.map(p.turnOf).filter((t): t is Turn => !!t)
    const toMessage = () => turns[0] && p.openMessage(turns[0])
    const msg = turns.length ? `↳ “${preview(turns[0]!.text, 60)}”${turns.length > 1 ? ` +${turns.length - 1}` : ''}` : ''
    if (msg) rows.push(row(iw, [{ text: '   ' }, { text: slide(msg, p.hscroll), style: { fg: C.gray, dim, underline: true }, action: toMessage }]))
    if (last) rows.push(row(iw, [{ text: '   ' }, { text: slide(`· ${last}`, p.hscroll), style: { fg: C.faint }, action: openLast }]))
  }
  // One section for everyone working: Claude first, then each agent it started, by name and role.
  if (p.main || shownAgents.length) {
    const rows: Line[] = []
    // Claude itself opens its own live view.
    const open = p.openWork
    rows.push(row(iw, [
      { text: p.agentView === 'main' ? '▸' : ' ', style: { fg: C.claude }, action: open },
      { text: '✻ ', style: { fg: C.claude }, action: open },
      { text: 'Claude', style: { bold: true }, action: open },
      { text: ' (lead)', style: { fg: C.faint }, action: open },
    ], [{ text: p.main ? 'working' : 'idle', style: { fg: p.main ? C.cyan : C.faint }, action: open }]))
    if (p.main) about(rows, p.main.for, p.main.last, false, open)
    const running = shownAgents.filter(a => a.state === 'running').length + (p.main ? 1 : 0)
    for (const a of shownAgents) {
      const icon = a.state === 'running' ? { t: '◐', fg: C.cyan } : a.state === 'done' ? { t: '✓', fg: C.green } : a.state === 'failed' ? { t: '✕', fg: C.red } : { t: '■', fg: C.gray }
      // The agent itself opens its own chat: what it was asked, what it did, what it handed back.
      const open = () => p.openAgent(a.id)
      const isOn = p.agentView === a.id
      const right = a.state === 'running' ? ago(now - a.startedAt) : `${a.state} ${ago(now - (a.endedAt ?? now))} ago`
      const tasks = a.tasks.length
      rows.push(row(iw, [
        { text: isOn ? '▸' : ' ', style: { fg: C.magenta }, action: open },
        { text: `${icon.t} `, style: { fg: icon.fg }, action: open },
        { text: who(a, p.agents), style: { bold: a.state === 'running' || isOn, dim: a.state !== 'running' && !isOn, fg: isOn ? C.magenta : undefined }, action: open },
        // Several tasks (Claude sent it more work): how many, before the first one's name.
        { text: tasks > 1 ? ` · ${tasks} tasks` : '', style: { fg: C.magenta, dim: a.state !== 'running' }, action: open },
        { text: slide(` · ${a.name}`, p.hscroll), style: { fg: C.gray, dim: a.state !== 'running' }, action: open },
        { text: a.isBackground ? ' bg' : '', style: { fg: C.faint } },
      ], [{ text: right, style: { fg: a.state === 'running' ? C.cyan : C.faint } }]))
      const last = a.state === 'running' ? (a.last ? `${a.last}${a.steps > 1 ? ` (${a.steps} steps)` : ''}` : 'starting') : ''
      if (tasks > 1) {
        // The task it is on (the newest running one, else the last it had); its messages are in its view.
        const n = currentTask(a)
        rows.push(row(iw, [{ text: '   ' }, { text: slide(`↳ task ${n + 1} of ${tasks}: ${a.tasks[n]!.title}`, p.hscroll), style: { fg: C.gray, dim: a.state !== 'running' }, action: open }]))
        about(rows, [], last, false, open)
      } else about(rows, a.for, last, a.state !== 'running', open)
    }
    sections.push({
      id: 'agents',
      cap: 12,
      header: [row(width, [{ text: 'Agents', style: { bold: true, fg: C.magenta } }], [{ text: running ? `${running} working` : 'all done', style: { fg: running ? C.cyan : C.faint } }])],
      rows,
    })
  }

  // ---- Not started: requests Claude still owes work on, with nothing on them now (no running agent
  // is for them, and Claude's turn isn't on them). Oldest wait first.
  const onIt = new Set([
    ...p.agents.filter(a => a.state === 'running').flatMap(a => a.for),
    ...(p.main?.for ?? []).flatMap(k => [k, p.turnOf(k)?.aboutRequest ?? '']),
  ])
  const idle = notStarted(messages, onIt)
  if (idle.length)
    sections.push({
      id: 'notstarted',
      cap: 5,
      header: [row(width, [{ text: 'Not started', style: { bold: true, fg: C.yellow } }], [{ text: String(idle.length), style: { fg: C.yellow, bold: true } }])],
      rows: idle.map(m => {
        const open = () => p.openRequest(m.turn)
        const title = (m.topicId && p.topicTitle?.(m.topicId)) || preview(m.turn.text, 200)
        return row(iw, [
          { text: ' ▷ ', style: { fg: C.yellow }, action: open },
          { text: slide(title, p.hscroll), action: open },
        ], [
          ...(p.startRequest ? [{ text: '▶ start', style: { fg: C.cyan }, action: () => p.startRequest!(m) }, { text: ' ' }] : []),
          { text: waited(now - m.updatedAt), style: { fg: C.faint }, action: open },
        ])
      }),
    })

  // ---- Scheduled jobs (crons, /loop wakeups): what each is, when it runs next, how it stands.
  if (p.jobs.length) {
    const rows: Line[] = []
    let live = 0
    for (const { job: j, by } of p.jobs) {
      const isLive = j.state === 'scheduled' || j.state === 'setting up' || j.state === 'unknown'
      if (isLive) live++
      const open = () => p.openJob(j.toolId)
      const isOn = p.jobView === j.toolId
      rows.push(row(iw, [
        { text: isOn ? '▸' : ' ', style: { fg: C.yellow }, action: open },
        { text: `${jobMark(j)} `, style: { fg: isLive ? C.yellow : C.faint }, action: open },
        { text: slide(jobName(j, 80), p.hscroll), style: { bold: isOn, dim: !isLive && !isOn, fg: isOn ? C.yellow : undefined }, action: open },
      ], [{ text: stateLabel(j), style: { fg: j.state === 'scheduled' ? C.cyan : j.state === 'failed' ? C.red : C.faint }, action: open }]))
      rows.push(row(iw, [{ text: '   ' }, { text: slide(`${scheduleLine(j, now)}${by ? ` · by ${by}` : ''}`, p.hscroll), style: { fg: C.gray, dim: !isLive }, action: open }]))
    }
    sections.push({
      id: 'scheduled',
      cap: 8,
      header: [row(width, [{ text: 'Scheduled', style: { bold: true, fg: C.yellow } }], [{ text: live ? `${live} active` : 'none active', style: { fg: live ? C.cyan : C.faint } }])],
      rows,
    })
  }

  // ---- Your recent messages, newest first, with when you sent them.
  const found = p.query ? messages.filter(m => matches(m.turn.text, p.query!)) : messages
  if (messages.length)
    sections.push({
      id: 'recent',
      cap: RECENT_ROWS,
      header: [p.query != null
        ? row(width, [{ text: '⌕ ', style: { fg: C.yellow, bold: true } }, { text: p.query ? `“${p.query}”` : 'type to search', style: { fg: C.yellow } }], [{ text: `${found.length} of ${messages.length}`, style: { fg: C.yellow } }])
        : row(width, [{ text: 'Your recent messages', style: { bold: true } }], [
            { text: '?', style: p.isLegend ? { fg: C.cyan, bold: true, inverse: true } : { fg: C.cyan, bold: true }, action: p.legend },
            { text: '  ⌕', style: { fg: C.cyan, bold: true }, action: p.search },
            { text: `  ${messages.length}`, style: { fg: C.faint } },
          ]),
        ...(p.isLegend && p.query == null ? legendLines(width, p.legend) : [])],
      // A click jumps to the message in the chat. Its status mark opens it as a request: its chain,
      // where it stands, the agents on it.
      rows: !found.length ? [row(iw, [{ text: '   no message matches', style: { fg: C.faint, italic: true } }])] : found.map(m => {
        const open = () => p.jumpTo(m.turn)
        const chain = () => p.openRequest(m.turn)
        const isOn = p.requestView === m.turn.key
        const isPicked = p.picked === m.turn.key
        return row(iw, [
          { text: isOn ? '▸' : isPicked ? '›' : ' ', style: { fg: isPicked ? C.yellow : C.blue, bold: true }, action: open },
          { text: m.active ? (p.spin ?? mark[m.state]) : mark[m.state], style: { fg: markFg[m.state] }, action: chain },
          { text: ' ', action: open },
          { text: slide(preview(m.turn.text, 200), p.hscroll), style: { dim: m.state === 'done' && !isOn && !isPicked, bold: isOn || isPicked, fg: isOn ? C.blue : isPicked ? C.yellow : undefined }, action: open },
        ], [{ text: m.state === 'lost' ? 'reply lost' : m.active ? 'in progress' : m.stale ? 'waiting' : `${m.event === 'replied' ? '↩ ' : m.event === 'status' ? '↻ ' : ''}${stamp(m.updatedAt, now)}`, style: { fg: m.state === 'lost' ? C.red : m.active ? C.cyan : C.faint }, action: open }])
      }),
    })

  // Fit: each section gets the rows it has, up to its cap; while that is more than the panel holds,
  // the tallest gives one up (none goes below 2 while it has 2).
  const fixed = sections.reduce((n, sec, i) => n + sec.header.length + (sec.footer?.length ?? 0) + (i ? 1 : 0), 0)
  const room = Math.max(0, p.height - head - fixed)
  const size = sections.map(sec => Math.min(sec.rows.length, sec.cap))
  for (let total = size.reduce((a, b) => a + b, 0); total > room; total--) {
    let k = -1
    size.forEach((n, i) => {
      if (n > Math.min(2, sections[i]!.rows.length) && (k < 0 || n > size[k]!)) k = i
    })
    if (k < 0) break
    size[k]!--
  }

  const lists: Record<string, { start: number; end: number; total: number; max: number }> = {}
  sections.forEach((sec, si) => {
    if (si) L.push(rule(width))
    L.push(...sec.header)
    const n = size[si]!
    const total = sec.rows.length
    const at = Math.max(0, Math.min(p.scroll[sec.id] ?? 0, total - n))
    lists[sec.id] = { start: L.length, end: L.length + n, total, max: n }
    for (let i = 0; i < n; i++) {
      // A thin bar on the left edge says where the box is in the whole list.
      const isBar = total > n && i >= Math.floor((at / total) * n) && i <= Math.floor(((at + n - 1) / total) * n)
      L.push([{ text: total > n ? (isBar ? '▐' : '│') : ' ', style: { fg: isBar ? C.gray : C.faint } }, ...sec.rows[at + i]!])
    }
    L.push(...(sec.footer ?? []))
  })
  return { lines: L, head, lists }
}
