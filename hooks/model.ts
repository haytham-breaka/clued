// Pure topic/thread logic: no $, so it is easy to test and reason about.

import type { Answer, Board, Thread, Topic, TopicStatus } from '../types/index.d.ts'

export const TOPICS_PER_THREAD = 3
/** Threads Claude may sort a Main message into: active within this window. */
export const ACTIVE_MS = 3 * 24 * 60 * 60 * 1000
/** Threads idle longer than this are dropped when a session loads the board. */
export const KEEP_MS = 30 * 24 * 60 * 60 * 1000
const ANSWER_CHARS = 4000

export const emptyBoard = (): Board => ({ topics: [], threads: [], answers: [], nextTopic: 1, turnTopics: [], replies: {} })

/** A stable key for a message: FNV-1a over its trimmed text. */
export function keyOf(text: string): string {
  let hash = 0x811c9dc5
  for (const ch of text.trim()) {
    hash ^= ch.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export function firstLine(text: string, max = 48): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, Math.max(1, max - 1))}…` : line
}

// ---- The tag Claude ends each reply with -------------------------------

// Sessions from before the rename (threadline) used <threadline> and [threadline]; both still read.
const TAGS = /<(?:clued|threadline)>([\s\S]*?)<\/(?:clued|threadline)>/g
/** Removes the tag, including a half-streamed one at the end. */
export const stripTag = (text: string) =>
  text.replace(/\s*<(?:clued|threadline)>[\s\S]*?<\/(?:clued|threadline)>\s*/g, '\n').replace(/\s*<(?:clued|threadline)>[\s\S]*$/, '').trim()

export type TagTopic = {
  id: string
  title?: string
  status?: TopicStatus
  /** Continues this earlier topic. */
  same_as?: string
  /** Refers to this earlier topic (a follow-up, a fix, an answer to its question). */
  about?: string
  /** Where an unsorted topic belongs: an existing thread's id, or "new". */
  thread?: number | 'new'
  /** Which of the text's tags it is in (0 for the first): a later tag's status replaces an earlier one's. */
  n?: number
}
export type Tag = { topics: TagTopic[]; threads: Record<string, string> }

const STATUSES: readonly TopicStatus[] = ['claude', 'me', 'done']

/**
 * Claude's tags in a text, all of them, in order: a text can hold several reply parts, each ending in
 * its own tag. Null when none can be read.
 */
export function parseTag(text: string): Tag | null {
  const tags = [...text.matchAll(TAGS)].map((m, n) => parseOne(m[1]!, n)).filter((t): t is Tag => !!t)
  if (!tags.length) return null
  return { topics: tags.flatMap(t => t.topics), threads: Object.assign({}, ...tags.map(t => t.threads)) }
}

function parseOne(raw: string, n: number): Tag | null {
  if (!raw.trim()) return null
  try {
    const data = JSON.parse(raw) as { topics?: unknown; threads?: unknown }
    const topics = (Array.isArray(data.topics) ? data.topics : []).flatMap((t): TagTopic[] => {
      if (!t || typeof t !== 'object') return []
      const o = t as Record<string, unknown>
      if (typeof o.id !== 'string') return []
      const thread = o.thread === 'new' ? 'new' : Number.isInteger(Number(String(o.thread ?? '').replace(/^#/, ''))) && o.thread != null ? Number(String(o.thread).replace(/^#/, '')) : undefined
      return [
        {
          id: o.id,
          title: typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, 60) : undefined,
          status: STATUSES.includes(o.status as TopicStatus) ? (o.status as TopicStatus) : undefined,
          same_as: typeof o.same_as === 'string' ? o.same_as : undefined,
          about: typeof o.about === 'string' ? o.about : undefined,
          thread,
          n,
        },
      ]
    })
    const threads: Record<string, string> = {}
    if (data.threads && typeof data.threads === 'object')
      for (const [id, name] of Object.entries(data.threads as Record<string, unknown>))
        if (typeof name === 'string' && name.trim()) threads[id.replace(/^#/, '')] = clipName(name)
    return { topics, threads }
  } catch {
    return null
  }
}

// ---- Placing a topic in a thread -------------------------------------------

/** Thread names: short enough for the panel. */
export const NAME_MAX = 16
/** Fits a name in `max` characters, cutting at a word where it can. */
export const clipName = (name: string, max = NAME_MAX) => {
  const n = name.trim().replace(/\s+/g, ' ')
  if (n.length <= max) return n
  const cut = n.slice(0, max - 1)
  const word = cut.lastIndexOf(' ')
  return `${(word >= max / 2 ? cut.slice(0, word) : cut).trimEnd()}…`
}
/** A fork's name: its root's name, numbered, within the limit. */
const forkName = (parentName: string, n: number) => {
  const suffix = ` ${n}`
  return clipName(parentName.replace(/ \d+$/, '').replace(/ \(\d+\)$/, '').replace(/…$/, ''), NAME_MAX - suffix.length) + suffix
}

const nextThreadId = (threads: readonly Thread[]) => Math.max(0, ...threads.map(t => t.id)) + 1

/**
 * Puts a topic in `desired`. A full thread hands it to its newest fork with
 * room, forking a new child when there is none: forks hang under the parent.
 */
function place(threads: Thread[], desired: number, topicId: string, now: number): { threads: Thread[]; threadId: number } {
  let at = threads.find(t => t.id === desired)
  if (!at) return { threads, threadId: 0 }
  while (at.topicIds.length >= TOPICS_PER_THREAD) {
    const parent: Thread = at
    const fork = threads.filter(t => t.parentId === parent.id).at(-1)
    if (!fork) {
      const child: Thread = { id: nextThreadId(threads), name: forkName(parent.name, threads.filter(t => t.parentId === parent.id || t.id === parent.id).length + 1), topicIds: [], parentId: parent.id, isUnnamed: true, createdAt: now, updatedAt: now }
      threads = [...threads, child]
      at = child
      break
    }
    at = fork
  }
  const id = at.id
  return { threads: threads.map(t => (t.id === id ? { ...t, topicIds: [...t.topicIds, topicId], updatedAt: now } : t)), threadId: id }
}

function newThread(threads: Thread[], name: string, topicId: string, now: number) {
  const id = nextThreadId(threads)
  return { threads: [...threads, { id, name: clipName(name), topicIds: [topicId], isUnnamed: true as const, createdAt: now, updatedAt: now }], threadId: id }
}

/** Threads Claude may sort into: active within the window, newest first. */
export const activeThreads = (board: Board, now: number) =>
  board.threads.filter(t => now - t.updatedAt <= ACTIVE_MS).sort((a, b) => b.updatedAt - a.updatedAt)

// ---- Raising a topic ----------------------------------------------------

/**
 * Files a new message as a provisional topic, waiting on Claude. A reply in a
 * thread lands there (or in its fork); a message to Main stays unsorted until
 * Claude's tag places it.
 */
export function raiseTopic(
  board: Board,
  message: { text: string; key: string; replyTo: number | null },
  now: number,
): { board: Board; topicId: string; threadId: number } {
  const id = `T${board.nextTopic}`
  let threads = board.threads
  let threadId = 0
  if (message.replyTo != null) ({ threads, threadId } = place(threads, message.replyTo, id, now))

  const topic: Topic = { id, title: firstLine(message.text, 40), threadId, status: 'claude', messageKeys: [message.key], isProvisional: true, updatedAt: now }
  const replies = threadId ? { ...board.replies, [message.key]: threadId } : board.replies
  return {
    board: { ...board, threads, replies, topics: [...board.topics, topic], nextTopic: board.nextTopic + 1, turnTopics: [...board.turnTopics, id] },
    topicId: id,
    threadId,
  }
}

// ---- Settling a turn ------------------------------------------------------

/** Which status wins when two entries settle one topic. */
const RANK: Record<TopicStatus, number> = { done: 0, claude: 1, me: 2 }

/** No tag: a reply ending in a question waits on the user, any other is done. */
export const guessStatus = (answer: string): TopicStatus => (/\?\s*$/.test(stripTag(answer)) ? 'me' : 'done')

/** The topic a question belongs to: the one the reply mark above its last "?" names, else the turn's only topic. */
function askingTopic(answer: string, topics: readonly Topic[], turnTopics: readonly string[]): Topic | undefined {
  const text = stripTag(answer).replace(/```[\s\S]*?```/g, '')
  const q = text.lastIndexOf('?')
  if (q < 0) return undefined
  const mark = [...text.slice(0, q).matchAll(/^[ \t]*<<reply\s+([^>]*)>>[ \t]*$/gim)].at(-1)
  const ids = mark ? mark[1]!.split(/[\s,]+/).map(s => s.trim().toUpperCase().split('.')[0]!) : turnTopics.length === 1 ? [...turnTopics] : []
  return topics.find(t => t.id === ids[0])
}

/**
 * Applies Claude's answer: merges continued topics, places unsorted ones, sets
 * titles and statuses, names threads and records the answer. Returns the
 * topics that now wait on the user.
 */
export function settleTurn(board: Board, answer: string, now: number, opts: { flat?: boolean; partial?: boolean } = {}): { board: Board; nowWaiting: Topic[] } {
  const tag = parseTag(answer)
  const fallback = guessStatus(answer)
  // A question your plain message was guessed to answer still counts as open until the tag says.
  const before = new Map(board.topics.map(t => [t.id, t.answerGuessed ? 'me' : t.status]))
  let topics = board.topics.map(t => ({ ...t, messageKeys: [...t.messageKeys] }))
  let threads = board.threads.map(t => ({ ...t, topicIds: [...t.topicIds] }))
  const touched = new Set<string>()
  // Which tag settled each topic last: two entries in one tag rank, a later tag's replaces it.
  const touchedIn = new Map<string, number | undefined>()
  const drop = (topic: Topic) => {
    topics = topics.filter(t => t.id !== topic.id)
    threads = threads.map(th => ({ ...th, topicIds: th.topicIds.filter(id => id !== topic.id) }))
  }
  // Topics an entry of this tag settled with "claude" or "done": a "me" after that is a new question.
  const settledNow = new Set<string>()
  const held = new Set<string>()
  const settle = (topic: Topic, entry: TagTopic | undefined, merged = false) => {
    if (entry?.title) topic.title = entry.title
    // The tag's status is trusted, "me" too: Claude often says it still waits on you in a reply about
    // something else, with no question mark there. Only the guess for a topic the tag left out reads the text.
    // Two entries for one topic (its own, a follow-up folded in): waiting on you wins, then on Claude.
    const status = entry?.status ?? (touched.has(topic.id) ? topic.status : fallback)
    // A question only kept open across a follow-up (held) gives way to the topic's own entry.
    const keep = entry?.status && touched.has(topic.id) && touchedIn.get(topic.id) === entry.n && !(held.has(topic.id) && !merged) && RANK[topic.status] > RANK[status]
    topic.status = keep ? topic.status : status
    if (!merged) held.delete(topic.id)
    if (entry?.status && entry.status !== 'me' && !merged) settledNow.add(topic.id)
    delete topic.isProvisional
    topic.updatedAt = now
    if (topic.threadId === 0 && !opts.flat) {
      // Unsorted: Claude's pick, else the most recently active thread, else a new one.
      const wanted = entry?.thread
      const recent = threads.filter(t => now - t.updatedAt <= ACTIVE_MS).sort((a, b) => b.updatedAt - a.updatedAt)[0]
      const target = typeof wanted === 'number' && threads.some(t => t.id === wanted) ? wanted : wanted === 'new' || !recent ? null : recent.id
      const placed = target == null ? newThread(threads, topic.title, topic.id, now) : place(threads, target, topic.id, now)
      threads = placed.threads
      topic.threadId = placed.threadId
    }
    touched.add(topic.id)
    if (entry) touchedIn.set(topic.id, entry.n)
  }

  // The messages each topic got this turn: a topic raised now has its own; an older one, those folded in.
  const fresh = new Map(topics.filter(t => t.isProvisional).map(t => [t.id, [...t.messageKeys]]))
  const raisedNow = new Set(fresh.keys())
  const madeUp: TagTopic[] = []
  for (const entry of tag?.topics ?? []) {
    const topic = topics.find(t => t.id === entry.id)
    if (!topic) {
      if (entry.status === 'me') madeUp.push(entry)
      continue
    }
    const into = entry.same_as && entry.same_as !== entry.id ? topics.find(t => t.id === entry.same_as) : undefined
    if (into && topic.isProvisional) {
      // A continuation of an earlier topic: fold the message into it. The follow-up's "done" is about
      // the follow-up: a question the earlier topic waits on stays open (also one your plain message was
      // guessed to answer) unless the tag settles that topic itself.
      const stillAsks = !touched.has(into.id) && (into.status === 'me' || !!into.answerGuessed)
      into.messageKeys.push(...topic.messageKeys)
      if (!raisedNow.has(into.id)) fresh.set(into.id, [...(fresh.get(into.id) ?? []), ...topic.messageKeys])
      drop(topic)
      if (stillAsks && entry.status !== 'me') held.add(into.id)
      settle(into, { ...entry, id: into.id, thread: undefined, ...(stillAsks ? { status: 'me' as const } : {}) }, true)
      continue
    }
    settle(topic, entry)
  }
  // A question under an id Claude made up ("T1-discount", or a new "T3"): it waits on the topic it
  // grew from, named by the id's start or by the reply mark of the part that asks.
  for (const entry of madeUp) {
    const owner = topics.find(t => t.id === entry.id.match(/^(T\d+)(?!\d)/)?.[1]) ?? askingTopic(answer, topics, board.turnTopics)
    if (owner) settle(owner, { id: owner.id, status: 'me' })
  }
  // A plain message taken as the answer to a question: the tag takes it up (lists the topic, or links a
  // message to it with "about"), or the message was about something else and the question is open again.
  if (!opts.partial) {
    const named = new Set((tag?.topics ?? []).flatMap(e => [e.id, e.about]).filter(Boolean))
    for (const topic of topics) {
      if (!topic.answerGuessed) continue
      if (!touched.has(topic.id) && !named.has(topic.id)) topic.status = 'me'
      delete topic.answerGuessed
    }
  }
  // Topics raised this turn that the tag left out.
  for (const id of board.turnTopics) {
    const topic = topics.find(t => t.id === id)
    if (topic && !touched.has(id)) settle(topic, undefined)
  }

  // Which messages a question is for: the ones whose reply raised it. A follow-up folded into a topic
  // that already waits on you isn't asked anything new, and a question raised by a follow-up's reply
  // isn't the first message's.
  // Without such messages (an older topic asked again), the panel decides from the replies.
  for (const topic of topics) {
    if (topic.status !== 'me') delete topic.askedBy
    else if (before.get(topic.id) !== 'me' || settledNow.has(topic.id)) {
      const keys = fresh.get(topic.id)
      if (keys?.length) topic.askedBy = keys
      else delete topic.askedBy
    }
  }

  // A merge can empty a thread: drop it unless a fork hangs under it.
  threads = threads.filter(th => th.topicIds.length > 0 || threads.some(c => c.parentId === th.id))

  for (const [id, name] of Object.entries(tag?.threads ?? {})) {
    const th = threads.find(t => String(t.id) === id)
    if (th) {
      th.name = name
      delete th.isUnnamed
    }
  }
  for (const th of threads) if (th.topicIds.some(id => touched.has(id))) th.updatedAt = now

  // Replies now point at the thread their topic settled in.
  const replies = { ...board.replies }
  for (const [key, _] of Object.entries(replies)) {
    const topic = topics.find(t => t.messageKeys.includes(key))
    if (topic) replies[key] = topic.threadId
  }

  const text = stripTag(answer).slice(0, ANSWER_CHARS)
  const record: Answer = { key: keyOf(text), text, topicIds: [...touched] }
  const nowWaiting = topics.filter(t => touched.has(t.id) && t.status === 'me' && before.get(t.id) !== 'me')
  return { board: { ...board, topics, threads, replies, answers: [...board.answers, record].slice(-200), turnTopics: [] }, nowWaiting }
}

/** Drops threads idle past the keep window, with their topics and answers. */
export function prune(board: Board, now: number): Board {
  const keep = new Set(board.threads.filter(t => now - t.updatedAt <= KEEP_MS).map(t => t.id))
  const topics = board.topics.filter(t => t.threadId === 0 ? now - t.updatedAt <= KEEP_MS : keep.has(t.threadId))
  const ids = new Set(topics.map(t => t.id))
  return {
    ...board,
    threads: board.threads.filter(t => keep.has(t.id)).map(t => ({ ...t, name: clipName(t.name), ...(t.parentId && !keep.has(t.parentId) ? { parentId: undefined } : {}) })),
    topics,
    answers: board.answers.filter(a => a.topicIds.some(id => ids.has(id))),
    replies: Object.fromEntries(Object.entries(board.replies).filter(([, th]) => keep.has(th))),
    turnTopics: board.turnTopics.filter(id => ids.has(id)),
  }
}

// ---- Reading the board -----------------------------------------------------

export type Counts = Record<TopicStatus, number>

export function counts(topics: readonly Topic[]): Counts {
  const c: Counts = { claude: 0, me: 0, done: 0 }
  for (const t of topics) c[t.status]++
  return c
}

export const topicsOf = (board: Board, threadId: number) =>
  threadId === 0 ? board.topics : board.topics.filter(t => t.threadId === threadId)

/** Threads in drawing order: newest roots first, each followed by its forks, with depth. */
/** The thread a fork chain starts from (a thread whose parent is gone is its own root). */
export function rootOf(board: Board, id: number): Thread | undefined {
  let t = board.threads.find(x => x.id === id)
  for (let i = 0; t?.parentId != null && i < 100; i++) {
    const parent = board.threads.find(x => x.id === t!.parentId)
    if (!parent) break
    t = parent
  }
  return t
}

/** A thread and its continuations (forks made when it filled up), oldest first: one conversation in parts. */
export function chainOf(board: Board, id: number): Thread[] {
  const root = rootOf(board, id)
  if (!root) return []
  const out: Thread[] = []
  const walk = (t: Thread) => {
    out.push(t)
    for (const c of board.threads.filter(x => x.parentId === t.id).sort((a, b) => a.createdAt - b.createdAt)) walk(c)
  }
  walk(root)
  return out.sort((a, b) => a.id - b.id)
}

/** Every chain once, newest activity first. */
export function chains(board: Board): { root: Thread; parts: Thread[]; updatedAt: number }[] {
  const roots = board.threads.filter(t => t.parentId == null || !board.threads.some(p => p.id === t.parentId))
  return roots
    .map(root => {
      const parts = chainOf(board, root.id)
      return { root, parts, updatedAt: Math.max(...parts.map(p => p.updatedAt)) }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function threadTree(board: Board): { thread: Thread; depth: number }[] {
  const out: { thread: Thread; depth: number }[] = []
  const walk = (parentId: number | undefined, depth: number) => {
    const isRoot = (t: Thread) => t.parentId === undefined || !board.threads.some(p => p.id === t.parentId)
    const level = board.threads.filter(t => (parentId === undefined ? isRoot(t) : t.parentId === parentId))
    for (const thread of level.sort((a, b) => (depth === 0 ? b.updatedAt - a.updatedAt : a.createdAt - b.createdAt))) {
      out.push({ thread, depth })
      walk(thread.id, depth + 1)
    }
  }
  walk(undefined, 0)
  return out
}

/** The latest answer that touched the thread. */
export function lastAnswerIn(board: Board, threadId: number): Answer | undefined {
  const ids = new Set(topicsOf(board, threadId).map(t => t.id))
  return board.answers.findLast(a => a.topicIds.some(id => ids.has(id)))
}

export const threadOfMessage = (board: Board, key: string) => board.topics.find(t => t.messageKeys.includes(key))?.threadId

/** The answer a drawn assistant block belongs to, if it is part of a final answer. */
export function answerOfBlock(board: Board, blockText: string): Answer | undefined {
  const block = stripTag(blockText)
  if (!block) return undefined
  const key = keyOf(block)
  return board.answers.findLast(a => a.key === key || a.text.includes(block.slice(0, ANSWER_CHARS)))
}

/** The threads an answer spoke in. */
export const threadsOfAnswer = (board: Board, answer: Answer) =>
  [...new Set(answer.topicIds.map(id => board.topics.find(t => t.id === id)?.threadId).filter((id): id is number => !!id))]
    .map(id => board.threads.find(t => t.id === id))
    .filter((t): t is Thread => !!t)

const WAITS: Record<TopicStatus, string> = { claude: 'on Claude', me: 'on user', done: 'done' }

/** What Claude reads beside a new message: never shown to the user. */
export function briefFor(
  board: Board,
  topicId: string,
  threadId: number,
  replyTo: number | null,
  now: number,
  quote?: { who: 'me' | 'claude'; text: string },
): string {
  const lines: string[] = []
  const quoted = quote ? (quote.text.length > 600 ? `${quote.text.slice(0, 600)}…` : quote.text).replace(/^/gm, '> ') : ''
  const thread = board.threads.find(t => t.id === threadId)
  if (thread) {
    lines.push(`[clued] This message is provisional topic ${topicId}, a reply in thread #${thread.id} "${thread.name}" (topics ${thread.topicIds.join(', ')}).`)
    const last = lastAnswerIn(board, replyTo ?? thread.id)
    if (quote) lines.push(`The user is replying to ${quote.who === 'claude' ? 'your' : 'their own'} message:\n${quoted}`)
    // Only repeat the thread's last message when it is not the answer Claude just gave.
    else if (last && last !== board.answers.at(-1)) {
      const excerpt = last.text.length > 600 ? `${last.text.slice(0, 600)}…` : last.text
      lines.push(`Your last message in that thread:\n${excerpt.replace(/^/gm, '> ')}`)
    }
  } else {
    lines.push(`[clued] This message is provisional topic ${topicId}, sent to Main: give it "thread" in your tag (an id below, or "new").`)
    if (quote) lines.push(`The user is replying to ${quote.who === 'claude' ? 'your' : 'their own'} message (sort it with that message's thread unless it is a new subject):\n${quoted}`)
    const active = activeThreads(board, now).slice(0, 12)
    // As in crewbase: a short message soon after a reply usually answers it.
    const last = board.answers.at(-1)
    const lastThread = last ? threadsOfAnswer(board, last)[0] : undefined
    const mine = board.topics.find(t => t.id === topicId)
    if (lastThread && mine && mine.title.length <= 40 && now - lastThread.updatedAt <= 10 * 60 * 1000)
      lines.push(`Likely thread: #${lastThread.id}, the one Claude just answered in (short message, sent soon after).`)
    if (active.length) {
      lines.push('Threads active in the last 3 days:')
      for (const t of active) {
        const ts = topicsOf(board, t.id).map(x => `${x.id} "${x.title}" (${WAITS[x.status]})`).join('; ')
        lines.push(`  #${t.id} "${t.name}"${t.parentId ? ` (fork of #${t.parentId})` : ''}: ${ts}`)
      }
    } else lines.push('No threads are active: use "new".')
  }
  const unnamed = board.threads.filter(t => t.isUnnamed).map(t => `#${t.id}`)
  if (unnamed.length) lines.push(`Name these threads in your tag: ${unnamed.join(', ')}.`)
  return lines.join('\n')
}

export const TAG_GUIDE = [
  'This session runs the clued interface. The user sends many messages; clued groups them into topics and threads',
  '(three topics a thread; a full thread forks a child). Each user message arrives with a [clued] note naming its provisional topic.',
  'End every reply with exactly one line, last, in this form (JSON inside the tag; clued hides it from the user):',
  '<clued>{"topics":[{"id":"T7","title":"3-6 word title","status":"claude|me|done","thread":2,"same_as":"T3"}],"threads":{"2":"2-3 word name, at most 16 characters"}}</clued>',
  'List every topic this turn touched. status: "claude" when you still owe work on it, "me" when it waits on the user',
  '(a question, a decision, something to check), "done" when nothing is pending. "thread" only for a topic sent to Main:',
  'the id of the active thread it belongs to; a follow-up, fix or tweak of recent work belongs to the thread of that work,',
  'and "new" is only for a subject none of the active threads covers. "same_as" only when a message continues an earlier',
  'topic. Name every thread the note lists as unnamed. When you need a yes before going on, ask it as a question:',
  'the user may answer with a 👍 reaction, which clued sends you as a go-ahead.',
].join(' ')

/** The tag for the clued app, which tracks your messages without threads. */
export const FLAT_GUIDE = [
  'This session runs the clued app. Each user message arrives with a [clued] note naming its topic id (T52).',
  'End every reply with exactly one line, last, in this form (JSON inside the tag; the app hides it from the user):',
  '<clued>{"topics":[{"id":"T52","title":"3-6 word title","status":"claude|me|done","same_as":"T49"}]}</clued>',
  'List every topic this turn touched. status: "claude" when you still owe work on it, "me" when it waits on the user',
  '(a question, a decision, something to check), "done" when nothing is pending. "same_as" only when a message continues',
  'an earlier topic. When you need a yes before going on, ask it as a question: the user may answer with a 👍 reaction,',
  'which the app sends you as a go-ahead.',
].join(' ')

/** The app's note on a message: its topic, what it replies to, and the topics still open. */
export function flatBrief(board: Board, topicId: string, quotes: { who: 'me' | 'claude'; text: string; topics?: string[] }[] = []): string {
  const lines = [`[clued] This message is topic ${topicId}.`]
  const quoted = (q: (typeof quotes)[number]) => {
    const text = (q.text.length > 600 ? `${q.text.slice(0, 600)}…` : q.text).replace(/^/gm, '> ')
    return q.topics?.length ? `(your reply to ${q.topics.join(', ')})\n${text}` : text
  }
  if (quotes.length === 1) lines.push(`The user is replying to ${quotes[0]!.who === 'claude' ? 'your' : 'their own'} message:\n${quoted(quotes[0]!)}`)
  else if (quotes.length > 1)
    lines.push(`The user is answering ${quotes.length} of these messages at once; answer each where it belongs:\n${quotes.map(quoted).join('\n\n')}`)
  const open = board.topics.filter(t => t.id !== topicId && t.status !== 'done').slice(-8)
  if (open.length) lines.push(`Still open: ${open.map(t => `${t.id} "${t.title}" (${WAITS[t.status]})`).join('; ')}.`)
  return lines.join('\n')
}

/** A reply to a message older than this many of your messages brings its request's chain along. */
export const CHAIN_FAR = 30
/** About how many characters the chain may take in the note. */
export const CHAIN_BUDGET = 2000
/** How many of the chain's last messages and replies go with its first message (2–3 exchanges). */
export const CHAIN_TAIL = 6

const clipTo = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat
}

