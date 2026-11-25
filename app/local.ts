// clued's own versions of Claude Code commands that headless mode refuses ("/help isn't available
// in this environment"): /help, /status, /plan, /diff, /copy and /export. What they show is a card
// in the chat, after the message that was last when you typed it, like a /btw answer: no topic, no
// part, nothing sent to Claude. ✕ or Esc closes it.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { placeAsides } from './btw.ts'
import type { Laid } from './btw.ts'
import type { ClaudeEvent, CommandInfo, Hello, McpServer } from './claude.ts'
import { block, codeRows, diffHead, diffRows, hunkGap, K, langOf } from './code.ts'
import type { Row } from './code.ts'
import { stripMarks } from './inbox.ts'
import type { Turn } from './session.ts'
import { C, cells, clip, pad, wrap } from './text.ts'
import type { Line, Span } from './text.ts'

/** clued's own commands: what /help says of each (Claude Code's own come from Claude Code). */
export const ABOUT: Record<string, { args?: string; about: string }> = {
  help: { about: 'every command: clued\'s own and Claude Code\'s' },
  status: { about: 'version, session, folder, account, model, permission mode and MCP servers' },
  plan: { args: '[description]', about: 'plan mode: Claude plans before it changes anything; a description goes as your message' },
  diff: { about: 'the uncommitted changes in this folder\'s git repository' },
  copy: { args: '[N]', about: 'copy Claude\'s last reply, or the Nth back' },
  export: { args: '[file]', about: 'the chat as Markdown: to a file, or to the clipboard' },
  clear: { about: 'a new session' },
  resume: { about: 'pick a session to go back to' },
  model: { args: '<name>', about: 'switch model: opus, sonnet, haiku or a model id' },
  btw: { args: '<question>', about: 'a quick side question: it sees the conversation but stays out of it' },
  notify: { args: 'on|always|off|test', about: 'system notifications when Claude asks you something' },
  hold: { args: '<seconds>', about: 'time to edit or delete a message before it goes' },
  queue: { args: 'on|off', about: 'hold messages sent while Claude works until its turn ends' },
  results: { about: 'hide Claude\'s steps and keep its results' },
  work: { args: 'folded|edits|all', about: 'how much of Claude\'s work the chat shows' },
  panel: { about: 'fold the panel' },
  demo: { args: 'on|off', about: 'fake agents on your messages (drawn only, no tokens)' },
  reload: { about: 'restart the app on this session' },
  exit: { about: 'quit' },
}

/** The commands this module runs. */
export const LOCAL_COMMANDS = ['help', 'status', 'plan', 'diff', 'copy', 'export']

// ---- Cards: what a command shows, in the chat -----------------------------------------

export type Card = {
  id: number
  /** The command's name, and a few words on what the card shows. */
  title: string
  about: string
  /** The chat's last message when it came ('' before any): the card sits after it. */
  after: string
  body: (width: number) => Line[]
  /** Clickable words in its foot, before ✕ close. */
  actions?: { label: string; run: () => void }[]
}

export type CardInput = Omit<Card, 'id'>

export class Cards {
  list: Card[] = []
  private next = 1
  private cache = new Map<number, { width: number; lines: Line[] }>()
  private changed: () => void
  constructor(changed: () => void) {
    this.changed = changed
  }

  /** Shows a card; one from the same command before it goes (a second /status replaces the first). */
  add(c: CardInput): Card {
    for (const old of this.list.filter(x => x.title === c.title)) this.cache.delete(old.id)
    this.list = this.list.filter(x => x.title !== c.title)
    const card = { ...c, id: this.next++ }
    this.list.push(card)
    this.changed()
    return card
  }

  /** Lays the card out again (what it shows changed). */
  redo(id: number) {
    this.cache.delete(id)
    this.changed()
  }

  dismiss(id: number) {
    this.list = this.list.filter(c => c.id !== id)
    this.cache.delete(id)
    this.changed()
  }

