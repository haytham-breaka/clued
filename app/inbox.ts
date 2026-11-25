// Replies and the inbox: Claude's answer split into parts, each a reply to one or more of your
// messages; which parts you haven't read; which questions wait on you; where each message stands.

import { stripTag } from '../hooks/model.ts'
import type { Board } from '../types/index.d.ts'
import type { Turn } from './session.ts'
import { remember } from './text.ts'

/** One reply in Claude's answer: `to` holds the topic ids (your messages) it answers. */
export type Part = { to: string[]; text: string; id?: string; subs?: string[] }

/**
 * The questions in one message of yours, when it asks more than one: each is quoted on its own, and
 * Claude can answer one of them by number (T90.2 is the second question of T90).
 */
export function questionsOf(text: string): string[] {
  // Asked of every message on every frame: worked out once per text.
  const known = questionsCache.get(text)
  if (known) return known
  const all = [...text.matchAll(/[^.?!\n]*[^.?!\n\s][^.?!\n]*\?/g)].map(m => m[0].trim()).filter(q => q.split(/\s+/).length >= 2)
  const qs = all.length > 1 ? all : []
  remember(questionsCache, text, qs)
  return qs
}
const questionsCache = new Map<string, string[]>()


/** A line Claude starts a reply part with: <<reply T43,T44>> */
const MARK = /^[ \t]*<<reply\s+([^>]*)>>[ \t]*$/gim

export const REPLY_GUIDE = [
  'Each of your replies answers some of the user\'s messages, which the [clued] notes name (T43, T44...).',
  'When one reply answers several messages that are about different things, split it into parts: start each part',
  'with a line of its own, <<reply T43>> or <<reply T43,T44>> (several ids only when those messages belong together),',
  'then that part\'s answer. The app shows each part as its own bubble quoting the messages it answers.',
  'Leave the line out when the reply answers only the latest message. Ask anything you need from the user at the end of',
  'the part it belongs to, as a question, so the app can list it under "waiting on you".',
  'When offering the user choices, ask with the AskUserQuestion tool, so the app shows them as options they can click.',
  'When one message asks several things, the note numbers them (T90.1, T90.2): a part answering only some of them names',
  'those (<<reply T90.2>>); a part naming the message (T90) quotes all of them.',
  'When a message refers to an earlier one of theirs without quoting it (a follow-up, a fix, "the second thing I asked",',
  'an answer to your question), add "about":"<that message\'s id>" to its entry in the tag (or "same_as" when it continues',
  'the same subject): the app then links the two, as if the user had replied to it.',
  'When an answer is ready, write it then, as its own part, even in the middle of a turn: don\'t hold finished answers',
  'for the end. A part written between tool calls reaches the user at once and is kept; end it with its own tag line',
  'for the messages it settles, so their marks change then. Your last tag still lists every topic.',
  'For a long job that other messages need not wait on, consider a background agent; when it comes back, start what',
  'you write about it with <<reply>> for the message it worked on.',
  'The note lists topics still "on Claude": whenever one of them is finished, or now waits on the user, list it in your',
  'tag with its new status, even when this turn is about something else; otherwise the app keeps showing it as waiting for Claude.',
  'A request is done only when its work is finished: while you still owe work on it (also right after "I will do it"),',
  'mark it "claude"; when you finish it, even later or in the background, write a short closing reply to its id',
  '(<<reply T5>> then "Done: ..." in a line) and mark it "done". If you cannot finish it, say so in a reply to its id.',
].join(' ')

/** Whether text holds reply marks (a reply written mid-turn, not narration). */
export const hasMarks = (text: string) => /^[ \t]*<<reply\s+[^>]*>>[ \t]*$/im.test(text)

/** Drops the reply marks (for previews and notes). */
export const stripMarks = (text: string) => text.replace(MARK, '').replace(/\n{3,}/g, '\n\n').trim()

/** Splits an answer at its reply marks; text before the first mark (or an answer with none) replies to `fallback`. */
export function splitAnswer(answer: string, fallback: string[]): Part[] {
  const text = stripTag(answer)
  const parts: Part[] = []
  let at = 0
  let to = fallback
  let subs: string[] = []
  const part = (text: string): Part => ({ to, text, ...(subs.length ? { subs } : {}) })
  for (const m of text.matchAll(MARK)) {
    const before = text.slice(at, m.index).trim()
    if (before) parts.push(part(before))
    const ids = m[1]!.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(s => /^T\d+(\.\d+)?$/.test(s))
    // T90.2 answers the second question of T90: the part is to T90, and remembers which questions.
    to = [...new Set(ids.map(s => s.split('.')[0]!))]
    subs = ids.filter(s => s.includes('.'))
    if (!to.length) to = fallback
    at = m.index! + m[0].length
  }
  const rest = text.slice(at).trim()
  if (rest) parts.push(part(rest))
  return parts
}

export const topicOfKey = (board: Board, key: string) => board.topics.find(t => t.messageKeys.includes(key))?.id

