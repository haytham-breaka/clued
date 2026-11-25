import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Notice, Reactions, Recent, ReplyTo, View } from '../types'
import {
  TAG_GUIDE,
  answerOfBlock,
  briefFor,
  counts,
  describeThread,
  emptyBoard,
  firstLine,
  keyOf,
  lastAnswerIn,
  raiseTopic,
  settleTurn,
  statusMark,
  stripTag,
  REACTION_PREFIX,
  isAsking,
  prune,
  reactionPrompt,
  reactionSignal,
  threadOfMessage,
  threadTree,
  threadsOfAnswer,
  topicsOf,
} from './model'
import { COMMANDS_FILE, STATE_FILE, parseCommands } from './bridge'
import type { Command, Snapshot } from './bridge'

// clued runs inside a real Claude Code session. It never calls the API
// itself: Claude Code keeps the harness, commands, status line and resume.

const PANE = 'threads'
const REACT_TOOL = 'mcp__clued__react'

// Bump a shape tag when that value's fields change: an older stored value is
// then declined instead of read with the wrong shape.
const board = atom({ plugin: 'clued', key: 'board' } as const, emptyBoard() as Board, { shape: 'board-2' })
const view = atom({ plugin: 'clued', key: 'view' } as const, { threadId: 0, isResultsOnly: false } as View, { shape: 'view-2' })
const replyTo = atom({ plugin: 'clued', key: 'replyTo' } as const, null as ReplyTo | null, { shape: 'reply-2' })
const reactions = atom({ plugin: 'clued', key: 'reactions' } as const, {} as Reactions, { shape: 'reactions-1' })
const notices = atom({ plugin: 'clued', key: 'notices' } as const, [] as Notice[], { shape: 'notices-1' })
const heard = atom({ plugin: 'clued', key: 'heard' } as const, [] as string[], { shape: 'heard-1' })
const isPaneOpen = atom({ plugin: 'clued', key: 'isPaneOpen' } as const, false as boolean, { shape: 'pane-1' })
const recent = atom({ plugin: 'clued', key: 'recent' } as const, [] as Recent, { shape: 'recent-1' })

// Claude's reactions: rare, each with one meaning. The tool enforces the limits.
const CLAUDE_EMOJI = ['👀', '👍', '✅', '🎉'] as const
const REACTION_GUIDE = [
  `You can react to the user's latest message with the ${REACT_TOOL} tool. Reactions are rare and each has one meaning:`,
  '👀 seen, on it: for a message the user sent while you were busy, so they know it landed;',
  '👍 noted: an FYI, an "ok", or a decision that needs no answer;',
  '✅ done, nothing to add: a small request you finished; react instead of writing "Done!", keeping only what the user must know;',
  '🎉 good news the user shares.',
  'Never react to a question or a request (answer it), never to praise or flatter, never twice on one message, and never',
  'together with text that says the same thing. Most messages get no reaction.',
].join(' ')

function addNotice($: EngineInterface, kind: Notice['kind'], text: string) {
  return update($, notices, list =>
    [...list, { id: crypto.randomUUID(), kind, text, at: Date.now(), isRead: false }].slice(-100),
  )
}

function remember($: EngineInterface, text: string, from: 'me' | 'claude') {
  return update($, recent, list => [...list, { key: keyOf(text), text, from }].slice(-50))
}

/** `/react 👍 2` → the 2nd-latest Claude message; no number means the latest. */
function parseTarget(args: string): { rest: string; back: number } {
  const match = args.trim().match(/^(.*?)(?:\s+(\d+))?$/s)
  return { rest: (match?.[1] ?? '').trim(), back: Math.max(1, Number(match?.[2] ?? 1)) }
}

// Whether a main turn runs, and the messages typed during one: for 👀's exception.
// Module variables are fine here: a reload loses them, and nothing draws from them.
let isWorking = false
const midTurn = new Set<string>()

// The clued window (bin/clued-classic) sets CLUED_DIR: the mod then talks to the
// window's own left panel through files there, and draws no panel of its own.
let bridgeDir: string | undefined
let lastWritten = ''
let commandsRead = 0

