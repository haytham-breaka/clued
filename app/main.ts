#!/usr/bin/env node
// clued: a chat app on top of a real Claude Code session.
//
//   clued                    new session
//   clued -c                 continue this folder's last session
//   clued --resume [id]      pick a session, or open one
//   clued --model opus ...   any other flag goes to Claude Code
//
// Claude Code runs headless underneath (claude -p, stream-json): the harness, tools, permissions,
// plugins, MCP and the session file are all Claude Code's. This file only draws and takes input.

import './migrate.ts'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  emptyBoard,
  flatBrief,
  FLAT_GUIDE,
  firstLine,
  keyOf,
  parseTag,
  prune,
  raiseTopic,
  reactionPrompt,
  reactionSignal,
  REACTION_PREFIX,
  settleTurn,
  stripTag,
} from '../hooks/model.ts'
import { agentLines, chatLines, requestLines, stepLabel } from './chat.ts'
import type { RequestInfo } from './chat.ts'
import { assignParts, hasMarks, inbox, matches, partId, questionsOf, REPLY_GUIDE, stripMarks } from './inbox.ts'
import type { Inbox, PartRef } from './inbox.ts'
import { Claude } from './claude.ts'
import type { ClaudeEvent, Usage } from './claude.ts'
import { FOLDED, MIN_FULL, RECENT_ROWS, panelLines, who } from './panel.ts'
import type { PanelList } from './panel.ts'
import { lastUsage, listSessions, loadHistory, loadKept, newTurn, saveKept } from './session.ts'
import type { Work } from './session.ts'
import type { Agent, AgentEntry } from './panel.ts'
import type { Kept, SessionInfo, Turn } from './session.ts'
import { C, cellText, cells, charCells, clip, clipLine, lineCells, markCells, pad, sgr, wrap } from './text.ts'
import type { Line, Span } from './text.ts'

// ---- Options ---------------------------------------------------------------------

const cwd = process.cwd()
const argv = process.argv.slice(2)
let resumeId: string | undefined
let wantPicker = false
const passArgs: string[] = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!
  if (a === '-c' || a === '--continue') resumeId = listSessions(cwd)[0]?.id
  else if (a === '-r' || a === '--resume') {
    const next = argv[i + 1]
    if (next && !next.startsWith('-')) {
      resumeId = next
      i++
    } else wantPicker = true
  } else passArgs.push(a)
}

const APP_GUIDE = [
  FLAT_GUIDE,
  REPLY_GUIDE,
  'The user reads your replies in the clued app as chat bubbles; your tool calls are folded into one line, so',
  'keep narration between tool calls short and put what matters in the final reply.',
  'To react to the user\'s latest message, add "react" to your tag. The user likes reactions: use one whenever it fits.',
  '"✅" a small request you finished with nothing more to say: the reaction is the whole reply, no "Done" text;',
  '"👍" noted: an FYI, a decision, or a go-ahead you act on; "👀" seen, on it: a message sent while you were busy;',
  '"🎉" good news. A reaction may also come with a reply when the reply adds something. None on praise alone.',
].join(' ')

// ---- State -----------------------------------------------------------------------

type Quote = { who: 'me' | 'claude'; text: string; key: string; anchor?: string; topics?: string[] }
/** What your next message replies to: one message, or several of Claude's reply parts at once. */
type ReplyTo = { quotes: Quote[] }
type Permission = { requestId: string; tool: string; input: Record<string, unknown> }

const PREFS = `${homedir()}/.clued/panel.json`
/** Every Enter you press and every message the app sends, one line each: to tell later whether two
 * messages were sent as one, and by whom. */
const SEND_LOG = `${homedir()}/.clued/sent.log`
function logSend(what: string, fields: Record<string, unknown>) {
  try {
    mkdirSync(`${homedir()}/.clued`, { recursive: true })
    appendFileSync(SEND_LOG, `${new Date().toISOString()} ${what} ${JSON.stringify({ session: S.sessionId.slice(0, 8), ...fields })}\n`)
  } catch {}
}
const prefs = (() => {
  try {
    return JSON.parse(readFileSync(PREFS, 'utf8')) as { width?: number; folded?: boolean; windows?: Record<string, number>; notify?: Notify }
  } catch {
    return {}
  }
})()

const S = {
  claude: undefined as Claude | undefined,
  sessionId: resumeId ?? '',
  model: '',
  commands: [] as string[],
  permissionMode: '',
  turns: [] as Turn[],
  kept: { board: emptyBoard(), reactions: {}, links: {} } as Kept,
  heard: [] as string[],
  isResultsOnly: false,
  replyTo: null as ReplyTo | null,
  isWorking: false,
  permissions: [] as Permission[],
  picker: null as { sessions: SessionInfo[]; at: number } | null,
  menuAt: 0,
  toast: '' as string,
  toastTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  // input
  text: '',
  cursor: 0,
  history: [] as string[],
  historyAt: -1,
  // layout
  panelWidth: Math.max(MIN_FULL, Math.min(80, prefs.width ?? 34)),
  isFolded: prefs.folded === true,
  panelScroll: 0,
  /** Each panel section's own scroll (by id), and which panel lines each box filled in the last frame. */
  listAt: {} as Record<string, number>,
  panelHead: 0,
  panelLists: {} as Record<string, PanelList>,
  hscroll: 0,
  chatScroll: 0, // lines up from the bottom
  dragging: false,
  // status line
  usage: {} as Usage,
  /** The context size Claude Code reports (0 until the first reply). */
  contextWindow: 0,
  costUsd: 0,
  rate: {} as Record<string, { used_percentage: number; resets_at?: number }>,
  statusRows: [] as string[],
  quitArmed: false,
  spinAt: 0,
  // last frame
  anchors: {} as Record<string, number>,
  chatTotal: 0,
  /** A message to scroll to once the next frame has laid it out (after switching threads). */
  pendingJump: '' as string,
  /** Hover: the message under the pointer, which chat line sits on screen row 1, and who owns each line. */
  hover: '' as string,
  /** The pointer is over the panel: its list keeps its order until it leaves. */
  isOnPanel: false,
  /** Your messages' order as last shown (turn keys). */
  recentOrder: [] as string[],
  chatOrigin: 0,
  owners: [] as string[],
  chatLeft: 0,
  chatTop: 0,
  chatRows: 0,
  /** The chat's lines as last drawn, and where the input box's text rows sit on screen: for selecting text. */
  chatLines: [] as Line[],
  inputGeo: null as { row: number; col: number; first: number; count: number; inner: number } | null,
  /** Text selected with the mouse (copied when you let go), and the press that may start one. */
  sel: null as Sel | null,
  press: null as { x: number; y: number; area: 'chat' | 'input'; isMoved: boolean } | null,
  lastClick: { x: 0, y: 0, at: 0 },
  /** Reply parts read, when each unread part on screen came into view, and whether the window has focus. */
  read: new Set<string>(),
  /**
   * Reading: for each unread reply, which of its lines have been on screen and for how long it has been
   * in view with the window focused. It counts as read once every line was seen, long enough to read.
   */
  seen: new Map<string, { lines: Set<number>; ms: number; total: number; words: number }>(),
  /** Unread replies on screen in the last frame. */
  inView: new Set<string>(),
  /** The last reply Ctrl+N went to, so the next press goes on from it. */
  lastJump: '',
  /** The message of yours Alt+↑/↓ is on ('' for none). */
  picked: '',
  /** The panel's Unread box shows the replies you read last. */
  isReadTab: false,
  /** The key to the marks under "Your recent messages". */
  isLegend: false,
  /** The input box's inner width, as last drawn (for moving the cursor up and down its rows). */
  inputInner: 40,
  /** Images for the next message: `[image N]` in the text stands for images[N-1]. */
  images: [] as { path: string; media: string }[],
  /** Searching your messages (Ctrl+F): what was in the box before, put back when you are done. */
  search: null as { text: string; cursor: number } | null,
  isFocused: true,
  box: { unread: [], waiting: [], messages: [] } as Inbox,
  /** Subagents Claude started, by the id of their Agent call. */
  agents: new Map<string, Agent>(),
  /** /demo: fake agents start on each message you send (drawn only; nothing runs, no tokens). */
  isDemo: false,
  /** The agent whose own chat is open ('' = the main chat), and where the main chat was scrolled. */
  agentView: '',
  /** In Claude's own view: the message its work ends at. */
  mainKey: '',
  /** The request whose chain is open (its turn key; '' = none). */
  requestView: '',
  mainScroll: 0,
}

const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const OUR_COMMANDS = ['clear', 'resume', 'model', 'reload', 'exit', 'results', 'panel', 'work', 'notify', 'demo']

// ---- Notifications: a system notification when Claude asks you something ---------------------

/** on: when the window isn't focused; always: also when it is; off: never. Set with /notify. */
type Notify = 'on' | 'always' | 'off'
let notifyMode: Notify = prefs.notify ?? 'on'
const appStart = Date.now()
const notified = new Set<string>()

/** Notifies about questions that just joined Waiting on you (the ones there at start are only noted). */
/**
 * The tab says when Claude waits on you, so with several tabs you can see which one: its title starts
 * with ✋ and the count, and in Windows Terminal the tab (and taskbar button) shows a paused, yellow mark.
 */
let tabMark = ''
function markTab() {
  const n = S.box.waiting.length + S.permissions.length
  const where = cwd.split('/').pop() || cwd
  const title = `${n ? `✋ ${n} · ` : ''}clued · ${where}`
  if (title === tabMark) return
  const had = tabMark.startsWith('✋')
  tabMark = title
  out.write(`\x1b]2;${title}\x07`)
  if (IS_WT && (n > 0) !== had) out.write(n ? '\x1b]9;4;4;100\x07' : '\x1b]9;4;0;0\x07')
}

function notifyNewQuestions() {
  const fresh = S.box.waiting.filter(w => !notified.has(w.id))
  for (const w of fresh) notified.add(w.id)
  if (!fresh.length || Date.now() - appStart < 5000 || notifyMode === 'off' || (notifyMode === 'on' && S.isFocused)) return
  const where = cwd.split('/').pop() || cwd
  notify(fresh.length > 1 ? `Claude asks you ${fresh.length} things · ${where}` : `Claude asks you · ${where}`, preview(fresh.at(-1)!.question, 200))
}

/**
 * Terminals that post a notification themselves (OSC 9, or kitty's OSC 99): a click on it
 * goes back to the very tab that sent it. Everywhere else the system's own notification is used.
 */
const TERM_NOTIFIES = process.env.TERM_PROGRAM === 'iTerm.app' || process.env.TERM_PROGRAM === 'WezTerm' || process.env.TERM_PROGRAM === 'ghostty' || !!process.env.KITTY_WINDOW_ID
const IS_WT = !!process.env.WT_SESSION

/** A system notification: from the terminal itself when it can (so a click opens this tab), else a Windows toast (from WSL too), macOS Notification Center, or notify-send. */
function notify(title: string, body: string) {
  const text = `${title}: ${body}`.replace(/[\x00-\x1f\x7f]/g, ' ')
  try {
    if (process.env.KITTY_WINDOW_ID) out.write(`\x1b]99;;${text}\x1b\\`)
    else if (TERM_NOTIFIES) out.write(`\x1b]9;${text}\x07`)
    else if (IS_WSL || process.platform === 'win32') {
      const b64 = (t: string) => Buffer.from(t, 'utf8').toString('base64')
      const ps = [
        `$u=[Text.Encoding]::UTF8; $t=$u.GetString([Convert]::FromBase64String('${b64(title)}')); $m=$u.GetString([Convert]::FromBase64String('${b64(body)}'))`,
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
        '$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
        "$e=$x.GetElementsByTagName('text'); [void]$e.Item(0).AppendChild($x.CreateTextNode($t)); [void]$e.Item(1).AppendChild($x.CreateTextNode($m))",
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))",
      ].join('; ')
      execFile(IS_WSL ? 'powershell.exe' : 'powershell', ['-NoProfile', '-Command', ps], () => {})
    } else if (process.platform === 'darwin') {
      execFile('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body], () => {})
    } else execFile('notify-send', ['-a', 'clued', title, body], () => {})
  } catch {}
}

/** Each model's context size as Claude Code last reported it, for the status line before the first reply. */
const knownWindows: Record<string, number> = { ...(prefs.windows ?? {}) }

function savePrefs() {
  mkdirSync(`${homedir()}/.clued`, { recursive: true })
  writeFileSync(PREFS, JSON.stringify({ width: S.panelWidth, folded: S.isFolded, windows: knownWindows, notify: notifyMode }))
}

/** Questions you dismissed since your last message: the next one tells Claude not to wait for them. */
let dismissed: string[] = []

/** Drops questions from Waiting on you without an answer: their messages count as done. */
function dismiss(partIds: string[]) {
  const ids = new Set(S.box.waiting.filter(w => partIds.includes(w.id)).flatMap(w => w.part.to))
  const now = Date.now()
  const hit = S.kept.board.topics.filter(t => ids.has(t.id) && t.status === 'me')
  if (!hit.length) return
  S.kept.board = { ...S.kept.board, topics: S.kept.board.topics.map(t => (hit.includes(t) ? { ...t, status: 'done' as const, updatedAt: now } : t)) }
  dismissed.push(...hit.map(t => t.id).filter(id => !dismissed.includes(id)))
  keep()
  toast(hit.length > 1 ? `Dismissed ${hit.length} questions. Claude won't wait for them.` : 'Dismissed. Claude won\'t wait for an answer.')
  draw()
}

function keep() {
  if (S.sessionId) saveKept(S.sessionId, S.kept)
}

// ---- Read and unread ------------------------------------------------------------------

