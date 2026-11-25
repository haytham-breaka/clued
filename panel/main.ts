// The clued window's left panel: draws the threads from the mod's state
// file and sends clicks back as commands. Plain Node (run as `node main.ts`),
// no dependencies: raw ANSI drawing and xterm SGR mouse reports.

import { appendFileSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'

import { COMMANDS_FILE, STATE_FILE } from '../hooks/bridge.ts'
import type { Command, Snapshot } from '../hooks/bridge.ts'
import { counts, describeThread, threadTree, topicsOf } from '../hooks/model.ts'
import type { Topic } from '../types/index.d.ts'

const DIR = process.env.CLUED_DIR
if (!DIR) {
  console.error('clued panel: CLUED_DIR is not set (start it with bin/clued-classic)')
  process.exit(1)
}

const NARROW = 7
/** Narrower than this, the panel draws its icon view. */
const MIN_FULL = 24
// The width you dragged the panel to, kept for every window (bin/clued-classic reads it too).
const PREFS = `${homedir()}/.clued/panel.json`
function savedWidth(): number {
  try {
    const w = Number((JSON.parse(readFileSync(PREFS, 'utf8')) as { width?: unknown }).width)
    return Number.isInteger(w) && w >= 24 && w <= 120 ? w : 34
  } catch {
    return 34
  }
}
let WIDE = savedWidth()
let saveTimer: ReturnType<typeof setTimeout> | undefined
function rememberWidth() {
  const w = out.columns
  if (isCollapsed || !w || w < MIN_FULL || w === WIDE) return
  WIDE = w
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    mkdirSync(`${homedir()}/.clued`, { recursive: true })
    writeFileSync(PREFS, JSON.stringify({ width: WIDE }))
  }, 400)
}
const out = process.stdout

let snapshot: Snapshot | null = null
let isCollapsed = false
let scroll = 0
/** Cells the titles are scrolled sideways, and the most they can be (from the last draw). */
let hscroll = 0
let hscrollMax = 0
/** hscrollMax as the last finished draw measured it: what the arrows read. */
let measuredMax = 0

// ---- Text width (terminal cells) ----------------------------------------------

const isWide = (cp: number) =>
  cp === 0x23f3 || cp === 0x231b || cp === 0x270b || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xff00 && cp <= 0xff60)

function cells(text: string): number {
  let n = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0xfe0f || cp === 0x200d) continue
    n += isWide(cp) ? 2 : 1
  }
  return n
}

function fit(text: string, width: number): string {
  if (width <= 0) return ''
  if (cells(text) <= width) return text + ' '.repeat(width - cells(text))
  let s = ''
  for (const ch of text) {
    if (cells(s + ch) > width - 1) break
    s += ch
  }
  return s + '…' + ' '.repeat(Math.max(0, width - cells(s) - 1))
}

// ---- Drawing --------------------------------------------------------------------

type Style = { bold?: boolean; dim?: boolean; color?: number; inverse?: boolean; italic?: boolean }
/** `scrolls`: a title, which moves with the sideways scroll while marks and counts stay. */
type Span = { text: string; style?: Style; action?: () => void; scrolls?: boolean }
type Line = Span[]

const sgr = (s: Style = {}) =>
  `\x1b[0${s.bold ? ';1' : ''}${s.dim ? ';2' : ''}${s.italic ? ';3' : ''}${s.inverse ? ';7' : ''}${s.color ? `;${s.color}` : ''}m`

const CYAN = 36
const MAGENTA = 35
const YELLOW = 33

const mark = { claude: '⏳', me: '✋', done: '✓' } as const

/** Drops the first `n` cells of `text`. */
function dropCells(text: string, n: number): string {
  let skipped = 0
  let i = 0
  const chars = [...text]
  while (i < chars.length && skipped < n) skipped += cells(chars[i++] ?? '')
  return chars.slice(i).join('')
}

function send(c: Command) {
  appendFileSync(`${DIR}/${COMMANDS_FILE}`, JSON.stringify(c) + '\n')
}

/** Clicking here moves tmux's focus to the panel: give the keyboard back to Claude. */
function focusClaude() {
  execFile('tmux', ['select-pane', '-R'], () => {})
}