async function applyCommand($: EngineInterface, c: Command) {
  if (c.op === 'thread') await selectThread($, c.threadId)
  else if (c.op === 'results') await toggleResults($)
  else if (c.op === 'reply') await update($, replyTo, () => ({ threadId: c.threadId }))
  else if (c.op === 'cancelReply') await cancelReply($)
  else if (c.op === 'readNotices') await update($, notices, list => list.map(n => ({ ...n, isRead: true })))
}

/** One beat of the bridge: publish what changed, take the panel's new commands. */
async function bridgeTick($: EngineInterface) {
  if (!bridgeDir) return
  const snapshot: Omit<Snapshot, 'writtenAt'> = {
    board: await read($, board),
    view: await read($, view),
    replyTo: await read($, replyTo),
    notices: (await read($, notices)).slice(-30),
    isWorking,
  }
  const text = JSON.stringify(snapshot)
  if (text !== lastWritten) {
    await $.fs.write(`${bridgeDir}/${STATE_FILE}`, JSON.stringify({ ...snapshot, writtenAt: Date.now() }))
    lastWritten = text
  }
  const path = `${bridgeDir}/${COMMANDS_FILE}`
  if (!(await $.fs.exists(path))) return
  const { size } = await $.fs.stat(path)
  if (size <= commandsRead) return
  const added = await $.fs.read(path, { offset: commandsRead, length: size - commandsRead })
  const { commands, used } = parseCommands(added as string)
  commandsRead += used
  for (const c of commands) await applyCommand($, c)
}

// Threads outlive a session: the board is saved per project folder.
let storeKey = 'board:default'

/** Changes the board and saves it for the project's next sessions. */
async function changeBoard($: EngineInterface, change: (b: Board) => Board) {
  const next = await update($, board, change)
  await $.store.set(storeKey, next)
  return next
}

async function loadBoard($: EngineInterface, cwd: string) {
  // Keyed by the project root: a shell `cd` during the session moves the
  // working folder but not the root. A board an earlier build saved under the
  // working folder is picked up when it is further along.
  const root = await $.session.root()
  storeKey = `board:${root}`
  const found: Board[] = []
  for (const key of new Set([storeKey, `board:${cwd}`])) {
    const saved = (await $.store.get(key)) as Board | undefined
    if (saved && Array.isArray(saved.threads) && saved.replies) found.push(saved)
  }
  // On a hot reload the live board is newest: a saved copy wins only when further along.
  const live = await read($, board)
  const best = found.sort((x, y) => y.nextTopic - x.nextTopic)[0]
  if (best && best.nextTopic > live.nextTopic) {
    const pruned = await update($, board, () => prune(best, Date.now()))
    await $.store.set(storeKey, pruned)
  } else if (live.nextTopic > 1) await $.store.set(storeKey, await update($, board, b => prune(b, Date.now())))
}

/** Whether the transcript hides Claude's actions now: results-only, or any thread view. */
async function hidesActions($: EngineInterface) {
  const v = await read($, view)
  return v.isResultsOnly || v.threadId !== 0
}

/** A bubble fits a short message; a long one takes at most `share` of the width. */
function bubbleWidth(text: string, columns: number | undefined, share = 0.75): string | undefined {
  const longest = Math.max(0, ...text.split('\n').map(l => l.length))
  return longest + 4 > (columns ?? 100) * share ? `${Math.round(share * 100)}%` : undefined
}

/** A click on a message's ↩: the next message replies to it, in its thread. */
function replyToMessage($: EngineInterface, who: 'me' | 'claude', text: string, threadId: number | null, anchor?: string) {
  return update($, replyTo, () => ({ threadId, quote: { who, text, ...(anchor ? { anchor } : {}) } }))
}

/** The replies that answered the message drawn at `anchor`, oldest first: their hashes. */
const repliesTo = (b: Board, anchor: string) => Object.entries(b.links ?? {}).filter(([, l]) => l.anchor === anchor).map(([k]) => k)