/** Loads what you have read; the first time the app opens a session, everything already there counts as read. */
function initRead() {
  S.read = new Set(S.kept.read ?? [])
  S.seen.clear()
  if (!S.kept.readInit) {
    for (const t of S.turns) (t.parts ?? []).forEach((_, i) => S.read.add(partId(t, i)))
    S.kept.readInit = true
    S.kept.read = [...S.read]
    keep()
  }
}

function markRead(ids: string[]) {
  const fresh = ids.filter(id => !S.read.has(id))
  if (!fresh.length) return
  for (const id of fresh) S.read.add(id)
  S.kept.read = [...S.read].slice(-3000)
  keep()
}

// ---- Inside an agent ------------------------------------------------------------------

function openAgent(id: string) {
  if (!S.agents.has(id)) return toast('That agent is no longer here.')
  if (!S.agentView && !S.requestView) S.mainScroll = S.chatScroll
  S.requestView = ''
  S.agentView = id
  S.chatScroll = 0
  S.replyTo = null
  draw()
}

/** An agent that finished and was continued: running again, from now. */
function resumeAgent(a: Agent) {
  a.state = 'running'
  a.startedAt = Date.now()
  delete a.endedAt
  delete a.result
}

/** Back to the main chat from an agent's or a request's view. */
function closeAgent() {
  if (!S.agentView && !S.requestView) return
  S.agentView = ''
  S.requestView = ''
  S.chatScroll = S.mainScroll
  draw()
}

// ---- Inside a request: its chain -----------------------------------------------------------

function openRequest(turn: Turn) {
  if (!S.agentView && !S.requestView) S.mainScroll = S.chatScroll
  S.agentView = ''
  S.requestView = turn.key
  S.chatScroll = 0
  S.replyTo = null
  draw()
}

/**
 * A request's chain: your message, the messages merged into it or sent about it (quoting it, or from
 * its view), the reply parts naming any of them, follow-ups on them, and the agents that worked on them.
 */
function requestInfo(req: Turn): RequestInfo {
  const board = S.kept.board
  const topic = board.topics.find(t => t.messageKeys.includes(req.key))
  const keys = new Set([req.key, ...(topic?.messageKeys ?? [])])
  const ids = new Set<string>()
  const addIds = () => {
    for (const t of S.turns) if (keys.has(t.key) && t.topicId) ids.add(t.topicId)
    if (topic) ids.add(topic.id)
  }
  // The topics a quoted reply answers (a part, or all of one answer's parts).
  const answers = (anchor: string): string[] => {
    if (anchor.startsWith('part:')) return S.turns.flatMap(t => t.parts ?? []).find(p => p.id === anchor.slice(5))?.to ?? []
    if (anchor.startsWith('claude:')) return S.turns.findLast(t => t.key === anchor.slice(7))?.parts?.flatMap(p => p.to) ?? []
    return []
  }
  // The chain grows until nothing more joins: messages sent about it, quoting one of its messages, or
  // quoting a reply of Claude's to one of them (and so on, down the replies).
  addIds()
  for (let grew = true; grew; ) {
    grew = false
    for (const t of S.turns) {
      if (keys.has(t.key)) continue
      const l = S.kept.links[t.key]
      const quoted = l ? (l.all?.length ? l.all.map(a => a.anchor) : [l.anchor ?? `${l.who}:${l.key}`]) : []
      const joins = (t.aboutRequest && keys.has(t.aboutRequest)) || (l?.who === 'me' && keys.has(l.key))
        || quoted.some(a => (a.startsWith('me:') && keys.has(a.slice(3))) || answers(a).some(id => ids.has(id)))
      if (joins) {
        keys.add(t.key)
        grew = true
      }
    }
    addIds()
  }
  const turns = S.turns.filter(t => keys.has(t.key) || t.followUp?.some(k => keys.has(k)) || t.parts?.some(p => p.to.some(id => ids.has(id))))
  const agents = [...S.agents.values()].filter(a => a.for.some(k => keys.has(k)))
  const ref = S.box.messages.find(m => m.turn === req)
  const state = ref?.stale ? 'no update' : ({ claude: 'waiting', progress: 'in progress', me: 'needs you', done: 'done', failed: 'failed', none: 'not answered', lost: 'reply lost' } as const)[ref?.state ?? 'claude']
  const mark = ref?.stale ? '⚠' : ({ claude: '⏳', progress: '▶', me: '✋', done: '✓', failed: '✕', none: '○', lost: '⚠' } as const)[ref?.state ?? 'claude']
  return { state, mark, isStale: !!ref?.stale, ids: [...ids], agents, turns, keys }
}

/** How many messages and replies a message's chain holds besides it (0: none yet). Worked out once a paint. */
let chainCache = new Map<Turn, number>()
function chainSize(turn: Turn): number {
  let n = chainCache.get(turn)
  if (n == null) {
    const info = requestInfo(turn)
    const parts = info.turns.flatMap(t => t.parts ?? []).filter(p => p.to.some(id => info.ids.includes(id))).length
    n = info.turns.filter(t => info.keys.has(t.key) && t !== turn && !t.reaction).length + parts
    chainCache.set(turn, n)
  }
  return n
}

/** Scrolls to a reply part (in Main when this view hides it) and counts it read. */
function openPart(id: string) {
  closeAgent()
  S.lastJump = id
  if (S.anchors[`part:${id}`] == null) {
    S.isResultsOnly = false
  }
  S.pendingJump = `part:${id}`
  draw()
}

function openMessage(turn: Turn) {
  closeAgent()
  if (S.anchors[`me:${turn.key}`] == null) {
    S.isResultsOnly = false
  }
  S.pendingJump = `me:${turn.key}`
  draw()
}

/** Claude's own work right now: its steps listed, the latest one in full, the chat at it. */
/** The view id of Claude's own live view, beside the agents'. */
const MAIN = 'main'

/** Claude's work right now, in a view of its own: every step and word as Claude Code streams it. */
function openWork() {
  const t = S.turns.findLast(x => !x.isDone) ?? S.turns.findLast(x => x.steps.length)
  if (!t) return toast('Claude has not worked yet.')
  if (!S.agentView && !S.requestView) S.mainScroll = S.chatScroll
  S.requestView = ''
  S.agentView = MAIN
  S.mainKey = t.key
  S.chatScroll = 0
  S.replyTo = null
  draw()
}

/**
 * Claude itself as an agent, for its view: the messages it is on (your message, and the ones it went
 * on with) and everything it did and wrote for them, live while it works.
 */
function mainAgent(): Agent | undefined {
  // While it works, the view follows the newest open message (a queued one becomes the end of the chain).
  const open = openTurn()
  if (open && S.mainKey !== open.key && S.turns.findIndex(x => x.key === S.mainKey) < S.turns.indexOf(open)) S.mainKey = open.key
  const end = S.turns.findLast(x => x.key === S.mainKey)
  if (!end) return undefined
  const idx = S.turns.indexOf(end)
  let start = idx
  while (start > 0 && S.turns[start - 1]!.continued) start--
  const chain = S.turns.slice(start, idx + 1)
  const asks = chain.filter(x => !x.reaction && !x.followUp)
  const log: AgentEntry[] = []
  for (const t of chain) {
    for (const s of t.steps) {
      if (s.said) log.push({ text: stripMarks(s.said) })
      log.push({ step: s })
    }
    for (const e of t.early ?? []) log.push({ text: stripMarks(e) })
    const live = !t.isDone ? t.live || t.pending : ''
    if (live) log.push({ text: stripMarks(stripTag(live)) })
  }
  const steps = chain.reduce((n, t) => n + t.steps.length, 0)
  return {
    id: MAIN,
    name: 'Claude',
    type: 'this session',
    isBackground: false,
    for: asks.map(x => x.key),
    startedAt: chain[0]!.at,
    ...(end.isDone ? { endedAt: end.at + (end.durationMs ?? 0) } : {}),
    state: !end.isDone ? 'running' : end.error ? 'failed' : 'done',
    steps,
    last: '',
    prompt: asks.map(x => x.text).join('\n\n---\n\n') || (chain[0]!.reaction ? `you reacted ${chain[0]!.reaction}` : ''),
    log,
    ...(end.answer ? { result: stripMarks(end.answer) } : {}),
    asker: asks.length > 1 ? `You asked (${asks.length} messages)` : 'You asked',
    resultLabel: '✓ Claude answered',
  }
}

/** Your messages as the panel lists them: newest first, only the matches while you search. */
const recentList = () => (S.search ? S.box.messages.filter(m => matches(m.turn.text, S.text)) : S.box.messages)

function startSearch() {
  if (S.search) return
  S.search = { text: S.text, cursor: S.cursor }
  S.text = ''
  S.cursor = 0
  S.listAt.recent = 0
  draw()
}

function endSearch() {
  if (!S.search) return
  S.text = S.search.text
  S.cursor = S.search.cursor
  S.search = null
  draw()
}

/** A click on one of your messages in the panel: the chat goes to it, and it is the one picked. */
function jumpTo(turn: Turn) {
  S.picked = turn.key
  openMessage(turn)
}

/** Alt+↑/↓ go up and down your messages as the panel lists them: the chat goes there, the panel shows it. */
function pickMessage(down: number) {
  const list = recentList()
  if (!list.length) return toast(S.search ? 'No message matches.' : 'No messages of yours yet.')
  const at = list.findIndex(m => m.turn.key === S.picked)
  const i = at < 0 ? 0 : Math.max(0, Math.min(list.length - 1, at + down))
  if (at >= 0 && i === at) toast(down > 0 ? 'That is the last in the list.' : 'That is the first in the list.')
  S.picked = list[i]!.turn.key
  // Keep its row inside the panel's box.
  const max = S.panelLists.recent?.max ?? RECENT_ROWS
  const top = S.listAt.recent ?? 0
  if (i < top) S.listAt.recent = i
  else if (i >= top + max) S.listAt.recent = i - max + 1
  openMessage(list[i]!.turn)
}

/** Alt+→: from the message you are on to Claude's reply to it. */
function openPickedReply() {
  const m = S.box.messages.find(x => x.turn.key === S.picked)
  if (!m) return
  if (m.replyId) return openPart(m.replyId)
  toast(m.state === 'claude' || m.state === 'progress' ? 'No reply yet: Claude is still on it.' : m.state === 'failed' ? 'That one failed: no reply.' : 'No reply to that one.')
}

/** The next reply you haven't read, after the one Ctrl+N went to last (round to the oldest). */
function nextUnread() {
  const list = S.box.unread
  if (!list.length) return toast('No unread replies.')
  const at = list.findIndex(p => p.id === S.lastJump)
  openPart(list[(at + 1) % list.length]!.id)
}

/** ✓ mark read / ● mark unread, from a reply's hover actions. */
function setRead(ids: string[], isRead: boolean) {
  if (isRead) markRead(ids)
  else {
    for (const id of ids) {
      S.read.delete(id)
      S.seen.delete(id)
    }
    S.kept.read = [...S.read]
    keep()
  }
  draw()
}

/** A message as one plain line: Markdown marks and the tag dropped. */
function preview(text: string, max = 80): string {
  const plain = stripMarks(stripTag(text))
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)]|>)\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain
}

function toast(text: string) {
  S.toast = text
  clearTimeout(S.toastTimer)
  S.toastTimer = setTimeout(() => {
    S.toast = ''
    draw()
  }, 3500)
  draw()
}

function setWork(w: Work) {
  S.kept.work = w
  for (const t of S.turns) for (const s of t.steps) delete s.isOpen
  for (const t of S.turns) t.isOpen = false
  keep()
  toast(w === 'folded' ? 'Claude\'s work: folded into one line.' : w === 'edits' ? 'Claude\'s work: file changes shown as diffs.' : 'Claude\'s work: every step, with diffs and output.')
}

// ---- Claude Code -------------------------------------------------------------------

function start(resume?: string) {
  S.claude?.close()
  S.isWorking = false
  S.permissions = []
  if (resume) {
    S.sessionId = resume
    S.turns = loadHistory(cwd, resume)
    // The context as the session left it, so the status line isn't empty until the next reply.
    S.usage = lastUsage(cwd, resume) ?? S.usage
    S.kept = loadKept(resume, cwd)
    S.kept.board = prune(S.kept.board, Date.now())
    // Mid-turn replies the transcript lost, from the app's own copy.
    for (const [key, texts] of Object.entries(S.kept.early ?? {})) {
      const t = S.turns.findLast(x => x.key === key)
      if (!t) continue
      const missing = texts.filter(x => !(t.early ?? []).includes(x))
      if (missing.length) t.early = [...(t.early ?? []), ...missing]
    }
    assignParts(S.turns, S.kept.board)
  } else {
    S.sessionId = ''
    S.turns = []
    S.kept = { board: emptyBoard(), reactions: {}, links: {} }
  }
  S.chatScroll = 0
  initRead()
  S.claude = new Claude({ args: [...(resume ? ['--resume', resume] : []), ...passArgs], cwd, appendSystemPrompt: APP_GUIDE }, onEvent)
  refreshStatus()
  draw()
}

/** The turn Claude's events belong to: the newest one still open. */
const openTurn = () => S.turns.findLast(t => !t.isDone)

/**
 * Claude writing with no message of yours open: it went on by itself, as when a background agent
 * comes back. A turn of its own, following up on the messages those agents worked for.
 */
function followUpTurn(): Turn {
  const now = Date.now()
  const bg = [...S.agents.values()].filter(a => a.isBackground)
  const back = bg.filter(a => a.endedAt && now - a.endedAt < 2 * 60 * 1000)
  const from = back.length ? back : bg.filter(a => a.state === 'running')
  const keys = from.length ? [...new Set(from.flatMap(a => a.for))] : S.turns.filter(x => !x.reaction && !x.followUp).slice(-1).map(x => x.key)
  const turn = newTurn('', now)
  turn.key = `follow-${now.toString(36)}`
  turn.followUp = keys
  S.turns.push(turn)
  S.isWorking = true
  return turn
}

