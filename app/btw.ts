// /btw: a quick side question. It runs in a Claude Code of its own, forked from this session
// (--resume <id> --fork-session), so it sees the conversation, but the session itself never gets
// the question: forking leaves the original session file alone, and with --no-session-persistence
// the fork writes no file of its own. It has no tools, works while Claude is busy, and ends once
// it has answered. The answer shows in the chat as a dimmed aside: no topic, no part, no unread.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { Claude } from './claude.ts'
import type { ClaudeEvent, Options } from './claude.ts'
import { stripMarks } from './inbox.ts'
import { COMMAND } from './command.ts'
import { markdown } from './markdown.ts'
import { projectDir } from './session.ts'
import { C, cells, clip, pad, wrap } from './text.ts'
import type { Line, Span } from './text.ts'

export type Aside = {
  id: number
  question: string
  /** The answer so far (streamed), then the whole of it. */
  answer: string
  state: 'asking' | 'answered' | 'failed'
  /** The key of the chat's last message when you asked: the aside sits after it ('' before any). */
  after: string
  /** Asked in a session (forked from it), or before there was one (no conversation to see). */
  forked: boolean
  error?: string
}

/** The side process: what the app needs of a Claude Code (the real one is app/claude.ts). */
export type Side = Pick<Claude, 'send' | 'close' | 'answerPermission' | 'answerAsk'>
export type Spawn = (opts: Options, onEvent: (e: ClaudeEvent) => void) => Side

/** What the side Claude reads with the question (the app shows only the question). */
export const BTW_NOTE = [
  '[clued] This is a side question (/btw). Answer it directly and briefly from what you already know of this conversation.',
  'It is not part of the work: do not continue, redo or plan the task, and you have no tools.',
  'Write plain Markdown only: no <<reply>> lines and no <clued> tag.',
].join(' ')

/** For a side question with no session yet (a resumed one keeps the session's own system prompt). */
const BTW_PROMPT = 'The user asks you a quick side question in a terminal chat app. Answer it directly and briefly.'

/**
 * The side Claude Code's own arguments: forked from the session when there is one, the same model,
 * no tools (built-in or MCP), no hooks, and no session file of its own.
 */
export function btwArgs(sessionId: string, model: string): string[] {
  return [
    ...(sessionId ? ['--resume', sessionId, '--fork-session'] : []),
    '--no-session-persistence',
    '--tools', '',
    '--strict-mcp-config',
    '--settings', '{"disableAllHooks":true}',
    ...(model ? ['--model', model] : []),
  ]
}

/** The answer without the app's own markup, if Claude writes it anyway. */
export const cleanAnswer = (text: string) => stripMarks(text.replace(/<(?:clued|threadline)>[\s\S]*?(?:<\/(?:clued|threadline)>|$)/g, '')).trim()

/** Line positions of a laid-out chat: what the aside lines go between. */
export type Laid = { lines: Line[]; anchors: Record<string, number>; owners: string[] }

/** Where a message's lines may start in the chat (chat.ts anchors). */
const STARTS = ['fired', 'me', 'work', 'now', 'claude']

export type Draw = { copy: (text: string) => void; spin: string }

export class Btw {
  asides: Aside[] = []
  private live = new Map<number, Side>()
  private next = 1
  private changed: () => void
  private spawn: Spawn
  constructor(changed: () => void, spawn: Spawn = (o, e) => new Claude(o, e)) {
    this.changed = changed
    this.spawn = spawn
  }

  /**
   * Asks `question` aside; `after` is the chat's last message key ('' when there is none). A session
   * Claude Code hasn't written yet has nothing to fork: the question goes to a fresh Claude Code.
   */
  ask(question: string, at: { sessionId: string; model: string; cwd: string; after: string }): Aside {
    const sessionId = at.sessionId && existsSync(`${projectDir(at.cwd)}/${at.sessionId}.jsonl`) ? at.sessionId : ''
    const a: Aside = { id: this.next++, question, answer: '', state: 'asking', after: at.after, forked: !!sessionId }
    this.asides.push(a)
    let streamed = ''
    let said = ''
    // Claude Code took the question in (its echo). A resumed session can end a turn of its own first,
    // empty (a background agent's end, told to the fork): that is not the answer.
    const uuid = randomUUID()
    let taken = false
    const side = this.spawn({ args: btwArgs(sessionId, at.model), cwd: at.cwd, appendSystemPrompt: BTW_PROMPT }, e => {
      if (a.state !== 'asking') return
      switch (e.kind) {
        case 'received':
          if (e.uuid === uuid) taken = true
          return
        case 'text-delta':
          streamed += e.text
          a.answer = cleanAnswer(streamed)
          break
        case 'text':
          said += (said ? '\n\n' : '') + e.text
          a.answer = cleanAnswer(said)
          break
        // No tools to ask for; whatever asks anyway is refused.
        case 'permission':
          side.answerPermission(e.requestId, false, e.input)
          return
        case 'ask':
          side.answerAsk(e.requestId, e.input, 'This is a side question: answer it without asking.')
          return
        case 'result': {
          const text = cleanAnswer(said || e.text || streamed)
          if (!taken && !text && !e.isError) return
          if (e.isError || !text) {
            a.state = 'failed'
            a.error = e.isError && e.text ? e.text : 'No answer came back.'
          } else {
            a.state = 'answered'
            a.answer = text
          }
          this.end(a.id)
          break
        }
        case 'exit':
          a.state = 'failed'
          a.error = `The side question stopped before answering${e.stderr.trim() ? `: ${e.stderr.trim().split('\n').at(-1)}` : ` (exit ${e.code})`}.`
          this.live.delete(a.id)
          break
        default:
          return
      }
      this.changed()
    })
    this.live.set(a.id, side)
    side.send(question, BTW_NOTE, [], uuid)
    this.changed()
    return a
  }