/** Brings one of our message anchors into view; it may be hidden by a thread filter. */
function jumpTo($: EngineInterface, anchor: string) {
  return $.ui.scroll({ to: { key: anchor }, block: 'center' }).catch(() =>
    $.ui.toast('That message is hidden by the current view. Show Main to see it.'),
  )
}

function cancelReply($: EngineInterface) {
  return update($, replyTo, () => null)
}

/**
 * My reaction on a Claude message, toggled: a second press takes it back.
 * A clear signal (yes to a question, 👎, ❓) starts a turn; any other reaction
 * is only heard, told to Claude with the next message.
 */
async function reactTo($: EngineInterface, key: string, text: string, emoji: string): Promise<string> {
  let isAdded = false
  await update($, reactions, all => {
    const list = all[key] ?? []
    const mine = list.some(r => r.by === 'me' && r.emoji === emoji)
    isAdded = !mine
    return { ...all, [key]: mine ? list.filter(r => !(r.by === 'me' && r.emoji === emoji)) : [...list, { emoji, by: 'me' as const }] }
  })
  if (!isAdded) return `Took back ${emoji}.`

  const b = await read($, board)
  const answer = b.answers.findLast(a => a.key === key)
  const topicIds = answer?.topicIds ?? []
  const signal = reactionSignal(emoji, isAsking(b, answer, text))
  if (signal === 'fyi') {
    await update($, heard, list => [...list, `${emoji} on your message “${firstLine(text, 60)}”`].slice(-10))
    return `Reacted ${emoji}. Claude reads it with your next message.`
  }
  await changeBoard($, bb => ({
    ...bb,
    topics: bb.topics.map(t => (topicIds.includes(t.id) ? { ...t, status: 'claude' as const, updatedAt: Date.now() } : t)),
  }))
  // A submit waits for the turn it starts: send it once this dispatch is done.
  await $.clock.after(0, () => $.prompt.submit({ text: reactionPrompt(signal, emoji, text, topicIds) }))
  return { go: `${emoji} sent: go ahead.`, stop: `${emoji} sent: Claude will ask what to change.`, explain: `${emoji} sent: Claude will explain.` }[signal]
}

/** Opens the panel; a press or command behind it seats it at any width. */
async function openPane($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: 'Threads', columns: 40 })
  await update($, isPaneOpen, () => opened.isPlaced)
  return opened
}

async function closePane($: EngineInterface) {
  await $.ui.close({ id: PANE })
  await update($, isPaneOpen, () => false)
}

function selectThread($: EngineInterface, threadId: number) {
  return update($, view, v => ({ ...v, threadId }))
}