function onEvent(e: ClaudeEvent) {
  let t = openTurn()
  if (!t && !quitting && (e.kind === 'text-delta' || e.kind === 'text' || e.kind === 'tool')) t = followUpTurn()
  switch (e.kind) {
    case 'init':
      if (!S.sessionId) {
        S.sessionId = e.sessionId
        const kept = loadKept(e.sessionId, cwd)
        if (kept.board.threads.length) {
          S.kept = kept
          initRead()
        }
      }
      S.model = e.model
      S.commands = e.commands
      S.permissionMode = e.permissionMode
      break
    case 'text-delta':
      if (t) t.live += e.text
      break
    case 'text':
      if (t) {
        t.pending = t.pending ? `${t.pending}\n\n${e.text}` : e.text
        t.live = ''
      }
      break
    case 'tool':
      // A message to an agent that finished continues it: back under Agents, running.
      if (e.tool.name === 'SendMessage') {
        const to = String(e.tool.input.to ?? '')
        const a = [...S.agents.values()].find(x => x.taskId === to || x.id === to || x.name === to)
        if (a) {
          resumeAgent(a)
          a.log.push({ text: `↻ Claude continued it: ${preview(String(e.tool.input.message ?? ''), 300)}` })
        }
      }
      if (e.tool.name === 'Agent' || e.tool.name === 'Task') {
        // A subagent: which of your messages it works for are the ones this turn answers.
        const i = e.tool.input
        const open = S.turns.filter(x => !x.isDone && !x.reaction)
        S.agents.set(e.tool.id, {
          id: e.tool.id,
          name: String(i.description || i.subagent_type || 'agent'),
          type: String(i.subagent_type ?? ''),
          isBackground: i.run_in_background === true,
          for: (open.length ? open : S.turns.filter(x => !x.reaction).slice(-1)).map(x => x.key),
          startedAt: Date.now(),
          state: 'running',
          steps: 0,
          last: '',
          prompt: String(i.prompt ?? ''),
          log: [],
        })
      }
      if (t) {
        // Text with reply marks before more work is a reply written early: shown now, kept as parts.
        if (hasMarks(t.pending)) {
          // Its own tag, if it has one, settles those messages now rather than at the end of the turn.
          if (/<(?:clued|threadline)>[\s\S]*?<\/(?:clued|threadline)>/.test(t.pending)) {
            // Only the topics it lists: the messages it leaves out are still being worked on.
            const was = S.kept.board.turnTopics
            S.kept.board = { ...settleTurn({ ...S.kept.board, turnTopics: [] }, t.pending, Date.now(), { flat: true }).board, turnTopics: was }
          }
          t.early = [...(t.early ?? []), stripTag(t.pending)]
          // Kept by the app too: the transcript may lose it.
          const kept = { ...S.kept.early, [t.key]: t.early }
          S.kept.early = Object.fromEntries(Object.entries(kept).slice(-300))
          t.pending = ''
          assignParts(S.turns, S.kept.board)
          keep()
        }
        t.steps.push({ tool: e.tool, ...(t.pending ? { said: stripMarks(stripTag(t.pending)) } : {}) })
        t.pending = ''
        t.live = ''
      }
      break
    case 'tool-result': {
      const a = S.agents.get(e.id)
      if (a) {
        if (a.isBackground && !e.isError) a.taskId = e.text.match(/agent ?id:?\s*([\w-]+)/i)?.[1] ?? a.taskId
        else {
          a.state = e.isError ? 'failed' : 'done'
          a.endedAt = Date.now()
          a.result = e.text
        }
      }
      for (const turn of S.turns)
        for (const s of turn.steps)
          if (s.tool.id === e.id) {
            s.result = e.text
            s.isError = e.isError
          }
      break
    }
    case 'usage':
      S.usage = e.usage
      statusSoon()
      break
    case 'output-tokens':
      S.usage = { ...S.usage, output_tokens: e.tokens }
      statusSoon()
      break
    case 'agent-step': {
      const a = S.agents.get(e.parent)
      if (a) {
        a.steps++
        a.last = stepLabel({ tool: e.tool }, cwd).text
        a.log.push({ step: { tool: e.tool } })
      }
      break
    }
    case 'agent-text': {
      const a = S.agents.get(e.parent)
      if (a) a.log.push({ text: e.text })
      break
    }
    case 'agent-tool-result': {
      const a = S.agents.get(e.parent)
      const hit = a?.log.find(x => 'step' in x && x.step.tool.id === e.id)
      if (hit && 'step' in hit) {
        hit.step.result = e.text
        hit.step.isError = e.isError
      }
      break
    }
    case 'task': {
      const a = (e.toolUseId && S.agents.get(e.toolUseId)) || [...S.agents.values()].find(x => x.taskId && x.taskId === e.taskId)
      if (!a) break
      if (e.taskId) a.taskId = e.taskId
      // News from an agent that had finished: it was continued (a message to it), so it runs again.
      if (e.phase !== 'done' && a.state !== 'running') resumeAgent(a)
      if (e.phase === 'progress' && e.lastTool) a.last = e.lastTool
      if (e.phase === 'done') {
        a.state = e.status === 'failed' ? 'failed' : e.status === 'stopped' ? 'stopped' : 'done'
        a.endedAt = Date.now()
        if (e.text) {
          a.last = e.text
          a.result = e.text
        }
      }
      break
    }
    case 'rate': {
      const w = (e.info.unifiedWindows ?? {}) as Record<string, { utilization?: number; resetsAt?: number }>
      for (const [k, v] of Object.entries(w)) S.rate[k] = { used_percentage: Math.round((v.utilization ?? 0) * 100), resets_at: v.resetsAt }
      statusSoon()
      break
    }
    case 'result':
      finishTurn(e.text, e.isError, e.durationMs)
      S.costUsd = e.costUsd || S.costUsd
      if (e.contextWindow) {
        S.contextWindow = e.contextWindow
        if (S.model && knownWindows[S.model] !== e.contextWindow) {
          knownWindows[S.model] = e.contextWindow
          savePrefs()
        }
      }
      if (e.sessionId) S.sessionId = e.sessionId
      refreshStatus()
      break
    case 'permission':
      S.permissions.push({ requestId: e.requestId, tool: e.tool, input: e.input })
      if (notifyMode === 'always' || (notifyMode === 'on' && !S.isFocused))
        notify(`Claude wants to use ${e.tool} · ${cwd.split('/').pop() || cwd}`, preview(String(e.input.description ?? e.input.command ?? e.input.file_path ?? e.input.url ?? ''), 200))
      break
    case 'status':
      if (e.text === 'compacting') toast('Compacting the conversation…')
      break
    case 'exit':
      if (!quitting) {
        const last = e.stderr.trim().split('\n').at(-1) ?? ''
        const turn = openTurn() ?? S.turns.at(-1)
        if (turn) {
          turn.isDone = true
          turn.error = `Claude Code stopped${e.code ? ` (exit ${e.code})` : ''}${last ? `: ${last}` : ''}. Send a message to start it again.`
        }
        S.isWorking = false
        S.claude = undefined
        for (const a of S.agents.values()) if (a.state === 'running') { a.state = 'stopped'; a.endedAt = Date.now() }
      }
      break
  }
  draw()
}

function finishTurn(resultText: string, isError: boolean, durationMs: number) {
  const open = S.turns.filter(t => !t.isDone)
  const last = open.at(-1)
  const raw = last?.pending || resultText
  for (const t of open) {
    t.isDone = true
    t.live = ''
    t.durationMs = Date.now() - t.at
  }
  if (last && raw) {
    last.answer = stripTag(raw)
    last.pending = ''
    if (isError) last.error = firstLine(raw, 200)
  }
  if (last) last.durationMs = durationMs || last.durationMs
  S.isWorking = false
  if (!raw) return
  const settled = settleTurn(S.kept.board, raw, Date.now(), { flat: true })
  S.kept.board = settled.board
  // Split into replies now the topics are known; new parts start unread (the inbox lists what waits on you).
  assignParts(S.turns, S.kept.board)
  // A new update on the same messages as the updates just before it (an agent reporting in): the chat
  // folds those into it, so they are not left unread where you cannot see them.
  const newest = S.turns.at(-1)
  if (newest?.followUp && newest.parts?.length) {
    const about = (t: Turn) => [...new Set((t.parts ?? []).flatMap(p => p.to))].sort().join(',')
    const old: string[] = []
    for (let i = S.turns.length - 2; i >= 0; i--) {
      const t = S.turns[i]!
      if (t.followUp && !t.parts?.length && !t.steps.length) continue
      if (!t.followUp || !t.parts?.length || about(t) !== about(newest)) break
      t.parts.forEach((_, k) => old.push(partId(t, k)))
    }
    if (old.length) markRead(old)
  }
  // Claude's reaction, from its tag.
  const m = raw.match(/<(?:clued|threadline)>\s*(\{[\s\S]*\})\s*<\/(?:clued|threadline)>/)
  try {
    const react = m ? (JSON.parse(m[1]!) as { react?: unknown }).react : undefined
    const mine = S.turns.findLast(x => !x.reaction && !x.followUp)
    if (typeof react === 'string' && ['👀', '👍', '✅', '🎉'].includes(react) && mine && !S.kept.reactions[mine.key]?.some(r => r.by === 'claude')) {
      S.kept.reactions[mine.key] = [...(S.kept.reactions[mine.key] ?? []), { emoji: react, by: 'claude' }]
    }
  } catch {}
  if (m) autoLink(m[1]!)
  keep()
}

/**
 * A message you sent without ↩ reply that Claude's tag says refers to an earlier one ("about", or
 * "same_as" when it continues it): linked as if you had replied to that message, so its quote and
 * chain show it. Your own links are never replaced.
 */
function autoLink(json: string) {
  let entries: { id?: unknown; about?: unknown; same_as?: unknown }[] = []
  try {
    entries = ((JSON.parse(json) as { topics?: unknown }).topics ?? []) as typeof entries
  } catch {
    return
  }
  if (!Array.isArray(entries)) return
  for (const e of entries) {
    const target = typeof e.about === 'string' ? e.about : typeof e.same_as === 'string' ? e.same_as : ''
    if (typeof e.id !== 'string' || !target || target === e.id) continue
    const at = S.turns.findLastIndex(t => t.topicId === e.id && !t.reaction)
    if (at < 0) continue
    const turn = S.turns[at]!
    if (S.kept.links[turn.key]) continue
    // The latest message of that topic before this one (a merged topic keeps its messages' keys).
    const topic = S.kept.board.topics.find(t => t.id === target)
    const earlier = S.turns.slice(0, at).findLast(t => !t.reaction && !t.followUp && (t.topicId === target || topic?.messageKeys.includes(t.key)))
    if (!earlier) continue
    S.kept.links[turn.key] = { key: earlier.key, who: 'me', text: preview(earlier.text, 60), anchor: `me:${earlier.key}`, auto: true }
  }
}