/** A message's topic id: the one it was given, else the topic holding it. */
const topicOfTurn = (board: Board, t: Turn) => t.topicId ?? topicOfKey(board, t.key)

/**
 * Gives every answered turn its parts. An answer's unmarked text replies to the messages since the
 * previous answer (messages sent while Claude worked are answered together).
 */
export function assignParts(turns: Turn[], board: Board) {
  let since: Turn[] = []
  const times = new Map<string, number>()
  for (const t of turns) {
    if (!t.reaction && !t.followUp) since.push(t)
    // Replies written mid-turn come first, then the final answer: earlier parts keep their ids as more arrive.
    const full = [...(t.early ?? []), t.answer ?? ''].filter(Boolean).join('\n\n')
    if (!full) continue
    const byKey = (k: string) => turns.findLast(x => x.key === k)
    const follows = (t.followUp ?? []).map(k => { const m = byKey(k); return m ? topicOfTurn(board, m) : undefined }).filter((id): id is string => !!id)
    const fallback = follows.length ? follows : since.map(x => topicOfTurn(board, x)).filter((id): id is string => !!id)
    // The same words sent twice ("yes") get different ids: the second is key~1.
    const n = times.get(t.key) ?? 0
    times.set(t.key, n + 1)
    const base = n ? `${t.key}~${n}` : t.key
    t.parts = splitAnswer(full, fallback).map((p, i) => ({ ...p, id: `${base}:${i}` }))
    // Only a final answer closes the group: messages before it are still being answered.
    if (t.answer && !t.followUp) since = []
  }
}

/** Whether a message matches a search: every word of the query is in it, any case. */
export function matches(text: string, query: string): boolean {
  const t = text.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(w => t.includes(w))
}

export const partId = (turn: Turn, i: number) => turn.parts?.[i]?.id ?? `${turn.key}:${i}`

export type PartRef = { id: string; turn: Turn; index: number; part: Part; preview: string }
/**
 * Where one of your messages stands:
 * claude ⏳ not answered yet (Claude is on this turn); progress ▶ answered, but Claude said it still owes
 * work, or an agent is on it; me ✋ the answer asks you something; done ✓ finished; failed ✕ the turn
 * failed; none ○ never answered; lost ⚠ Claude's tag named it, but no reply to it arrived (it went
 * missing on the way: text written before a tool call can). `active`: Claude's turn or an agent is on it now.
 * `stale`: in progress with nothing working on it (shown as waiting for Claude). `queued`: sent while
 * Claude worked on another message and not answered yet (shown as in queue).
 */
export type MessageState = 'claude' | 'progress' | 'me' | 'done' | 'failed' | 'none' | 'lost'
export type MessageRef = {
  turn: Turn
  topicId?: string
  state: MessageState
  replyId?: string
  active?: boolean
  stale?: boolean
  queued?: boolean
  /** When it last moved, and how: you sent it, Claude replied to it, or its status changed. */
  updatedAt: number
  event: 'sent' | 'replied' | 'status'
}

/** What is busy right now: Claude's turn, and the messages agents are working on (turn keys). */
export type Live = { isWorking: boolean; busy: ReadonlySet<string>; now: number; reacted?: ReadonlySet<string> }

/** In progress this long with nothing working on it: shown as waiting for Claude. */
export const STALE_MS = 60 * 1000

/** A message, or a part, as one plain line. */
function previewOnce(text: string, max: number): string {
  const plain = stripMarks(stripTag(text))
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)]|>)\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain
}

/** A message, or a part, as one plain line (the panel asks for each on every frame: kept). */
export function preview(text: string, max = 80): string {
  const key = `${max}\0${text}`
  let p = previews.get(key)
  if (p == null) remember(previews, key, (p = previewOnce(text, max)))
  return p
}
const previews = new Map<string, string>()