  /** Esc: closes the latest card; false when there is none. */
  dismissLast(): boolean {
    const c = this.list.at(-1)
    if (!c) return false
    this.dismiss(c.id)
    return true
  }

  clear() {
    this.list = []
    this.cache.clear()
  }

  lines(c: Card, width: number): Line[] {
    const known = this.cache.get(c.id)
    if (known && known.width === width) return known.lines
    const border = { fg: C.faint }
    const b = (t: string): Span => ({ text: t, style: border })
    const close: Span = { text: '✕', style: { fg: C.gray }, action: () => this.dismiss(c.id) }
    const room = Math.max(8, width - 12 - cells(c.title))
    const about = clip(c.about, room)
    const out: Line[] = [[]]
    out.push([pad(2), b('╭ '), { text: c.title, style: { fg: C.cyan, bold: true } }, b(' · '), { text: about, style: { fg: C.gray, italic: true } }, pad(Math.max(1, room - cells(about) + 1)), close])
    for (const l of c.body(Math.max(20, width - 6))) out.push([pad(2), b('│ '), ...l])
    const foot: Span[] = [pad(2), b('╰ ')]
    for (const a of c.actions ?? []) foot.push({ text: a.label, style: { fg: C.cyan }, action: a.run }, b(' · '))
    foot.push({ text: '✕ close', style: { fg: C.gray }, action: () => this.dismiss(c.id) })
    out.push(foot)
    this.cache.set(c.id, { width, lines: out })
    return out
  }

  /** The chat with each card after the message that was last when it came; `card:<id>` anchors its top. */
  into(laid: Laid, keys: string[], width: number): Laid {
    return placeAsides(laid, keys, this.list.map(c => ({ after: c.after, lines: this.lines(c, width), anchor: `card:${c.id}` })))
  }
}

// ---- What Claude Code said of itself ------------------------------------------------------

/** From the initialize answer and the init event: for /help and /status. */
export type Facts = {
  commands: CommandInfo[]
  account?: Hello['account']
  version?: string
  mcpServers?: McpServer[]
  apiKeySource?: string
  outputStyle?: string
  models?: Hello['models']
}

export function takeFacts(f: Facts, e: ClaudeEvent) {
  if (e.kind === 'hello') {
    if (e.info.commands?.length) f.commands = e.info.commands
    if (e.info.account) f.account = e.info.account
    if (e.info.claude_code_version) f.version = e.info.claude_code_version
    if (e.info.output_style) f.outputStyle = e.info.output_style
    if (e.info.models) f.models = e.info.models
  } else if (e.kind === 'init') {
    if (e.version) f.version = e.version
    if (e.mcpServers) f.mcpServers = e.mcpServers
    if (e.apiKeySource) f.apiKeySource = e.apiKeySource
    if (e.outputStyle) f.outputStyle = e.outputStyle
    // A Claude Code that gave no descriptions: its commands' names at least.
    if (!f.commands.length) f.commands = e.commands.map(name => ({ name }))
  } else if (e.kind === 'commands') f.commands = e.commands
}

// ---- /help ----------------------------------------------------------------------------

/** Rows of "/name args   what it does", the names in one column, each row one line. */
function commandRows(list: { name: string; args?: string; about?: string }[], width: number): Line[] {
  const heads = list.map(c => `/${c.name}${c.args ? ` ${c.args}` : ''}`)
  const col = Math.min(Math.max(0, ...heads.map(cells)) + 2, Math.max(12, Math.floor(width / 2.5)))
  return list.map((c, i) => {
    const head = clip(heads[i]!, col - 1)
    const about = clip((c.about ?? '').replace(/\s+/g, ' ').trim(), Math.max(4, width - col - 1))
    return [{ text: head, style: { fg: C.white } }, pad(col - cells(head)), { text: about, style: { fg: C.gray } }]
  })
}