function submit(text: string, opts: { reaction?: string } = {}) {
  if (!S.claude) start(S.sessionId || undefined)
  const now = Date.now()
  const turn = newTurn(text, now)
  if (opts.reaction) turn.reaction = opts.reaction
  let hidden: string | undefined
  if (!opts.reaction && !text.startsWith('/')) {
    const reply = S.replyTo
    // Your answer to a question: what it asked is back with Claude at once, not still ✋ until the next
    // reply's tag. Quoting a reply answers its question. A plain message answers the question only when
    // just one was open and the message is not a question itself ("btw, what about…?" answers nothing).
    const quoted = reply?.quotes.flatMap(q => q.topics ?? []) ?? []
    const asked = S.kept.board.topics.filter(t => t.status === 'me')
    const answered = new Set(quoted.length ? quoted : asked.length === 1 && !/\?\s*$/.test(text) ? [asked[0]!.id] : [])
    S.kept.board = { ...S.kept.board, topics: S.kept.board.topics.map(t => (t.status === 'me' && answered.has(t.id) ? { ...t, status: 'claude' as const, updatedAt: now } : t)) }
    const raised = raiseTopic(S.kept.board, { text, key: turn.key, replyTo: null }, now)
    turn.topicId = raised.topicId
    hidden = flatBrief(raised.board, raised.topicId, reply?.quotes ?? [])
    // Several questions in one message: numbered, so a reply can say which it answers (each is quoted).
    const qs = questionsOf(text)
    if (qs.length) hidden = `${hidden}\nIt asks ${qs.length} things: ${qs.map((q, i) => `${raised.topicId}.${i + 1} "${preview(q, 80)}"`).join('; ')}.`
    const req = S.requestView ? S.turns.findLast(t => t.key === S.requestView) : undefined
    if (req) {
      // Written inside a request: part of it, linked to it, and Claude is told so.
      turn.aboutRequest = req.key
      if (!reply?.quotes.length) S.kept.links[turn.key] = { key: req.key, who: 'me', text: preview(req.text, 60) }
      hidden = `${hidden}\nThe user wrote this from inside the view of their request ${req.topicId ?? ''} ("${preview(req.text, 80)}"): it is part of that request (use same_as ${req.topicId ?? 'its topic'} unless it is a new subject). Reply to its id.`
    }
    const inside = S.agentView ? S.agents.get(S.agentView) : undefined
    if (inside) {
      turn.aboutAgent = inside.id
      hidden = `${hidden}\nThe user wrote this from inside the view of your agent ${who(inside, S.agents.values())}, "${inside.name}" (${inside.state}; Agent tool use ${inside.id}${inside.taskId ? `, agent id ${inside.taskId}` : ''}): it is about that agent's work. If they want the agent itself to go on, continue it (SendMessage to it, when you can); otherwise answer or do it yourself.`
    }
    // The names the panel gives your agents, so "ask Jake" means something.
    const named = [...S.agents.values()].filter(a => a.state === 'running' || Date.now() - (a.endedAt ?? 0) < 30 * 60_000)
    if (named.length && !inside) hidden = `${hidden}\nThe app shows your agents by these names: ${named.map(a => `${who(a, S.agents.values())} = "${preview(a.name, 50)}" (${a.state}; Agent tool use ${a.id}${a.taskId ? `, agent id ${a.taskId}` : ''})`).join('; ')}.`
    S.kept.board = raised.board
    const first = reply?.quotes[0]
    if (first) S.kept.links[turn.key] = { key: first.key, who: first.who, text: preview(first.text, 60), ...(first.anchor ? { anchor: first.anchor } : {}), ...(reply!.quotes.length > 1 ? { more: reply!.quotes.length - 1, all: reply!.quotes.map(q => ({ anchor: q.anchor ?? `${q.who}:${q.key}`, text: preview(q.text, 120) })) } : {}) }
    S.replyTo = null
    if (dismissed.length) {
      hidden += `\nThe user dismissed your question${dismissed.length > 1 ? 's' : ''} on ${dismissed.join(', ')} without answering: don't wait for an answer, and ask again only if it still matters.`
      dismissed = []
    }
    if (S.heard.length) {
      hidden += `\nSince your last reply the user reacted: ${S.heard.join('; ')}. Mention it only if it matters.`
      S.heard = []
    }
  }
  // Sent while Claude works: Claude Code folds it into the running turn, so the earlier open
  // turns stop here (their steps stay with them) and the rest of the work shows under this one.
  for (const t of S.turns.filter(x => !x.isDone)) {
    turn.pending = t.pending
    turn.queued = true
    t.pending = ''
    t.live = ''
    t.isDone = true
    t.continued = true
    t.durationMs = now - t.at
  }
  S.turns.push(turn)
  S.isWorking = true
  S.chatScroll = 0
  // The images its text still names ([image N]) go with it.
  const images = S.images.filter((_, i) => text.includes(`[image ${i + 1}]`)).flatMap(img => {
    try {
      return [{ media: img.media, data: readFileSync(img.path).toString('base64') }]
    } catch {
      return []
    }
  })
  S.images = []
  logSend('sent', { topic: turn.topicId, text, ...(hidden ? { note: hidden } : {}), ...(images.length ? { images: images.length } : {}) })
  S.claude!.send(text, hidden, images)
  statusSoon()
  if (S.isDemo && !opts.reaction && !text.startsWith('/')) demoAgents(turn)
  keep()
  draw()
}

// ---- /demo: fake agents, to see how the panel shows them -----------------------------

const DEMO = [
  { name: 'Explore the codebase', type: 'Explore', steps: ['Searched for useAuth', 'Read src/auth/session.ts', 'Read src/auth/token.ts', 'Searched for refreshToken', 'Read src/api/client.ts'] },
  { name: 'Review the diff', type: 'code-reviewer', steps: ['Ran git diff', 'Read app/panel.ts', 'Read app/main.ts', 'Searched for TODO'] },
  { name: 'Run the test suite', type: 'general-purpose', steps: ['Ran npm test', 'Read test/panel.test.ts', 'Ran npm test -- panel'] },
  { name: 'Check the docs', type: 'web-fetch', steps: ['Fetched docs.example.com/api', 'Fetched docs.example.com/limits'] },
  { name: 'Plan the refactor', type: 'Plan', steps: ['Read app/chat.ts', 'Read app/inbox.ts', 'Updated the plan'] },
]
let demoAt = 0

/** One or two fake agents on this message: they step through made-up work, then finish (one may fail). */
function demoAgents(turn: Turn) {
  const count = 1 + (demoAt % 2)
  for (let k = 0; k < count; k++) {
    const d = DEMO[demoAt++ % DEMO.length]!
    const id = `demo-${crypto.randomUUID()}`
    const a: Agent = {
      id, name: d.name, type: d.type, isBackground: false, for: [turn.key], startedAt: Date.now(), state: 'running', steps: 0, last: '',
      prompt: `${d.name} for the user's message: “${preview(turn.text, 80)}”. Report what you find in a few bullet points. (demo)`,
      log: [{ text: `I'll start by looking around. (demo)` }],
    }
    S.agents.set(id, a)
    const every = 2500 + Math.random() * 2500
    const tick = setInterval(() => {
      if (a.steps < d.steps.length) {
        a.last = d.steps[a.steps]!
        a.log.push({ step: { tool: { id: `${id}-${a.steps}`, name: 'Demo', input: { step: a.last } }, result: `(demo) ${a.last}: ok` } })
        a.steps++
      } else {
        a.result = `**${d.name}** (demo)\n\n${d.steps.map(x => `- ${x}: nothing unusual`).join('\n')}`
        clearInterval(tick)
        a.state = demoAt % 4 === 0 && k === 1 ? 'failed' : 'done'
        a.endedAt = Date.now()
      }
      draw()
    }, every)
  }
  draw()
}

// ---- Replies and reactions ---------------------------------------------------------

/**
 * Replies to a message. Claude's reply parts can be gathered: while you are replying to some,
 * ↩ on another adds it (a second click takes it out), and `parts` adds all of an answer's parts.
 */
function replyTo(who: 'me' | 'claude', t: Turn, parts?: number[]) {
  if (who === 'me' || !parts) {
    S.replyTo = { quotes: [{ who, text: who === 'me' ? t.text : stripMarks(t.answer ?? ''), key: t.key, anchor: `${who}:${t.key}` }] }
    return draw()
  }
  const quotes = (S.replyTo?.quotes ?? []).filter(q => q.who === 'claude' && q.anchor?.startsWith('part:'))
  const add = parts.map(i => ({ who, text: t.parts?.[i]?.text ?? '', key: t.key, anchor: `part:${partId(t, i)}`, topics: t.parts?.[i]?.to ?? [] }))
  const isAll = parts.length > 1
  const has = (a: string) => quotes.some(q => q.anchor === a)
  const next = isAll ? [...quotes.filter(q => !add.some(x => x.anchor === q.anchor)), ...add] : has(add[0]!.anchor) ? quotes.filter(q => q.anchor !== add[0]!.anchor) : [...quotes, add[0]!]
  S.replyTo = next.length ? { quotes: next } : null
  draw()
}

/** The replies you read last, newest first (in the order you read them). */
function readList(): PartRef[] {
  const byId = new Map<string, PartRef>()
  for (const turn of S.turns)
    (turn.parts ?? []).forEach((part, index) => {
      const id = partId(turn, index)
      byId.set(id, { id, turn, index, part, preview: preview(part.text) })
    })
  const out: PartRef[] = []
  const ids = [...S.read]
  for (let i = ids.length - 1; i >= 0 && out.length < 50; i--) {
    const r = byId.get(ids[i]!)
    if (r && S.read.has(r.id)) out.push(r)
  }
  return out
}

/** A message whose reply went missing: asks Claude, quoting it, to write that reply again. */
function askAgain(t: Turn) {
  S.replyTo = { quotes: [{ who: 'me', text: t.text, key: t.key, anchor: `me:${t.key}` }] }
  const id = t.topicId ?? S.kept.board.topics.find(x => x.messageKeys.includes(t.key))?.id
  submit(`Your reply to this message${id ? ` (${id})` : ''} never reached the app: it shows no answer. Please write that reply again${id ? `, as a part starting with <<reply ${id}>>` : ''}.`)
  draw()
}

function react(t: Turn, emoji: string, part?: number) {
  // On one reply part: its own reactions, and Claude hears which part.
  const p = part != null ? t.parts?.[part] : undefined
  const id = p ? `part:${partId(t, part!)}` : `claude:${t.key}`
  const list = S.kept.reactions[id] ?? []
  if (list.some(r => r.emoji === emoji && r.by === 'me')) {
    S.kept.reactions[id] = list.filter(r => !(r.emoji === emoji && r.by === 'me'))
    keep()
    return draw()
  }
  S.kept.reactions[id] = [...list, { emoji, by: 'me' }]
  const answer = p ? p.text : t.answer ?? ''
  const topics = p ? S.kept.board.topics.filter(x => p.to.includes(x.id) || x.messageKeys.some(k => S.turns.some(m => m.key === k && m.topicId && p.to.includes(m.topicId)))) : S.kept.board.topics.filter(x => x.messageKeys.includes(t.key))
  const asking = /\?\s*$/.test(answer.trim()) || topics.some(x => x.status === 'me')
  const signal = reactionSignal(emoji, asking)
  if (signal === 'fyi') S.heard.push(`${emoji} on your message “${preview(answer, 60)}”`)
  else {
    for (const x of topics) x.status = 'claude'
    submit(reactionPrompt(signal, emoji, preview(answer, 200), topics.map(x => x.id)), { reaction: emoji })
    // The reaction is a message about that reply: kept as a link, so Claude's answer to it quotes it.
    const sent = S.turns.at(-1)
    if (sent?.reaction) S.kept.links[sent.key] = { key: t.key, who: 'claude', text: preview(answer, 60), anchor: id.startsWith('part:') ? id : `claude:${t.key}` }
  }
  keep()
  draw()
}

function jump(anchor: string) {
  const at = S.anchors[anchor]
  if (at == null) return toast('That message is hidden by this view. Show Main to see it.')
  // Put it a third of the way down the chat.
  S.chatScroll = Math.max(0, S.chatTotal - at - Math.floor(S.chatRows * 2 / 3))
  draw()
}

// ---- Status line (your own statusLine command, fed what Claude Code would feed it) --------

/** The statusLine command and effort level from your settings (the nearest file that sets each). */
let effortLevel = ''
const statusCommand = (() => {
  for (const f of [`${cwd}/.claude/settings.local.json`, `${cwd}/.claude/settings.json`, `${homedir()}/.claude/settings.json`]) {
    try {
      const s = JSON.parse(readFileSync(f, 'utf8'))
      if (!effortLevel && typeof s.effortLevel === 'string') effortLevel = s.effortLevel
    } catch {}
  }
  for (const f of [`${cwd}/.claude/settings.local.json`, `${cwd}/.claude/settings.json`, `${homedir()}/.claude/settings.json`]) {
    try {
      const s = JSON.parse(readFileSync(f, 'utf8'))
      if (s.statusLine?.command) return String(s.statusLine.command)
    } catch {}
  }
  return ''
})()

