// The conversation as the app draws it: turns of (your message, Claude's steps, Claude's answer),
// plus what the app keeps beside Claude Code's own session file (threads, reactions, links).

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { emptyBoard, keyOf, reactionText, stripTag } from '../hooks/model.ts'
import type { Board } from '../types/index.d.ts'
import type { ToolUse } from './claude.ts'
import { deletedAsked, hasMarks, lostRepliesAsked } from './inbox.ts'
import type { Part } from './inbox.ts'
import { shellsFromTurns } from './shells.ts'
import { agentsFromTurns, notifiedFor } from './tasks.ts'

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
  /** When Claude made the call (from the session file). */
  at?: number
  /** The folder Claude Code was in when it ran a shell command (from the session file). */
  cwd?: string
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
  /**
   * Where your message is on its way: the app has it (sending), it is written to Claude Code
   * (sent). None: Claude Code took it into the conversation (it echoes it back), or it is history.
   */
  delivery?: 'sending' | 'sent'
  /** The id it was sent with: Claude Code's echo of it carries the same one. */
  uuid?: string
  /** Its work went on under a later message (sent while it ran): one piece of work, not a stopped one. */
  continued?: boolean
  /**
   * Claude Code compacted the conversation during or right after this turn: it and the turns before
   * it are left to Claude's summary (a reply to one of them brings its request's chain along).
   */
  compacted?: boolean
  /** Sent from inside a request's view: that request's turn key. */
  aboutRequest?: string
  /** Sent from inside an agent's view: that agent's id. */
  aboutAgent?: string
  /** Sent from inside a scheduled job's view: that job's tool call id. */
  aboutJob?: string
  /** A reaction sent as a message: drawn as one small line. */
  reaction?: string
  /** The app asking Claude again for replies that never arrived (their topic ids): drawn as one small line. */
  retry?: string[]
  /**
   * You deleted it after it went to Claude Code: withdrawn (Claude Code dropped it from its queue,
   * Claude never sees it) or told (it was too late for that: Claude was told to ignore it).
   * Drawn as one small line, and left out of the panel.
   */
  deleted?: 'withdrawn' | 'told'
  /** Being deleted: the app asked Claude Code to drop it and waits for the answer. */
  deleting?: boolean
  /** The app telling Claude to ignore a message you deleted (its topic id): not drawn itself. */
  deletes?: string
  steps: Step[]
  /** Claude's final words, tag stripped. */
  answer?: string
  /** Reply parts Claude wrote mid-turn, before more work: shown at once, ahead of the final answer. */
  early?: string[]
  /**
   * The last of them with its tag, while nothing has come after it: a reply part shows as soon as
   * Claude finishes writing it. Its next step leaves it an early part; if the turn ends there, it is
   * the final answer after all.
   */
  tail?: string
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
  /**
   * From the session file: background agents' task notifications that came during this turn, each
   * after this many of its steps.
   */
  agentEnds?: AgentEnd[]
}

/** A task notification in the session file: an agent's run ended. */
export type AgentEnd = { taskId: string; toolUseId?: string; status: string; summary?: string; at: number; after: number }

/** The task notifications in a message's text (<task-notification> blocks). */
export function agentEndsIn(text: string, at: number, after: number): AgentEnd[] {
  const out: AgentEnd[] = []
  for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const field = (k: string) => m[1]!.match(new RegExp(`<${k}>([\\s\\S]*?)</${k}>`))?.[1]?.trim()
    const taskId = field('task-id') ?? ''
    const toolUseId = field('tool-use-id')
    if (!taskId && !toolUseId) continue
    const summary = field('summary')
    out.push({ taskId, ...(toolUseId ? { toolUseId } : {}), status: field('status') ?? 'completed', ...(summary ? { summary } : {}), at, after })
  }
  return out
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
  /** Agents still running when the app quit (Agent tool use id: how), so on resume they say why they stopped. */
  stopped?: Record<string, 'reload' | 'exit'>
  /** Set once the parts there were when the app first opened this session were marked read. */
  readInit?: boolean
  /** 2: the replies Claude wrote by itself (after an agent, a job) have the same ids live and on resume. */
  readIds?: number
  /** This chat's work setting. */
  work?: Work
  /**
   * Replies Claude wrote mid-turn, by turn key, as the app got them live: Claude Code's transcript can
   * miss them, and the chat is rebuilt from it on load.
   */
  early?: Record<string, string[]>
  /** Messages you saved to get back to later, newest last. */
  saved?: Saved[]
  /**
   * Messages you sent that were still waiting for Claude to finish its turn when the app closed: held
   * again when it opens the session. `from`: what each replied to, the view it was written in, its images.
   */
  held?: { text: string; from: unknown }[]
  /** A branch (/branch): the session it was forked from, when, and the name you gave it. */
  forkOf?: { id: string; at: number; name?: string }
  /** Folders /add-dir added: Claude Code gets each (--add-dir) whenever it starts on this session. */
  addDirs?: string[]
  /** The images your messages were sent with, by turn key: `[image N]` in its text is the Nth file. */
  images?: Record<string, string[]>
}