/** /help: clued's commands (`own`: the names the app runs), then Claude Code's, minus those clued runs itself. */
export function helpLines(own: string[], f: Facts, width: number): Line[] {
  const ours = [...new Set(own)].sort()
  const theirs = f.commands.filter(c => !ours.includes(c.name)).sort((a, b) => a.name.localeCompare(b.name))
  const out: Line[] = [[{ text: 'clued', style: { bold: true, fg: C.cyan } }, { text: '  run by the app itself', style: { fg: C.faint } }]]
  out.push(...commandRows(ours.map(name => ({ name, ...ABOUT[name] })), width))
  out.push([], [{ text: 'Claude Code', style: { bold: true, fg: C.claudeName } }, { text: '  sent to the session, as you type them', style: { fg: C.faint } }])
  if (theirs.length) out.push(...commandRows(theirs.map(c => ({ name: c.name, ...(c.argumentHint ? { args: c.argumentHint } : {}), ...(c.description ? { about: c.description } : {}) })), width))
  else out.push([{ text: 'Claude Code\'s commands show here once it has started: send a message first.', style: { fg: C.faint, italic: true } }])
  out.push([], ...wrap([{ text: 'Every other slash command goes to Claude Code. Shift+Tab changes the permission mode, Esc closes this.', style: { fg: C.faint } }], width))
  return out
}

// ---- /status --------------------------------------------------------------------------

export type StatusInfo = {
  cliVersion: string
  sessionId: string
  cwd: string
  /** Where Claude Code is working now, when its shell's cd moved it. */
  here?: string
  model: string
  permissionMode: string
  contextUsed: number
  contextSize: number
  costUsd: number
  /** More rows from the app (the folders /add-dir added). */
  extra?: [string, string][]
}

const MODE_WORDS: Record<string, string> = {
  default: 'default: asks before edits and commands',
  acceptEdits: 'accept edits: edits go ahead, commands ask',
  plan: 'plan: Claude plans, and changes nothing until you say so',
  auto: 'auto',
  bypassPermissions: 'bypass permissions: nothing asks',
  dontAsk: 'don\'t ask: what isn\'t allowed is refused',
}

const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p)
const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

export function statusRows(s: StatusInfo, f: Facts): [string, string][] {
  const a = f.account ?? {}
  const login = [a.email, a.subscriptionType, a.organization].filter(Boolean).join(' · ')
  const key = f.apiKeySource && f.apiKeySource !== 'none' ? `API key (${f.apiKeySource})` : ''
  const provider = a.apiProvider && a.apiProvider !== 'firstParty' ? a.apiProvider : ''
  const model = f.models?.find(m => m.resolvedModel === s.model || m.value === s.model)
  const rows: [string, string][] = [
    ['clued', s.cliVersion],
    ['Claude Code', f.version ?? 'not started yet'],
    ['Session', s.sessionId || 'new: no messages yet'],
    ['Folder', tilde(s.cwd) + (s.here && s.here !== s.cwd ? ` (Claude is in ${tilde(s.here)})` : '')],
    ['Account', [login, key, provider].filter(Boolean).join(' · ') || 'not known yet'],
    ['Model', s.model ? `${s.model}${model?.description ? ` · ${model.description}` : ''}` : 'not known yet'],
    ['Permission mode', MODE_WORDS[s.permissionMode || 'default'] ?? s.permissionMode],
  ]
  if (f.outputStyle && f.outputStyle !== 'default') rows.push(['Output style', f.outputStyle])
  if (s.contextSize) rows.push(['Context', s.contextUsed ? `${k(s.contextUsed)} of ${k(s.contextSize)} tokens (${Math.round((s.contextUsed / s.contextSize) * 100)}%)` : `${k(s.contextSize)} tokens`])
  if (s.costUsd) rows.push(['Cost', `$${s.costUsd.toFixed(4)} since this Claude Code started`])
  rows.push(...(s.extra ?? []))
  const mcp = f.mcpServers ?? []
  const mark = (st: string) => (st === 'connected' ? '✔' : st === 'failed' ? '✘' : st === 'pending' ? '…' : '△')
  rows.push(['MCP servers', mcp.length ? mcp.map(m => `${mark(m.status)} ${m.name}${m.status === 'connected' ? '' : ` (${m.status})`}`).join('\n') : f.version ? 'none' : 'not known yet'])
  return rows
}