  /** Its Claude Code goes once it has answered. */
  private end(id: number) {
    this.live.get(id)?.close()
    this.live.delete(id)
  }

  dismiss(id: number) {
    this.end(id)
    this.asides = this.asides.filter(a => a.id !== id)
    this.changed()
  }

  /** Esc: closes the latest aside; false when there is none. */
  dismissLast(): boolean {
    const a = this.asides.at(-1)
    if (!a) return false
    this.dismiss(a.id)
    return true
  }

  /** A new or other session: the asides go, and any side question still running. */
  clear() {
    this.close()
    this.asides = []
  }

  close() {
    for (const id of [...this.live.keys()]) this.end(id)
  }

  /** One aside's lines, `width` wide. */
  lines(a: Aside, width: number, d: Draw): Line[] {
    const border = { fg: C.faint }
    const b = (t: string): Span => ({ text: t, style: border })
    const close: Span = { text: '✕', style: { fg: C.gray }, action: () => this.dismiss(a.id) }
    const room = Math.max(8, width - 12)
    const out: Line[] = [[]]
    const q = clip(a.question.replace(/\s+/g, ' '), room)
    // The question as you asked it: /btw in the colour of a command, as in the box and your messages.
    out.push([pad(2), b('╭ '), { text: '/btw', style: COMMAND }, { text: ` ${q}`, style: { fg: C.gray, italic: true } }, pad(Math.max(1, room - cells(q) + 2)), close])
    const bodyW = Math.max(10, Math.min(80, width - 6))
    const body: Line[] =
      a.state === 'failed'
        ? wrap([{ text: `✕ ${a.error}`, style: { fg: C.red } }], bodyW)
        : [
            // Dimmed: Claude's words, but not a reply in the conversation.
            ...(a.answer ? markdown(a.answer, bodyW, d.copy).map(l => l.map(s => ({ ...s, style: { ...s.style, fg: s.style?.bg != null ? s.style.fg : C.gray } }))) : []),
            ...(a.state === 'asking' ? [[{ text: `${d.spin} thinking about it aside…`, style: { fg: C.faint, italic: true } }]] : []),
          ]
    for (const l of body) out.push([pad(2), b('│ '), ...l])
    out.push([
      pad(2),
      b('╰ '),
      { text: a.forked ? 'a side answer: not part of the conversation' : 'a side answer, with no conversation yet to see', style: { fg: C.faint, italic: true } },
      ...(a.state === 'answered' ? [b(' · '), { text: '⧉ copy', style: { fg: C.gray }, action: () => d.copy(a.answer) }] : []),
      b(' · '),
      { text: '✕ close', style: { fg: C.gray }, action: () => this.dismiss(a.id) },
    ])
    return out
  }

  /**
   * The chat with each aside after the message that was last when it was asked (before the next
   * message's lines). `keys`: the chat's messages, in order.
   */
  into(laid: Laid, keys: string[], width: number, d: Draw): Laid {
    return placeAsides(laid, keys, this.asides.map(a => ({ after: a.after, lines: this.lines(a, width, d) })))
  }
}

/**
 * The chat with lines of its own put in after the message that was last when each came (`after`, a
 * turn key; '' before any message): before the next message's lines. Anchors and owners move down
 * with the lines; `anchor` names where an aside starts. One from another session's chat is left out.
 */
export function placeAsides(laid: Laid, keys: string[], asides: { after: string; lines: Line[]; anchor?: string }[]): Laid {
  const inserts: { at: number; lines: Line[]; anchor?: string }[] = []
  for (const a of asides) {
    const from = a.after ? keys.lastIndexOf(a.after) : -1
    // Asked in another session's chat.
    if (a.after && from < 0) continue
    let at = laid.lines.length
    for (const k of keys.slice(from + 1)) {
      const starts = STARTS.map(p => laid.anchors[`${p}:${k}`]).filter((n): n is number => n != null)
      if (starts.length) {
        at = Math.min(...starts)
        break
      }
    }
    inserts.push({ at, lines: a.lines, ...(a.anchor ? { anchor: a.anchor } : {}) })
  }
  if (!inserts.length) return laid
  // The asides going in before each line; a blank row parts them from the message after.
  const before = new Map<number, Line[]>()
  // Each named aside's place within the lines going in before its line.
  const offset = new Map<string, number>()
  for (const x of inserts) {
    const ls = before.get(x.at) ?? []
    if (x.anchor) offset.set(x.anchor, ls.length)
    before.set(x.at, [...ls, ...x.lines])
  }
  for (const [at, ls] of before) if (at < laid.lines.length) ls.push([])
  const lines: Line[] = []
  const owners: string[] = []
  const placed = new Map<number, number>()
  for (let n = 0; n <= laid.lines.length; n++) {
    placed.set(n, lines.length)
    for (const l of before.get(n) ?? []) lines.push(l), owners.push('')
    if (n < laid.lines.length) lines.push(laid.lines[n]!), owners.push(laid.owners[n] ?? '')
  }
  const moved = (n: number) => n + [...before].filter(([at]) => at <= n).reduce((sum, [, ls]) => sum + ls.length, 0)
  const anchors = Object.fromEntries(Object.entries(laid.anchors).map(([k, v]) => [k, moved(v)]))
  for (const x of inserts) if (x.anchor) anchors[x.anchor] = placed.get(x.at)! + offset.get(x.anchor)!
  return { lines, anchors, owners }
}