/**
 * The part of the note that brings back a request's chain when the message replied to is older than
 * what Claude still holds word for word: its first message, then its last few messages and replies,
 * each trimmed, about CHAIN_BUDGET characters in all. `why`: compacted since, or just far back.
 */
export function chainNote(chain: { who: 'me' | 'claude'; text: string }[], why: 'compacted' | 'far'): string {
  const pieces = chain.filter(c => c.text.trim())
  if (!pieces.length) return ''
  const [first, ...rest] = pieces
  const tail = rest.slice(-CHAIN_TAIL)
  const skipped = rest.length - tail.length
  const firstMax = Math.min(500, CHAIN_BUDGET)
  const each = tail.length ? Math.max(120, Math.floor((CHAIN_BUDGET - firstMax) / tail.length)) : 0
  const label = (c: { who: 'me' | 'claude' }) => (c.who === 'me' ? 'You' : 'Claude')
  const lines = [
    why === 'compacted'
      ? 'Earlier in this request (the conversation was compacted since: this is the app\'s copy, in order):'
      : 'Earlier in this request (far back in the conversation: the app\'s copy, in order):',
    `- ${label(first!)} (its first message): ${clipTo(first!.text, firstMax)}`,
    ...(skipped > 0 ? [`- … ${skipped} more in between …`] : []),
    ...tail.map(c => `- ${label(c)}: ${clipTo(c.text, each)}`),
  ]
  return lines.join('\n')
}