export function statusLines(rows: [string, string][], width: number): Line[] {
  const col = Math.max(...rows.map(([l]) => cells(l))) + 2
  const out: Line[] = []
  for (const [label, value] of rows)
    value.split('\n').forEach((v, i) => {
      const ls = wrap([{ text: v, style: { fg: v.startsWith('✘') ? C.red : v.startsWith('△') ? C.yellow : C.white } }], Math.max(8, width - col))
      ls.forEach((l, j) => out.push([{ text: i || j ? '' : label, style: { fg: C.gray } }, pad(i || j ? col : col - cells(label)), ...l]))
    })
  return out
}

// ---- Claude's replies: /copy and /export ------------------------------------------------

/** What Claude said in a turn, as one text: its reply parts, else its answer. */
export function replyOf(t: Turn): string {
  if (t.parts?.length) return t.parts.map(p => p.text.trim()).filter(Boolean).join('\n\n')
  return stripMarks(t.answer ?? '').trim()
}

/** The turns that are a conversation: none of the app's own small lines (reactions, retries, deletions). */
const spoken = (turns: Turn[]) => turns.filter(t => !t.reaction && !t.retry && !t.deletes && !t.deleted)

/** Claude's replies, oldest first. */
export const replies = (turns: Turn[]) => spoken(turns).map(replyOf).filter(Boolean)

const two = (n: number) => String(n).padStart(2, '0')
const day = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
const clock = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`

/** The chat as Markdown: your messages and Claude's replies, in order. */
export function exportMarkdown(turns: Turn[], meta: { sessionId: string; cwd: string; now: number }): string {
  const list = spoken(turns)
  const first = list.find(t => t.text.trim())
  const out = [`# ${first ? first.text.split('\n')[0]!.slice(0, 80) : 'A chat with Claude'}`, '', `Exported from clued on ${day(new Date(meta.now))} ${clock(new Date(meta.now))} · ${tilde(meta.cwd)}${meta.sessionId ? ` · session ${meta.sessionId}` : ''}`]
  for (const t of list) {
    const at = new Date(t.at)
    if (t.text.trim()) out.push('', `## You · ${day(at)} ${clock(at)}`, '', t.text.trim())
    const reply = replyOf(t)
    if (reply) out.push('', t.text.trim() ? '## Claude' : `## Claude · ${t.fired ? 'a scheduled job' : 'on its own'} · ${day(at)} ${clock(at)}`, '', reply)
    else if (t.error) out.push('', '## Claude', '', `_${t.error}_`)
  }
  return out.join('\n') + '\n'
}

/** A file name for the export: the day and the first words of the first message. */
export function exportName(turns: Turn[], now: number): string {
  const first = spoken(turns).find(t => t.text.trim() && !t.text.startsWith('/'))
  const slug = (first?.text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 6).join('-').slice(0, 50).replace(/-+$/, '')
  return `${day(new Date(now))}-${slug || 'chat'}.md`
}

/** Where /export writes: `file` from the folder (~ is home; a folder gets the usual name), else the usual name there, never over another file. */
export function exportPath(cwd: string, file: string, turns: Turn[], now: number): string {
  const name = exportName(turns, now)
  if (file) {
    const p = file.startsWith('~/') ? join(homedir(), file.slice(2)) : isAbsolute(file) ? file : resolve(cwd, file)
    if (existsSync(p) && statSync(p).isDirectory()) return join(p, name)
    return /\.[a-z0-9]+$/i.test(p) ? p : `${p}.md`
  }
  let p = join(cwd, name)
  for (let n = 2; existsSync(p); n++) p = join(cwd, name.replace(/\.md$/, `-${n}.md`))
  return p
}

