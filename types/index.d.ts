// The values clued keeps in $.state (and, per project, in $.store).

/** Who a topic waits on: Claude still owes work, the user owes an answer, or nothing. */
export type TopicStatus = 'claude' | 'me' | 'done'

export type Topic = {
  /** `T1`, `T2`, ... in the order topics were raised (per project). */
  id: string
  title: string
  /** 0 while unsorted: sent to Main and not yet placed by Claude. */
  threadId: number
  status: TopicStatus
  /** Text hashes of the user's messages on this topic. */
  messageKeys: string[]
  /** Set while the title is the mod's first guess, before Claude names it. */
  isProvisional?: true
  updatedAt: number
}

/**
 * A named group of at most three topics. Thread 0 is Main: every message, never stored.
 * A thread that fills up forks a child, drawn under its parent.
 */
export type Thread = {
  id: number
  name: string
  topicIds: string[]
  /** The thread this one forked from when it filled up. */
  parentId?: number
  /** Set until Claude names the thread. */
  isUnnamed?: true
  createdAt: number
  updatedAt: number
}

/** A final answer of Claude's, kept so the transcript can tell results from actions. */
export type Answer = { key: string; text: string; topicIds: string[] }

export type Board = {
  topics: Topic[]
  threads: Thread[]
  answers: Answer[]
  nextTopic: number
  /** Topics raised since Claude's last answer: what the next answer's tag settles. */
  turnTopics: string[]
  /** Messages the user sent as a reply in a thread: message hash → thread id. */
  replies: Record<string, number>
  /** Replies to one message: reply's hash → the replied-to message, so either can jump to the other. */
  links?: Record<string, Link>
}

/** A reply's link to the message it answered. `anchor` is that message's element key in the chat. */
export type Link = { anchor: string; who: 'me' | 'claude'; text: string }

export type Reactor = 'me' | 'claude'
/** Reactions on one message, keyed by the message's text hash. */
export type Reactions = Record<string, { emoji: string; by: Reactor }[]>

export type Notice = {
  id: string
  kind: 'task' | 'reaction' | 'waiting' | 'error'
  text: string
  at: number
  isRead: boolean
  /** Where a click takes you: a chat anchor (`part:<id>`, `me:<key>`). */
  target?: string
  /** The topic a "waiting" notification is about. */
  topicId?: string
}

/** The latest messages, newest last, so /react can point at them. */
export type Recent = { key: string; text: string; from: 'me' | 'claude' }[]

/** A reply about to be sent: in a thread, to one message, or both. */
export type ReplyTo = {
  /** The thread it lands in; null lets Claude sort it, as for Main. */
  threadId: number | null
  /** The message clicked, quoted to Claude with the reply. */
  quote?: { who: 'me' | 'claude'; text: string; anchor?: string }
}

export type View = {
  /** 0 = Main (everything). Any other id filters the transcript to that thread. */
  threadId: number
  /** Results only: hide Claude's actions (tool calls, in-between narration). */
  isResultsOnly: boolean
}

declare module 'claude-code' {
  interface PluginState {
    clued: {
      board: Shaped<Board>
      view: Shaped<View>
      /** What the next submitted message replies to (a click on a message, or /reply); null for none. */
      replyTo: Shaped<ReplyTo | null>
      reactions: Shaped<Reactions>
      notices: Shaped<Notice[]>
      /** Reactions Claude has not read yet that start no turn: told with the next message. */
      heard: Shaped<string[]>
      /** Whether the threads panel is open and drawn; false shows a reopen button above the prompt. */
      isPaneOpen: Shaped<boolean>
      recent: Shaped<Recent>
    }
  }
}