const modelName = (id: string) => {
  const m = id.match(/claude-(\w+)-(\d+)-(\d+)/)
  return m ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}` : id || '—'
}

let statusBusy = false
let statusAgain = false
let statusTimer: NodeJS.Timeout | undefined
/** Runs the status line again soon: at most once a second, like Claude Code on each update. */
function statusSoon() {
  if (statusTimer) return
  statusTimer = setTimeout(() => {
    statusTimer = undefined
    refreshStatus()
  }, 1000)
}
// And now and then with nothing happening, for the clock and the "ago" times it shows.
setInterval(() => refreshStatus(), 15_000).unref()
function refreshStatus() {
  if (!statusCommand) return
  if (statusBusy) {
    statusAgain = true
    return
  }
  statusBusy = true
  // What Claude Code reports; before the first reply, a guess from the model's name.
  const size = S.contextWindow || knownWindows[S.model] || (/\[1m\]|1m/.test(S.model) ? 1_000_000 : 200_000)
  const used = (S.usage.input_tokens ?? 0) + (S.usage.cache_read_input_tokens ?? 0) + (S.usage.cache_creation_input_tokens ?? 0)
  const payload = {
    session_id: S.sessionId || 'new',
    prompt_id: S.turns.at(-1)?.key,
    cwd,
    workspace: { current_dir: cwd, project_dir: cwd },
    model: { id: S.model, display_name: modelName(S.model) },
    ...(effortLevel ? { effort: { level: effortLevel } } : {}),
    context_window: { used_percentage: used ? Math.round((used / size) * 100) : 0, context_window_size: size, current_usage: S.usage },
    cost: { total_cost_usd: S.costUsd },
    // The share of the last request read from the cache.
    ...(used ? { prompt_cache: { hit_ratio: (S.usage.cache_read_input_tokens ?? 0) / used } } : {}),
    rate_limits: S.rate,
    permission_mode: S.permissionMode,
  }
  const child = execFile('sh', ['-c', statusCommand], { env: { ...process.env, COLUMNS: String(chatWidth()) }, timeout: 5000 }, (err, stdout) => {
    statusBusy = false
    if (!err) S.statusRows = stdout.replace(/\n+$/, '').split('\n').slice(0, 6)
    draw()
    if (statusAgain) {
      statusAgain = false
      statusSoon()
    }
  })
  child.stdin?.end(JSON.stringify(payload))
}

// ---- Layout ------------------------------------------------------------------------

const out = process.stdout
const width = () => out.columns || 100
const height = () => out.rows || 30
const panelShown = () => width() >= 60
const panelW = () => (!panelShown() ? 0 : S.isFolded ? FOLDED : Math.min(S.panelWidth, Math.floor(width() / 2)))
const chatWidth = () => width() - (panelShown() ? panelW() + 1 : 0)

type Region = { row: number; x0: number; x1: number; action: () => void }

// ---- Selecting text ------------------------------------------------------------------
// A drag in the chat or the input box selects text, and letting go copies it. A press that
// doesn't move stays a click; a double-click selects a word.

type ChatPos = { line: number; col: number }
type Sel = { area: 'chat'; a: ChatPos; b: ChatPos } | { area: 'input'; a: number; b: number }

const IS_WSL = !!process.env.WSL_DISTRO_NAME || /microsoft/i.test((() => { try { return readFileSync('/proc/version', 'utf8') } catch { return '' } })())

/** The chat line and cell under the pointer; with `clamp`, the nearest one (while dragging past an edge). */
function chatPos(x: number, y: number, clamp = false): ChatPos | undefined {
  const top = S.chatTop + 1
  const bottom = S.chatTop + S.chatRows
  if (!clamp && (y < top || y > bottom || x <= S.chatLeft || !S.chatLines.length)) return undefined
  const row = Math.max(top, Math.min(bottom, y))
  const line = Math.max(0, Math.min(S.chatLines.length - 1, S.chatOrigin + (row - 1 - S.chatTop)))
  return { line, col: Math.max(0, x - (S.chatLeft + 2)) }
}

/** The place in the input text under the pointer; with `clamp`, the nearest one. */
function inputPos(x: number, y: number, clamp = false): number | undefined {
  const g = S.inputGeo
  if (!g || !S.text) return undefined
  if (!clamp && (y < g.row || y >= g.row + g.count || x < g.col - 1 || x > g.col + g.inner)) return undefined
  const span = rowSpans(g.inner)[g.first + Math.max(0, Math.min(g.count - 1, y - g.row))]
  if (!span) return undefined
  const col = x - g.col
  let i = span.start
  let cw = 0
  for (const ch of span.chars) {
    const c = charCells(ch)
    if (cw + c > col) break
    cw += c
    i += ch.length
  }
  return i
}

const ordered = (a: ChatPos, b: ChatPos): [ChatPos, ChatPos] => (a.line < b.line || (a.line === b.line && a.col <= b.col) ? [a, b] : [b, a])

/** The cells a chat line has selected, as [from, to). */
function selCells(line: number): [number, number] | undefined {
  if (S.sel?.area !== 'chat') return undefined
  const [p, q] = ordered(S.sel.a, S.sel.b)
  if (line < p.line || line > q.line) return undefined
  return [line === p.line ? p.col : 0, line === q.line ? q.col + 1 : Infinity]
}

/** The selected text. From the chat, without bubble borders and with the common indent removed. */
function selectedText(): string {
  const sel = S.sel
  if (!sel) return ''
  if (sel.area === 'input') return S.text.slice(Math.min(sel.a, sel.b), Math.max(sel.a, sel.b))
  const [p, q] = ordered(sel.a, sel.b)
  let lines: string[] = []
  for (let i = p.line; i <= q.line; i++) {
    const [from, to] = selCells(i)!
    lines.push(cellText(S.chatLines[i] ?? [], from, to))
  }
  if (lines.length > 1 || /[│┃▎╭╮╰╯]/.test(lines[0] ?? '')) {
    lines = lines
      .map(l => l.replace(/^\s*[│┃▎]\s?/, '').replace(/\s?[│┃]\s*$/, '').replace(/\s+$/, ''))
      .filter(l => !l || !(/^[\s─╭╮╰╯]*$/.test(l) || /^\s*[╭╰]─/.test(l)))
    // The common indent, not counting a first line that starts mid-row.
    const rest = p.col > 0 ? lines.slice(1) : lines
    const indent = Math.min(...rest.filter(l => l.trim()).map(l => l.match(/^ */)![0].length))
    if (Number.isFinite(indent)) lines = lines.map((l, i) => (i === 0 && p.col > 0 ? l : l.slice(indent)))
  }
  while (lines.length && !lines[0]!.trim()) lines.shift()
  while (lines.length && !lines.at(-1)!.trim()) lines.pop()
  return lines.join('\n')
}

/** Selects the word (or path, or URL) under the pointer. */
function selectWord(area: 'chat' | 'input', x: number, y: number) {
  const isWord = (ch: string) => /[\p{L}\p{N}_\-./:@~#%+=?&]/u.test(ch)
  if (area === 'input') {
    const i = inputPos(x, y)
    if (i == null) return
    let a = i
    let b = i
    while (a > 0 && isWord(S.text[a - 1]!)) a--
    while (b < S.text.length && isWord(S.text[b]!)) b++
    if (b > a) S.sel = { area: 'input', a, b }
    return
  }
  const at = chatPos(x, y)
  if (!at) return
  const chars: { ch: string; col: number }[] = []
  let col = 0
  for (const sp of S.chatLines[at.line] ?? []) for (const ch of sp.text) { chars.push({ ch, col }); col += charCells(ch) }
  let k = chars.findIndex((c, j) => c.col <= at.col && (chars[j + 1]?.col ?? Infinity) > at.col)
  if (k < 0 || !isWord(chars[k]!.ch)) return
  let a = k
  while (a > 0 && isWord(chars[a - 1]!.ch)) a--
  while (k + 1 < chars.length && isWord(chars[k + 1]!.ch)) k++
  S.sel = { area: 'chat', a: { line: at.line, col: chars[a]!.col }, b: { line: at.line, col: chars[k]!.col + charCells(chars[k]!.ch) - 1 } }
}

/** Removes the selected input text; true when there was some. */
function cutSelection(): boolean {
  if (S.sel?.area !== 'input') return false
  const lo = Math.min(S.sel.a, S.sel.b)
  S.text = S.text.slice(0, lo) + S.text.slice(Math.max(S.sel.a, S.sel.b))
  S.cursor = lo
  S.sel = null
  return true
}

/**
 * Puts text on the system clipboard. OSC 52 asks the terminal (Windows Terminal, kitty, WezTerm; iTerm2 only
 * when allowed in its settings), and the system's own tool does it too: PowerShell from WSL, pbcopy, wl-copy or xclip.
 */
function copyText(text: string, note = 'Copied.') {
  if (!text) return
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  out.write(`\x1b]52;c;${b64}\x07`)
  const pipe = (cmd: string, args: string[]) => {
    try {
      const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] })
      p.on('error', () => {})
      p.stdin.on('error', () => {})
      p.stdin.end(text)
      return true
    } catch {
      return false
    }
  }
  // CLUED_CLIPBOARD=osc52 leaves it to the terminal alone.
  if (process.env.CLUED_CLIPBOARD === 'osc52') {
  } else if (IS_WSL) {
    if (b64.length < 24000) execFile('powershell.exe', ['-NoProfile', '-Command', `Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`], () => {})
  } else if (process.platform === 'darwin') pipe('pbcopy', [])
  else if (process.env.WAYLAND_DISPLAY) pipe('wl-copy', [])
  else if (process.env.DISPLAY) pipe('xclip', ['-selection', 'clipboard'])
  toast(note)
}
let regions: Region[] = []

/** Input lines: the text cut into rows of `w` cells, and where the cursor sits. */
function inputRows(w: number): { rows: string[]; row: number; col: number } {
  const rows: string[] = []
  let row = 0
  let col = 0
  let idx = 0
  const logical = S.text.split('\n')
  for (let li = 0; li < logical.length; li++) {
    const l = logical[li]!
    let cur = ''
    let cw = 0
    const chars = [...l]
    for (let ci = 0; ci <= chars.length; ci++) {
      if (idx === S.cursor) {
        row = rows.length
        col = cw
      }
      if (ci === chars.length) break
      const ch = chars[ci]!
      const c = charCells(ch)
      if (cw + c > w) {
        rows.push(cur)
        cur = ''
        cw = 0
        if (idx === S.cursor) {
          row = rows.length
          col = 0
        }
      }
      cur += ch
      cw += c
      idx += ch.length
    }
    rows.push(cur)
    idx += 1 // the newline
  }
  return { rows, row, col }
}

/** The input box's rows as the box lays them out: where each starts in the text, and its characters. */
function rowSpans(w: number): { start: number; chars: string[] }[] {
  const out: { start: number; chars: string[] }[] = []
  let idx = 0
  for (const l of S.text.split('\n')) {
    let cur = { start: idx, chars: [] as string[] }
    let cw = 0
    for (const ch of [...l]) {
      const c = charCells(ch)
      if (cw + c > w) {
        out.push(cur)
        cur = { start: idx, chars: [] }
        cw = 0
      }
      cur.chars.push(ch)
      cw += c
      idx += ch.length
    }
    out.push(cur)
    idx += 1
  }
  return out
}

/** Moves the cursor one row up or down inside the box, keeping its column; false at the top or bottom row. */
function moveRow(delta: number): boolean {
  const w = S.inputInner
  const { row, col } = inputRows(w)
  const spans = rowSpans(w)
  const to = spans[row + delta]
  if (!to) return false
  let i = to.start
  let cw = 0
  for (const ch of to.chars) {
    const c = charCells(ch)
    if (cw + c > col) break
    cw += c
    i += ch.length
  }
  S.cursor = i
  return true
}

const wordBack = () => (S.cursor = S.text.slice(0, S.cursor).replace(/\S+\s*$/, '').length)
const wordOn = () => {
  const m = S.text.slice(S.cursor).match(/^\s*\S+/)
  S.cursor += m ? m[0].length : 0
}

/**
 * The image on the clipboard, saved as a PNG under ~/.clued/images (the terminal can't paste one):
 * PowerShell on WSL and Windows, osascript on macOS, wl-paste or xclip on Linux.
 */
function clipboardImage(): string | undefined {
  const dir = `${homedir()}/.clued/images`
  mkdirSync(dir, { recursive: true })
  const file = `${dir}/${Date.now()}.png`
  const run = (cmd: string, args: string[], opts: { input?: string } = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000, ...opts })
  const isWsl = IS_WSL
  if (isWsl || process.platform === 'win32') {
    const ps = 'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $i=[Windows.Forms.Clipboard]::GetImage(); if ($i) { $p=[IO.Path]::Combine([IO.Path]::GetTempPath(), "clued-clip.png"); $i.Save($p, [Drawing.Imaging.ImageFormat]::Png); Write-Output $p }'
    const r = run(isWsl ? 'powershell.exe' : 'powershell', ['-NoProfile', '-STA', '-Command', ps])
    const win = r.stdout?.trim()
    if (!win) return undefined
    const src = isWsl ? run('wslpath', ['-u', win]).stdout?.trim() : win
    if (!src || !existsSync(src)) return undefined
    copyFileSync(src, file)
    return file
  }
  if (process.platform === 'darwin') {
    const r = run('osascript', ['-e', 'set d to (the clipboard as «class PNGf»)', '-e', `set f to open for access POSIX file "${file}" with write permission`, '-e', 'write d to f', '-e', 'close access f'])
    return r.status === 0 && existsSync(file) ? file : undefined
  }
  for (const [cmd, args] of [['wl-paste', ['--type', 'image/png']], ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']]] as const) {
    const r = spawnSync(cmd, [...args], { timeout: 10000 })
    if (r.status === 0 && r.stdout?.length) {
      writeFileSync(file, r.stdout)
      return file
    }
  }
  return undefined
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

/** Adds an image to the next message, as `[image N]` at the cursor. */
function attachImage(path: string) {
  const ext = path.split('.').pop()!.toLowerCase()
  S.images.push({ path, media: IMAGE_TYPES[ext] ?? 'image/png' })
  insert(`[image ${S.images.length}] `)
  toast('Image added: it goes with your next message.')
}

/** A pasted or dropped path to an image file (possibly quoted or with escaped spaces), else undefined. */
function imagePath(text: string): string | undefined {
  let p = text.trim().replace(/^['"]|['"]$/g, '').replace(/\\ /g, ' ')
  if (/^[a-zA-Z]:\\/.test(p)) p = spawnSync('wslpath', ['-u', p], { encoding: 'utf8' }).stdout?.trim() || p
  if (p.startsWith('~/')) p = `${homedir()}${p.slice(1)}`
  return /\.(png|jpe?g|gif|webp)$/i.test(p) && !p.includes('\n') && existsSync(p) ? p : undefined
}

function menuItems(): string[] {
  if (S.search) return []
  const m = S.text.match(/^\/(\S*)$/)
  if (!m) return []
  const all = [...new Set([...OUR_COMMANDS, ...S.commands])]
  return all.filter(c => c.startsWith(m[1]!)).sort((a, b) => a.length - b.length).slice(0, 8)
}

function bottomLines(w: number): { lines: Line[]; cursor?: { row: number; col: number }; textRow?: number; first?: number; count?: number; inner?: number } {
  const L: Line[] = []
  // Permission prompt
  const perm = S.permissions[0]
  if (perm) {
    const what = String(perm.input.command ?? perm.input.file_path ?? perm.input.url ?? perm.input.pattern ?? JSON.stringify(perm.input))
    L.push([{ text: '╭─ ', style: { fg: C.yellow } }, { text: `Claude wants to use ${perm.tool}`, style: { fg: C.yellow, bold: true } }])
    // What it says the command does, then the whole command, wrapped (long ones up to half the screen).
    const about = typeof perm.input.description === 'string' ? perm.input.description : ''
    if (about) for (const l of wrap([{ text: about, style: { fg: C.gray, italic: true } }], w - 4)) L.push([{ text: '│ ', style: { fg: C.yellow } }, ...l])
    const rows = what.split('\n').flatMap(line => wrap([{ text: line }], w - 4))
    const room = Math.max(4, Math.floor(height() / 2) - 6)
    const shown = rows.length > room ? rows.slice(0, room - 1) : rows
    for (const l of shown) L.push([{ text: '│ ', style: { fg: C.yellow } }, ...(l.length ? l : [{ text: '' }])])
    if (shown.length < rows.length) L.push([{ text: '│ ', style: { fg: C.yellow } }, { text: `… ${rows.length - shown.length} more lines  `, style: { fg: C.gray } }, { text: '⧉ copy all', style: { fg: C.cyan }, action: () => copyText(what, 'Copied the whole command.') }])
    L.push([
      { text: '╰─ ', style: { fg: C.yellow } },
      { text: ' Allow (y) ', style: { bg: C.green, fg: 16, bold: true }, action: () => answerPermission(true) },
      pad(2),
      { text: ' Deny (n) ', style: { bg: C.red, fg: 16, bold: true }, action: () => answerPermission(false) },
    ])
  }
  // Slash menu
  const items = menuItems()
  if (items.length && !perm) {
    S.menuAt = Math.min(S.menuAt, items.length - 1)
    items.forEach((c, i) =>
      L.push([{ text: ` /${c} `, style: i === S.menuAt ? { inverse: true, fg: C.cyan } : { fg: C.gray }, action: () => { S.text = `/${c} `; S.cursor = S.text.length; draw() } }]),
    )
  }
  if (S.toast) L.push([{ text: ` ${S.toast}`, style: { fg: C.yellow } }])
  // Reply bar
  if (S.replyTo) {
    const r = S.replyTo
    const who = r.quotes[0]?.who === 'claude' ? 'Claude' : 'yourself'
    const tail: Span[] = [{ text: '  ✕', style: { bold: true }, action: () => { S.replyTo = null; draw() } }]
    const many = r.quotes.length > 1
    const lead: Span[] = [{ text: '▎', style: { fg: C.cyan } }, { text: many ? ` ↩ Replying to ${r.quotes.length} of Claude's replies ` : ` ↩ Replying to ${who} `, style: { fg: C.cyan, bold: true } }]
    const room = w - lineCells(lead) - lineCells(tail) - 1
    // Replying to one of several parts: say that ↩ on the others adds them (in the same row, so nothing moves).
    const hint = !many && r.quotes[0]?.anchor?.startsWith('part:') ? '  ↩ others to add them' : ''
    const q = clip(r.quotes.map(x => (many ? `“${preview(x.text, 40)}”` : preview(x.text, 300))).join(' · '), Math.max(8, room - cells(hint)))
    const h = clip(hint, room - cells(q))
    L.push([...lead, { text: q, style: { fg: C.gray, italic: true } }, { text: h, style: { fg: C.faint } }, pad(room - cells(q) - cells(h)), ...tail])
  }
  // Input box
  const inner = w - 4
  S.inputInner = inner
  const { rows, row, col } = inputRows(inner)
  const maxRows = 8
  const first = Math.max(0, Math.min(row - maxRows + 1, rows.length - maxRows))
  const shown = rows.slice(first, first + maxRows)
  // Inside an agent the box is magenta and says so in its border, so you always know where you are writing.
  const inside = S.agentView ? S.agents.get(S.agentView) : undefined
  const req = S.requestView ? S.turns.findLast(t => t.key === S.requestView) : undefined
  const border = { fg: S.search ? C.yellow : req ? C.blue : inside ? C.magenta : S.isWorking ? C.faint : C.cyan }
  const label = S.search ? ' ⌕ search your messages ' : req ? ` ▣ in request ${req.topicId ?? ''}: ${clip(preview(req.text, 60), Math.max(6, w - 30))} ` : inside ? ` ◇ to ${who(inside, S.agents.values())}: ${clip(inside.name, Math.max(6, w - 40))} ` : ''
  L.push(label ? [{ text: '╭─', style: border }, { text: label, style: { fg: S.search ? C.yellow : req ? C.blue : C.magenta, bold: true } }, { text: '─'.repeat(Math.max(0, w - 4 - cells(label))) + '╮', style: border }] : [{ text: '╭' + '─'.repeat(w - 2) + '╮', style: border }])
  const top = L.length
  const placeholder = S.search ? 'Type to search your messages   (↑↓ through the matches · Enter go to it · Esc done)' : req ? 'Add to this request, or ask about it   (Esc back to chat)' : inside ? 'Ask Claude about this agent, or have it continue   (Esc back to chat)' : S.isWorking ? 'Claude is working… you can still send a message (Esc to interrupt)' : 'Message Claude   (/ commands · Alt+Enter new line · Esc cancels a reply)'
  const spans = S.sel?.area === 'input' ? rowSpans(inner) : []
  shown.forEach((r, i) => {
    const text = !S.text && i === 0 ? clip(placeholder, inner) : r
    let body: Line = [{ text, style: !S.text ? { fg: C.faint } : {} }]
    // The selected part of this row, in cells.
    const span = spans[first + i]
    if (span && S.sel?.area === 'input') {
      const lo = Math.min(S.sel.a, S.sel.b)
      const hi = Math.max(S.sel.a, S.sel.b)
      let idx = span.start
      let at = 0
      let from = -1
      let to = -1
      for (const ch of span.chars) {
        if (idx >= lo && idx < hi) {
          if (from < 0) from = at
          to = at + charCells(ch)
        }
        at += charCells(ch)
        idx += ch.length
      }
      if (from >= 0) body = markCells(body, from, to)
    }
    L.push([{ text: '│ ', style: border }, ...body, pad(inner - cells(text)), { text: ' │', style: border }])
  })
  L.push([{ text: '╰' + '─'.repeat(w - 2) + '╯', style: border }])
  const cursor = { row: top + (row - first), col: 2 + col }
  return { lines: L, cursor, textRow: top, first, count: shown.length, inner }
}