// ---- /diff ----------------------------------------------------------------------------

export type FileDiff = { path: string; note?: string; hunks: { before: string; after: string; at: number }[]; added: number; removed: number }

/** A unified diff (git diff) cut into files and hunks: each hunk's old and new lines. */
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let f: FileDiff | undefined
  let before: string[] = []
  let after: string[] = []
  let at = 0
  /** In a hunk: its lines start with " ", "-" or "+" (a "--- " is a removed line, not a header). */
  let inHunk = false
  const endHunk = () => {
    if (f && (before.length || after.length)) f.hunks.push({ before: before.join('\n'), after: after.join('\n'), at })
    before = []
    after = []
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      endHunk()
      inHunk = false
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/)
      f = { path: m?.[2] ?? line.slice(11), hunks: [], added: 0, removed: 0 }
      files.push(f)
    } else if (!f) continue
    else if (line.startsWith('@@')) {
      endHunk()
      inHunk = true
      at = Number(line.match(/\+(\d+)/)?.[1] ?? 0)
    } else if (inHunk) {
      if (line.startsWith('+')) (after.push(line.slice(1)), f.added++)
      else if (line.startsWith('-')) (before.push(line.slice(1)), f.removed++)
      else if (line.startsWith(' ')) (before.push(line.slice(1)), after.push(line.slice(1)))
    } else if (line.startsWith('+++ b/')) f.path = line.slice(6)
    else if (line === '+++ /dev/null') f.note = 'deleted'
    else if (line === '--- /dev/null') f.note = 'new'
    else if (line.startsWith('rename from ')) f.note = `renamed from ${line.slice(12)}`
    else if (line.startsWith('Binary files ')) f.note = 'binary'
  }
  endHunk()
  return files
}

export type GitDiff = { kind: 'no-git' | 'not-repo' | 'clean' | 'failed'; error?: string } | { kind: 'diff'; root: string; files: FileDiff[] }

/** Past this many lines, a new untracked file shows only its start. */
const NEW_FILE_LINES = 200

/** The uncommitted changes in `cwd`'s repository: staged and not, and the untracked files. */
export function gitDiff(cwd: string): GitDiff {
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] })
  let root: string
  try {
    root = git('rev-parse', '--show-toplevel').trim()
  } catch (err: any) {
    return err?.code === 'ENOENT' ? { kind: 'no-git' } : { kind: 'not-repo' }
  }
  try {
    // A repository with no commit yet: everything in it is new, against the empty tree.
    let base = 'HEAD'
    try {
      git('rev-parse', '--verify', '-q', 'HEAD')
    } catch {
      base = git('hash-object', '-t', 'tree', '/dev/null').trim()
    }
    const files = parseDiff(git('diff', '--no-color', '--no-ext-diff', base))
    const untracked = git('ls-files', '--others', '--exclude-standard', '-z', ':/').split('\0').filter(Boolean)
    for (const path of untracked) {
      let text = ''
      try {
        text = readFileSync(join(root, path), 'utf8')
      } catch {}
      const isBinary = text.includes('\0')
      const lines = isBinary || !text ? [] : text.replace(/\n$/, '').split('\n')
      files.push({ path, note: isBinary ? 'new, binary' : 'new, untracked', hunks: lines.length ? [{ before: '', after: lines.slice(0, NEW_FILE_LINES).join('\n'), at: 1 }] : [], added: lines.length, removed: 0 })
    }
    return files.length ? { kind: 'diff', root, files } : { kind: 'clean' }
  } catch (err: any) {
    return { kind: 'failed', error: String(err?.stderr || err?.message || err).trim().split('\n').at(-1) }
  }
}

/** Past this many rows, a file's diff is cut; a click shows it all. */
const FILE_ROWS = 120