/**
 * A message you saved: `anchor` is where it is in the chat (`me:<turn key>` for yours, `part:<id>`
 * for one of Claude's reply parts; both stay the same on resume). Its words are kept too, so the
 * Saved list still shows it when the chat can't.
 */
export type Saved = { anchor: string; who: 'me' | 'claude'; text: string; at: number }

/** Saves a message, or unsaves it when it was saved. */
export function toggleSaved(list: readonly Saved[], item: Saved): Saved[] {
  return list.some(x => x.anchor === item.anchor) ? list.filter(x => x.anchor !== item.anchor) : [...list, item].slice(-500)
}

/**
 * The key of Claude's turn answering an agent's end: the same live and from the session file. An
 * agent continued ends again: its next one is follow-<id>.2, and so on.
 */
export function followKey(turns: Turn[], taskId: string) {
  const base = `follow-${taskId}`
  const n = turns.filter(t => t.key === base || t.key.startsWith(`${base}.`)).length
  return n ? `${base}.${n + 1}` : base
}
/**
 * The key of a scheduled job's turn: by the minute it fired, so the app's clock and the session
 * file's agree (a job fires at most once a minute).
 */
export const firedKey = (at: number) => `fired-${Math.floor(at / 60000).toString(36)}`

/** The app telling Claude to ignore a message you deleted (deletedPrompt): that message stays deleted on resume. */
function markDeleted(turn: Turn, turns: readonly Turn[]) {
  const gone = deletedAsked(turn.text)
  if (!gone) return
  turn.reaction = '✕'
  turn.deletes = gone
  const was = turns.findLast(t => t.topicId === gone && !t.reaction)
  if (was) was.deleted = 'told'
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
export function saveKept(sessionId: string, kept: Kept, now = false) {
  clearTimeout(saveTimer)
  const write = () => {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(`${DIR}/${sessionId}.json`, JSON.stringify(kept))
  }
  if (now) write()
  else saveTimer = setTimeout(write, 300)
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
  // Whether Claude's last turn had ended (so news from an agent starts a turn of its own).
  let ended = false
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
    // Claude Code compacted the conversation here: what came before is only in its summary now.
    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      if (cur) cur.compacted = true
      continue
    }
    const at = Date.parse(e.timestamp ?? '') || 0
    // A background agent's run ended: Claude Code tells Claude with a task notification.
    if (cur && (e.type === 'user' || (e.type === 'attachment' && e.attachment?.type === 'queued_command'))) {
      const c = e.type === 'user' ? e.message?.content : e.attachment.prompt
      const raw = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b.type === 'text').map((b: any) => String(b.text)).join('\n') : ''
      if (raw.includes('<task-notification>')) {
        const ends = agentEndsIn(raw, at, cur.steps.length)
        if (ends.length) cur.agentEnds = [...(cur.agentEnds ?? []), ...ends]
        // Claude had finished: it answers the notification in a turn of its own, as it does live
        // (same key, so what you read stays read).
        if (ended && e.type === 'user' && ends[0]) {
          const id = ends[0].taskId || ends[0].toolUseId!
          // About the messages the agents or commands that ended worked for, as live; else a guess.
          // Read from the first turn that started one of them, not the whole file again each time.
          const ids = ends.map(x => x.taskId || x.toolUseId!)
          const since = turns.findIndex(t => t.steps.some(s => ends.some((x, i) => s.tool.id === x.toolUseId || (s.result ?? '').includes(ids[i]!))))
          const told = since < 0 ? undefined : notifiedFor(agentsFromTurns(turns.slice(since)), shellsFromTurns(turns.slice(since)).list, ids)
          const from = turns.find(t => t.steps.some(s => (s.tool.name === 'Agent' || s.tool.name === 'Task') && (s.tool.id === ends[0]!.toolUseId || (s.result ?? '').includes(id))))
          finish()
          cur = newTurn('', at)
          cur.key = followKey(turns, id)
          cur.followUp = told ?? (from ? (from.followUp ?? [from.key]) : turns.filter(x => !x.reaction && !x.followUp).slice(-1).map(x => x.key))
          turns.push(cur)
          ended = false
          continue
        }
      }
    }
    if (e.type === 'assistant') ended = e.message?.stop_reason === 'end_turn' || e.message?.stop_reason === 'stop_sequence'
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
      ended = false
      cur = newTurn(text, at)
      if (tid) cur.topicId = tid
      cur.queued = true
      cur.pending = carry
      markDeleted(cur, turns)
      turns.push(cur)
      continue
    }
    // A scheduled job firing: Claude Code wrote its prompt as a hidden message, and Claude answers it.
    if (e.type === 'user' && e.isMeta && (e.turnOrigin === 'scheduled' || e.wakeupSource)) {
      const c = e.message?.content
      const prompt = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') : ''
      finish()
      ended = false
      cur = newTurn('', at)
      cur.key = firedKey(at)
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
      ended = false
      cur = newTurn(text, at)
      const tid = briefTopic(JSON.stringify(c))
      if (tid) cur.topicId = tid
      const reacted = reactionText(text)
      if (reacted !== undefined) cur.reaction = reacted.trim().split(/\s/)[0] ?? '👍'
      // The app asking again for replies that never arrived: shown as that, not as a message of yours.
      const retry = lostRepliesAsked(text)
      if (retry) {
        cur.reaction = '↻'
        cur.retry = retry
      }
      markDeleted(cur, turns)
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
          const step: Step = { tool: { id: b.id, name: b.name, input: b.input ?? {} }, ...(cur.pending ? { said: stripTag(cur.pending) } : {}), ...(at ? { at } : {}) }
          if (b.name === 'Bash' && typeof e.cwd === 'string' && e.cwd) step.cwd = e.cwd
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

/** What a background agent did, read from its own transcript (Claude Code does not stream it). */
/** `at`: when the transcript says it happened, else when the file last changed. */
export type AgentFileEntry = (
  | { kind: 'step'; tool: { id: string; name: string; input: Record<string, unknown> } }
  | { kind: 'text'; text: string }
  | { kind: 'result'; id: string; text: string; isError: boolean }
  /** A message to it after its first (a SendMessage arriving). */
  | { kind: 'prompt'; text: string }
  /** A task notification it was given: one of its background commands (or its own agents) ended. */
  | { kind: 'task-end'; end: AgentEnd }
) & { at: number }

/** How Claude Code writes a message Claude sends a running agent (SendMessage): hidden, in these words. */
const SENT = 'The coordinator sent a message while you were working:\n'
const SENT_END = '\n\nAddress this before completing your current task.'
/** The message in Claude Code's words around it (it is written exactly as sent). */
export const sentMessage = (t: string) => {
  const body = t.startsWith(SENT) ? t.slice(SENT.length) : t
  return body.endsWith(SENT_END) ? body.slice(0, -SENT_END.length) : body
}
/** A line Claude Code writes when the agent is stopped mid-step: no one sent it this. */
const isInterruption = (t: string) => /^\[Request interrupted by user[^\]]*\]$/.test(t.trim())