function setCollapsed(next: boolean) {
  isCollapsed = next
  execFile('tmux', ['resize-pane', '-t', process.env.TMUX_PANE ?? '', '-x', String(next ? NARROW : WIDE)], () => {})
  draw()
}

/** One row: `left` fitted to the room `right` leaves, `right` flush with the edge. */
function row(width: number, left: Span[], right: Span[] = []): Line {
  const rightW = right.reduce((n, sp) => n + cells(sp.text), 0)
  let room = Math.max(1, width - rightW - (rightW ? 1 : 0))
  const out: Span[] = []
  for (const original of left) {
    if (room <= 0) break
    let sp = original
    if (sp.scrolls) {
      // How far this title runs past its room: the most the sideways scroll needs.
      hscrollMax = Math.max(hscrollMax, cells(sp.text) - room + 1)
      if (hscroll > 0 && sp.text) sp = { ...sp, text: '‹' + dropCells(sp.text, hscroll + 1) }
    }
    const w = cells(sp.text)
    if (w <= room) {
      out.push(sp)
      room -= w
    } else {
      out.push({ ...sp, text: fit(sp.text, room) })
      room = 0
    }
  }
  if (room > 0) out.push({ text: ' '.repeat(room) })
  if (rightW) out.push({ text: ' ' }, ...right)
  return out
}

/** ⏳ and ✋ counts, only when non-zero; ✓ dim. */
function countSpans(topics: readonly Topic[], action?: () => void): Span[] {
  const c = counts(topics)
  const spans: Span[] = []
  if (c.claude) spans.push({ text: `⏳${c.claude}`, style: { color: CYAN }, action })
  if (c.me) spans.push({ text: `${spans.length ? ' ' : ''}✋${c.me}`, style: { color: YELLOW, bold: true }, action })
  if (c.done) spans.push({ text: `${spans.length ? ' ' : ''}✓${c.done}`, style: { dim: true }, action })
  return spans
}

const rule = (width: number): Line => [{ text: '─'.repeat(width), style: { dim: true } }]

/** The most urgent count of a set of topics: ✋ before ⏳, else a dim ✓. */
function urgent(topics: readonly Topic[]): Span {
  const c = counts(topics)
  if (c.me) return { text: `✋${c.me}`, style: { color: YELLOW, bold: true } }
  if (c.claude) return { text: `⏳${c.claude}`, style: { color: CYAN } }
  return { text: '✓', style: { dim: true } }
}

/** The icon view: ☰ to open, then Main and each thread as `#id` with its most urgent count. */
function icons(s: Snapshot | null, width: number): Line[] {
  const open = () => setCollapsed(false)
  const L: Line[] = [
    row(width, [{ text: '☰', style: { bold: true, color: CYAN }, action: open }], [
      s?.isWorking ? { text: '●', style: { color: CYAN } } : { text: '○', style: { dim: true } },
    ]),
    rule(width),
  ]
  headRows = L.length
  const b = s?.board
  if (!b) return L
  const view = s.view ?? { threadId: 0, isResultsOnly: false }
  const on = (id: number) => (view.threadId === id ? { text: '▸', style: { color: CYAN } } : { text: ' ' })
  const toMain = () => send({ op: 'thread', threadId: 0 })
  L.push(row(width, [{ ...on(0), action: toMain }, { text: 'M', style: { bold: true }, action: toMain }], [{ ...urgent(b.topics), action: toMain }]))
  for (const { thread } of threadTree(b)) {
    const select = () => send({ op: 'thread', threadId: view.threadId === thread.id ? 0 : thread.id })
    const topics = topicsOf(b, thread.id)
    const quiet = topics.every(t => t.status === 'done')
    L.push(row(width, [{ ...on(thread.id), action: select }, { text: `#${thread.id}`, style: { dim: quiet, bold: !quiet }, action: select }], [{ ...urgent(topics), action: select }]))
  }
  const unread = (s.notices ?? []).filter(n => !n.isRead).length
  if (unread) L.push(rule(width), row(width, [{ text: '🔔', action: open }], [{ text: String(unread), style: { color: MAGENTA, bold: true }, action: open }]))
  return L
}

/** Rows at the top that stay put while the rest scrolls. */
let headRows = 0