// ---- Drawing -----------------------------------------------------------------------

let drawQueued = false
function draw() {
  if (drawQueued) return
  drawQueued = true
  setImmediate(paint)
}

function lineText(line: Line, w: number, row: number, x: number): string {
  let s = ''
  let used = 0
  for (const sp of clipLine(line, w)) {
    const cw = cells(sp.text)
    if (sp.action && cw) regions.push({ row, x0: x + used + 1, x1: x + used + cw, action: sp.action })
    s += sgr(sp.style) + sp.text
    used += cw
  }
  return s + sgr() + ' '.repeat(Math.max(0, w - used))
}

function paint() {
  drawQueued = false
  if (quitting) return
  const W = width()
  const H = height()
  regions = []
  const frame: string[] = Array.from({ length: H }, () => '')
  const pw = panelW()
  const cx = panelShown() ? pw + 1 : 0
  const cw = W - cx

  if (S.picker) return paintPicker(W, H)
  const busy = new Set([...S.agents.values()].filter(a => a.state === 'running').flatMap(a => a.for))
  const reacted = new Set(Object.entries(S.kept.reactions).filter(([, l]) => l.some(r => r.by === 'claude')).map(([k]) => k))
  S.box = inbox(S.turns, S.kept.board, S.read, { isWorking: S.isWorking, busy, now: Date.now(), reacted })
  notifyNewQuestions()
  markTab()
  // Sorted by what moved last, but never reordered under the pointer or during a search: the new
  // order shows once you leave the panel. A message not in the old order goes on top.
  if ((S.isOnPanel || S.search) && S.recentOrder.length) {
    const at = new Map(S.recentOrder.map((k, i) => [k, i]))
    const rank = (k: string) => at.get(k) ?? -1
    S.box.messages.sort((a, b) => rank(a.turn.key) - rank(b.turn.key))
  } else S.recentOrder = S.box.messages.map(m => m.turn.key)
  chainCache = new Map()
  const lostTurns = new Set(S.box.messages.filter(m => m.state === 'lost').map(m => m.turn))
  const replyByTurn = new Map(S.box.messages.filter(m => m.replyId).map(m => [m.turn, m.replyId!]))

  // Left: the panel, its head pinned, the rest scrolled.
  if (panelShown()) {
    const { lines, head, lists } = panelLines(
      {
        isResultsOnly: S.isResultsOnly,
        isWorking: S.isWorking,
        isFolded: S.isFolded,
        hscroll: S.hscroll,
        results: () => { S.isResultsOnly = !S.isResultsOnly; draw() },
        fold: folded => { S.isFolded = folded; savePrefs(); draw() },
        readParts: ids => setRead(ids, true),
        unreadParts: ids => setRead(ids, false),
        isReadTab: S.isReadTab,
        readTab: on => { S.isReadTab = on; S.listAt.read = 0; draw() },
        readList: S.isReadTab ? readList() : [],
        work: S.kept.work ?? 'folded',
        setWork: w => { setWork(w); draw() },
        agents: [...S.agents.values()],
        main: S.isWorking ? { for: S.turns.filter(x => !x.isDone && !x.reaction).flatMap(x => x.followUp ?? [x.key]), last: (() => { const s = openTurn()?.steps.at(-1); return s ? stepLabel(s, cwd).text : 'thinking' })() } : undefined,
        turnOf: key => S.turns.findLast(x => x.key === key),
        openAgent,
        agentView: S.agentView,
        openRequest,
        requestView: S.requestView,
        scroll: S.listAt,
        height: H,
        side: d => { S.hscroll = Math.max(0, S.hscroll + d); draw() },
        box: S.box,
        openPart,
        dismiss,
        openMessage,
        openWork,
        picked: S.picked,
        query: S.search ? S.text : null,
        search: startSearch,
        isLegend: S.isLegend,
        legend: () => { S.isLegend = !S.isLegend; draw() },
        jumpTo,
        next: nextUnread,
      },
      pw,
    )
    const body = lines.slice(head)
    const room = H - head
    S.panelHead = head
    S.panelLists = lists ?? {}
    S.panelScroll = Math.max(0, Math.min(S.panelScroll, body.length - room))
    const shown = [...lines.slice(0, head), ...body.slice(S.panelScroll, S.panelScroll + room)]
    for (let r = 0; r < H; r++) frame[r] = lineText(shown[r] ?? [], pw, r + 1, 0) + `${sgr({ fg: S.dragging ? C.cyan : C.faint })}│${sgr()}`
    regions.push({ row: -1, x0: pw + 1, x1: pw + 1, action: () => {} }) // the divider (drag)
  }

  // Right, bottom up: status line, input, reply bar, prompts; the chat above.
  const status = S.statusRows.length ? S.statusRows : [`${sgr({ fg: C.gray })} ${modelName(S.model)}  ${S.sessionId ? S.sessionId.slice(0, 8) : 'new session'}${sgr()}`]
  const bottom = bottomLines(cw - 1)
  // Inside an agent: a pinned banner says so, with the message it works on and the way back.
  const inside = S.agentView === MAIN ? mainAgent() : S.agentView ? S.agents.get(S.agentView) : undefined
  if (S.agentView && !inside) S.agentView = ''
  const isMain = S.agentView === MAIN
  const insideFor = inside ? inside.for.map(k => S.turns.findLast(t => t.key === k)).filter((t): t is Turn => !!t) : []
  const req = S.requestView ? S.turns.findLast(t => t.key === S.requestView) : undefined
  if (S.requestView && !req) S.requestView = ''
  const reqInfo = req ? requestInfo(req) : undefined
  const banner: Line | undefined = req && reqInfo
    ? [
        { text: ` ▣ Request ${req.topicId ?? ''} `, style: { bg: C.blue, fg: 16, bold: true } },
        { text: ` ${reqInfo.mark} ${reqInfo.state}  `, style: { fg: reqInfo.isStale ? C.yellow : C.cyan, bold: true } },
        { text: `“${preview(req.text, 50)}”`, style: { fg: C.gray, underline: true }, action: () => openMessage(req) },
        { text: '  · ', style: { fg: C.faint } },
        { text: '← back to chat', style: { fg: C.cyan, bold: true }, action: closeAgent },
      ]
    : inside
    ? [
        isMain
          ? { text: ` ✻ Claude, live${inside.state === 'running' ? '' : ` · ${inside.state}`} `, style: { bg: C.claude, fg: 231, bold: true } }
          : { text: ` ◇ ${who(inside, S.agents.values())} · ${clip(inside.name, 40)} `, style: { bg: C.magenta, fg: 16, bold: true } },
        ...(insideFor[0] ? [{ text: '  ↳ ', style: { fg: C.gray } }, { text: `“${preview(insideFor[0].text, 50)}”`, style: { fg: C.gray, underline: true }, action: () => openMessage(insideFor[0]!) }] : []),
        { text: '  · ', style: { fg: C.faint } },
        { text: '← back to chat', style: { fg: C.cyan, bold: true }, action: closeAgent },
      ]
    : undefined
  const top = banner ? 1 : 0
  S.chatTop = top
  const chatRows = Math.max(3, H - status.length - bottom.lines.length - top)
  const ctx: Parameters<typeof chatLines>[0] = {
      turns: S.turns,
      kept: S.kept,
      isResultsOnly: S.isResultsOnly,
      picked: S.picked,
      cwd,
      now: Date.now(),
      spin: SPIN[S.spinAt % SPIN.length]!,
      toggle: t => { t.isOpen = !t.isOpen; draw() },
      reply: replyTo,
      replying: new Set((S.replyTo?.quotes ?? []).map(q => q.anchor ?? '')),
      react,
      jump,
      copy: text => copyText(text),
      hover: S.hover,
      unread: new Set(S.box.unread.map(p => p.id)),
      waiting: new Set(S.box.waiting.map(p => p.id)),
      // The topic's latest message sent before this answer (a topic can hold several).
      messageOf: (id, answering) => {
        const upTo = S.turns.indexOf(answering)
        const before = S.turns.slice(0, upTo + 1)
        // The message given that id; else (older ones) the topic's latest message before this answer.
        const own = before.findLast(t => t.topicId === id) ?? S.turns.find(t => t.topicId === id)
        if (own) return own
        const keys = new Set(S.kept.board.topics.find(t => t.id === id)?.messageKeys ?? [])
        return before.findLast(t => keys.has(t.key)) ?? S.turns.find(t => keys.has(t.key))
      },
      replyOf: t => replyByTurn.get(t),
      isLost: t => lostTurns.has(t),
      chainOf: chainSize,
      openChain: openRequest,
      askAgain,
      work: S.kept.work ?? 'folded',
      poke: draw,
      isWorking: S.isWorking,
      agentName: id => { const a = S.agents.get(id); return a ? `${who(a, S.agents.values())} · ${a.name}` : undefined },
      openAgent,
      setRead,
      dismiss,
  }
  const { lines: chat, anchors, owners } = req && reqInfo
    ? requestLines(req, reqInfo, { ...ctx, askStatus: () => submit('What is the status of this request?') }, cw - 2)
    : inside ? agentLines(inside, S.turns.filter(t => t.aboutAgent === inside.id), ctx, cw - 2) : chatLines(ctx, cw - 2)
  S.anchors = anchors
  S.owners = owners
  S.chatLines = chat
  S.chatLeft = cx
  S.chatTotal = chat.length
  S.chatRows = chatRows
  if (S.pendingJump) {
    const at = anchors[S.pendingJump]
    S.pendingJump = ''
    if (at == null) setImmediate(() => toast('Couldn\'t find that message in this view.'))
    else S.chatScroll = Math.max(0, chat.length - at - Math.floor((chatRows * 2) / 3))
  }
  S.chatScroll = Math.max(0, Math.min(S.chatScroll, chat.length - chatRows))
  const endAt = chat.length - S.chatScroll
  const view = chat.slice(Math.max(0, endAt - chatRows), endAt)
  const lead = chatRows - view.length
  const viewStart = Math.max(0, endAt - chatRows)
  S.chatOrigin = viewStart - lead
  // Unread replies on screen: note which of their lines are in view (the timer adds the time).
  S.inView = new Set()
  for (const p of S.box.unread) {
    const a = anchors[`part:${p.id}`]
    const b = anchors[`partEnd:${p.id}`]
    if (a == null || b == null || a >= endAt || b <= viewStart) continue
    const rec = S.seen.get(p.id) ?? { lines: new Set<number>(), ms: 0, total: 0, words: 0 }
    rec.total = b - a
    rec.words = p.part.text.split(/\s+/).filter(Boolean).length
    for (let i = Math.max(a, viewStart); i < Math.min(b, endAt); i++) rec.lines.add(i - a)
    S.seen.set(p.id, rec)
    S.inView.add(p.id)
  }
  if (banner) frame[0] += ' ' + lineText(banner, cw - 1, 1, cx + 1)
  if (!S.turns.length) {
    const hello = [
      [{ text: 'clued', style: { bold: true, fg: C.cyan } }, { text: `  on Claude Code · ${cwd.replace(homedir(), '~')}`, style: { fg: C.gray } }],
      [{ text: 'Your messages sit on the right, Claude\'s answers on the left, its work folded into one line.', style: { fg: C.gray } }],
      [{ text: 'Click ↩ reply or a reaction under any message. Unread replies and your messages are on the left.', style: { fg: C.gray } }],
    ] as Line[]
    hello.forEach((l, i) => (frame[i + 1 + top] += ' ' + lineText(l, cw - 1, i + 2 + top, cx + 1)))
    for (let r = 0; r < chatRows; r++) if (r < 1 || r > 3) frame[r + top] += ' '.repeat(cw)
  } else
    for (let r = 0; r < chatRows; r++) {
      const line = r >= lead ? view[r - lead]! : []
      const marked = r >= lead ? selCells(viewStart + r - lead) : undefined
      frame[r + top] += ' ' + lineText(marked ? markCells(line, marked[0], marked[1]) : line, cw - 1, r + top + 1, cx + 1)
    }
  // A scrolled-up chat says so.
  if (S.chatScroll > 0) {
    const tag = ` ↓ ${S.chatScroll} more lines `
    regions.unshift({ row: chatRows + top, x0: cx + cw - cells(tag), x1: cx + cw, action: () => { S.chatScroll = 0; draw() } })
    overlays.push({ row: chatRows + top, col: cx + cw - cells(tag) + 1, text: `${sgr({ inverse: true, fg: C.cyan })}${tag}${sgr()}` })
  }
  bottom.lines.forEach((l, i) => (frame[top + chatRows + i] += ' ' + lineText(l, cw - 1, top + chatRows + i + 1, cx + 1)))
  S.inputGeo = bottom.textRow == null ? null : { row: top + chatRows + bottom.textRow + 1, col: cx + 4, first: bottom.first!, count: bottom.count!, inner: bottom.inner! }
  status.forEach((s, i) => (frame[top + chatRows + bottom.lines.length + i] += `${s}${sgr()}\x1b[K`))

  let buf = '\x1b[?2026h\x1b[?25l\x1b[H'
  for (let r = 0; r < H; r++) buf += `\x1b[${r + 1};1H` + frame[r] + (frame[r]!.includes('\x1b[K') ? '' : '\x1b[K')
  for (const o of overlays) buf += `\x1b[${o.row};${o.col}H${o.text}`
  overlays.length = 0
  if (bottom.cursor && !S.permissions.length) {
    const cr = top + chatRows + bottom.cursor.row + 1
    const cc = cx + 1 + bottom.cursor.col + 1
    buf += `\x1b[${cr};${cc}H\x1b[?25h`
  }
  buf += '\x1b[?2026l'
  out.write(buf)
}