/**
 * A background agent's new entries since byte `from`, in Claude Code's file for it
 * (<project>/<session>/subagents/agent-<id>.jsonl), and where the next read starts. Only whole lines
 * are read: one still being written waits for the next read. The first message to it, Claude's
 * prompt, is skipped (the app has it from the Agent call). Later ones are SendMessage arriving:
 * Claude Code writes them hidden, as "The coordinator sent a message while you were working: …".
 * Not messages to it: the summary a compaction writes, an interruption line, other hidden entries
 * (another session's or the user's message to it, a reminder). A task notification (as a hidden
 * message, or an attachment when it came mid-turn) is a task-end: often the only word of the end of
 * a background command the agent started, as Claude Code may not stream it. A fork's file
 * starts with a reference to Claude's context and Claude's own Agent call (its prompt is in it): it
 * has no first message to skip, and that call is not one of its steps.
 */
export function readAgentFile(cwd: string, sessionId: string, agentId: string, from: number): { entries: AgentFileEntry[]; next: number } {
  const entries: AgentFileEntry[] = []
  let fd: number | undefined
  try {
    fd = openSync(`${projectDir(cwd)}/${sessionId}/subagents/agent-${agentId}.jsonl`, 'r')
    const { size, mtimeMs } = fstatSync(fd)
    if (size <= from) return { entries, next: from }
    const buf = Buffer.alloc(size - from)
    readSync(fd, buf, 0, buf.length, from)
    const end = buf.lastIndexOf(0x0a)
    if (end < 0) return { entries, next: from }
    let isPrompted = from > 0
    // A fork's: the next entry is Claude's Agent call that started it, and its result.
    let isForkStart = false
    const inherited = new Set<string>()
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      let e: any
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      const content = e.message?.content
      const at = Date.parse(e.timestamp ?? '') || mtimeMs
      if (e.type === 'fork-context-ref') {
        isPrompted = true
        isForkStart = true
        continue
      }
      if (isForkStart && e.type === 'assistant') {
        isForkStart = false
        const calls = (Array.isArray(content) ? content : []).filter((b: any) => b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task'))
        for (const b of calls) inherited.add(String(b.id))
        if (calls.length) continue
      }
      const isResult = Array.isArray(content) && content.some((b: any) => b.type === 'tool_result')
      // A task notification given to it: mid-turn (an attachment), or waking it (a hidden message).
      // Only Claude Code's own (hidden) entries: a message that quotes one (Claude's, another session's) is still a message.
      const note = e.type === 'attachment' && e.attachment?.type === 'queued_command' ? e.attachment.prompt : e.type === 'user' && !isResult && (e.origin?.kind === 'task-notification' || (e.isMeta && !e.origin)) ? content : undefined
      const noteText = typeof note === 'string' ? note : Array.isArray(note) ? note.filter((b: any) => b.type === 'text').map((b: any) => String(b.text)).join('\n') : ''
      if (noteText.includes('<task-notification>')) {
        for (const end of agentEndsIn(noteText, at, 0)) entries.push({ kind: 'task-end', end, at })
        continue
      }
      if (e.type === 'user' && !isResult && (typeof content === 'string' || Array.isArray(content))) {
        const text = typeof content === 'string' ? content : content.filter((b: any) => b.type === 'text').map((b: any) => String(b.text)).join('\n')
        // A message Claude sent it (SendMessage), hidden in Claude Code's words.
        if (e.origin?.kind === 'coordinator' || text.startsWith(SENT)) {
          const sent = sentMessage(text)
          if (sent.trim()) entries.push({ kind: 'prompt', text: sent, at })
          continue
        }
        if (e.isMeta || e.isCompactSummary || e.isVisibleInTranscriptOnly || isInterruption(text) || text.startsWith('This session is being continued')) continue
        // A message to the agent: the first is Claude's prompt (the app has it from the Agent call).
        if (!isPrompted) isPrompted = true
        else if (text.trim()) entries.push({ kind: 'prompt', text, at })
        continue
      }
      if (!Array.isArray(content)) continue
      for (const b of content) {
        if (e.type === 'assistant' && b.type === 'tool_use') entries.push({ kind: 'step', tool: { id: String(b.id), name: String(b.name), input: b.input ?? {} }, at })
        else if (e.type === 'assistant' && b.type === 'text' && b.text) entries.push({ kind: 'text', text: String(b.text), at })
        else if (e.type === 'user' && b.type === 'tool_result' && !inherited.has(String(b.tool_use_id))) {
          const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') : ''
          entries.push({ kind: 'result', id: String(b.tool_use_id), text, isError: !!b.is_error, at })
        }
      }
    }
    return { entries, next: from + end + 1 }
  } catch {
    return { entries, next: from }
  } finally {
    if (fd != null) closeSync(fd)
  }
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