function lines(width: number): Line[] {
  headRows = 0
  const s = snapshot
  const b = s?.board
  const all = b?.topics ?? []
  // Folded, or dragged narrower than the full rows can use: one short row per thread.
  if (isCollapsed || width < MIN_FULL) return icons(s, width)

  const L: Line[] = []
  const view = s?.view ?? { threadId: 0, isResultsOnly: false }
  const toggle = () => send({ op: 'results' })

  // Header: the fold button, and whether Claude is working.
  L.push(row(width, [{ text: '☰ Threads', style: { bold: true, color: CYAN }, action: () => setCollapsed(true) }], [
    s?.isWorking ? { text: '● working', style: { color: CYAN } } : { text: '○ idle', style: { dim: true } },
  ]))
  // What the chat shows: everything, or Claude's results only.
  // Sideways arrows only while a title is cut off (hscrollMax is from the last draw).
  const arrows: Span[] =
    measuredMax > 0 || hscroll > 0
      ? [
          { text: '‹', style: { bold: hscroll > 0, dim: hscroll === 0, color: CYAN }, action: () => { hscroll = Math.max(0, hscroll - 6); draw() } },
          { text: ' ' },
          { text: '›', style: { bold: hscroll < measuredMax, dim: hscroll >= measuredMax, color: CYAN }, action: () => { hscroll += 6; draw() } },
        ]
      : []
  L.push(row(width, [
    { text: 'show ', style: { dim: true } },
    { text: 'all', style: view.isResultsOnly ? { dim: true } : { bold: true, inverse: true }, action: toggle },
    { text: ' ' },
    { text: 'results', style: view.isResultsOnly ? { bold: true, inverse: true } : { dim: true }, action: toggle },
  ], arrows))
  if (!b) {
    L.push([], [{ text: 'Waiting for Claude Code…', style: { dim: true } }])
    return L
  }
  L.push(rule(width))
  headRows = L.length

  const toMain = () => send({ op: 'thread', threadId: 0 })
  L.push(row(width, [{ text: `${view.threadId === 0 ? '▸ ' : '  '}Main`, style: { bold: view.threadId === 0, color: view.threadId === 0 ? CYAN : undefined }, action: toMain }], countSpans(all, toMain)))
  for (const t of all.filter(x => x.threadId === 0))
    L.push(row(width, [{ text: '    ⏳ ', style: { dim: true } }, { text: t.title, style: { dim: true, italic: true }, scrolls: true }], [{ text: 'sorting', style: { dim: true } }]))
  L.push(rule(width))

  if (b.threads.length === 0 && !all.length) L.push([{ text: '  No topics yet. Send a message.', style: { dim: true } }])
  for (const { thread, depth } of threadTree(b)) {
    const isOn = view.threadId === thread.id
    const select = () => send({ op: 'thread', threadId: isOn ? 0 : thread.id })
    const topics = topicsOf(b, thread.id)
    const isQuiet = topics.every(t => t.status === 'done')
    const lead = isOn ? '▸ ' : '  '
    const fork = depth > 0 ? '└ ' : ''
    L.push(row(width, [
      { text: lead + fork, style: { color: CYAN }, action: select },
      { text: `#${thread.id} `, style: { dim: true }, action: select },
      { text: thread.name, style: { bold: isOn || !isQuiet, dim: isQuiet && !isOn, color: isOn ? CYAN : undefined }, action: select, scrolls: true },
    ], countSpans(topics, select)))
    // Open topics always; a thread you are in shows its finished ones too.
    const pad = ' '.repeat(cells(lead + fork) + 2)
    for (const topic of topics.filter(t => isOn || t.status !== 'done'))
      L.push(row(width, [
        { text: `${pad}${mark[topic.status]} `, style: { color: topic.status === 'me' ? YELLOW : topic.status === 'claude' ? CYAN : undefined, dim: topic.status === 'done' }, action: select },
        { text: topic.title, style: { dim: topic.status === 'done', italic: topic.isProvisional === true }, action: select, scrolls: true },
      ]))
  }

  const notes = (s.notices ?? []).slice().reverse()
  const unread = notes.filter(n => !n.isRead).length
  const markRead = () => send({ op: 'readNotices' })
  L.push(rule(width))
  L.push(row(width, [{ text: 'Notifications', style: { bold: true }, action: markRead }], unread ? [{ text: `${unread} new`, style: { color: MAGENTA, bold: true }, action: markRead }] : []))
  if (!notes.length) L.push([{ text: '  Nothing yet.', style: { dim: true } }])
  for (const n of notes.slice(0, 6)) L.push(row(width, [{ text: '  ' }, { text: n.text, style: { dim: n.isRead }, scrolls: true }]))
  return L
}