/** The diff, a block per file as Claude's edits show: the path and +added −removed, then its hunks. */
export function diffLines(files: FileDiff[], width: number, full: Set<string>, showAll: (path: string) => void): Line[] {
  const out: Line[] = []
  for (const f of files) {
    const body: Row[] = []
    f.hunks.forEach((h, n) => {
      if (n) body.push(hunkGap())
      // A whole new or deleted file: its lines, numbered, as a Write shows (a diff would add an empty line).
      const lines = (t: string) => t.split('\n')
      if (!h.before) body.push(...codeRows(lines(h.after), langOf(f.path), h.at || 1, { fg: K.addSign, bg: K.addBg }, '+'))
      else if (!h.after) body.push(...codeRows(lines(h.before), langOf(f.path), 1, { fg: K.delSign, bg: K.delBg }, '-'))
      else body.push(...diffRows(h.before, h.after).rows)
    })
    const head = diffHead(f.note ? `${f.path}  (${f.note})` : f.path, f.added, f.removed)
    const lines = block(body, width, head)
    const cut = !full.has(f.path) && lines.length > FILE_ROWS + 1
    out.push(...(cut ? lines.slice(0, FILE_ROWS + 1) : lines))
    if (cut) out.push([{ text: `… ${lines.length - FILE_ROWS - 1} more lines, show all`, style: { fg: C.cyan }, action: () => showAll(f.path) }])
    else if (f.note?.startsWith('new') && f.added > NEW_FILE_LINES) out.push([{ text: `… ${f.added - NEW_FILE_LINES} more lines in the file`, style: { fg: C.faint } }])
    out.push([])
  }
  out.pop()
  return out
}

// ---- The commands -----------------------------------------------------------------------

/** What the commands need of the app. */
export type Ctx = {
  cwd: string
  turns: Turn[]
  /** The chat's last message ('' when there is none): a card goes after it. */
  after: string
  /** The commands the app runs itself (for /help). */
  own: string[]
  status: () => StatusInfo
  copy: (text: string, note: string) => void
  toast: (text: string) => void
  /** The permission mode now, and a change to it (Claude Code is started if it isn't running). */
  permissionMode: string
  setMode: (mode: string) => void
  /** Sends a message as if you typed it. */
  send: (text: string) => void
  /** A card was added: the chat goes to it. */
  shown: (card: Card) => void
  now?: number
}

const nth = (n: number) => (n === 1 ? 'last' : `${n}${n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : n % 10 === 1 && n !== 11 ? 'st' : 'th'} last`)

export class Local {
  cards: Cards
  facts: Facts = { commands: [] }
  constructor(changed: () => void) {
    this.cards = new Cards(changed)
  }

  /** Every event from Claude Code: what it says of itself. */
  take(e: ClaudeEvent) {
    takeFacts(this.facts, e)
  }

  private show(ctx: Ctx, c: Omit<CardInput, 'after'>) {
    ctx.shown(this.cards.add({ ...c, after: ctx.after }))
  }

  /** Runs `/cmd arg` when it is one of these commands; false when it isn't. */
  run(cmd: string, arg: string, ctx: Ctx): boolean {
    switch (cmd) {
      case 'help':
        this.show(ctx, { title: 'help', about: 'clued\'s commands, then Claude Code\'s', body: w => helpLines(ctx.own, this.facts, w) })
        return true
      case 'status': {
        const rows = statusRows(ctx.status(), this.facts)
        this.show(ctx, { title: 'status', about: 'this session and the Claude Code under it', body: w => statusLines(rows, w) })
        return true
      }
      case 'plan':
        if (ctx.permissionMode !== 'plan') ctx.setMode('plan')
        if (arg) ctx.send(arg)
        ctx.toast(ctx.permissionMode === 'plan' && !arg ? 'Already in plan mode. Shift+Tab leaves it.' : `Plan mode on: Claude plans before it changes anything${arg ? ', starting with your message' : ''}. Shift+Tab leaves it.`)
        return true
      case 'copy':
        return this.copy(arg, ctx), true
      case 'export':
        return this.export(arg, ctx), true
      case 'diff':
        return this.diff(ctx), true
    }
    return false
  }