const overlays: { row: number; col: number; text: string }[] = []

function paintPicker(W: number, H: number) {
  const p = S.picker!
  const L: Line[] = [
    [{ text: ' Resume a session', style: { bold: true, fg: C.cyan } }, { text: `   ${cwd.replace(homedir(), '~')}`, style: { fg: C.gray } }],
    [{ text: ' ↑↓ choose · Enter open · Esc new session', style: { fg: C.faint } }],
    [],
  ]
  const ago = (ms: number) => {
    const m = Math.round((Date.now() - ms) / 60000)
    return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
  }
  const room = H - L.length
  const first = Math.max(0, Math.min(p.at - Math.floor(room / 2), p.sessions.length - room))
  p.sessions.slice(Math.max(0, first), Math.max(0, first) + room).forEach((s, i) => {
    const idx = Math.max(0, first) + i
    const on = idx === p.at
    const open = () => { S.picker = null; start(s.id) }
    L.push([
      { text: on ? ' ▸ ' : '   ', style: { fg: C.cyan }, action: open },
      { text: clip(s.title, W - 20), style: on ? { bold: true, fg: C.cyan } : {}, action: open },
      { text: `  ${ago(s.mtime)}`, style: { fg: C.gray }, action: open },
    ])
  })
  let buf = '\x1b[?2026h\x1b[?25l'
  for (let r = 0; r < H; r++) buf += `\x1b[${r + 1};1H` + lineText(L[r] ?? [], W, r + 1, 0)
  out.write(buf + '\x1b[?2026l')
}

// ---- Input -------------------------------------------------------------------------

function answerPermission(allow: boolean) {
  const p = S.permissions.shift()
  if (p) S.claude?.answerPermission(p.requestId, allow, p.input)
  draw()
}

function insert(s: string) {
  cutSelection()
  S.text = S.text.slice(0, S.cursor) + s + S.text.slice(S.cursor)
  S.cursor += s.length
  S.historyAt = -1
}

const prevChar = (i: number) => {
  const cp = S.text.codePointAt(i - 2)
  return cp != null && cp > 0xffff ? 2 : 1
}

function runCommand(text: string): boolean {
  const [cmd, ...rest] = text.slice(1).split(/\s+/)
  const arg = rest.join(' ').trim()
  switch (cmd) {
    case 'exit':
    case 'quit':
      quit()
      return true
    case 'reload':
      // bin/clued starts the app again on this session when it exits with 75.
      quit(75)
      return true
    case 'clear':
      start()
      toast('New session.')
      return true
    case 'resume':
      S.picker = { sessions: listSessions(cwd), at: 0 }
      draw()
      return true
    case 'model':
      if (!arg) return toast('Usage: /model opus | sonnet | haiku | <model id>'), true
      for (let i = passArgs.indexOf('--model'); i >= 0; i = passArgs.indexOf('--model')) passArgs.splice(i, 2)
      passArgs.push('--model', arg)
      start(S.sessionId || undefined)
      toast(`Model: ${arg}`)
      return true
    case 'results':
      S.isResultsOnly = !S.isResultsOnly
      draw()
      return true
    case 'demo':
      S.isDemo = arg === 'off' ? false : arg === 'on' ? true : !S.isDemo
      // Your last 3 messages get some at once, and every message you send from now on.
      if (S.isDemo) for (const t of S.turns.filter(x => !x.reaction && !x.text.startsWith('/')).slice(-3)) demoAgents(t)
      toast(S.isDemo ? 'Demo on: fake agents on your last 3 messages and the next ones (drawn only, no tokens). /demo again to stop.' : 'Demo off.')
      return true
    case 'work': {
      // /work folded|edits|all, or /work alone to go round them.
      const order: Work[] = ['folded', 'edits', 'all']
      const want = arg.trim() as Work
      setWork(order.includes(want) ? want : order[(order.indexOf(S.kept.work ?? 'folded') + 1) % 3]!)
      draw()
      return true
    }
    case 'notify': {
      // /notify on|always|off, or /notify alone to go round them.
      if (arg.trim() === 'test') {
        notify('Claude asks you · test', 'This is how a question from Claude will look.')
        toast('Sent a test notification.')
        return true
      }
      const order: Notify[] = ['on', 'always', 'off']
      const want = arg.trim() as Notify
      notifyMode = order.includes(want) ? want : order[(order.indexOf(notifyMode) + 1) % 3]!
      savePrefs()
      toast(notifyMode === 'off' ? 'Notifications off.' : notifyMode === 'always' ? 'You get a notification for every question Claude asks.' : 'You get a notification when Claude asks something while this window is in the background.')
      draw()
      return true
    }
    case 'panel':
    case 'threads':
      S.isFolded = !S.isFolded
      savePrefs()
      draw()
      return true
  }
  return false
}

function enter() {
  const items = menuItems()
  let text = S.text
  if (items.length && !items.includes(text.slice(1).trim())) text = `/${items[S.menuAt] ?? items[0]}`
  text = text.replace(/\s+$/, '')
  if (!text.trim()) return
  S.history.push(text)
  S.historyAt = -1
  S.text = ''
  S.cursor = 0
  S.menuAt = 0
  if (text.startsWith('/') && runCommand(text)) return
  submit(text)
}

