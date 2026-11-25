// The conversation as the app draws it: turns of (your message, Claude's steps, Claude's answer),
// plus what the app keeps beside Claude Code's own session file (threads, reactions, links).

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { emptyBoard, keyOf, reactionText, stripTag } from '../hooks/model.ts'
import type { Board } from '../types/index.d.ts'
import type { ToolUse } from './claude.ts'
import { hasMarks } from './inbox.ts'
import type { Part } from './inbox.ts'

export type Step = {
  tool: ToolUse
  result?: string
  isError?: boolean
  said?: string
  /** Shown with its details (diff, command and output), against what the work setting says. */
  isOpen?: boolean
  /** Details shown whole, not cut at DETAIL_ROWS. */
  isFull?: boolean
  /** The result's structured form, when Claude Code gave one (CronCreate's id and next run). */
  data?: unknown
}

/** How much of Claude's work a chat shows: one folded line, the file edits as diffs, or every step with its output. */
export type Work = 'folded' | 'edits' | 'all'

export type Turn = {
  /** keyOf(your text): what topics, replies and reactions point at. */
  key: string
  text: string
  at: number
  /** The topic id this message was given (T63): what Claude's <<reply>> lines name, even after it merges into another. */
  topicId?: string
  /** Sent while Claude was working: Claude Code queues it until Claude's next step. */
  queued?: boolean
  /** Its work went on under a later message (sent while it ran): one piece of work, not a stopped one. */
  continued?: boolean
  /** Sent from inside a request's view: that request's turn key. */
  aboutRequest?: string
  /** Sent from inside an agent's view: that agent's id. */
  aboutAgent?: string
  /** Sent from inside a scheduled job's view: that job's tool call id. */
  aboutJob?: string
  /** A reaction sent as a message: drawn as one small line. */
  reaction?: string
  steps: Step[]
  /** Claude's final words, tag stripped. */
  answer?: string
  /** Reply parts Claude wrote mid-turn, before more work: shown at once, ahead of the final answer. */
  early?: string[]
  /** The answer as replies to your messages (app/inbox.ts). */
  parts?: Part[]
  /** A turn Claude started on its own (an agent came back): the messages (turn keys) it follows up on. */
  followUp?: string[]
  /** A turn a scheduled job started: its prompt and kind (when known), and the job (its call id, once matched). */
  fired?: { prompt?: string; source?: string; job?: string }
  /** The latest of several follow-ups on the same messages: whether the earlier ones are shown. */
  showUpdates?: boolean
  /** Streaming text not yet known to be narration or the answer. */
  live: string
  /** Text finished in this turn and not yet followed by a tool. */
  pending: string
  isDone: boolean
  isOpen: boolean
  error?: string
  durationMs?: number
}

export type Reaction = { emoji: string; by: 'me' | 'claude' }
/** A reply's link to the message it answered: `who` wrote the answered one, `key` is its turn key. */
export type Link = { key: string; who: 'me' | 'claude'; text: string; /** Set by the app from Claude's tag, not by your click. */ auto?: boolean; /** Where a click goes (a reply part), and how many more it answered. */ anchor?: string; more?: number; /** Every message a reply answered, when it answered several. */ all?: { anchor: string; text: string }[] }

export type Kept = {
  board: Board
  /** By turn key; `claude:` + key for reactions on Claude's answer of that turn. */
  reactions: Record<string, Reaction[]>
  /** Reply turn key → what it answered. */
  links: Record<string, Link>
  /** Reply parts you have read (`<turn key>:<index>`). */
  read?: string[]
  /** Set once the parts there were when the app first opened this session were marked read. */
  readInit?: boolean
  /** This chat's work setting. */
  work?: Work
  /**
   * Replies Claude wrote mid-turn, by turn key, as the app got them live: Claude Code's transcript can
   * miss them, and the chat is rebuilt from it on load.
   */
  early?: Record<string, string[]>
}

export const newTurn = (text: string, at = Date.now()): Turn => ({
  key: keyOf(text),
  text,
  at,
  steps: [],
  live: '',
  pending: '',
  isDone: false,
  isOpen: false,
})

const HOME = homedir()
const DIR = `${HOME}/.clued/sessions`