export const statusMark: Record<TopicStatus, string> = { claude: '⏳', me: '✋', done: '✓' }

export const describeThread = (t: Thread) => `#${t.id} ${t.name}`

// ---- Reactions the user leaves on Claude's messages ----------------------------

/** What a reaction asks of Claude: a turn now (go, stop, explain), or nothing (fyi). */
export type ReactionSignal = 'go' | 'stop' | 'explain' | 'fyi'

const YES = ['👍', '✅', '👌', '🚀', '💯']
const NO = ['👎', '❌', '🛑']
const HUH = ['❓', '🤔', '😕']

/**
 * A like on a message that asked something is a yes; 👎 and ❓ always ask for
 * a turn; anything else (a like on finished work, 🎉, 👀) is only heard.
 */
export function reactionSignal(emoji: string, isAsking: boolean): ReactionSignal {
  if (NO.includes(emoji)) return 'stop'
  if (HUH.includes(emoji)) return 'explain'
  if (YES.includes(emoji) && isAsking) return 'go'
  return 'fyi'
}

/** Whether a Claude message waits on the user: a topic on them, or it asks. */
export function isAsking(board: Board, answer: Answer | undefined, text: string): boolean {
  if (answer?.topicIds.some(id => board.topics.find(t => t.id === id)?.status === 'me')) return true
  return /\?\s*$/.test(stripTag(text))
}

export const REACTION_PREFIX = '[clued reaction]'
/** The reaction text after its prefix, for this name or the old one; undefined when it isn't a reaction. */
export const reactionText = (text: string) => text.match(/^\[(?:clued|threadline) reaction\]/) ? text.replace(/^\[(?:clued|threadline) reaction\]/, '') : undefined

/** The message a reaction that asks for a turn sends Claude. */
export function reactionPrompt(signal: Exclude<ReactionSignal, 'fyi'>, emoji: string, text: string, topicIds: readonly string[]): string {
  const on = `${emoji} on your message “${firstLine(text, 80)}”`
  const topics = topicIds.length ? ` Topics: ${topicIds.join(', ')}.` : ''
  const ask = {
    go: 'The user is saying yes: go ahead as you proposed.',
    stop: "The user disagrees, or something is not right. Before more work, ask briefly what to change.",
    explain: "The user doesn't follow. Explain it again, more simply and briefly.",
  }[signal]
  return `${REACTION_PREFIX} ${on}. ${ask}${topics}`
}