function toggleResults($: EngineInterface) {
  return update($, view, v => ({ ...v, isResultsOnly: !v.isResultsOnly }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'threads', description: 'Open the threads panel' })
    await $.command.register({
      name: 'thread',
      description: 'Show one thread and send new messages there: /thread 2, or /thread main for everything',
    })
    await $.command.register({ name: 'reply', description: 'Reply in a thread: /reply 2 your text' })
    await $.command.register({ name: 'results', description: "Results only: hide Claude's actions (tool calls, narration); again to show them" })
    await $.command.register({ name: 'react', description: "React to Claude's latest message (or the nth latest): /react 👍 [n]" })
    await $.tool.register({
      name: 'react',
      description: "React to the user's latest message: 👀 seen (sent while you were busy), 👍 noted (needs no answer), ✅ done (small request finished), 🎉 good news. Rare: never on a question or request.",
      inputSchema: {
        type: 'object',
        properties: { emoji: { type: 'string', enum: [...CLAUDE_EMOJI], description: '👀 seen, on it · 👍 noted · ✅ done, nothing to add · 🎉 good news' } },
        required: ['emoji'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await loadBoard($, e.cwd)
    // Opened unasked, the engine seats a pane only from 144 columns (110 once you
    // have opened it): below that the reopen button above the prompt stands in.
    bridgeDir = await $.env.get('CLUED_DIR')
    if (bridgeDir) {
      // The window's left panel draws the threads: start from the end of its commands.
      lastWritten = ''
      const path = `${bridgeDir}/${COMMANDS_FILE}`
      commandsRead = (await $.fs.exists(path)) ? (await $.fs.stat(path)).size : 0
      $.clock.every(400, () => void bridgeTick($))
      // The window's left panel replaces the mod's own: close one left open from before.
      void $.ui.close({ id: PANE })
      return next(e)
    }
    void openPane($).then(opened => {
      if (!opened.isPlaced) $.ui.log(`clued: the threads panel is waiting (${opened.reason}). Click ☰ Threads above the prompt, or type /threads.`)
    })
    return next(e)
  })

  // How Claude labels topics, once, in the session side of the system prompt.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return {
      sections: [
        ...composed.sections,
        { id: 'clued:topics', text: TAG_GUIDE, scope: 'session' as const },
        { id: 'clued:reactions', text: REACTION_GUIDE, scope: 'session' as const },
      ],
    }
  })

  on('prompt.submit', async ($, e, next) => {
    // A message typed while Claude works: the one place 👀 is free of the limit.
    if (e.origin.kind === 'composer' && !e.command && isWorking) midTurn.add(keyOf(e.text))
    if (e.origin.kind === 'task-notification') {
      await addNotice($, 'task', firstLine(e.text, 80))
      return next(e)
    }
    const pendingReply = await read($, replyTo)
    const isMine = e.origin.kind === 'composer' || pendingReply != null
    if (!isMine || e.command || e.isMeta || !e.text.trim()) return next(e)

    const viewThread = (await read($, view)).threadId || null
    const target = pendingReply ? pendingReply.threadId : viewThread
    if (pendingReply != null) await update($, replyTo, () => null)

    let brief = ''
    await changeBoard($, b => {
      const now = Date.now()
      const raised = raiseTopic(b, { text: e.text, key: keyOf(e.text), replyTo: target }, now)
      brief = briefFor(raised.board, raised.topicId, raised.threadId, target, now, pendingReply?.quote)
      const q = pendingReply?.quote
      if (!q?.anchor) return raised.board
      const links = Object.entries({ ...(raised.board.links ?? {}), [keyOf(e.text)]: { anchor: q.anchor, who: q.who, text: firstLine(q.text, 60) } })
      return { ...raised.board, links: Object.fromEntries(links.slice(-200)) }
    })
    const notes = await read($, heard)
    if (notes.length) {
      brief += `\nSince your last reply the user reacted: ${notes.join('; ')}. Mention it only if it matters.`
      await update($, heard, () => [])
    }
    await remember($, e.text, 'me')
    return next({ ...e, context: [...(e.context ?? []), brief] })
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) isWorking = false
    if (!e.agentId && !e.isAborted && e.answer.trim()) {
      let waiting: string[] = []
      await changeBoard($, b => {
        const settled = settleTurn(b, e.answer, Date.now())
        waiting = settled.nowWaiting.map(t => `✋ #${t.threadId} ${t.title}: Claude is waiting on you`)
        return settled.board
      })
      for (const text of waiting) await addNotice($, 'waiting', text)
      await remember($, stripTag(e.answer), 'claude')
    }
    return next(e)
  })

  // Claude's reaction tool: lands on the user's latest message.
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) isWorking = true
    return next(e)
  })

  // Claude's reaction tool: lands on the user's latest message, within limits.
  on('tool.run', { tool: REACT_TOOL }, async ($, e) => {
    const emoji = String((e as { emoji?: unknown }).emoji ?? '').trim()
    if (!(CLAUDE_EMOJI as readonly string[]).includes(emoji)) return { deny: `Use one of ${CLAUDE_EMOJI.join(' ')}.` }
    const mine = (await read($, recent)).filter(m => m.from === 'me')
    const latest = mine.at(-1)
    if (!latest) return { deny: 'There is no user message to react to yet.' }
    const all = await read($, reactions)
    if (all[latest.key]?.some(r => r.by === 'claude')) return { deny: 'You already reacted to this message.' }
    const isSeen = emoji === '👀' && midTurn.has(latest.key)
    const lately = mine.slice(-4, -1).filter(m => all[m.key]?.some(r => r.by === 'claude' && r.emoji !== '👀')).length
    if (!isSeen && lately >= 1) return { deny: 'You reacted recently: answer in words, or not at all.' }
    await update($, reactions, x => ({ ...x, [latest.key]: [...(x[latest.key] ?? []), { emoji, by: 'claude' as const }] }))
    await addNotice($, 'reaction', `Claude reacted ${emoji} to “${firstLine(latest.text, 40)}”`)
    return { result: `Reacted ${emoji}.` }
  })

  // ---- Commands ----------------------------------------------------------------

  on('command.run', { command: 'threads' }, async $ => {
    if (bridgeDir) {
      await $.ui.close({ id: PANE })
      return { text: 'The threads panel is on the left. If it is folded, click ☰ at its top.' }
    }
    const opened = await openPane($)
    await update($, notices, list => list.map(n => ({ ...n, isRead: true })))
    return { text: opened.isPlaced ? 'Threads panel open.' : `Threads panel not placed: ${opened.reason}` }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, isPaneOpen, () => false)
    return next(e)
  })

  on('command.run', { command: 'thread' }, async ($, e) => {
    const arg = e.args.trim().replace(/^#/, '').toLowerCase()
    if (!arg || arg === 'main' || arg === '0') {
      await selectThread($, 0)
      return { text: 'Showing Main: every message.' }
    }
    const thread = (await read($, board)).threads.find(t => String(t.id) === arg)
    if (!thread) return { text: `No thread ${arg}. /threads lists them.` }
    await selectThread($, thread.id)
    return { text: `Showing ${describeThread(thread)}. New messages go to this thread; /thread main shows everything.` }
  })

  on('command.run', { command: 'reply' }, async ($, e) => {
    const match = e.args.trim().match(/^#?(\d+)(?:\s+([\s\S]+))?$/)
    if (!match) return { text: 'Usage: /reply 2 your text, or /reply 2 and then type your message' }
    const id = Number(match[1])
    const text = (match[2] ?? '').trim()
    const b = await read($, board)
    const thread = b.threads.find(t => t.id === id)
    if (!thread) return { text: `No thread ${id}.` }
    await update($, replyTo, () => ({ threadId: id }))
    const last = lastAnswerIn(b, id)
    const after = last ? ` · after “${firstLine(last.text, 40)}”` : ''
    if (!text) return { text: `↳ Your next message replies in ${describeThread(thread)}${after}` }
    // A submit waits for the turn this command holds: send it once the command is done.
    await $.clock.after(0, () => $.prompt.submit({ text, asUser: true }))
    return { text: `↳ ${describeThread(thread)}${after}` }
  })

  on('command.run', { command: 'results' }, async $ => {
    await toggleResults($)
    const { isResultsOnly } = await read($, view)
    return { text: isResultsOnly ? "Results only: Claude's actions are hidden." : "Claude's actions are shown again." }
  })

  on('command.run', { command: 'react' }, async ($, e) => {
    const { rest: emoji, back } = parseTarget(e.args)
    if (!emoji) return { text: 'Usage: /react 👍 [n]' }
    const target = (await read($, recent)).filter(m => m.from === 'claude').at(-back)
    if (!target) return { text: 'No Claude message to react to yet.' }
    return { text: await reactTo($, target.key, target.text, emoji) }
  })

  // ---- The transcript -------------------------------------------------------

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    if (e.props.text.includes(REACTION_PREFIX)) {
      const said = e.props.text.slice(e.props.text.indexOf(REACTION_PREFIX) + REACTION_PREFIX.length).split('. ')[0]?.trim()
      return <Text dimColor>  you reacted {said}</Text>
    }
    const key = keyOf(e.props.text)
    const v = await read($, view)
    const b = await read($, board)
    const threadId = threadOfMessage(b, key)
    if (v.threadId !== 0 && threadId !== v.threadId) return <Box />
    const replyIn = b.replies[key]
    const thread = replyIn ? b.threads.find(t => t.id === replyIn) : undefined
    const list = (await read($, reactions))[key]
    const answeredBy = repliesTo(b, `reply-me-${key}`)
    const link = b.links?.[key]
    const footer = (
      <Box flexDirection="row" gap={2} justifyContent="flex-end" paddingX={1}>
        {!!list?.length && <Text dimColor>{list.map(r => r.emoji).join(' ')} · Claude</Text>}
        {answeredBy.length > 0 && (
          <Button key={`to-reply-me-${key}`} plain onPress={() => jumpTo($, `reply-me-${answeredBy.at(-1)}`)}>
            <Text color="cyan">↪ {answeredBy.length > 1 ? `${answeredBy.length} replies` : 'your reply'}</Text>
          </Button>
        )}
        <Button key={`reply-me-${key}`} plain onPress={() => replyToMessage($, 'me', e.props.text, threadId ?? null, `reply-me-${key}`)}>
          <Text dimColor>↩ reply</Text>
        </Button>
      </Box>
    )
    // My own messages: a bubble on the right. Anything else keeps the engine's row.
    const isMine = e.props.origin.kind === 'composer' || threadId !== undefined
    if (!isMine) {
      const row = await next(e)
      return (
        <Box flexDirection="column">
          {row}
          {footer}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row" justifyContent="flex-end">
          <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={bubbleWidth(e.props.text, e.viewport?.columns)}>
            {link ? (
              <Button key={`to-quote-${key}`} plain onPress={() => jumpTo($, link.anchor)}>
                <Text color="cyan">↩ {link.who === 'claude' ? 'Claude' : 'you'}: <Text dimColor>“{link.text}”</Text>{thread ? <Text dimColor> · #{thread.id}</Text> : ''}</Text>
              </Button>
            ) : (
              thread && <Text color="cyan" dimColor>↳ in {describeThread(thread)}</Text>
            )}
            <Text>{e.props.text}</Text>
          </Box>
        </Box>
        {/* Below the bubble, on its side. */}
        {footer}
      </Box>
    )
  })

  const QUICK = ['👍', '👎', '❓', '👀']

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const text = stripTag(e.props.text)
    const v = await read($, view)
    const b = await read($, board)
    const answer = answerOfBlock(b, text)

    if (v.isResultsOnly || v.threadId !== 0) {
      // Results only: a block that is part of no final answer is narration.
      if (!answer) return <Box />
      if (v.threadId !== 0 && !answer.topicIds.some(id => b.topics.find(t => t.id === id)?.threadId === v.threadId)) return <Box />
    }
    if (!text) return <Box />

    const row = await next(text === e.props.text ? e : { ...e, props: { ...e.props, text } })
    const spokeIn = answer ? threadsOfAnswer(b, answer) : []
    const key = answer?.key ?? keyOf(text)
    const list = (await read($, reactions))[key]
    const marks = answer
      ? answer.topicIds.map(id => b.topics.find(t => t.id === id)).filter(t => !!t).map(t => `${statusMark[t!.status]} ${t!.title}`).join('  ')
      : ''
    const header = spokeIn.length > 0 && (
      <Text color="magenta">
        ↳ {spokeIn.map(describeThread).join(', ')} <Text dimColor>{marks}</Text>
      </Text>
    )
    // Narration between tool calls: the engine's plain row, no bubble.
    if (!answer)
      return (
        <Box flexDirection="column">
          {row}
          {!!list?.length && <Text dimColor>  {list.map(r => r.emoji).join(' ')} · you</Text>}
        </Box>
      )
    const answeredBy = repliesTo(b, `reply-claude-${keyOf(text)}`)
    // A final answer: a bubble on the left, with its reply and reaction line.
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row" justifyContent="flex-start">
          <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} width={bubbleWidth(text, e.viewport?.columns, 0.85)}>
            {header}
            {row}
          </Box>
        </Box>
        {/* Below the bubble, on its side. */}
        <Box flexDirection="row" gap={2} paddingX={1}>
            {!!list?.length && <Text dimColor>{list.map(r => r.emoji).join(' ')} · you</Text>}
            {answeredBy.length > 0 && (
              <Button key={`to-reply-claude-${keyOf(text)}`} plain onPress={() => jumpTo($, `reply-me-${answeredBy.at(-1)}`)}>
                <Text color="cyan">↪ {answeredBy.length > 1 ? `${answeredBy.length} replies` : 'your reply'}</Text>
              </Button>
            )}
            <Button key={`reply-claude-${keyOf(text)}`} plain onPress={() => replyToMessage($, 'claude', answer.text, spokeIn[0]?.id ?? null, `reply-claude-${keyOf(text)}`)}>
              <Text dimColor>↩ reply</Text>
            </Button>
            {QUICK.map((emoji, i) => (
              <Button key={`react-${i}-${keyOf(text)}`} plain onPress={() => reactTo($, key, answer.text, emoji)}>
                {emoji}
              </Button>
            ))}
        </Box>
      </Box>
    )
  })

  // Claude's actions: hidden in results-only and thread views.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await hidesActions($))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await hidesActions($))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (!(await hidesActions($))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // A one-line band above the prompt: the reply being written, the thread in view, results-only.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    const pending = await read($, replyTo)
    // In the clued window the left panel shows views and counts, and a reply
    // floats on the prompt (BesidePrompt below): nothing of ours in the band.
    if (bridgeDir) return next(e)
    const isOpen = await read($, isPaneOpen)
    const showOpen = !isOpen && !bridgeDir
    if (v.threadId === 0 && !v.isResultsOnly && pending == null && !showOpen) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const b = await read($, board)
    const threads = b.threads
    const c = counts(b.topics)
    const replyThread = pending?.threadId != null ? threads.find(t => t.id === pending.threadId) : undefined
    const viewThread = threads.find(t => t.id === v.threadId)
    return (
      <Box flexDirection="row" gap={2}>
        {showOpen && (
          <Button key="open-pane" plain onPress={() => openPane($)}>
            <Text color="cyan">☰ Threads</Text> <Text dimColor>⏳{c.claude} ✋{c.me}</Text>
          </Button>
        )}
        {pending && (
          // One slim line on the prompt, like a quoted reply in a chat app.
          <Box flexDirection="row" gap={1}>
            <Text color="cyan">▎↩</Text>
            <Text color="cyan" bold>{pending.quote ? (pending.quote.who === 'claude' ? 'Claude' : 'You') : replyThread ? describeThread(replyThread) : 'Main'}</Text>
            {pending.quote && <Text dimColor wrap="truncate-end">{firstLine(pending.quote.text, 50)}</Text>}
            {pending.quote && replyThread && <Text color="cyan" dimColor>#{replyThread.id}</Text>}
            <Button key="cancel-reply" plain onPress={() => cancelReply($)}>
              <Text dimColor>✕</Text>
            </Button>
          </Box>
        )}
        {!bridgeDir && !pending && viewThread && <Text color="cyan">↳ {describeThread(viewThread)} · new messages go here</Text>}
        {!bridgeDir && v.isResultsOnly && <Text dimColor>results only</Text>}
        {!bridgeDir && viewThread && (
          <Button key="main" plain onPress={() => selectThread($, 0)}>
            show Main
          </Button>
        )}
      </Box>
    )
  })

  // The reply bar in the clued window: floats on the prompt's top edge, so the
  // band (and its [-]) stays empty. A click on its ✕ comes back as a ui.message.
  on('ui.render', { component: 'BesidePrompt' }, async ($, e, next) => {
    const pending = bridgeDir ? await read($, replyTo) : null
    if (!pending || e.props.floatColumns < 20) return next(e)
    const els = $.ui.resolve(e)
    if (!('Client' in els)) return next(e)
    const { Box, Client } = els
    const b = await read($, board)
    const th = pending.threadId != null ? b.threads.find(t => t.id === pending.threadId) : undefined
    const who = pending.quote ? (pending.quote.who === 'claude' ? 'Claude' : 'You') : th ? describeThread(th) : 'Main'
    return (
      <Box width={0}>
        <Box position="absolute" anchor="above" right={1} width={e.props.floatColumns - 2}>
          <Client
            key="replybar"
            module="./replybar.tsx"
            width="100%"
            props={{ who, text: pending.quote ? firstLine(pending.quote.text, 200) : '', thread: pending.quote && th ? `#${th.id}` : '' }}
          />
        </Box>
      </Box>
    )
  })

  on('ui.message', async ($, e, next) => {
    if (e.element === 'replybar' && (e.data as { op?: unknown })?.op === 'cancel') {
      await cancelReply($)
      return {}
    }
    return next(e)
  })

  // ---- The panel -------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    if (bridgeDir) {
      // Never a second threads panel inside the clued window.
      void $.ui.close({ id: PANE })
      return <Box />
    }
    const b = await read($, board)
    const v = await read($, view)
    const width = Math.max(16, e.props.bodyColumns)
    const tally = (topics: Parameters<typeof counts>[0]) => {
      const c = counts(topics)
      return `⏳${c.claude} ✋${c.me} ✓${c.done}`
    }
    const noticeList = (await read($, notices)).slice().reverse()
    const unread = noticeList.filter(n => !n.isRead).length
    const unsorted = b.topics.filter(t => t.threadId === 0)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>Threads</Text>
          <Box flexDirection="row" gap={2}>
            <Button key="results" hotkey="r" plain onPress={() => toggleResults($)}>
              {v.isResultsOnly ? 'results only' : 'all activity'}
            </Button>
            <Button key="close-pane" plain onPress={() => closePane($)}>
              ✕
            </Button>
          </Box>
        </Box>
        <Text dimColor>⏳ on Claude  ✋ on you  ✓ done</Text>
        <Button key="thread-0" plain onPress={() => selectThread($, 0)}>
          <Text bold={v.threadId === 0}>
            {v.threadId === 0 ? '▸ ' : '  '}Main · {b.topics.length} topics {tally(b.topics)}
          </Text>
        </Button>
        {unsorted.map(topic => (
          <Text italic dimColor>
            {'    '}⏳ {firstLine(topic.title, Math.max(8, width - 18))} · sorting…
          </Text>
        ))}
        {b.threads.length === 0 && unsorted.length === 0 && <Text dimColor>  No topics yet. Send a message.</Text>}
        {threadTree(b).map(({ thread: t, depth }) => {
          const topics = topicsOf(b, t.id)
          const isOn = v.threadId === t.id
          const indent = '  '.repeat(Math.min(depth, 4))
          return (
            <Box flexDirection="column">
              <Button key={`thread-${t.id}`} plain onPress={() => selectThread($, isOn ? 0 : t.id)}>
                <Text bold={isOn}>
                  {isOn ? '▸ ' : '  '}
                  {indent}
                  {depth > 0 ? '└ ' : ''}
                  {firstLine(describeThread(t), Math.max(8, width - 16 - indent.length))} <Text dimColor>{tally(topics)}</Text>
                </Text>
              </Button>
              {topics.map(topic => (
                <Text dimColor={topic.status === 'done'} italic={topic.isProvisional === true}>
                  {'    '}
                  {indent}
                  {statusMark[topic.status]} {firstLine(topic.title, Math.max(8, width - 7 - indent.length))}
                </Text>
              ))}
            </Box>
          )
        })}
        <Text> </Text>
        <Text bold>Notifications{unread ? ` · ${unread} new` : ''}</Text>
        {noticeList.length === 0 && <Text dimColor>  Nothing yet.</Text>}
        {noticeList.slice(0, 8).map(n => (
          <Text dimColor={n.isRead}>  {firstLine(n.text, width - 2)}</Text>
        ))}
      </Box>
    )
  })
}
