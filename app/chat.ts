// The conversation: your messages in bubbles on the right; Claude's work folded into one line;
// Claude's answer in a bubble on the left, with reply and reactions under it.

import { firstLine, stripTag } from '../hooks/model.ts'
import { markdown } from './markdown.ts'
import { preview, questionsOf, splitAnswer, stripMarks } from './inbox.ts'
import { block, codeRows, diffHead, diffRows, hunkGap, K, langOf, readRows, shellRows } from './code.ts'
import type { Lang, Row } from './code.ts'
import type { Kept, Step, Turn, Work } from './session.ts'
import { ago, roleOf } from './panel.ts'
import type { Agent } from './panel.ts'
import { canContinue, currentTask, cutLabel, isQuiet, pulseOf, todosOf } from './tasks.ts'
import type { AgentTask, Todo } from './tasks.ts'
import { clock, cronWords, jobMark, scheduleLine, stateLabel } from './scheduled.ts'
import type { Job } from './scheduled.ts'
import type { Part } from './inbox.ts'
import { C, cells, clip, lineCells, pad, wrap } from './text.ts'
import type { Line, Span, Style } from './text.ts'

export type ChatCtx = {
  turns: Turn[]
  /** The message Alt+↑/↓ is on: its bubble stands out. */
  picked?: string
  kept: Kept
  isResultsOnly: boolean
  cwd: string
  now: number
  spin: string
  toggle: (t: Turn) => void
  /** `parts`: reply to these parts of Claude's answer (added to a reply already being written). */
  reply: (who: 'me' | 'claude', t: Turn, parts?: number[]) => void
  /** What the reply being written answers (anchors). */
  replying: ReadonlySet<string>
  /** `part`: a reaction on one reply part (when the answer has several), not on the whole answer. */
  react: (t: Turn, emoji: string, part?: number) => void
  jump: (anchor: string) => void
  /** Puts text on the clipboard. */
  copy: (text: string) => void
  /** The message under the pointer (`me:<key>` or `claude:<key>`): only it shows its actions. */
  hover: string
  /** Reply parts not read yet, and those that wait on your answer (`<turn key>:<index>`). */
  unread: ReadonlySet<string>
  waiting: ReadonlySet<string>
  /** Your message for a topic id, and the latest reply part to a message of yours. */
  messageOf: (topicId: string, answering: Turn) => Turn | undefined
  replyOf: (t: Turn) => string | undefined
  /** Claude's tag settled this message, but no reply to it arrived; asking for it again. */
  isLost: (t: Turn) => boolean
  /** A message's chain: how many messages and replies it holds besides it, and its view. */
  chainOf: (t: Turn) => number
  openChain: (t: Turn) => void
  askAgain: (t: Turn) => void
  /** How much of Claude's work to show. */
  work: Work
  /** Redraws after a click changed a step. */
  poke: () => void
  /** Whether Claude is working now (work carried on under a later message is still going). */
  isWorking: boolean
  /** An agent's name, and opening its view (for messages sent from inside one). */
  agentName: (id: string) => string | undefined
  openAgent: (id: string) => void
  /** Asks Claude to continue an agent its Claude Code's exit stopped. */
  continueAgent?: (id: string) => void
  /** Goes to one of your messages in the main chat (from an agent's task). */
  openMessage?: (t: Turn) => void
  /** A request's view draws only its chain: your messages in it, and the reply parts about it. */
  showMessage?: (t: Turn) => boolean
  /** Marks reply parts read or unread by hand. */
  setRead: (ids: string[], isRead: boolean) => void
  dismiss: (ids: string[]) => void
  showPart?: (p: Part) => boolean
  /** A turn a scheduled job started: what to say above it, and opening that job's view. */
  firedBy?: (t: Turn) => { label: string; open?: () => void } | undefined
}

export const QUICK = ['👍', '👎', '❓', '👀']

// ---- Steps --------------------------------------------------------------------

const rel = (p: unknown, cwd: string) => {
  const s = String(p ?? '')
  return s.startsWith(cwd + '/') ? s.slice(cwd.length + 1) : s.replace(/^\/home\/[^/]+/, '~')
}

/** One step as an icon and a short line. */
export function stepLabel(s: Step, cwd: string): { icon: string; text: string } {
  const i = s.tool.input
  switch (s.tool.name) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return { icon: '✎', text: `${s.tool.name === 'Write' ? 'Wrote' : 'Edited'} ${rel(i.file_path ?? i.notebook_path, cwd)}` }
    case 'Read':
      return { icon: '◔', text: `Read ${rel(i.file_path, cwd)}` }
    case 'Bash':
      return { icon: '$', text: String(i.description || firstLine(String(i.command ?? ''), 200)) }
    case 'Grep':
      return { icon: '⌕', text: `Searched for ${String(i.pattern ?? '')}` }
    case 'Glob':
      return { icon: '⌕', text: `Found files ${String(i.pattern ?? '')}` }
    case 'Agent':
    case 'Task':
      return { icon: '◇', text: `Agent: ${String(i.description ?? '')}` }
    case 'WebFetch':
      return { icon: '⇣', text: `Fetched ${String(i.url ?? '')}` }
    case 'WebSearch':
      return { icon: '⌕', text: `Searched the web for ${String(i.query ?? '')}` }
    case 'TodoWrite':
      return { icon: '☐', text: 'Updated the plan' }
    case 'Demo':
      return { icon: '·', text: String(i.step ?? '') }
    case 'AskUserQuestion': {
      const qs: any[] = Array.isArray(i.questions) ? i.questions : []
      return { icon: '?', text: `Asked you: ${qs.map(q => String(q?.question ?? '')).join(' · ')}` }
    }
    case 'Skill':
      return { icon: '✦', text: `Skill ${String(i.skill ?? '')}` }
    default: {
      const name = s.tool.name.replace(/^mcp__([^_]+)__/, '$1: ')
      return { icon: '·', text: name }
    }
  }
}

