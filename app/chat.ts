// The conversation: your messages in bubbles on the right; Claude's work folded into one line;
// Claude's answer in a bubble on the left, with reply and reactions under it.

import { firstLine, stripTag } from '../hooks/model.ts'
import { markdown } from './markdown.ts'
import { preview, questionsOf, splitAnswer, stripMarks } from './inbox.ts'
import { lineDiff } from './diff.ts'
import type { Kept, Step, Turn, Work } from './session.ts'
import { roleOf } from './panel.ts'
import type { Agent } from './panel.ts'
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
  /** A request's view draws only its chain: your messages in it, and the reply parts about it. */
  showMessage?: (t: Turn) => boolean
  /** Marks reply parts read or unread by hand. */
  setRead: (ids: string[], isRead: boolean) => void
  dismiss: (ids: string[]) => void
  showPart?: (p: Part) => boolean
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

/** What a step did, exactly: an edit as a diff, a new file's text, a command and its output. */
function stepDetail(s: Step, width: number, left: number, ctx: ChatCtx): Line[] {
  const i = s.tool.input
  const rows: Line[] = []
  const code = (text: string, style: Style, mark = '  ') => {
    for (const l of wrap([{ text: text.replace(/\t/g, '  ') || ' ', style }], width - 2)) rows.push([{ text: mark, style }, ...l])
  }
  const diff = (before: string, after: string) => {
    for (const d of lineDiff(before, after))
      code(d.text, d.kind === '-' ? { fg: C.red, bg: 52 } : d.kind === '+' ? { fg: C.green, bg: 22 } : { fg: C.gray }, `${d.kind} `)
  }
  switch (s.tool.name) {
    case 'Edit':
      diff(String(i.old_string ?? ''), String(i.new_string ?? ''))
      break
    case 'MultiEdit':
      for (const [n, e] of ((i.edits ?? []) as { old_string?: string; new_string?: string }[]).entries()) {
        if (n) rows.push([{ text: '  ⋯', style: { fg: C.faint } }])
        diff(String(e.old_string ?? ''), String(e.new_string ?? ''))
      }
      break
    case 'Write':
      for (const l of String(i.content ?? '').split('\n')) code(l, { fg: C.green }, '+ ')
      break
    case 'NotebookEdit':
      for (const l of String(i.new_source ?? '').split('\n')) code(l, { fg: C.green }, '+ ')
      break
    case 'Bash': {
      const cmd = String(i.command ?? '')
      rows.push([
        { text: '$ ', style: { fg: C.cyan, bold: true } },
        { text: '⧉ copy', style: { fg: C.gray }, action: () => ctx.copy(cmd) },
      ])
      for (const l of cmd.split('\n')) code(l, { fg: C.white })
      if (s.result) for (const l of s.result.replace(/\s+$/, '').split('\n')) code(l, { fg: s.isError ? C.red : C.gray })
      break
    }
    default: {
      const input = JSON.stringify(i, null, 1)
      for (const l of (input.length > 2000 ? input.slice(0, 2000) + '…' : input).split('\n')) code(l, { fg: C.gray })
      if (s.result) for (const l of s.result.replace(/\s+$/, '').split('\n')) code(l, { fg: s.isError ? C.red : C.faint })
    }
  }
  const shown = s.isFull ? rows : rows.slice(0, DETAIL_ROWS)
  const out = shown.map(l => [pad(left), ...l])
  if (shown.length < rows.length)
    out.push([pad(left), { text: `… ${rows.length - shown.length} more lines, show all`, style: { fg: C.cyan }, action: () => { s.isFull = true; ctx.poke() } }])
  return out
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
      // Claude went on by itself (an agent came back): no message of yours to draw.
    } else if (turn.reaction) {
      // On which reply: a click goes there.
      const on = ctx.kept.links[turn.key]
      const t = on ? `you reacted ${turn.reaction} on “${clip(on.text, Math.max(10, meMax - 20))}”` : `you reacted ${turn.reaction}`
      const go = on?.anchor ? () => ctx.jump(on.anchor!) : undefined
      out.push([pad(width - cells(t) - 1), { text: t, style: { fg: C.gray, italic: true, ...(go ? { underline: true } : {}) }, ...(go ? { action: go } : {}) }])
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
      if (chain > 1) foot.push({ text: `⛓ chain · ${chain}  `, style: { fg: C.cyan }, action: () => ctx.openChain(turn) })
      // Sent while Claude worked, and Claude hasn't got to it yet.
      if (turn.queued && !turn.isDone && !turn.steps.length && !turn.live) foot.push({ text: '⏸ queued: Claude reads it at its next step  ', style: { fg: C.faint, italic: true } })
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
    // Queued and not reached yet: nothing of Claude's under it until it is.
    const notYet = !!turn.queued && working && !turn.steps.length && !turn.live && !hasParts
    if (!notYet && (showSteps || working || text || hasParts || carried)) {
      owned = out.length
      const doneAt = new Date(turn.at + (turn.durationMs ?? 0))
      const time = `${String(doneAt.getHours()).padStart(2, '0')}:${String(doneAt.getMinutes()).padStart(2, '0')}`
      const doing = carried ? (stillHere ? ' is working… your next message is queued ↓' : goesOn ? ' is still on it, with your next message ↓' : ' · went on with your next message ↓') : !working ? ` · ${time}${turn.followUp ? ' · followed up' : ''}` : turn.followUp ? ' is following up…' : turn.live ? ' is typing…' : turn.steps.length ? ' is working…' : ` is thinking… ${secs(ctx.now - turn.at)}`
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

    if (turn.error) out.push([pad(IN), { text: `✕ ${turn.error}`, style: { fg: C.red } }])
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
 * An agent's chat: what Claude asked it (on the right, as the one who wrote to it), then what the
 * agent said and did (on the left, under its avatar), then what it handed back. Below that, your
 * messages about this agent and Claude's replies, drawn as in the main chat.
 */
export function agentLines(a: Agent, about: Turn[], ctx: ChatCtx, width: number): { lines: Line[]; anchors: Record<string, number>; owners: string[] } {
  const out: Line[] = []
  const IN = 4
  const max = Math.max(20, Math.min(110, width - 6 - IN))
  const meMax = Math.max(16, Math.floor(width * 0.75) - 4)

  // Claude's request.
  out.push([])
  const ask = a.prompt ? markdown(a.prompt, meMax, ctx.copy) : [[{ text: a.name, style: {} }] as Line]
  const askW = Math.max(snug(ask, meMax), 16)
  out.push(...bubble(ask, askW, Math.max(0, width - askW - 5), { fg: C.claude }, undefined, undefined, { text: a.asker ?? '✻ Claude asked', style: { fg: a.asker ? C.cyan : C.claudeName, bold: true } }))

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
    out.push([pad(IN), { text: a.isBackground ? 'It runs in the background: Claude Code does not stream its steps here. What it hands back shows below when it is done.' : a.state === 'running' ? `${ctx.spin} starting…` : 'No steps were streamed.', style: { fg: C.gray, italic: true } }])
  for (const e of a.log) {
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

  // What it handed back to Claude.
  if (a.result) {
    out.push([])
    const body = markdown(a.result, max, ctx.copy)
    const ok = a.state !== 'failed'
    const tag: Span = { text: ok ? (a.resultLabel ?? '✓ handed back to Claude') : '✕ failed', style: { fg: ok ? C.green : C.red, bold: true } }
    out.push(...bubble(body, Math.max(snug(body, max), cells(tag.text) + 1), IN, { fg: ok ? C.green : C.red }, undefined, undefined, tag))
    out.push([pad(IN + 2), { text: '⧉ copy', style: { fg: C.gray }, action: () => ctx.copy(a.result ?? '') }])
  } else if (a.state === 'running') out.push([pad(IN), { text: `${ctx.spin} working · ${a.steps} step${a.steps === 1 ? '' : 's'} so far`, style: { fg: C.cyan } }])

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
  const head: Span[] = [pad(2), { text: `${info.mark} ${info.state}`, style: { bold: true, fg: info.isStale ? C.yellow : info.state === 'done' ? C.green : C.cyan } }]
  const replies = info.turns.reduce((n, t) => n + (t.parts ?? []).filter(p => p.to.some(id => info.ids.includes(id))).length, 0)
  head.push({ text: `  ·  ${replies} repl${replies === 1 ? 'y' : 'ies'}${info.agents.length ? ` · ${info.agents.length} agent${info.agents.length === 1 ? '' : 's'}` : ''}`, style: { fg: C.gray } })
  if (info.state !== 'done') head.push({ text: '   ' }, { text: ' ask for status ', style: { inverse: true, fg: C.yellow }, action: ctx.askStatus })
  out.push(head)
  if (info.isStale) out.push([pad(2), { text: '⚠ No update: nothing is working on it. Ask for its status, or add to it below.', style: { fg: C.yellow } }])
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