/** The last question in a part, if it ends on one (what "waiting on you" shows). */
export function questionOf(text: string): string | undefined {
  const plain = stripMarks(stripTag(text)).replace(/```[\s\S]*?```/g, '').trim()
  const sentences = plain.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean)
  const last = sentences.at(-1)
  return last && last.endsWith('?') ? last.replace(/^[-*>\s]+/, '').replace(/[*_`]+/g, '') : undefined
}

export type Inbox = { unread: PartRef[]; waiting: (PartRef & { question: string })[]; messages: MessageRef[] }

export function inbox(turns: Turn[], board: Board, read: ReadonlySet<string>, live: Live = { isWorking: false, busy: new Set(), now: Date.now() }): Inbox {
  const parts: PartRef[] = []
  for (const turn of turns) (turn.parts ?? []).forEach((part, index) => parts.push({ id: partId(turn, index), turn, index, part, preview: preview(part.text) }))
  const latestFor = new Map<string, PartRef>()
  for (const p of parts) for (const id of p.part.to) latestFor.set(id, p)

  // Waiting on you: a message whose topic waits on you, through the latest part that answered it,
  // when that part asks something; or any recent part ending on a question you haven't answered since.
  const waiting: Inbox['waiting'] = []
  const seen = new Set<string>()
  for (const topic of board.topics) {
    if (topic.status !== 'me') continue
    const p = latestFor.get(topic.id)
    if (!p || seen.has(p.id)) continue
    seen.add(p.id)
    waiting.push({ ...p, question: questionOf(p.part.text) ?? p.preview })
  }

  // A message is answered by the first answer at or after it: messages sent while Claude worked are
  // answered together. This holds even for messages with no topic (history from before the app).
  const answeredBy: (Turn | undefined)[] = []
  let next: Turn | undefined
  for (let i = turns.length - 1; i >= 0; i--) {
    // Only a final answer answers the messages before it; a reply written mid-turn answers just the ones it names.
    if (turns[i]!.answer && turns[i]!.parts?.length && !turns[i]!.followUp) next = turns[i]
    answeredBy[i] = next
  }
  const messages: MessageRef[] = []
  turns.forEach((turn, i) => {
    if (turn.reaction || turn.followUp || turn.text.startsWith('/')) return
    // Its own id (what parts name), and the topic it lives in now (merged ones live in another).
    const topicId = topicOfTurn(board, turn)
    const topic = board.topics.find(t => t.id === topicId) ?? board.topics.find(t => t.messageKeys.includes(turn.key))
    const by = answeredBy[i]
    const own = by?.parts?.find(p => topicId && p.to.includes(topicId))
    // The latest reply naming this message, or the topic it merged into (a closing report may name either).
    const named = [topicId, topic?.id].map(id => (id ? latestFor.get(id) : undefined)).filter((x): x is PartRef => !!x)
    const latest = named.sort((a, b) => turns.indexOf(a.turn) - turns.indexOf(b.turn) || a.index - b.index).at(-1)
    // A message with a topic is answered only by a part naming it (unmarked text names everyone it
    // answers). Taking the answer's first part instead linked "answered" to some other message's reply
    // when its own reply never arrived. History from before the app has no topics: there it is the answer.
    const replyId = latest?.id ?? own?.id ?? (topicId || topic ? undefined : by?.parts?.[0]?.id)
    const isBusy = live.busy.has(turn.key)
    // "claude" after a settled tag means Claude still owes work: an "OK, I'll do it" is not done.
    const owes = !!topic && !topic.isProvisional && topic.status === 'claude'
    const reply = replyId ? parts.find(p => p.id === replyId) : undefined
    // A topic waiting on you shows ✋ on the messages whose reply asked (askedBy). Boards from before
    // that: a follow-up merged in waits only if its own latest reply asks something.
    const merged = !!topicId && !!topic && topic.id !== topicId
    const waitsOnYou = topic?.status === 'me' && (topic.askedBy ? topic.askedBy.includes(turn.key) : !merged || !!(reply && questionOf(reply.part.text)))
    const state: MessageState = replyId
      ? waitsOnYou ? 'me' : owes || isBusy ? 'progress' : 'done'
      : turns.slice(i).some(t => !t.isDone) ? 'claude' : isBusy ? 'progress' : turn.error ? 'failed'
      // A reaction can be the whole reply (✅ done); a topic Claude's tag settled had a reply that got lost.
      : live.reacted?.has(turn.key) ? 'done' : topic && !topic.isProvisional ? 'lost' : 'none'
    const stale = state === 'progress' && !live.isWorking && !isBusy && live.now - (topic?.updatedAt ?? turn.at) > STALE_MS
    const queued = state === 'claude' && !!turn.queued && live.isWorking && !isBusy
    const active = !queued && ((state === 'claude' && live.isWorking) || (state === 'progress' && isBusy))
    // The reply lands when its turn ends; the status moves when the topic does.
    const replyTurn = reply?.turn
    const repliedAt = replyTurn ? replyTurn.at + (replyTurn.durationMs ?? 0) : 0
    const statusAt = topic?.updatedAt ?? 0
    const updatedAt = Math.max(turn.at, repliedAt, statusAt)
    // The tag that came with a reply stamps its topic a moment later: that is still the reply.
    const event = updatedAt === turn.at ? 'sent' : repliedAt && updatedAt - repliedAt < 10_000 ? 'replied' : 'status'
    messages.push({ turn, topicId, state, replyId, updatedAt, event, ...(active ? { active } : {}), ...(stale ? { stale } : {}), ...(queued ? { queued } : {}) })
  })
  // What is being worked on first, then what waits in queue (oldest first: Claude takes them in
  // order), then the rest by newest activity; the same moment keeps the later message on top.
  const order = new Map(messages.map((m, i) => [m, i]))
  const rank = (m: MessageRef) => (m.active ? 0 : m.queued ? 1 : 2)
  messages.sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? order.get(a)! - order.get(b)! : b.updatedAt - a.updatedAt || order.get(b)! - order.get(a)!))
  return { unread: parts.filter(p => !read.has(p.id)), waiting, messages }
}