/** "8 steps · edited 3 files · ran 4 commands · read 5 files" */
function summary(steps: Step[]): string {
  const edited = new Set<string>()
  const read = new Set<string>()
  let ran = 0
  let searched = 0
  let agents = 0
  let other = 0
  for (const s of steps) {
    const n = s.tool.name
    if (n === 'Edit' || n === 'Write' || n === 'MultiEdit' || n === 'NotebookEdit') edited.add(String(s.tool.input.file_path ?? s.tool.input.notebook_path))
    else if (n === 'Read') read.add(String(s.tool.input.file_path))
    else if (n === 'Bash') ran++
    else if (n === 'Grep' || n === 'Glob' || n === 'WebSearch') searched++
    else if (n === 'Agent' || n === 'Task') agents++
    else other++
  }
  const parts = [`${steps.length} step${steps.length === 1 ? '' : 's'}`]
  if (edited.size) parts.push(`edited ${edited.size} file${edited.size === 1 ? '' : 's'}`)
  if (ran) parts.push(`ran ${ran} command${ran === 1 ? '' : 's'}`)
  if (read.size) parts.push(`read ${read.size} file${read.size === 1 ? '' : 's'}`)
  if (searched) parts.push(`${searched} search${searched === 1 ? '' : 'es'}`)
  if (agents) parts.push(`${agents} agent${agents === 1 ? '' : 's'}`)
  if (other && parts.length === 1) parts.push(`${other} tool${other === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
export const isEdit = (s: Step) => EDITS.has(s.tool.name)

/** Rows of one step's details before "… N more lines". */
const DETAIL_ROWS = 40

/** A tool's input as `key: value` lines: strings as they are, other values as short JSON. */
export function fieldLines(input: Record<string, unknown>, width: number): Line[] {
  const rows: Line[] = []
  let budget = 2000
  for (const [k, v] of Object.entries(input)) {
    if (v == null || v === '' || budget <= 0) continue
    let text = typeof v === 'string' ? v : JSON.stringify(v)
    if (text.length > budget) text = text.slice(0, budget) + '…'
    budget -= text.length
    const key: Span = { text: `${k}: `, style: { fg: C.gray } }
    const val: Style = { fg: typeof v === 'string' ? C.white : typeof v === 'object' ? C.gray : K.number }
    const lines = text.split('\n')
    if (lines.length === 1) rows.push(...wrap([key, { text: text.replace(/\t/g, '  '), style: val }], width, [pad(2)]))
    else {
      rows.push([key])
      for (const l of lines) rows.push(...wrap([{ text: l.replace(/\t/g, '  ') || ' ', style: val }], width - 2, [pad(2)]).map(r => [pad(2), ...r]))
    }
  }
  return rows
}

/** What a step did, exactly: an edit as a diff, a new file's text, a command and its output. */
export function stepDetail(s: Step, width: number, left: number, ctx: ChatCtx): Line[] {
  const i = s.tool.input
  const rows: Line[] = []
  const path = rel(i.file_path ?? i.notebook_path, ctx.cwd)
  const plain = (text: string, style: Style) => {
    for (const l of wrap([{ text: text.replace(/\t/g, '  ') || ' ', style }], width - 2)) rows.push([pad(2), ...l])
  }
  const edits = (list: { old_string?: unknown; new_string?: unknown }[]) => {
    const all = list.map(e => diffRows(String(e.old_string ?? ''), String(e.new_string ?? '')))
    const body: Row[] = []
    all.forEach((d, n) => body.push(...(n ? [hunkGap()] : []), ...d.rows))
    rows.push(...block(body, width, diffHead(path, all.reduce((n, d) => n + d.added, 0), all.reduce((n, d) => n + d.removed, 0))))
  }
  const written = (text: string, lang: Lang | undefined) => {
    const lines = text.replace(/\n$/, '').split('\n')
    rows.push(...block(codeRows(lines, lang, 1, { fg: K.addSign, bg: K.addBg }, '+'), width, diffHead(path, lines.length, 0)))
  }
  switch (s.tool.name) {
    case 'Edit':
      edits([i as { old_string?: unknown; new_string?: unknown }])
      break
    case 'MultiEdit':
      edits((i.edits ?? []) as { old_string?: unknown; new_string?: unknown }[])
      break
    case 'Write':
      written(String(i.content ?? ''), langOf(String(i.file_path ?? '')))
      break
    case 'NotebookEdit':
      written(String(i.new_source ?? ''), i.cell_type === 'markdown' ? 'md' : 'py')
      break
    case 'Read': {
      const r = s.result != null && !s.isError ? readRows(s.result, langOf(String(i.file_path ?? ''))) : []
      const range = [i.offset != null ? `from line ${i.offset}` : '', i.limit != null ? `${i.limit} lines` : ''].filter(Boolean).join(', ')
      if (range) rows.push([pad(2), { text: range, style: { fg: C.faint } }])
      if (r.length) rows.push(...block(r, width))
      else if (s.result) plain(s.result.replace(/<\/?system-reminder>/g, '').trim(), { fg: s.isError ? C.red : C.faint })
      break
    }
    case 'Bash': {
      const cmd = String(i.command ?? '')
      rows.push(...block(shellRows(cmd, s.result, s.isError), width, { left: [{ text: ' bash', style: { fg: C.gray, italic: true } }], right: [{ text: '⧉ copy ', style: { fg: C.cyan }, action: () => ctx.copy(cmd) }] }))
      break
    }
    case 'TodoWrite':
      rows.push(...todoLines((i.todos ?? []) as Partial<Todo>[], width, 2))
      break
    default: {
      for (const l of fieldLines(i, width - 2)) rows.push([pad(2), ...l])
      // What an agent hands back is markdown, with code in it.
      if (s.result && (s.tool.name === 'Agent' || s.tool.name === 'Task') && !s.isError) for (const l of markdown(s.result, width - 2, ctx.copy)) rows.push([pad(2), ...l])
      else if (s.result) plain(s.result.replace(/\s+$/, ''), { fg: s.isError ? C.red : C.faint })
    }
  }
  // An edit that failed says why (the text to replace was not found, the file changed).
  if (s.isError && s.result && isEdit(s)) plain(s.result.replace(/\s+$/, ''), { fg: C.red })
  const shown = s.isFull ? rows : rows.slice(0, DETAIL_ROWS)
  // A code row's indent is not copied either, as its gutter is not: a copy holds the code alone.
  const out = shown.map(l => [{ ...pad(left), ...(l[0]?.noCopy ? { noCopy: true } : {}) }, ...l])
  if (shown.length < rows.length)
    out.push([pad(left), { text: `… ${rows.length - shown.length} more lines, show all`, style: { fg: C.cyan }, action: () => { s.isFull = true; ctx.poke() } }])
  return out
}

/** A to-do list: ☑ done, ◐ in progress, ☐ to do, each item wrapped under itself. */
export function todoLines(todos: Partial<Todo>[], width: number, left: number): Line[] {
  const rows: Line[] = []
  for (const t of todos) {
    const mark = t.status === 'completed' ? '☑ ' : t.status === 'in_progress' ? '◐ ' : '☐ '
    const style: Style = t.status === 'completed' ? { fg: C.gray } : t.status === 'in_progress' ? { fg: C.cyan } : {}
    for (const [n, l] of wrap([{ text: String(t.content ?? '') }], width - left - 2).entries()) rows.push([pad(left), { text: n ? '  ' : mark, style: { fg: C.cyan } }, ...l.map(x => ({ ...x, style }))])
  }
  return rows
}

const secs = (ms: number) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`)

// ---- Bubbles ------------------------------------------------------------------

/** A rounded box around `body`, `inner` cells wide, placed `left` cells in. */
function bubble(body: Line[], inner: number, left: number, border: Style, header?: Line, headerAction?: () => void, tag?: Span, foot?: Span): Line[] {
  const out: Line[] = []
  const b = (t: string): Span => ({ text: t, style: border })
  // A tag sits in the top border: ╭─ ↩ “your message” ──╮
  const tagW = tag ? cells(tag.text) + 2 : 0
  out.push(tag ? [pad(left), b('╭─ '), tag, b(' ' + '─'.repeat(Math.max(0, inner + 2 - tagW - 1)) + '╮')] : [pad(left), b('╭' + '─'.repeat(inner + 2) + '╮')])
  const rows = header ? [header.map(s => (headerAction ? { ...s, action: headerAction } : s)), ...body] : body
  for (const l of rows) out.push([pad(left), b('│ '), ...l, pad(inner - lineCells(l)), b(' │')])
  // An action can sit in the bottom border, so showing it moves nothing: ╰──── ↩ reply ─╯
  const footW = foot ? cells(foot.text) + 2 : 0
  out.push(foot && footW + 3 <= inner + 2 ? [pad(left), b('╰' + '─'.repeat(inner + 2 - footW - 1) + ' '), foot, b(' ─╯')] : [pad(left), b('╰' + '─'.repeat(inner + 2) + '╯')])
  return out
}

/** The widest line of `text` wrapped at `max`, so short messages get snug bubbles. */
const snug = (lines: Line[], max: number) => Math.min(max, Math.max(8, ...lines.map(lineCells)))

/** Your message's way to Claude: ◌ sending (the app has it), ✓ sent (written to Claude Code), ✓✓ (Claude Code took it in). */
export function delivered(turn: Turn): Span {
  return turn.delivery === 'sending'
    ? { text: '◌ sending', style: { fg: C.faint, italic: true } }
    : turn.delivery === 'sent' ? { text: '✓ sent', style: { fg: C.gray } } : { text: '✓✓', style: { fg: C.cyan } }
}

export function chatLines(ctx: ChatCtx, width: number): { lines: Line[]; anchors: Record<string, number>; owners: string[] } {
  const out: Line[] = []
  const anchors: Record<string, number> = {}
  const meMax = Math.max(16, Math.floor(width * 0.75) - 4)
  /** Claude's side sits under its avatar: everything indented this much. */
  const IN = 4
  // A readable measure: lines past about 80 columns are hard to follow.
  const claudeMax = Math.max(20, Math.min(80, width - 6 - IN))

  // Which message each line belongs to, for hover.
  const owners: string[] = []
  let owned = 0
  const mark = (id: string) => {
    for (let i = owned; i < out.length; i++) owners[i] = id
    owned = out.length
  }

  // Updates Claude sent by itself (an agent reporting in) on the same messages, one after another,
  // fold into the latest: the chain keeps one bubble for them, the earlier ones a click away.
  const earlier = new Map<Turn, Turn[]>()
  const foldedInto = new Map<Turn, Turn>()
  const aboutOf = (t: Turn) => [...new Set((t.parts ?? []).flatMap(p => p.to))].sort().join(',')
  let run: Turn[] = []
  for (const t of ctx.turns) {
    if (t.followUp && t.parts?.length) {
      if (run.length && aboutOf(run[0]!) !== aboutOf(t)) run = []
      run.push(t)
      if (run.length > 1) {
        for (const x of run.slice(0, -1)) foldedInto.set(x, t)
        earlier.set(t, run.slice(0, -1))
        earlier.delete(run.at(-2)!)
      }
    } else if (!(t.followUp && !t.parts?.length && !t.steps.length)) run = []
  }

  for (const turn of ctx.turns) {
    owned = out.length
    const latest = foldedInto.get(turn)
    if (latest && !latest.showUpdates) continue
    const before = earlier.get(turn)
    if (before) {
      const flip = () => { turn.showUpdates = !turn.showUpdates; ctx.poke() }
      out.push([], [pad(4), { text: turn.showUpdates ? `▾ hide ${before.length} earlier update${before.length > 1 ? 's' : ''} (above)` : `▸ ${before.length} earlier update${before.length > 1 ? 's' : ''}`, style: { fg: C.cyan }, action: flip }])
    }

    // ---- Yours, on the right
    if (turn.followUp || (ctx.showMessage && !ctx.showMessage(turn))) {
      // Claude went on by itself (an agent came back, a scheduled job fired): no message of yours to draw.
      if (turn.fired && !(ctx.showMessage && !ctx.showMessage(turn))) {
        const f = ctx.firedBy?.(turn)
        out.push([])
        anchors[`fired:${turn.key}`] = out.length
        out.push([pad(2), { text: clip(f?.label ?? '⏰ a scheduled job ran', width - 4), style: { fg: C.yellow, ...(f?.open ? { underline: true } : {}) }, ...(f?.open ? { action: f.open } : {}) }])
      }
    } else if (turn.reaction) {
      // On which reply: a click goes there.
      const on = ctx.kept.links[turn.key]
      const n = turn.retry?.length ?? 0
      const t = n ? `↻ asked Claude again for ${n > 1 ? `${n} replies` : 'a reply'} that never arrived` : on ? `you reacted ${turn.reaction} on “${clip(on.text, Math.max(10, meMax - 24))}”` : `you reacted ${turn.reaction}`
      const go = on?.anchor ? () => ctx.jump(on.anchor!) : undefined
      const way = delivered(turn)
      out.push([pad(width - cells(t) - 2 - cells(way.text)), { text: t, style: { fg: C.gray, italic: true, ...(go ? { underline: true } : {}) }, ...(go ? { action: go } : {}) }, pad(1), way])
    } else {
      out.push([])
      const link = ctx.kept.links[turn.key]
      const body = wrap([{ text: turn.text }], meMax)
      // What it replies to: one line each (a click goes there), so a reply to several lists them all.
      const quotes = link ? (link.all?.length ? link.all : [{ anchor: link.anchor ?? `${link.who}:${link.key}`, text: link.text }]) : []
      const heads: Line[] = quotes.map(q => {
        const go = () => ctx.jump(q.anchor)
        return [{ text: link!.auto ? '↩ about: ' : `↩ ${link!.who === 'claude' ? 'Claude' : 'you'}: `, style: { fg: C.cyan }, action: go }, { text: clip(`“${q.text}”`, meMax - 12), style: { fg: C.gray, italic: true }, action: go }]
      })
      const head: Line | undefined = heads.length === 1 ? heads[0] : undefined
      // Sent from inside an agent's view: its name on the bubble, a click opens that agent again.
      const agent = turn.aboutAgent ? ctx.agentName(turn.aboutAgent) : undefined
      const isPicked = ctx.picked === turn.key
      const tag: Span | undefined = agent
        ? { text: `◇ ${clip(agent, Math.max(8, meMax - 6))}`, style: { fg: C.magenta, bold: true }, action: () => ctx.openAgent(turn.aboutAgent!) }
        : isPicked ? { text: '▸ Alt+→ its reply', style: { fg: C.yellow, bold: true } } : undefined
      const inner = Math.max(snug(body, meMax), ...heads.map(h => Math.min(meMax, lineCells(h))), tag ? Math.min(meMax, cells(tag.text) + 1) : 0)
      const rows = heads.length > 1 ? [...heads.map(h => clipped(h, inner)), [{ text: '─'.repeat(inner), style: { fg: C.faint } }] as Line, ...body] : body
      const left = Math.max(0, width - inner - 4 - 1)
      anchors[`me:${turn.key}`] = out.length
      out.push(...bubble(rows, inner, left, isPicked ? { fg: C.yellow, bold: true } : { fg: C.cyan }, head ? clipped(head, inner) : undefined, undefined, tag))
      // Under it, right-aligned: Claude's reaction, replies to it, ↩ reply.
      const foot: Span[] = []
      const mine = ctx.kept.reactions[turn.key]
      if (mine?.length) foot.push({ text: `${mine.map(r => r.emoji).join(' ')} Claude  `, style: { fg: C.gray } })
      const reply = ctx.replyOf(turn)
      if (!reply && ctx.isLost(turn))
        foot.push({ text: '⚠ no reply arrived · ', style: { fg: C.red } }, { text: '↻ ask again  ', style: { fg: C.cyan, bold: true }, action: () => ctx.askAgain(turn) })
      if (reply) foot.push({ text: ctx.unread.has(reply) ? '● answered  ' : '↪ answered  ', style: { fg: ctx.unread.has(reply) ? C.magenta : C.cyan }, action: () => ctx.jump(`part:${reply}`) })
      // Everything that replies to it, down the replies: one click opens the whole chain.
      const chain = ctx.chainOf(turn)
      if (chain > 0) foot.push({ text: `⛓ chain · ${chain}  `, style: { fg: C.cyan }, action: () => ctx.openChain(turn) })
      // Sent while Claude worked, and Claude hasn't got to it yet.
      if (turn.queued && turn.delivery && !turn.isDone && !turn.steps.length && !turn.live && !turn.pending && !turn.early?.length) foot.push({ text: '⏸ queued: Claude reads it at its next step  ', style: { fg: C.faint, italic: true } })
      // Where it is on its way, last: the app has it, it went to Claude Code, Claude Code took it in.
      if (!turn.text.startsWith('/')) foot.push(delivered(turn))
      while (foot.length && foot.at(-1)!.text.trim() === '') foot.pop()
      // Actions show while the pointer is on this message, on the left of the row: what is on the
      // right (answered, replies) keeps its place, so a click never lands on something that moved.
      const acts: Span[] = ctx.hover === `me:${turn.key}`
        ? [{ text: '⧉ copy', style: { fg: C.gray }, action: () => ctx.copy(turn.text) }, pad(2), { text: '↩ reply', style: { fg: C.gray }, action: () => ctx.reply('me', turn) }]
        : []
      const rightAt = width - lineCells(foot) - 1
      const actsAt = Math.max(0, Math.min(left + 1, rightAt - lineCells(acts) - 3))
      out.push(acts.length ? [pad(actsAt), ...acts, pad(Math.max(1, rightAt - actsAt - lineCells(acts))), ...foot] : [pad(rightAt), ...foot])
      mark(`me:${turn.key}`)
    }

    // ---- Claude, like a contact: avatar, name, time or what it is doing
    const working = !turn.isDone
    // Only the final answer gets a bubble; words written while working stay as a note (below).
    const text = turn.answer ?? ''
    const hasParts = !!turn.parts?.length
    const showSteps = turn.steps.length > 0 && !ctx.isResultsOnly
    // Work that went on under a later message: one piece of work, still going if Claude is.
    const idx = ctx.turns.indexOf(turn)
    const carried = !!turn.continued && !text && !hasParts
    const nextTurn = carried ? ctx.turns.slice(idx + 1).find(t => !t.reaction) : undefined
    // Still going only while the message the work went on with (the end of the chain) is open.
    const end = carried ? ctx.turns.slice(idx + 1).find(t => !t.reaction && !t.continued) : undefined
    const goesOn = carried && ctx.isWorking && !!end && !end.isDone
    const below = nextTurn ? () => ctx.jump(`work:${nextTurn.key}`) : undefined
    // Its step still running: the work is here until Claude gets to the queued message.
    const stillHere = goesOn && !!turn.steps.length && turn.steps.at(-1)!.result == null
    // Queued and not reached yet: nothing of Claude's under it until it is. Words Claude finished
    // writing (a reply part, before its next step) count as reaching it.
    const notYet = !!turn.queued && working && !turn.steps.length && !turn.live && !turn.pending && !hasParts
    if (!notYet && (showSteps || working || text || hasParts || carried)) {
      owned = out.length
      const doneAt = new Date(turn.at + (turn.durationMs ?? 0))
      const time = `${String(doneAt.getHours()).padStart(2, '0')}:${String(doneAt.getMinutes()).padStart(2, '0')}`
      const doing = carried ? (stillHere ? ' is working… your next message is queued ↓' : goesOn ? ' is still on it, with your next message ↓' : ' · went on with your next message ↓') : !working ? ` · ${time}${turn.followUp ? ' · followed up' : ''}` : turn.followUp ? ' is following up…' : turn.live || turn.pending ? ' is typing…' : turn.steps.length ? ' is working…' : ` is thinking… ${secs(ctx.now - turn.at)}`
      out.push([])
      anchors[`work:${turn.key}`] = out.length
      out.push([
        pad(1),
        { text: ' ✻ ', style: { bg: C.claude, fg: 231, bold: true } },
        { text: ' Claude', style: { fg: C.claudeName, bold: true } },
        { text: doing, style: working || goesOn ? { fg: C.cyan, italic: true } : { fg: C.faint }, ...(below ? { action: below } : {}) },
      ])
    }

    // ---- Claude's work, folded into one line (or listed, as the work setting says; a click flips it)
    const isListOpen = ctx.work === 'folded' ? turn.isOpen : ctx.work === 'edits' && !turn.steps.some(isEdit) ? turn.isOpen : !turn.isOpen
    if (showSteps) {
      const last = turn.steps.at(-1)!
      const head: Span[] = working || stillHere
        ? [
            { text: `${ctx.spin} `, style: { fg: C.cyan } },
            { text: `Working ${secs(ctx.now - turn.at)} · `, style: { fg: C.cyan } },
            { text: clip(stepLabel(last, ctx.cwd).text, Math.max(10, width - 40)), style: { fg: C.gray } },
            { text: `  ${turn.steps.length} step${turn.steps.length === 1 ? '' : 's'} ${turn.isOpen ? '▾' : '▸'}`, style: { fg: C.faint } },
          ]
        : [
            { text: '⚙ ', style: { fg: C.faint } },
            { text: summary(turn.steps), style: { fg: C.gray } },
            { text: carried ? ' · then went on below' : turn.durationMs ? ` · ${secs(turn.durationMs)}` : '', style: { fg: C.faint } },
            { text: isListOpen ? '  ▾ hide' : '  ▸ show', style: { fg: C.cyan } },
          ]
      anchors[`now:${turn.key}`] = out.length
      out.push([pad(IN), ...head.map(s => ({ ...s, action: () => ctx.toggle(turn) }))])
      if (isListOpen) {
        // "edits" lists only the steps that changed files; "all" and a list you opened list every step.
        const listed = ctx.work === 'edits' && !turn.isOpen ? turn.steps.filter(isEdit) : turn.steps
        for (const s of listed) {
          if (s.said && ctx.work !== 'edits')
            for (const l of wrap([{ text: firstLine(s.said, 400), style: { fg: C.gray, italic: true } }], width - 6 - IN)) out.push([pad(IN + 4), ...l])
          const { icon, text } = stepLabel(s, ctx.cwd)
          const isShown = s.isOpen ?? (ctx.work === 'all' || (ctx.work === 'edits' && isEdit(s)))
          const flip = () => {
            s.isOpen = !isShown
            ctx.poke()
          }
          if (s === turn.steps.at(-1)) anchors[`now:${turn.key}`] = out.length
          out.push([
            pad(IN + 2),
            { text: `${icon} `, style: { fg: s.isError ? C.red : C.cyan }, action: flip },
            { text: clip(text, width - 10 - IN), action: flip },
            { text: isShown ? ' ▾' : ' ▸', style: { fg: C.faint }, action: flip },
          ])
          if (isShown) out.push(...stepDetail(s, width - 6 - IN, IN + 4, ctx))
          else if (s.result != null) {
            const r = firstLine(s.result.replace(/\s+/g, ' ').trim(), 200)
            if (r) out.push([pad(IN + 4), { text: clip(`└ ${r}`, width - 6 - IN), style: { fg: s.isError ? C.red : C.faint } }])
          }
        }
      }
    }

    // ---- Claude's answer: one bubble per reply, each quoting the messages it answers
    if (text || hasParts) {
      const parts = turn.parts?.length ? turn.parts : [{ to: [] as string[], text: stripMarks(text) }]
      // Several parts: each is its own message, with its own actions (reply, copy, reactions) on hover.
      const multi = parts.length > 1
      // Your reactions since Claude's previous answer, up to this one: what this answer may reply to.
      const at = ctx.turns.indexOf(turn)
      let from = at
      while (from > 0 && !ctx.turns[from - 1]!.answer) from--
      const reactedHere = ctx.turns.slice(from, at + 1).flatMap(t => {
        const link = t.reaction ? ctx.kept.links[t.key] : undefined
        return link ? [{ turn: t, link }] : []
      })
      if (multi) mark(`claude:${turn.key}`)
      parts.forEach((part, i) => {
        if (ctx.showPart && turn.parts?.length && !ctx.showPart(part)) return
        const id = part.id ?? `${turn.key}:${i}`
        const isUnread = ctx.unread.has(id)
        const asks = ctx.waiting.has(id)
        const body = markdown(part.text, claudeMax, ctx.copy)
        let inner = snug(body, claudeMax)
        // The tag: which of your messages this answers (a click goes to it); ● when unread.
        const replied = part.to.map(t => ctx.messageOf(t, turn)).filter((m): m is Turn => !!m)
        // What it answers, one quote each: a message, or each question of one that asks several
        // (the ones the part names, T90.2, else all of them).
        const quotes = part.to.flatMap(id => {
          const m = ctx.messageOf(id, turn)
          if (!m) return []
          const qs = questionsOf(m.text)
          const named = (part.subs ?? []).filter(s => s.split('.')[0] === id).map(s => qs[Number(s.split('.')[1]) - 1]).filter((q): q is string => !!q)
          return (qs.length ? (named.length ? named : qs) : [preview(m.text, 200)]).map(text => ({ anchor: `me:${m.key}`, text }))
        })
        // A reaction of yours this answers (a go-ahead): quoted too, as the reply you reacted to.
        for (const r of reactedHere) {
          const target = r.link.anchor?.startsWith('part:') ? ctx.turns.flatMap(x => x.parts ?? []).find(p => p.id === r.link.anchor!.slice(5)) : undefined
          const about = target ? target.to : ctx.turns.findLast(x => x.key === r.link.key)?.parts?.flatMap(p => p.to) ?? []
          if (about.some(id => part.to.includes(id)) || !quotes.length)
            quotes.unshift({ anchor: r.link.anchor ?? `claude:${r.link.key}`, text: `your ${r.turn.reaction} on “${r.link.text}”` })
        }
        const many = quotes.length > 1
        const quote = many ? `↩ ${quotes.length} ${replied.length > 1 || reactedHere.length ? 'messages' : 'questions'}` : quotes.length ? (quotes[0]!.text.startsWith('your ') && reactedHere.length ? `↩ ${clip(quotes[0]!.text, 44)}` : `↩ “${clip(preview(quotes[0]!.text, 40), 40)}”`) : ''
        const tagText = [isUnread ? '● new' : '', quote].filter(Boolean).join('  ')
        const tag: Span | undefined = tagText
          ? { text: clip(tagText, claudeMax - 4), style: { fg: isUnread ? C.magenta : C.cyan, bold: isUnread }, ...(quotes.length === 1 ? { action: () => ctx.jump(quotes[0]!.anchor) } : {}) }
          : undefined
        if (tag) inner = Math.min(claudeMax, Math.max(inner, cells(tag.text) + 1))
        // Answering several: each of them listed on its own line at the top, a click goes to it.
        let rows = body
        if (many) {
          const heads: Line[] = quotes.map(({ anchor, text }) => {
            const go = () => ctx.jump(anchor)
            const shown = anchor.startsWith('me:') ? `“${preview(text, 200)}”` : text
            return [{ text: '↩ ', style: { fg: C.cyan }, action: go }, { text: clip(shown, claudeMax - 2), style: { fg: C.gray, italic: true }, action: go }]
          })
          inner = Math.min(claudeMax, Math.max(inner, ...heads.map(lineCells)))
          rows = [...heads.map(h => clipped(h, inner)), [{ text: '─'.repeat(inner), style: { fg: C.faint } }], ...body]
        }
        anchors[`part:${id}`] = out.length
        if (i === 0) anchors[`claude:${turn.key}`] = out.length
        // Several parts: each can be replied to on its own (↩ in its bottom border, on hover), and gathered.
        const anchor = `part:${id}`
        const isPicked = ctx.replying.has(anchor)
        const pick: Span | undefined = multi && isPicked ? { text: '✓ in your reply', style: { fg: C.cyan, bold: true }, action: () => ctx.reply('claude', turn, [i]) } : undefined
        out.push(...bubble(rows, inner, IN, { fg: isPicked ? C.cyan : isUnread ? C.magenta : asks ? C.yellow : C.faint }, undefined, undefined, tag, pick))
        if (asks) out.push([pad(IN + 2), { text: '✋ waiting for your answer', style: { fg: C.yellow } }, { text: '   ✕ dismiss', style: { fg: C.gray }, action: () => ctx.dismiss([id]) }])
        anchors[`partEnd:${id}`] = out.length
        if (multi) {
          // Its row is always there, so hovering moves nothing; reactions you left stay.
          const key = `part:${id}`
          const given = QUICK.filter(e => ctx.kept.reactions[key]?.some(r => r.emoji === e && r.by === 'me'))
          const row: Span[] = [pad(IN + 2)]
          // Your replies to this part: first on the row, so the hover actions after it never shift it.
          const root = part.to.map(t => ctx.messageOf(t, turn)).find((m): m is Turn => !!m)
          const replies = Object.values(ctx.kept.links).filter(l => (l.all?.map(a => a.anchor) ?? [l.anchor]).includes(key)).length
          if (replies && root) row.push({ text: `⛓ ${replies} repl${replies > 1 ? 'ies' : 'y'} · chain`, style: { fg: C.cyan }, action: () => ctx.openChain(root) }, pad(2))
          if (ctx.hover === key) {
            row.push({ text: isPicked ? '✓ in your reply' : '↩ reply', style: { fg: isPicked ? C.cyan : C.gray }, action: () => ctx.reply('claude', turn, [i]) }, pad(2))
            row.push({ text: '⧉ copy', style: { fg: C.gray }, action: () => ctx.copy(part.text) }, pad(2))
            for (const e of QUICK) row.push({ text: e, style: given.includes(e) ? { bg: C.meBg } : {}, action: () => ctx.react(turn, e, i) }, pad(1))
            row.push(pad(1), { text: isUnread ? '✓ mark read' : '● mark unread', style: { fg: C.faint }, action: () => ctx.setRead([id], isUnread) })
          } else if (given.length) {
            for (const e of given) row.push({ text: e, style: { bg: C.meBg }, action: () => ctx.react(turn, e, i) }, pad(1))
            row.push({ text: 'you', style: { fg: C.faint } })
          }
          out.push(row)
          mark(key)
        }
      })
      if (turn.answer) {
        const foot: Span[] = [pad(IN + 2)]
        const theirs = ctx.kept.reactions[`claude:${turn.key}`]
        // Replies to the answer as a whole; a reply to one of several parts shows on that part's row.
        const answeredBy = Object.entries(ctx.kept.links)
          .filter(([, l]) => l.who === 'claude' && l.key === turn.key && (!multi || !(l.all?.map(x => x.anchor) ?? [l.anchor]).every(x => x?.startsWith('part:'))))
          .map(([k]) => k)
        // Your replies to this answer: the chain of the message it answers holds them all.
        const root = parts.flatMap(pt => pt.to).map(t => ctx.messageOf(t, turn)).find((m): m is Turn => !!m)
        if (answeredBy.length)
          foot.push({ text: `⛓ ${answeredBy.length > 1 ? `${answeredBy.length} replies` : '1 reply'} · chain`, style: { fg: C.cyan }, action: () => (root ? ctx.openChain(root) : ctx.jump(`me:${answeredBy.at(-1)}`)) }, pad(2))
        const given = QUICK.filter(e => theirs?.some(r => r.emoji === e && r.by === 'me'))
        if (ctx.hover === `claude:${turn.key}`) {
          const all = parts.map((_, i) => i)
          foot.push(parts.length > 1
            ? { text: `↩ reply to all ${parts.length}`, style: { fg: C.gray }, action: () => ctx.reply('claude', turn, all) }
            : { text: '↩ reply', style: { fg: C.gray }, action: () => ctx.reply('claude', turn) }, pad(2))
          foot.push({ text: parts.length > 1 ? '⧉ copy all' : '⧉ copy', style: { fg: C.gray }, action: () => ctx.copy(stripMarks(turn.answer ?? '')) }, pad(2))
          // Read by hand: the app only counts a reply read once you had it all on screen long enough.
          const ids = parts.map((pt, i) => pt.id ?? `${turn.key}:${i}`)
          const anyUnread = ids.some(id => ctx.unread.has(id))
          foot.push({ text: anyUnread ? '✓ mark read' : '● mark unread', style: { fg: anyUnread ? C.gray : C.faint }, action: () => ctx.setRead(ids, anyUnread) }, pad(2))
          for (const e of QUICK) foot.push({ text: e, style: given.includes(e) ? { bg: C.meBg } : {}, action: () => ctx.react(turn, e) }, pad(1))
        } else if (given.length) {
          // Your reactions stay; a click takes one back.
          for (const e of given) foot.push({ text: e, style: { bg: C.meBg }, action: () => ctx.react(turn, e) }, pad(1))
          foot.push({ text: 'you', style: { fg: C.faint } })
        }
        out.push(foot)
      }
      mark(`claude:${turn.key}`)
    }
    // ---- While working: Claude's latest words, kept on screen as a soft note (never a bubble that
    // vanishes when a tool call turns out to follow them).
    // Its words since the last step are the reply it is writing (unless another step follows):
    // drawn as it streams, one bubble per part, each quoting the message it answers.
    const writing = working && !notYet ? [turn.pending, turn.live].filter(Boolean).join('\n\n').replace(/\n?<<[^>\n]*$/, '') : ''
    const liveParts = stripTag(writing).trim() ? splitAnswer(writing, turn.topicId ? [turn.topicId] : []) : []
    if (liveParts.length) {
      liveParts.forEach((part, i) => {
        if (i) out.push([])
        const body = markdown(part.text, claudeMax, ctx.copy)
        // A caret at the end of the part being written.
        if (i === liveParts.length - 1) {
          const last = body.at(-1)
          if (last && lineCells(last) < claudeMax) last.push({ text: '▍', style: { fg: C.cyan } })
          else body.push([{ text: '▍', style: { fg: C.cyan } }])
        }
        const m = part.to.map(id => ctx.messageOf(id, turn)).find((x): x is Turn => !!x)
        const tag: Span | undefined = m ? { text: clip(`↩ “${preview(m.text, 40)}”`, claudeMax - 4), style: { fg: C.cyan }, action: () => ctx.jump(`me:${m.key}`) } : undefined
        const inner = Math.min(claudeMax, Math.max(snug(body, claudeMax), tag ? cells(tag.text) + 1 : 0))
        out.push(...bubble(body, inner, IN, { fg: C.faint }, undefined, undefined, tag))
      })
    } else if (working && !notYet) {
      const note = stripMarks(stripTag(turn.steps.at(-1)?.said || ''))
      if (note) {
        const rows = wrap([{ text: note.replace(/\s+/g, ' '), style: { fg: C.gray, italic: true } }], Math.min(claudeMax, width - IN - 4))
        for (const l of rows.slice(-3)) out.push([pad(IN), { text: '▎ ', style: { fg: C.faint } }, ...l])
      }
    }

    // Wrapped, not cut: the end says what to do next ("Send a message to start it again").
    if (turn.error) for (const l of wrap([{ text: `✕ ${turn.error}`, style: { fg: C.red } }], width - IN - 1, [pad(2)])) out.push([pad(IN), ...l])
  }
  return { lines: out, anchors, owners }
}

function clipped(line: Line, width: number): Line {
  const out: Line = []
  let room = width
  for (const s of line) {
    if (room <= 0) break
    const t = clip(s.text, room)
    out.push({ ...s, text: t })
    room -= cells(t)
  }
  return out
}

// ---- Inside an agent: its own chat ---------------------------------------------------

/**
 * An agent's tasks, when Claude gave it more than one: each with its mark (✓ done, the spinner while
 * it runs, ◌ queued, ✕ failed), its title (a click goes to where it starts in the log), when Claude
 * sent it, and the topic ids of your messages it is for (a click goes to that message).
 */
export function tasksBlock(a: Agent, ctx: ChatCtx, width: number): Line[] {
  const tasks = a.tasks
  if (tasks.length < 2) return []
  const n = currentTask(a)
  const counts = (['running', 'queued', 'done', 'failed'] as const).map(s => [s, tasks.filter(t => t.state === s).length] as const).filter(([, k]) => k)
  const out: Line[] = [[], [
    pad(2),
    { text: 'Tasks', style: { bold: true } },
    { text: `  ${tasks.length} · ${counts.map(([s, k]) => `${k} ${s}`).join(' · ')}`, style: { fg: C.gray } },
  ]]
  const numW = String(tasks.length).length + 2
  tasks.forEach((t, i) => {
    const mark: Span = t.state === 'done' ? { text: '✓ ', style: { fg: C.green } }
      : t.state === 'running' ? { text: `${ctx.spin} `, style: { fg: C.cyan } }
      : t.state === 'failed' ? { text: '✕ ', style: { fg: C.red } }
      : { text: '◌ ', style: { fg: C.gray } }
    const go = () => ctx.jump(`task:${i}`)
    // Right of the title: when it was sent, and which of your messages it is for.
    const msgs = t.for.map(k => ctx.turns.findLast(x => x.key === k)).filter((x): x is Turn => !!x)
    const right: Span[] = [{ text: `  ${clock(t.at, ctx.now)}`, style: { fg: C.faint } }]
    msgs.slice(0, 4).forEach((m, k) => {
      right.push({ text: k ? ' ' : ' · ', style: { fg: C.faint } })
      const label = m.topicId ?? `“${preview(m.text, 14)}”`
      right.push({ text: label, style: { fg: C.blue, underline: true }, ...(ctx.openMessage ? { action: () => ctx.openMessage!(m) } : {}) })
    })
    if (msgs.length > 4) right.push({ text: ` +${msgs.length - 4}`, style: { fg: C.faint } })
    const rightW = right.reduce((w, sp) => w + cells(sp.text), 0)
    const room = Math.max(8, width - 4 - 2 - numW - rightW)
    const title = clip(t.title, room)
    const isOn = i === n && t.state === 'running'
    out.push([
      pad(4),
      { ...mark, action: go },
      { text: `${i + 1}.`.padEnd(numW), style: { fg: C.faint }, action: go },
      { text: title, style: { bold: isOn, fg: t.state === 'queued' ? C.gray : undefined, dim: t.state === 'done' }, action: go },
      ...right,
    ])
  })
  return out
}

/**
 * An agent's chat: what Claude asked it (on the right, as the one who wrote to it), then what the
 * agent said and did (on the left, under its avatar), then what it handed back. Below that, your
 * messages about this agent and Claude's replies, drawn as in the main chat.
 */
export function agentLines(a: Agent, about: Turn[], ctx: ChatCtx, width: number): { lines: Line[]; anchors: Record<string, number>; owners: string[] } {
  const out: Line[] = []
  const IN = 4
  const max = Math.max(20, Math.min(110, width - 6 - IN))
  const meMax = Math.max(16, Math.floor(width * 0.75) - 4)
  const taskAnchors: Record<string, number> = {}
  const tasks = a.tasks
  const many = tasks.length > 1

  // What Claude asked it, task by task, and its own to-do list.
  out.push(...tasksBlock(a, ctx, width))
  const todos = todosOf(a.log)
  if (todos.length) {
    const done = todos.filter(t => t.status === 'completed').length
    out.push([], [pad(2), { text: 'To-do', style: { bold: true } }, { text: `  ${done} of ${todos.length} done`, style: { fg: C.gray } }])
    out.push(...todoLines(todos, width, 4))
  }

  // Claude's request.
  out.push([])
  taskAnchors['task:0'] = out.length
  const ask = a.prompt ? markdown(a.prompt, meMax, ctx.copy) : [[{ text: a.name, style: {} }] as Line]
  const askTag: Span = { text: a.asker ?? (many ? '✻ Claude asked · task 1' : '✻ Claude asked'), style: { fg: a.asker ? C.cyan : C.claudeName, bold: true } }
  const askW = Math.max(snug(ask, meMax), many ? Math.min(meMax, cells(askTag.text) + 1) : 0, 16)
  out.push(...bubble(ask, askW, Math.max(0, width - askW - 5), { fg: C.claude }, undefined, undefined, askTag))
  /** A later task where it starts: Claude's message, on the right as the first one is. */
  const sent = (n: number) => {
    const t = tasks[n]!
    out.push([])
    taskAnchors[`task:${n}`] = out.length
    const body = markdown(t.text || t.title, meMax, ctx.copy)
    const tag: Span = t.state === 'queued'
      ? { text: clip(`◌ task ${n + 1} · queued: it gets it after this run`, meMax), style: { fg: C.gray, bold: true } }
      : { text: clip(`✻ Claude sent task ${n + 1} · ${clock(t.at, ctx.now)}`, meMax), style: { fg: C.claudeName, bold: true } }
    const w = Math.max(snug(body, meMax), Math.min(meMax, cells(tag.text) + 1), 16)
    out.push(...bubble(body, w, Math.max(0, width - w - 5), { fg: t.state === 'queued' ? C.faint : C.claude }, undefined, undefined, tag))
  }
  const startsAt = new Map<number, number[]>()
  tasks.forEach((t, n) => {
    if (n && t.logAt != null && t.state !== 'queued') startsAt.set(Math.min(t.logAt, a.log.length), [...(startsAt.get(Math.min(t.logAt, a.log.length)) ?? []), n])
  })

  // The agent, like a contact.
  out.push([])
  const state = a.state === 'running' ? ` is working… ${secs(ctx.now - a.startedAt)}` : ` · ${a.state}${a.endedAt ? ` after ${secs(a.endedAt - a.startedAt)}` : ''}`
  out.push([
    pad(1),
    a.asker ? { text: ' ✻ ', style: { bg: C.claude, fg: 231, bold: true } } : { text: ' ◇ ', style: { bg: C.magenta, fg: 16, bold: true } },
    { text: ` ${a.person ? `${a.person} (${roleOf(a.type)})` : a.name}`, style: { fg: a.asker ? C.claudeName : C.magenta, bold: true } },
    { text: a.person ? ` · ${a.name}` : a.type ? ` (${a.type})` : '', style: { fg: C.faint } },
    { text: state, style: a.state === 'running' ? { fg: C.cyan, italic: true } : { fg: C.faint } },
  ])
  if (!a.log.length)
    out.push([pad(IN), { text: a.isBackground ? (a.state === 'running' ? `${ctx.spin} It runs in the background: its steps show here as Claude Code writes them down.` : 'It ran in the background, and no steps of it were found.') : a.state === 'running' ? `${ctx.spin} starting…` : 'No steps were streamed.', style: { fg: C.gray, italic: true } }])
  for (const [k, e] of a.log.entries()) {
    for (const n of startsAt.get(k) ?? []) sent(n)
    if ('text' in e) {
      const body = markdown(e.text, max, ctx.copy)
      out.push(...bubble(body, snug(body, max), IN, { fg: C.faint }))
      continue
    }
    const s = e.step
    const { icon, text } = stepLabel(s, ctx.cwd)
    // You opened the agent to see its work: each step shows in full unless you fold it.
    const isShown = s.isOpen ?? true
    const flip = () => {
      s.isOpen = !isShown
      ctx.poke()
    }
    out.push([
      pad(IN),
      { text: `${icon} `, style: { fg: s.isError ? C.red : C.cyan }, action: flip },
      { text: clip(text, width - 8 - IN), action: flip },
      { text: isShown ? ' ▾' : ' ▸', style: { fg: C.faint }, action: flip },
    ])
    if (isShown) out.push(...stepDetail(s, width - 4 - IN, IN + 2, ctx))
    else if (s.result != null) {
      const r = firstLine(s.result.replace(/\s+/g, ' ').trim(), 200)
      if (r) out.push([pad(IN + 2), { text: clip(`└ ${r}`, width - 4 - IN), style: { fg: s.isError ? C.red : C.faint } }])
    }
  }

  for (const n of startsAt.get(a.log.length) ?? []) sent(n)

  // What it handed back to Claude.
  if (a.result) {
    out.push([])
    const body = markdown(a.result, max, ctx.copy)
    const ok = a.state !== 'failed'
    const tag: Span = { text: ok ? (a.resultLabel ?? '✓ handed back to Claude') : '✕ failed', style: { fg: ok ? C.green : C.red, bold: true } }
    out.push(...bubble(body, Math.max(snug(body, max), cells(tag.text) + 1), IN, { fg: ok ? C.green : C.red }, undefined, undefined, tag))
    out.push([pad(IN + 2), { text: '⧉ copy', style: { fg: C.gray }, action: () => ctx.copy(a.result ?? '') }])
  } else if (a.state === 'running') {
    // How long it has run, and how it is doing now: the tool it waits on, or its last step.
    const now = ctx.now
    const pulse = pulseOf(a, now)
    const doing = pulse.kind === 'tool' ? `running ${pulse.tool} for ${ago(now - pulse.since)}` : `last step ${ago(now - pulse.since)} ago`
    out.push([pad(IN), { text: `${ctx.spin} working for ${ago(now - a.startedAt)} · ${a.steps} step${a.steps === 1 ? '' : 's'} so far · ${doing}`, style: { fg: C.cyan } }])
    // Nothing new for a while, and nothing running: it may be stuck. Claude can check on it.
    if (pulse.kind === 'quiet')
      out.push([pad(IN), { text: `◌ no new steps for ${ago(now - pulse.since)}: it may be stuck.`, style: { fg: C.yellow, italic: true } },
        ...(isQuiet(a, now) && ctx.continueAgent ? [{ text: '  ▶ continue', style: { fg: C.cyan, bold: true }, action: () => ctx.continueAgent!(a.id) }] : [])])
  }
  // Stopped mid-run by Claude Code's exit: what happened, and going on from here.
  if (a.state === 'stopped' && a.cut) {
    out.push([])
    out.push([pad(IN), { text: `■ ${cutLabel(a)}${canContinue(a) ? ', before it finished.' : '.'}`, style: { fg: C.gray, italic: true } },
      ...(canContinue(a) && ctx.continueAgent ? [{ text: '  ▶ continue', style: { fg: C.cyan, bold: true }, action: () => ctx.continueAgent!(a.id) }] : [])])
  }
  // Tasks it has not started: waiting their turn.
  tasks.forEach((t, n) => n && t.state === 'queued' && sent(n))

  // Your messages about it, with Claude's replies.
  const base = out.length
  const rest = chatLines({ ...ctx, turns: about }, width)
  const anchors: Record<string, number> = {}
  for (const [k, v] of Object.entries(rest.anchors)) anchors[k] = v + base
  const owners: string[] = []
  rest.owners.forEach((o, i) => (owners[i + base] = o))
  if (about.length) out.push([], [pad(2), { text: `── your messages about this agent ${'─'.repeat(Math.max(0, width - 40))}`, style: { fg: C.faint } }])
  else out.push([], [pad(2), { text: a.asker ? 'What you write below goes to Claude as a normal message. Esc goes back to the chat.' : 'Write below to ask Claude about this agent, or to have it continue the agent.', style: { fg: C.faint } }])
  const shift = out.length - base
  for (const k of Object.keys(anchors)) anchors[k]! += shift
  Object.assign(anchors, taskAnchors)
  const ownersShifted: string[] = []
  owners.forEach((o, i) => (ownersShifted[i + shift] = o))
  out.push(...rest.lines)
  return { lines: out, anchors, owners: ownersShifted }
}

// ---- Inside a request: its whole chain ---------------------------------------------------

export type RequestInfo = { state: string; mark: string; isStale: boolean; ids: string[]; agents: Agent[]; turns: Turn[]; keys: ReadonlySet<string> }

/**
 * One request's story: where it stands (with "ask for status" while it is not done), the agents on it,
 * then your messages in it and Claude's replies about it, in order, drawn as in the main chat.
 */
export function requestLines(req: Turn, info: RequestInfo, ctx: ChatCtx & { askStatus: () => void }, width: number): { lines: Line[]; anchors: Record<string, number>; owners: string[] } {
  const out: Line[] = [[]]
  const head: Span[] = [pad(2), { text: `${info.mark} ${info.state}`, style: { bold: true, fg: info.isStale ? C.gray : info.state === 'done' ? C.green : C.cyan } }]
  const replies = info.turns.reduce((n, t) => n + (t.parts ?? []).filter(p => p.to.some(id => info.ids.includes(id))).length, 0)
  head.push({ text: `  ·  ${replies} repl${replies === 1 ? 'y' : 'ies'}${info.agents.length ? ` · ${info.agents.length} agent${info.agents.length === 1 ? '' : 's'}` : ''}`, style: { fg: C.gray } })
  if (info.state !== 'done') head.push({ text: '   ' }, { text: ' ask for status ', style: { inverse: true, fg: C.yellow }, action: ctx.askStatus })
  out.push(head)
  if (info.isStale) out.push([pad(2), { text: 'Claude said it still owes work here, but nothing is running on it right now. Ask for its status, or add to it below.', style: { fg: C.gray } }])
  for (const a of info.agents) {
    const icon = a.state === 'running' ? '◐' : a.state === 'done' ? '✓' : a.state === 'failed' ? '✕' : '■'
    out.push([pad(4), { text: `${icon} ◇ ${a.person ? `${a.person} (${roleOf(a.type)}) · ` : ''}${a.name}`, style: { fg: C.magenta }, action: () => ctx.openAgent(a.id) }, { text: `  ${a.state}`, style: { fg: C.faint } }])
  }
  const rest = chatLines({ ...ctx, turns: info.turns, showMessage: t => info.keys.has(t.key), showPart: p => p.to.some(id => info.ids.includes(id)) }, width)
  const base = out.length
  const anchors: Record<string, number> = {}
  for (const [k, v] of Object.entries(rest.anchors)) anchors[k] = v + base
  const owners: string[] = []
  rest.owners.forEach((o, i) => (owners[i + base] = o))
  out.push(...rest.lines)
  return { lines: out, anchors, owners }
}

// ---- Inside a scheduled job ------------------------------------------------------------

export type JobInfo = {
  /** Who set it up: Claude itself, or the agent whose steps made the call. */
  by: { name: string; agent?: Agent }
  /** Your messages it was made for. */
  for: Turn[]
  /** Each run so far, and the turn it started when that is known. */
  runs: { at: number; open?: () => void }[]
  openMessage: (t: Turn) => void
  openAgent: (id: string) => void
  /** Asks Claude to delete it. */
  cancel: () => void
  copy: (text: string) => void
  now: number
}

/**
 * A scheduled job: what it is for (its prompt, and the reason a wakeup gave), its schedule in words
 * and as cron, who set it up and who runs it when it fires, the message of yours it was made for, and
 * each run so far. Below that, your messages about it and Claude's replies, as in the main chat.
 */
export function jobLines(j: Job, info: JobInfo, ctx: ChatCtx, width: number): { lines: Line[]; anchors: Record<string, number>; owners: string[] } {
  const out: Line[] = [[]]
  const IN = 4
  const max = Math.max(20, Math.min(100, width - 6 - IN))
  const isLive = j.state === 'scheduled' || j.state === 'setting up' || j.state === 'unknown'
  const kind = j.kind === 'wakeup' ? 'Wakeup (/loop)' : j.kind === 'remote' ? 'Cloud routine' : j.recurring ? 'Recurring job' : 'One-off job'
  const head: Span[] = [pad(2), { text: `${jobMark(j)} ${kind}`, style: { bold: true, fg: C.yellow } }, { text: j.id !== j.toolId ? `  ${j.id}` : '', style: { fg: C.gray } }, { text: `  ·  ${stateLabel(j)}`, style: { bold: true, fg: j.state === 'scheduled' ? C.cyan : j.state === 'failed' ? C.red : C.gray } }]
  if (isLive) head.push({ text: '   ' }, { text: ' ✕ cancel ', style: { inverse: true, fg: C.red, bold: true }, action: info.cancel })
  out.push(head)
  const section = (title: string) => out.push([], [pad(2), { text: title, style: { bold: true } }])
  // A label, and its value wrapped under itself.
  const field = (label: string, value: Span[]) => {
    const rows = wrap(value, Math.max(10, width - IN - 13), [pad(IN + 12)])
    rows.forEach((l, i) => out.push(i ? l : [pad(IN), { text: label.padEnd(12), style: { fg: C.gray } }, ...l]))
  }

  // What it is for: the prompt it sends, and the reason.
  section('What it is for')
  const body = markdown(j.prompt || '(no prompt)', max, ctx.copy)
  const tag: Span = { text: j.kind === 'remote' ? '☁ the routine runs' : '✻ sent to Claude when it fires', style: { fg: C.claudeName, bold: true } }
  out.push(...bubble(body, Math.max(snug(body, max), cells(tag.text) + 2), IN, { fg: C.yellow }, undefined, undefined, tag, { text: '⧉ copy', style: { fg: C.gray }, action: () => info.copy(j.prompt) }))
  if (j.reason) field('reason', [{ text: j.reason }])

  // When: in words, the raw cron, how long it lasts.
  section('Schedule')
  field('when', [{ text: scheduleLine(j, info.now), style: { fg: C.cyan } }])
  if (j.cron) field('cron', [{ text: j.cron, style: { fg: C.white } }, { text: `  (${j.kind === 'wakeup' ? 'one-shot' : cronWords(j.cron, j.recurring)}${j.human ? `; Claude Code says “${j.human}”` : ''})`, style: { fg: C.faint } }])
  else if (j.delaySeconds != null) field('delay', [{ text: `${j.delaySeconds} s asked`, style: { fg: C.white } }])
  if (j.nextAt != null && isLive && !(j.kind === 'cron' && j.recurring)) field('next run', [{ text: `${clock(j.nextAt, info.now)}`, style: { fg: C.white } }, { text: j.state === 'unknown' ? '  (as the session file last showed it)' : '', style: { fg: C.faint } }])
  const lasts = j.kind === 'remote' ? 'in the cloud, apart from this session'
    : j.durable === true ? 'kept on disk: it can outlive this session'
    : j.durable === false ? 'session-only: it ends when this Claude Code session exits'
    : 'while this Claude Code session runs'
  field('lasts', [{ text: lasts }, { text: j.expiresAt ? ` · auto-expires ${clock(j.expiresAt, info.now)}` : '', style: { fg: C.gray } }])

  // Who: set it up, runs it, for which message of yours.
  section('Who')
  const agent = info.by.agent
  field('set up by', agent
    ? [{ text: `◇ ${info.by.name}`, style: { fg: C.magenta, bold: true, underline: true }, action: () => info.openAgent(agent.id) }, { text: ` · ${agent.name}`, style: { fg: C.gray } }]
    : [{ text: j.isOutside ? 'not in this session: CronList showed it' : '✻ Claude (lead)', style: { fg: j.isOutside ? C.gray : C.claudeName, bold: !j.isOutside } }])
  field('runs it', j.kind === 'remote'
    ? [{ text: 'a cloud routine on claude.ai, not this session' }]
    : [{ text: '✻ Claude (lead)', style: { fg: C.claudeName, bold: true } }, { text: ', the main session: when it fires, its prompt comes to Claude as a turn of its own', style: { fg: C.gray } }])
  if (info.for.length)
    for (const [i, t] of info.for.entries())
      field(i ? '' : 'made for', [{ text: `↳ “${preview(t.text, Math.max(20, width - 24))}”`, style: { fg: C.gray, underline: true }, action: () => info.openMessage(t) }])
  else field('made for', [{ text: 'no message of yours in this chat', style: { fg: C.faint } }])

  // Each run, linked to the turn it started.
  section(`Runs${j.runs.length ? ` (${j.runs.length})` : ''}`)
  if (!j.runs.length) out.push([pad(IN), { text: isLive ? 'Not run yet.' : 'It never ran.', style: { fg: C.faint, italic: true } }])
  for (const r of info.runs.slice(-20).reverse())
    out.push([pad(IN), { text: '· ', style: { fg: C.faint } }, { text: clock(r.at, info.now), style: { fg: C.white, ...(r.open ? { underline: true } : {}) }, ...(r.open ? { action: r.open } : {}) }, { text: r.open ? '  ↗ its turn' : '', style: { fg: C.cyan }, ...(r.open ? { action: r.open } : {}) }])
  if (info.runs.length > 20) out.push([pad(IN), { text: `… and ${info.runs.length - 20} earlier`, style: { fg: C.faint } }])

  // How it ended, or what can't be known.
  const note = j.state === 'unknown' ? 'From the session file: it was still scheduled when the transcript ends. It may still run, or may have been deleted outside it.'
    : j.note ? `${j.state === 'expired' ? 'Expired' : j.state === 'failed' ? 'Failed' : 'Ended'}: ${j.note}.`
    : isLive ? '✕ cancel asks Claude to delete it; the app never stops a job itself.' : ''
  if (note) out.push([])
  if (note) for (const l of wrap([{ text: note, style: { fg: C.gray, italic: true } }], width - 4)) out.push([pad(2), ...l])

  // Your messages about it, with Claude's replies.
  const about = ctx.turns
  const rest = chatLines(ctx, width)
  out.push([])
  if (about.length) out.push([pad(2), { text: `── your messages about this job ${'─'.repeat(Math.max(0, width - 36))}`, style: { fg: C.faint } }])
  else out.push(...wrap([{ text: 'Write below to ask Claude about this job, or to change it. Esc goes back to the chat.', style: { fg: C.faint } }], width - 4).map(l => [pad(2), ...l]))
  const base = out.length
  const anchors: Record<string, number> = {}
  for (const [k, v] of Object.entries(rest.anchors)) anchors[k] = v + base
  const owners: string[] = []
  rest.owners.forEach((o, i) => (owners[i + base] = o))
  out.push(...rest.lines)
  return { lines: out, anchors, owners }
}