let regions: { row: number; x0: number; x1: number; action: () => void }[] = []

function draw() {
  const width = out.columns || WIDE
  const height = out.rows || 24
  // Built at full width first: if the body overflows, again one column narrower for the scrollbar.
  hscrollMax = 0
  let all = lines(width)
  const overflows = all.length > height
  if (overflows) {
    hscrollMax = 0
    all = lines(width - 1)
  }
  hscroll = Math.max(0, Math.min(hscroll, hscrollMax))
  const head = all.slice(0, headRows)
  const body = all.slice(headRows)
  const bodyRows = Math.max(1, height - head.length)
  scroll = Math.max(0, Math.min(scroll, body.length - bodyRows))
  const shown = [...head, ...body.slice(scroll, scroll + bodyRows)]

  // The scrollbar: a thumb sized and placed by what part of the body shows.
  const thumb = Math.max(1, Math.round((bodyRows * bodyRows) / Math.max(body.length, 1)))
  const thumbAt = body.length > bodyRows ? Math.round((scroll / (body.length - bodyRows)) * (bodyRows - thumb)) : 0

  regions = []
  let frame = '\x1b[H'
  for (let r = 0; r < height; r++) {
    const line = shown[r] ?? []
    const lineWidth = overflows ? width - 1 : width
    let x = 0
    let text = ''
    for (const span of line) {
      const room = lineWidth - x
      if (room <= 0) break
      const piece = cells(span.text) > room ? fit(span.text, room) : span.text
      const w = cells(piece)
      if (span.action) regions.push({ row: r + 1, x0: x + 1, x1: x + w, action: span.action })
      text += sgr(span.style) + piece
      x += w
    }
    text += sgr() + ' '.repeat(Math.max(0, lineWidth - x))
    if (overflows) {
      const b = r - head.length
      text += b < 0 ? ' ' : b >= thumbAt && b < thumbAt + thumb ? `${sgr({ color: CYAN })}┃` : `${sgr({ dim: true })}│`
    }
    frame += text + sgr() + (r < height - 1 ? '\r\n' : '')
  }
  out.write(frame)
  // The arrows show only once titles are measured: draw again when that changes.
  if (measuredMax !== hscrollMax) {
    measuredMax = hscrollMax
    draw()
  }
}

// ---- State file -------------------------------------------------------------------

function load() {
  const path = `${DIR}/${STATE_FILE}`
  if (!existsSync(path)) return
  try {
    snapshot = JSON.parse(readFileSync(path, 'utf8')) as Snapshot
  } catch {
    return // mid-write: the next change or tick reads it whole
  }
  draw()
}

// ---- Input: SGR mouse reports and a few keys ----------------------------------------

function onInput(data: Buffer) {
  const text = data.toString('utf8')
  for (const m of text.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
    const button = Number(m[1])
    const x = Number(m[2])
    const y = Number(m[3])
    if (button === 64) scroll = Math.max(0, scroll - 2)
    else if (button === 65) scroll += 2
    else if (button === 66 || button === 68) hscroll = Math.max(0, hscroll - 4)
    else if (button === 67 || button === 69) hscroll += 4
    else if (button === 0 && m[4] === 'M') {
      const hit = regions.find(r => r.row === y && x >= r.x0 && x <= r.x1)
      if (hit) hit.action()
      focusClaude()
    }
    draw()
  }
  if (text === 'q' || text === '\x03') shutdown()
}

function shutdown() {
  out.write('\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l')
  process.exit(0)
}

out.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[2J')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', onInput)
// Start open at your width, whatever size the pane had (a restart keeps a folded pane's 5).
if (process.env.TMUX_PANE && (out.columns ?? 0) < MIN_FULL) setCollapsed(false)
out.on('resize', () => {
  rememberWidth()
  draw()
})
process.on('SIGTERM', shutdown)
process.on('SIGHUP', shutdown)

try {
  watch(DIR, (_, name) => {
    if (name === STATE_FILE) load()
  })
} catch {
  // No watcher on this filesystem: the poll below keeps up.
}
setInterval(load, 1000)
load()
draw()