export function loadKept(sessionId: string, cwd: string): Kept {
  const empty: Kept = { board: emptyBoard(), reactions: {}, links: {} }
  try {
    // Notifications are gone (Unread and Waiting say the same): an old file's list is dropped.
    const { notices: _, ...k } = JSON.parse(readFileSync(`${DIR}/${sessionId}.json`, 'utf8')) as Partial<Kept> & { notices?: unknown }
    return { ...empty, ...k, board: { ...emptyBoard(), ...k.board } }
  } catch {
    // First time in the app: take the threads the mod kept for this project, if any.
    try {
      const store = readdirSync(`${HOME}/.claude/plugins/store`).find(f => (f.startsWith('clued_') || f.startsWith('threadline_')))
      if (store) {
        const all = JSON.parse(readFileSync(`${HOME}/.claude/plugins/store/${store}`, 'utf8')) as Record<string, any>
        const v = all[`board:${cwd}`]
        const b = (v && 'value' in v ? v.value : v) as Board | undefined
        if (b?.threads) return { ...empty, board: { ...emptyBoard(), ...b } }
      }
    } catch {}
    return empty
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
export function saveKept(sessionId: string, kept: Kept) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(`${DIR}/${sessionId}.json`, JSON.stringify(kept))
  }, 300)
}

// ---- Claude Code's session files ------------------------------------------------

export const projectDir = (cwd: string) => `${HOME}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}`

export type SessionInfo = { id: string; mtime: number; title: string }

/** This folder's sessions, newest first. */
export function listSessions(cwd: string): SessionInfo[] {
  const dir = projectDir(cwd)
  if (!existsSync(dir)) return []
  const out: SessionInfo[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue
    const path = `${dir}/${f}`
    const mtime = statSync(path).mtimeMs
    let title = ''
    try {
      // The title Claude Code gave it, else the first thing you said.
      const text = readFileSync(path, 'utf8')
      const ai = [...text.matchAll(/"type":"ai-title"[^\n]*?"title":"((?:[^"\\]|\\.)*)"/g)].at(-1)
      if (ai) title = JSON.parse(`"${ai[1]}"`)
      if (!title) {
        for (const l of text.split('\n')) {
          if (!l.includes('"type":"user"')) continue
          const e = JSON.parse(l)
          const c = e.message?.content
          const t = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b: any) => b.type === 'text')?.text : ''
          if (t && !e.isMeta && !t.startsWith('<')) {
            title = t.split('\n')[0]!.slice(0, 80)
            break
          }
        }
      }
    } catch {}
    out.push({ id: f.slice(0, -6), mtime, title: title || '(untitled)' })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

const isNoise = (t: string) =>
  !t.trim() || /^\[(?:clued|threadline)\]/.test(t) || t.startsWith('<') || t.startsWith('Caveat:') || t.startsWith('This session is being continued')

/** The topic id the app's hidden note gave a message ("This message is topic T63"). */
const briefTopic = (raw: string) => raw.match(/\[(?:clued|threadline)\] This message is (?:provisional )?topic (T\d+)/)?.[1]