function key(k: string) {
  // The window gained or lost focus (unread replies only count as read while you are looking).
  if (k === '\x1b[I' || k === '\x1b[O') {
    S.isFocused = k === '\x1b[I'
    // Gone from the window: the pointer is no longer on the panel, so your messages may reorder.
    if (!S.isFocused && S.isOnPanel) {
      S.isOnPanel = false
      draw()
    }
    return
  }
  S.quitArmed = k === '\x03' ? S.quitArmed : false
  // With text selected: Ctrl+C copies it, Esc drops it, typing or Backspace replaces it in the input box.
  if (S.sel) {
    if (k === '\x03') {
      copyText(selectedText())
      S.sel = null
      return draw()
    }
    if (k === '\x1b') {
      S.sel = null
      return draw()
    }
    if (k === '\x7f' || k === '\b' || k === '\x1b[3~') {
      if (cutSelection()) return draw()
    }
    if (S.sel?.area !== 'input' || k.startsWith('\x1b') || k < ' ') S.sel = null
  }
  if (S.picker) {
    const p = S.picker
    if (k === '\x1b[A') p.at = Math.max(0, p.at - 1)
    else if (k === '\x1b[B') p.at = Math.min(p.sessions.length - 1, p.at + 1)
    else if (k === '\r') {
      const s = p.sessions[p.at]
      S.picker = null
      start(s?.id)
    } else if (k === '\x1b' || k === '\x03') {
      S.picker = null
      if (!S.claude) start()
    }
    return draw()
  }
  if (S.permissions.length && (k === 'y' || k === 'Y' || k === 'n' || k === 'N')) return answerPermission(k.toLowerCase() === 'y')

  const items = menuItems()
  switch (k) {
    case '\r':
      logSend('enter', { text: S.text, ...(S.search ? { mode: 'search' } : S.permissions.length ? { mode: 'permission' } : {}) })
      if (S.search) {
        const list = recentList()
        const m = list.find(x => x.turn.key === S.picked) ?? list[0]
        if (!m) return toast('No message matches.')
        return jumpTo(m.turn)
      }
      return enter(), draw()
    case '\x1b\r':
    case '\n':
      insert('\n')
      break
    case '\x7f':
    case '\b':
      if (S.cursor > 0) {
        const n = prevChar(S.cursor)
        S.text = S.text.slice(0, S.cursor - n) + S.text.slice(S.cursor)
        S.cursor -= n
      }
      break
    case '\x1b[3~':
      S.text = S.text.slice(0, S.cursor) + S.text.slice(S.cursor + 1)
      break
    case '\x1b[D':
      S.cursor = Math.max(0, S.cursor - prevChar(S.cursor))
      break
    case '\x1b[C':
      S.cursor = Math.min(S.text.length, S.cursor + ((S.text.codePointAt(S.cursor) ?? 0) > 0xffff ? 2 : 1))
      break
    case '\x1b[H':
    case '\x01':
      S.cursor = S.text.lastIndexOf('\n', S.cursor - 1) + 1
      break
    case '\x1b[F':
    case '\x05': {
      const e = S.text.indexOf('\n', S.cursor)
      S.cursor = e < 0 ? S.text.length : e
      break
    }
    case '\x15':
      S.text = S.text.slice(S.cursor)
      S.cursor = 0
      break
    case '\x0b':
      S.text = S.text.slice(0, S.cursor)
      break
    case '\x17': {
      const before = S.text.slice(0, S.cursor).replace(/\S+\s*$/, '')
      S.text = before + S.text.slice(S.cursor)
      S.cursor = before.length
      break
    }
    case '\x1b[1;3A':
    case '\x1b[1;9A':
    case '\x1b[1;5A':
    case '\x1b\x1b[A':
      pickMessage(-1)
      break
    case '\x1b[1;3B':
    case '\x1b[1;9B':
    case '\x1b[1;5B':
    case '\x1b\x1b[B':
      pickMessage(1)
      break
    case '\x1bb':
    case '\x1b[1;3D':
      // On a message (Alt+↑/↓) with nothing typed: back to it. Otherwise a word back.
      if (S.picked && (!S.text || S.search)) {
        const m = S.box.messages.find(x => x.turn.key === S.picked)
        if (m) openMessage(m.turn)
        break
      }
      S.cursor = S.text.slice(0, S.cursor).replace(/\S+\s*$/, '').length
      break
    case '\x1bf':
    case '\x1b[1;3C': {
      // On a message with nothing typed: its reply. Otherwise a word on.
      if (S.picked && (!S.text || S.search)) {
        openPickedReply()
        break
      }
      const m = S.text.slice(S.cursor).match(/^\s*\S+/)
      S.cursor += m ? m[0].length : 0
      break
    }
    case '\x1b[A':
      // Searching: the arrows go up and down the matches, as the panel lists them.
      if (S.search) pickMessage(-1)
      else if (items.length) S.menuAt = Math.max(0, S.menuAt - 1)
      // Inside a message of several rows the arrows move between them; from the top row, your earlier messages.
      else if (moveRow(-1)) {}
      else if (S.history.length) {
        S.historyAt = S.historyAt < 0 ? S.history.length - 1 : Math.max(0, S.historyAt - 1)
        S.text = S.history[S.historyAt]!
        S.cursor = S.text.length
      }
      break
    case '\x1b[B':
      if (S.search) pickMessage(1)
      else if (items.length) S.menuAt = Math.min(items.length - 1, S.menuAt + 1)
      else if (moveRow(1)) {}
      else if (S.historyAt >= 0) {
        S.historyAt++
        S.text = S.history[S.historyAt] ?? ''
        if (S.historyAt >= S.history.length) S.historyAt = -1
        S.cursor = S.text.length
      }
      break
    case '\t':
      if (items.length) {
        S.text = `/${items[S.menuAt]} `
        S.cursor = S.text.length
      }
      break
    case '\x1b[5~':
      S.chatScroll += Math.max(3, S.chatRows - 3)
      break
    case '\x1b[6~':
      S.chatScroll = Math.max(0, S.chatScroll - Math.max(3, S.chatRows - 3))
      break
    case '\x1b[1;5D':
      // Ctrl+←/→: a word back or on (Windows Terminal and most Linux terminals send these).
      wordBack()
      break
    case '\x1b[1;5C':
      wordOn()
      break
    case '\x16':
    case '\x1bv': {
      // Ctrl+V or Alt+V: an image on the clipboard (text pastes come through the terminal's own paste).
      const img = clipboardImage()
      if (img) attachImage(img)
      else toast('No image on the clipboard. Text pastes with your terminal\'s paste key.')
      break
    }
    case '\x06':
      // Ctrl+F: search your messages.
      startSearch()
      break
    case '\x0e':
      // Ctrl+N: the next reply you haven't read.
      nextUnread()
      break
    case '\x0f': {
      // Ctrl+O: open or close the last turn's steps.
      const t = S.turns.findLast(x => x.steps.length)
      if (t) t.isOpen = !t.isOpen
      break
    }
    case '\x1b':
      if (S.search) endSearch()
      else if (items.length) {
        S.text = ''
        S.cursor = 0
      } else if (S.replyTo) S.replyTo = null
      else if (S.picked) S.picked = ''
      else if (S.agentView || S.requestView) closeAgent()
      else if (S.isWorking) {
        S.claude?.interrupt()
        toast('Interrupted.')
      }
      break
    case '\x03':
      if (S.text) {
        S.text = ''
        S.cursor = 0
      } else if (S.isWorking) {
        S.claude?.interrupt()
        toast('Interrupted.')
      } else if (S.quitArmed) return quit()
      else {
        S.quitArmed = true
        toast('Press Ctrl+C again to quit.')
      }
      break
    case '\x04':
      if (!S.text) return quit()
      break
    default:
      if (k >= ' ' || k.length > 1) {
        if (!k.startsWith('\x1b')) insert(k)
      }
  }
  draw()
}

function mouse(b: number, x: number, y: number, isPress: boolean) {
  const pw = panelW()
  // Pointer moves (no button held): which message is under it.
  if (b === 35) {
    const onPanel = panelShown() && x <= pw
    if (onPanel !== S.isOnPanel) {
      S.isOnPanel = onPanel
      draw()
    }
    const owner = x > S.chatLeft && y > S.chatTop && y <= S.chatTop + S.chatRows ? (S.owners[y - 1 - S.chatTop + S.chatOrigin] ?? '') : ''
    if (owner !== S.hover) {
      S.hover = owner
      draw()
    }
    return
  }
  // Drag the divider to resize the panel.
  if (b === 0 && isPress && panelShown() && !S.isFolded && x === pw + 1) {
    S.dragging = true
    return draw()
  }
  if (S.dragging) {
    if (b === 32 || (b === 0 && isPress)) {
      S.panelWidth = Math.max(MIN_FULL, Math.min(Math.floor(width() / 2), x - 1))
    } else {
      S.dragging = false
      savePrefs()
    }
    return draw()
  }
  if (b === 64 || b === 65) {
    const d = b === 64 ? 3 : -3
    if (panelShown() && x <= pw) {
      const line = y - 1 < S.panelHead ? -1 : S.panelHead + S.panelScroll + (y - 1 - S.panelHead)
      // Over a section the wheel moves that section's box (a row at a time in small ones).
      const hit = Object.entries(S.panelLists).find(([, l]) => line >= l.start && line < l.end)
      if (hit) {
        const [id, l] = hit
        const step = (l.max > 6 ? 3 : 1) * Math.sign(d)
        S.listAt[id] = Math.max(0, Math.min(l.total - l.max, (S.listAt[id] ?? 0) - step))
      } else S.panelScroll = Math.max(0, S.panelScroll - d)
    }
    else S.chatScroll = Math.max(0, S.chatScroll + d)
    return draw()
  }
  if (b === 66 || b === 68) {
    S.hscroll = Math.max(0, S.hscroll - 4)
    return draw()
  }
  if (b === 67 || b === 69) {
    S.hscroll += 4
    return draw()
  }
  // In the chat or the input box a press may start a selection, so its click happens on release.
  if (b === 0 && isPress) {
    const area = chatPos(x, y) ? 'chat' : inputPos(x, y) != null ? 'input' : undefined
    if (area) {
      S.press = { x, y, area, isMoved: false }
      if (S.sel) {
        S.sel = null
        draw()
      }
      return
    }
  }
  if (S.press && b === 32) {
    const p = S.press
    if (!p.isMoved && x === p.x && y === p.y) return
    p.isMoved = true
    if (p.area === 'chat') {
      // Dragging past the top or bottom scrolls the chat.
      if (y <= S.chatTop) S.chatScroll = Math.min(S.chatScroll + 1, Math.max(0, S.chatLines.length - S.chatRows))
      else if (y > S.chatTop + S.chatRows) S.chatScroll = Math.max(0, S.chatScroll - 1)
      const a = S.sel?.area === 'chat' ? S.sel.a : chatPos(p.x, p.y, true)!
      S.sel = { area: 'chat', a, b: chatPos(x, y, true)! }
    } else {
      const a = S.sel?.area === 'input' ? S.sel.a : inputPos(p.x, p.y, true)
      let c = inputPos(x, y, true)
      // Like the chat, the character under the pointer is included.
      if (a != null && c != null && c >= a && c < S.text.length) c += (S.text.codePointAt(c) ?? 0) > 0xffff ? 2 : 1
      if (a != null && c != null) S.sel = { area: 'input', a, b: c }
    }
    return draw()
  }
  if (S.press && b === 0 && !isPress) {
    const p = S.press
    S.press = null
    if (p.isMoved) {
      const text = selectedText()
      if (text) copyText(text, `Copied ${[...text].length} characters.`)
      else S.sel = null
      return draw()
    }
    const now = Date.now()
    const isDouble = now - S.lastClick.at < 400 && Math.abs(S.lastClick.x - x) <= 1 && S.lastClick.y === y
    S.lastClick = { x, y, at: isDouble ? 0 : now }
    if (isDouble) {
      selectWord(p.area, x, y)
      const text = selectedText()
      if (text) copyText(text, `Copied “${preview(text, 30)}”.`)
      return draw()
    }
    if (p.area === 'input') {
      const i = inputPos(x, y)
      if (i != null) S.cursor = i
    }
    const hit = regions.find(r => r.row === y && x >= r.x0 && x <= r.x1)
    if (hit) hit.action()
    return draw()
  }
  if (b !== 0 || !isPress) return
  const hit = regions.find(r => r.row === y && x >= r.x0 && x <= r.x1)
  if (hit) hit.action()
}

let pasting = false
let pasteBuf = ''
function input(data: string) {
  let s = data
  while (s.length) {
    if (pasting) {
      const end = s.indexOf('\x1b[201~')
      if (end < 0) {
        pasteBuf += s
        return
      }
      pasteBuf += s.slice(0, end)
      // A dropped or pasted image file goes with the message as the image, not as its path.
      const img = imagePath(pasteBuf)
      if (img) attachImage(img)
      else insert(pasteBuf.replace(/\r\n?/g, '\n'))
      pasteBuf = ''
      pasting = false
      s = s.slice(end + 6)
      draw()
      continue
    }
    if (s.startsWith('\x1b[200~')) {
      pasting = true
      s = s.slice(6)
      continue
    }
    const m = s.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/)
    if (m) {
      mouse(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === 'M')
      s = s.slice(m[0].length)
      continue
    }
    const seq = s.match(/^\x1b\[[0-9;]*[A-Za-z~]|^\x1bO[A-Za-z]|^\x1b[\r\x7fbf]|^\x1b(?!\[)/)
    if (seq) {
      key(seq[0] === '\x1bOA' ? '\x1b[A' : seq[0] === '\x1bOB' ? '\x1b[B' : seq[0] === '\x1bOC' ? '\x1b[C' : seq[0] === '\x1bOD' ? '\x1b[D' : seq[0] === '\x1bOH' ? '\x1b[H' : seq[0] === '\x1bOF' ? '\x1b[F' : seq[0])
      s = s.slice(seq[0].length)
      continue
    }
    // Plain text: up to the next escape or control character, sent as one insert.
    const text = s.match(/^[^\x00-\x1f\x7f]+/)
    if (text) {
      key(text[0])
      s = s.slice(text[0].length)
      continue
    }
    key(s[0]!)
    s = s.slice(1)
  }
}

// ---- Run ---------------------------------------------------------------------------

let quitting = false
function quit(code = 0) {
  quitting = true
  S.claude?.close()
  if (IS_WT && tabMark.startsWith('✋')) out.write('\x1b]9;4;0;0\x07')
  out.write('\x1b[?1004l\x1b[?2004l\x1b[?1003l\x1b[?1002l\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l')
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
  if (S.sessionId) {
    keep()
    if (code === 75) writeFileSync(`${homedir()}/.clued/reload`, S.sessionId)
    else out.write(`Resume this conversation with: clued --resume ${S.sessionId}\n`)
  }
  setTimeout(() => process.exit(code), 300)
}

if (!process.stdin.isTTY) {
  console.error('clued needs a terminal.')
  process.exit(1)
}
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d: string) => input(d))
out.write('\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[2J')
out.on('resize', () => {
  refreshStatus()
  draw()
})
process.on('SIGTERM', quit)
process.on('SIGHUP', quit)
process.on('uncaughtException', err => {
  quitting = true
  out.write('\x1b[?1004l\x1b[?2004l\x1b[?1003l\x1b[?1002l\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l')
  console.error(err)
  process.exit(1)
})

// The spinner, the turn timer and a slow status refresh.
setInterval(() => {
  if (S.isWorking) {
    S.spinAt++
    draw()
  }
}, 120)
setInterval(refreshStatus, 15000)
/** Time to read a reply: about 4 words a second, at least 3 seconds, at most a minute. */
const readMs = (words: number) => Math.min(60_000, Math.max(3000, (words / 4) * 1000))

// A reply counts as read once all its lines have been on screen and it was in view, with the window
// focused, long enough to read it. Time only adds up while you are looking; it is kept if you look away.
setInterval(() => {
  if (!S.isFocused || S.picker) return
  const done: string[] = []
  for (const id of S.inView) {
    const rec = S.seen.get(id)
    if (!rec) continue
    rec.ms += 1000
    if (rec.lines.size >= rec.total && rec.ms >= readMs(rec.words)) done.push(id)
  }
  if (done.length) {
    markRead(done)
    for (const id of done) S.seen.delete(id)
    draw()
  }
}, 1000)
// Running agents' clocks.
setInterval(() => {
  if (!S.isWorking && [...S.agents.values()].some(a => a.state === 'running')) draw()
}, 1000)

if (wantPicker) {
  const sessions = listSessions(cwd)
  if (sessions.length) S.picker = { sessions, at: 0 }
  else start()
  draw()
} else start(resumeId)