  private copy(arg: string, ctx: Ctx) {
    const n = arg ? Number(arg) : 1
    if (!Number.isInteger(n) || n < 1) return ctx.toast('Usage: /copy [N]: Claude\'s last reply, or the Nth back (/copy 2 is the one before).')
    const all = replies(ctx.turns)
    if (!all.length) return ctx.toast('Claude hasn\'t replied yet: nothing to copy.')
    if (n > all.length) return ctx.toast(`Claude has replied ${all.length === 1 ? 'once' : `${all.length} times`} in this chat: /copy ${all.length} is the first reply.`)
    const text = all[all.length - n]!
    ctx.copy(text, `Copied Claude's ${nth(n)} reply (${text.split('\n').length} lines).`)
  }

  private export(arg: string, ctx: Ctx) {
    const now = ctx.now ?? Date.now()
    if (!spoken(ctx.turns).some(t => t.text.trim() || replyOf(t))) return ctx.toast('Nothing to export yet: the chat is empty.')
    const md = () => exportMarkdown(ctx.turns, { sessionId: ctx.status().sessionId, cwd: ctx.cwd, now })
    const save = (file: string) => {
      const path = exportPath(ctx.cwd, file, ctx.turns, now)
      try {
        writeFileSync(path, md())
        ctx.toast(`Exported the chat to ${tilde(path)}`)
        return true
      } catch (err: any) {
        ctx.toast(`Couldn't export to ${tilde(path)}: ${err?.code === 'ENOENT' ? 'no such folder' : err?.code === 'EACCES' ? 'permission denied' : String(err?.message ?? err)}`)
        return false
      }
    }
    if (arg) return void save(arg)
    // As Claude Code's own /export: with no file, a choice between the clipboard and a file.
    const name = tilde(exportPath(ctx.cwd, '', ctx.turns, now))
    const counts = spoken(ctx.turns)
    const mine = counts.filter(t => t.text.trim()).length
    const theirs = counts.filter(t => replyOf(t)).length
    const card = this.cards.add({
      title: 'export',
      about: 'the chat as Markdown',
      after: ctx.after,
      body: w => wrap([{ text: `${mine} message${mine === 1 ? '' : 's'} of yours and ${theirs} repl${theirs === 1 ? 'y' : 'ies'} of Claude's. Copy them, or save them to ${name}. /export <file> saves under another name.`, style: { fg: C.gray } }], w),
      actions: [
        { label: '⧉ copy to the clipboard', run: () => (this.cards.dismiss(card.id), ctx.copy(md(), 'Copied the chat as Markdown.')) },
        { label: `⤓ save to ${name.split('/').pop()}`, run: () => save('') && this.cards.dismiss(card.id) },
      ],
    })
    ctx.shown(card)
  }

  private diff(ctx: Ctx) {
    const d = gitDiff(ctx.cwd)
    if (d.kind !== 'diff')
      return ctx.toast(
        d.kind === 'no-git' ? '/diff needs git, and git isn\'t installed.'
        : d.kind === 'not-repo' ? `Not a git repository: ${tilde(ctx.cwd)}. /diff shows a repository's uncommitted changes.`
        : d.kind === 'failed' ? `git diff failed: ${d.error}`
        : 'Nothing uncommitted: the working tree is clean.',
      )
    const added = d.files.reduce((n, f) => n + f.added, 0)
    const removed = d.files.reduce((n, f) => n + f.removed, 0)
    const full = new Set<string>()
    const card = this.cards.add({
      title: 'diff',
      about: `${d.files.length} file${d.files.length === 1 ? '' : 's'} changed, +${added} −${removed}, uncommitted in ${tilde(d.root)}`,
      after: ctx.after,
      body: w => diffLines(d.files, w, full, path => (full.add(path), this.cards.redo(card.id))),
    })
    ctx.shown(card)
  }
}

/** clued's own version, for /status. */
export function cluedVersion(): string {
  try {
    return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '')
  } catch {
    return ''
  }
}