/** Turns from a Claude Code session file, for showing history on resume. */
export function loadHistory(cwd: string, sessionId: string): Turn[] {
  const path = `${projectDir(cwd)}/${sessionId}.jsonl`
  if (!existsSync(path)) return []
  const turns: Turn[] = []
  let cur: Turn | undefined
  const byId = new Map<string, { turn: Turn; step: Step }>()
  const finish = () => {
    if (cur && !cur.answer && cur.pending) cur.answer = stripTag(cur.pending)
    if (cur) {
      cur.pending = ''
      cur.isDone = true
    }
  }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    let e: any
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.isSidechain) continue
    const at = Date.parse(e.timestamp ?? '') || 0
    // A message you sent while Claude worked: Claude Code stores it as a queued command.
    if (e.type === 'attachment' && e.attachment?.type === 'queued_command') {
      const pr = e.attachment.prompt
      const text = typeof pr === 'string' ? pr.split(/\n\[(?:clued|threadline)\]/)[0]! : Array.isArray(pr) ? pr.filter((b: any) => b.type === 'text').map((b: any) => b.text).filter((t: string) => !isNoise(t)).join('\n') : ''
      if (isNoise(text)) continue
      const tid = briefTopic(JSON.stringify(pr))
      // The work goes on under the newest message, as it does live: unfinished words move with it.
      const carry = cur?.pending ?? ''
      if (cur) {
        cur.pending = ''
        if (!cur.answer) cur.continued = true
      }
      finish()
      cur = newTurn(text, at)
      if (tid) cur.topicId = tid
      cur.queued = true
      cur.pending = carry
      turns.push(cur)
      continue
    }
    // A scheduled job firing: Claude Code wrote its prompt as a hidden message, and Claude answers it.
    if (e.type === 'user' && e.isMeta && (e.turnOrigin === 'scheduled' || e.wakeupSource)) {
      const c = e.message?.content
      const prompt = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') : ''
      finish()
      cur = newTurn('', at)
      cur.key = `fired-${at.toString(36)}`
      cur.fired = { prompt, ...(e.wakeupSource ? { source: String(e.wakeupSource) } : {}) }
      const ask = turns.findLast(t => !t.reaction && !t.followUp)
      cur.followUp = ask ? [ask.key] : []
      turns.push(cur)
      continue
    }
    if (e.type === 'user' && !e.isMeta) {
      const c = e.message?.content
      if (Array.isArray(c) && c.some((b: any) => b.type === 'tool_result')) {
        const one = c.filter((b: any) => b.type === 'tool_result').length === 1
        for (const b of c) {
          if (b.type !== 'tool_result') continue
          const hit = byId.get(b.tool_use_id)
          if (!hit) continue
          hit.step.result = typeof b.content === 'string' ? b.content : (b.content ?? []).filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n')
          hit.step.isError = !!b.is_error
          if (one && e.toolUseResult != null && typeof e.toolUseResult === 'object') hit.step.data = e.toolUseResult
        }
        continue
      }
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).filter((t: string) => !isNoise(t)).join('\n') : ''
      if (isNoise(text)) continue
      finish()
      cur = newTurn(text, at)
      const tid = briefTopic(JSON.stringify(c))
      if (tid) cur.topicId = tid
      const reacted = reactionText(text)
      if (reacted !== undefined) cur.reaction = reacted.trim().split(/\s/)[0] ?? '👍'
      turns.push(cur)
      continue
    }
    if (e.type === 'assistant' && cur) {
      for (const b of e.message?.content ?? []) {
        if (b.type === 'text' && b.text) cur.pending = cur.pending ? `${cur.pending}\n\n${b.text}` : b.text
        else if (b.type === 'tool_use') {
          if (hasMarks(cur.pending)) {
            cur.early = [...(cur.early ?? []), stripTag(cur.pending)]
            cur.pending = ''
          }
          const step: Step = { tool: { id: b.id, name: b.name, input: b.input ?? {} }, ...(cur.pending ? { said: stripTag(cur.pending) } : {}) }
          cur.pending = ''
          cur.steps.push(step)
          byId.set(b.id, { turn: cur, step })
        }
      }
    }
  }
  finish()
  return turns
}

/** The token usage of a session's last main-agent reply (what its context holds), from its file. */
/**
 * The folder Claude Code is working in now (it moves with cd in its shell): the cwd of the
 * session file's last entry. Only the file's tail is read.
 */
export function lastCwd(cwd: string, sessionId: string): string | undefined {
  try {
    const fd = openSync(`${projectDir(cwd)}/${sessionId}.jsonl`, 'r')
    try {
      const size = fstatSync(fd).size
      const len = Math.min(size, 256 * 1024)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, size - len)
      const lines = buf.toString('utf8').trimEnd().split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i]!.includes('"isSidechain":true')) continue // an agent may work elsewhere
        const m = lines[i]!.match(/"cwd":"((?:[^"\\]|\\.)*)"/)
        if (m) return JSON.parse(`"${m[1]}"`) as string
      }
    } finally {
      closeSync(fd)
    }
  } catch {}
  return undefined
}

export function lastUsage(cwd: string, sessionId: string): Record<string, number> | undefined {
  try {
    const lines = readFileSync(`${projectDir(cwd)}/${sessionId}.jsonl`, 'utf8').trimEnd().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.includes('"usage"')) continue
      const e = JSON.parse(lines[i]!)
      if (e.type === 'assistant' && !e.isSidechain && e.message?.usage) return e.message.usage
    }
  } catch {}
  return undefined
}
