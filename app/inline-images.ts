// Images in Claude's replies, drawn in the chat: `![alt](/absolute/path.png)` under its paragraph,
// and ```mermaid blocks as diagrams (diagrams.ts). Three ways to draw, picked from the terminal:
// iTerm2's inline images (iTerm2, WezTerm), the kitty graphics protocol (kitty, Ghostty) and Sixel
// (Windows Terminal 1.22+, foot, mlterm, xterm -ti vt340); CLUED_IMAGES=iterm|kitty|sixel|off
// overrides. Where none can draw, an image is a link that opens it in the system's viewer.
//
// The chat is redrawn whole on every frame, so an image keeps N rows of the reply for itself (sized
// to the bubble, at most 20 rows, its aspect kept) and is drawn after the text, at its cells. It is
// drawn again only when it moves: a frame where it stays skips its cells (the cursor steps over
// them), so the text frame never wipes it. Partly scrolled off, it is cropped to the rows in view.

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Renders } from './diagrams.ts'
import type { Render } from './diagrams.ts'
import { cropRows, decodePng, encodePng, imageSize, isPng, scale } from './png.ts'
import type { Bitmap } from './png.ts'
import { sixel } from './sixel.ts'
import { C, cells, clip, pad, remember } from './text.ts'
import type { Line, Span } from './text.ts'
import type { Media } from './markdown.ts'

export type Protocol = 'iterm' | 'kitty' | 'sixel' | 'off'

/** The most rows an image takes, and the largest file and image it draws. */
export const MAX_ROWS = 20
export const MAX_BYTES = 10 << 20
export const MAX_PIXELS = 40_000_000
const MAX_SIDE = 20_000
const EXTS = /\.(png|jpe?g|gif|webp|svg)$/i

/**
 * The protocol this terminal draws images with, from its environment; 'query' when only asking it
 * can tell (a Sixel terminal says so in its device attributes). Off inside tmux and screen, which
 * don't pass images through.
 */
export function detectProtocol(env: Record<string, string | undefined>): Protocol | 'query' {
  const forced = env.CLUED_IMAGES?.trim().toLowerCase()
  if (forced && forced !== 'auto') return forced === 'iterm' || forced === 'iterm2' ? 'iterm' : forced === 'kitty' || forced === 'sixel' ? forced : 'off'
  const term = env.TERM ?? ''
  const program = env.TERM_PROGRAM ?? ''
  if (env.TMUX || env.STY || /^(screen|tmux)/.test(term)) return 'off'
  if (program === 'iTerm.app' || env.LC_TERMINAL === 'iTerm2' || program === 'WezTerm') return 'iterm'
  if (term === 'xterm-kitty' || env.KITTY_WINDOW_ID || program === 'ghostty' || term === 'xterm-ghostty' || env.GHOSTTY_RESOURCES_DIR) return 'kitty'
  if (env.WT_SESSION || /^foot/.test(term) || term === 'mlterm' || env.MLTERM) return 'sixel'
  if (program === 'Apple_Terminal' || term === 'linux' || term === 'dumb') return 'off'
  return 'query'
}

/** Cells an image of `w` × `h` pixels takes: as wide as it is (in cells), at most `maxCols`, at most `maxRows` high, its aspect kept. */
export function fitCells(w: number, h: number, maxCols: number, cell: { w: number; h: number }, maxRows = MAX_ROWS): { cols: number; rows: number } {
  let cols = Math.max(1, Math.min(maxCols, Math.round(w / cell.w)))
  let rows = Math.max(1, Math.round((cols * cell.w * h) / w / cell.h))
  if (rows > maxRows) {
    rows = maxRows
    cols = Math.max(1, Math.min(maxCols, Math.round((rows * cell.h * w) / h / cell.w)))
  }
  return { cols, rows }
}

/** A local file an image link names: an absolute path, file:// or ~/; nothing for a URL or a relative path. */
export function localPath(src: string, home = homedir()): string | undefined {
  let p = src.trim().replace(/^<|>$/g, '')
  if (/^file:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(p.replace(/^file:\/\/(localhost)?/i, ''))
    } catch {
      return undefined
    }
  } else if (p.startsWith('~/')) p = join(home, p.slice(2))
  return p.startsWith('/') && !p.includes('\0') ? p : undefined
}

// ---- Escape sequences -----------------------------------------------------------

export const cup = (row: number, col: number) => `\x1b[${row};${col}H`

/** iTerm2's inline image (OSC 1337 File), `cols` × `rows` cells, its aspect kept inside them. */
export function itermImage(data: Uint8Array, cols: number, rows: number): string {
  const b64 = Buffer.from(data).toString('base64')
  return `\x1b]1337;File=inline=1;size=${data.length};width=${cols};height=${rows};preserveAspectRatio=1;doNotMoveCursor=1:${b64}\x07`
}

/** A PNG sent to kitty to keep as image `id`, in chunks of 4096 (the protocol's most). Nothing is drawn yet. */
export function kittyTransmit(id: number, png: Uint8Array): string {
  const b64 = Buffer.from(png).toString('base64')
  let s = ''
  for (let at = 0; at < b64.length || at === 0; at += 4096) {
    const more = at + 4096 < b64.length ? 1 : 0
    s += at === 0 ? `\x1b_Ga=t,f=100,t=d,i=${id},q=2,m=${more};` : `\x1b_Gm=${more},q=2;`
    s += b64.slice(at, at + 4096) + '\x1b\\'
  }
  return s
}

/** Image `id` drawn at the cursor over `cols` × `rows` cells; `crop` (pixels of the image) for part of it. The cursor stays. */
export function kittyPlace(id: number, cols: number, rows: number, crop?: { x: number; y: number; w: number; h: number }): string {
  const rect = crop ? `,x=${crop.x},y=${crop.y},w=${crop.w},h=${crop.h}` : ''
  return `\x1b_Ga=p,i=${id},p=1,c=${cols},r=${rows}${rect},C=1,q=2\x1b\\`
}

/** Takes image `id` off the screen (kept to draw again); with no id every image, and `free` forgets them too. */
export const kittyDelete = (id?: number, free = false) => (id ? `\x1b_Ga=d,d=i,i=${id},q=2\x1b\\` : `\x1b_Ga=d,d=${free ? 'A' : 'a'},q=2\x1b\\`)

/** What a terminal's answer at the start of `s` is: its length, and what it says. */
export type Reply = { len: number; sixel?: boolean; cell?: { w: number; h: number }; area?: { w: number; h: number } }

/**
 * A terminal's answer to the app's questions, at the start of input: device attributes (CSI ? … c;
 * 4 among them is Sixel), cell size in pixels (CSI 6 ; h ; w t), text area (CSI 4 ; h ; w t), iTerm2's
 * cell size (OSC 1337 ReportCellSize) and kitty's replies (APC G … ST). Undefined when it is none.
 */
export function parseReply(s: string): Reply | undefined {
  let m = s.match(/^\x1b\[\?([\d;]*)c/)
  if (m) return { len: m[0].length, sixel: m[1]!.split(';').slice(1).includes('4') }
  m = s.match(/^\x1b\[6;(\d+);(\d+)t/)
  if (m) return { len: m[0].length, cell: { w: Number(m[2]), h: Number(m[1]) } }
  m = s.match(/^\x1b\[4;(\d+);(\d+)t/)
  if (m) return { len: m[0].length, area: { w: Number(m[2]), h: Number(m[1]) } }
  m = s.match(/^\x1b\]1337;ReportCellSize=([\d.]+);([\d.]+)(?:;([\d.]+))?(?:\x07|\x1b\\)/)
  if (m) {
    const k = Number(m[3] ?? 1)
    return { len: m[0].length, cell: { w: Math.round(Number(m[2]) * k), h: Math.round(Number(m[1]) * k) } }
  }
  m = s.match(/^\x1b_G[^\x1b]*\x1b\\/)
  if (m) return { len: m[0].length }
  return undefined
}

// ---- The app's images -------------------------------------------------------------

/** An image laid out in the chat: its file, its pixels, its cells. */
type Slot = { id: string; file: string; png: boolean; w: number; h: number; cols: number; rows: number; alt: string }
/** Where an image was drawn last frame (its rows and cells), and kitty's id for it. */
type Placed = { key: string; row: number; col: number; cols: number; rows: number; kitty?: number }

/** Erases cells (ECH) over a rectangle: what was drawn there goes, whatever the terminal does with text written over an image. */
const erase = (p: Placed) => Array.from({ length: p.rows }, (_, i) => `${cup(p.row + i, p.col)}\x1b[${p.cols}X`).join('')

export type Opts = {
  env?: Record<string, string | undefined>
  /** The cache folder (~/.clued/cache). */
  cache?: string
  /** Called when something changed what the chat should show (a diagram drawn, the terminal answered). */
  onChange?: () => void
  /** Opens an image in the system's viewer. */
  open?: (path: string) => void
  /** The terminal's size in cells. */
  size?: () => { cols: number; rows: number }
  renders?: Renders
  /** A one-time hint may show (/setup installs the diagram tool): true the first time it would help. */
  hint?: (name: 'diagrams') => boolean
}

export class InlineImages {
  protocol: Protocol
  /** A cell's size in pixels: asked of the terminal; 10 × 20 (Windows Terminal's for Sixel) until it answers. */
  cell = { w: 10, h: 20 }
  private fixedCell = false
  /** The terminal said its cell size (CSI 6 t, or iTerm2's own), not just its text area. */
  private gotCell = false
  private asking = false
  private version = 0
  private slots = new Map<string, Slot>()
  private placed = new Map<string, Placed>()
  private broken = new Set<string>()
  private kittyIds = new Map<string, number>()
  private sent = new Set<number>()
  private bitmaps = new Map<string, Bitmap>()
  private drawn = new Map<string, string>()
  private sizes = new Map<string, { w: number; h: number; type: string } | undefined>()
  readonly renders: Renders
  private opts: Opts

  constructor(opts: Opts = {}) {
    this.opts = opts
    const env = opts.env ?? process.env
    const found = detectProtocol(env)
    this.asking = found === 'query'
    this.protocol = found === 'query' ? 'off' : found
    const fixed = env.CLUED_IMAGE_CELL?.match(/^(\d+)x(\d+)$/)
    if (fixed && Number(fixed[1]) > 0 && Number(fixed[2]) > 0) {
      this.cell = { w: Number(fixed[1]), h: Number(fixed[2]) }
      this.fixedCell = true
    }
    this.renders = opts.renders ?? new Renders(opts.cache ?? join(homedir(), '.clued', 'cache'), () => this.changed())
  }

  private changed() {
    this.version++
    this.opts.onChange?.()
  }

  /**
   * What to ask the terminal when the app starts: its cell size, and (when its environment didn't
   * say) whether it draws Sixel. Nothing when images are off.
   */
  queries(): string {
    if (this.protocol === 'off' && !this.asking) return ''
    return (this.fixedCell ? '' : '\x1b[16t\x1b[14t') + (this.protocol === 'iterm' && !this.fixedCell ? '\x1b]1337;ReportCellSize\x07' : '') + (this.asking ? '\x1b[c' : '')
  }

  /** No answer to the device attributes: no images. */
  giveUp() {
    this.asking = false
  }

  /** Reads a terminal's answer at the start of input; returns how much of it to skip (0: none). */
  reply(s: string): number {
    if (!s.startsWith('\x1b')) return 0
    const r = parseReply(s)
    if (!r) return 0
    if (r.sixel !== undefined && this.asking) {
      this.asking = false
      if (r.sixel) {
        this.protocol = 'sixel'
        this.changed()
      }
    }
    const size = this.opts.size?.()
    const cell = r.cell ?? (r.area && size && size.cols && size.rows ? { w: Math.floor(r.area.w / size.cols), h: Math.floor(r.area.h / size.rows) } : undefined)
    if (cell && !this.fixedCell && cell.w > 0 && cell.h > 0 && (cell.w !== this.cell.w || cell.h !== this.cell.h)) {
      // A cell size from CSI 6 t is the terminal's own word: a text area divided by cells only stands in for it.
      if (r.cell || !this.gotCell) {
        this.cell = cell
        this.reset()
        this.changed()
      }
    }
    if (r.cell) this.gotCell = true
    return r.len
  }

  /** For markdown(): images and diagrams laid out for this terminal. */
  media(): Media {
    const open = this.opts.open
    return {
      key: `${this.protocol}${this.cell.w}x${this.cell.h}.${this.version}`,
      ...(open ? { open } : {}),
      image: (alt, src, width) => this.image(alt, src, width),
      diagram: (code, width) => this.diagram(code, width),
    }
  }

  /** The file to draw for a link (a converted PNG for a format the protocol can't take), and its size. */
  private source(path: string): { file: string; w: number; h: number; png: boolean } | undefined {
    let st
    try {
      st = statSync(path)
    } catch {
      return undefined
    }
    if (!st.isFile() || st.size > MAX_BYTES || st.size === 0) return undefined
    const key = `${path}\0${st.size}\0${st.mtimeMs}`
    const isSvg = /\.svg$/i.test(path)
    let info = this.sizes.get(key)
    if (!this.sizes.has(key)) {
      info = isSvg ? undefined : headerSize(path)
      remember(this.sizes, key, info, 500)
    }
    if (!isSvg && !info) return undefined
    // iTerm2 takes JPEG, GIF and WebP as they are; the others draw from PNG.
    if (info && (info.type === 'png' || this.protocol === 'iterm')) return this.broken.has(path) ? undefined : { file: path, w: info.w, h: info.h, png: info.type === 'png' }
    const r: Render = this.renders.convert(path)
    if (r.state !== 'ready' || this.broken.has(r.png)) return undefined
    const conv = headerSize(r.png)
    return conv?.type === 'png' ? { file: r.png, w: conv.w, h: conv.h, png: true } : undefined
  }

  /** An image's rows (its cells kept for it) and its caption, or undefined to keep it a link. */
  image(alt: string, src: string, width: number): Line[] | undefined {
    if (this.protocol === 'off') return undefined
    const path = localPath(src)
    if (!path || !EXTS.test(path)) return undefined
    const s = this.source(path)
    if (!s || s.w > MAX_SIDE || s.h > MAX_SIDE || s.w * s.h > MAX_PIXELS) return undefined
    return this.rows(s, alt || path.split('/').pop()!, path, Math.max(1, width))
  }

  /** `shown`: the path in the caption and the one a click opens; `where`: whether the caption says it. */
  private rows(s: { file: string; w: number; h: number; png: boolean }, alt: string, shown: string, width: number, where = true): Line[] {
    const { cols, rows } = fitCells(s.w, s.h, width, this.cell)
    const id = `${s.file}|${cols}x${rows}`
    this.slots.set(id, { id, file: s.file, png: s.png, w: s.w, h: s.h, cols, rows, alt })
    const open = this.opts.open
    const go = open ? { action: () => open(shown) } : {}
    const out: Line[] = []
    for (let k = 0; k < rows; k++) out.push([{ text: ' '.repeat(cols), noCopy: true, image: { id, row: k }, ...go }])
    return [...out, caption(alt, shown, width, open, where)]
  }

  /**
   * A mermaid block: the diagram in its place once drawn; meanwhile a note under the code, and without
   * mmdc, once (a hint), that /setup installs it.
   */
  diagram(code: string, width: number): { lines: Line[]; replace: boolean } | undefined {
    const note = (text: string): { lines: Line[]; replace: boolean } => ({ lines: [[{ text: clip(text, width), style: { fg: C.gray, italic: true } }]], replace: false })
    const r = this.renders.diagram(code)
    if (r.state === 'ready') {
      if (this.protocol === 'off') return { lines: [caption('diagram', r.png, width, this.opts.open, false)], replace: false }
      const info = headerSize(r.png)
      if (info?.type !== 'png' || this.broken.has(r.png)) return note('⚠ the diagram came out empty')
      return { lines: this.rows({ file: r.png, w: info.w, h: info.h, png: true }, 'diagram', r.png, width, false), replace: true }
    }
    // With no images here, a drawn diagram is still a link that opens it: the hint helps there too.
    if (r.state === 'missing') return this.opts.hint?.('diagrams') ? note('Diagrams need mmdc: /setup installs the diagram tool') : undefined
    if (this.protocol === 'off') return undefined
    if (r.state === 'drawing') return note('◌ drawing the diagram…')
    return note(`⚠ couldn't draw the diagram: ${r.error}`)
  }

  /**
   * One frame's images. `rows`: the chat's lines on screen, each with its screen row (1-based);
   * `col`: the screen column of a line's first cell. `blocked`: cells drawn over the chat after it
   * (an image there waits). Returns lines to draw instead (an image's cells skipped, as it is
   * already there), what to write before the text (where images were) and after it.
   */
  frame(rows: { line: Line; row: number }[], col: number, blocked: { row: number; col0: number; col1: number }[] = []): { lines: Map<number, Line>; before: string; out: string } {
    const lines = new Map<number, Line>()
    let out = ''
    if (this.protocol === 'off') return { lines, before: '', out }
    type Seen = { slot: Slot; col: number; at: { k: number; row: number; i: number; s: number }[] }
    const seen = new Map<string, Seen>()
    rows.forEach(({ line, row }, i) => {
      let x = 0
      line.forEach((sp, s) => {
        const slot = sp.image ? this.slots.get(sp.image.id) : undefined
        if (slot && sp.image) {
          const e = seen.get(slot.id) ?? { slot, col: col + x, at: [] }
          const hidden = blocked.some(b => b.row === row && b.col0 <= col + x + slot.cols - 1 && b.col1 >= col + x)
          if (!hidden) e.at.push({ k: sp.image.row, row, i, s })
          seen.set(slot.id, e)
        }
        x += cells(sp.text)
      })
    })
    const now = new Map<string, Placed>()
    for (const [id, e] of seen) {
      // The rows in view, from the first one shown to the first gap.
      const at = e.at.sort((a, b) => a.k - b.k)
      let n = 0
      while (n < at.length && at[n]!.k === at[0]!.k + n) n++
      const run = at.slice(0, n)
      if (!run.length) continue
      const k0 = run[0]!.k
      const k1 = run.at(-1)!.k
      const whole = k0 === 0 && k1 === e.slot.rows - 1
      const key = `${run[0]!.row},${e.col}:${k0}-${k1}`
      const prev = this.placed.get(id)
      const skip = () => {
        for (const a of run) {
          const line = lines.get(a.i) ?? rows[a.i]!.line.slice()
          line[a.s] = { ...line[a.s]!, image: { ...line[a.s]!.image!, skip: true } }
          lines.set(a.i, line)
        }
      }
      if (prev?.key === key) {
        now.set(id, prev)
        skip()
        continue
      }
      const drawn = this.draw(e.slot, k0, k1, whole)
      if (drawn === undefined) {
        // Can't be cropped (a JPEG in iTerm2): a note until all of it is in view.
        const a = run[0]!
        const line = lines.get(a.i) ?? rows[a.i]!.line.slice()
        line[a.s] = { ...line[a.s]!, text: fitText(`▒ ${e.slot.alt} (scroll to see it)`, e.slot.cols), style: { fg: C.faint } }
        lines.set(a.i, line)
        continue
      }
      const kitty = this.protocol === 'kitty' ? this.kittyId(e.slot) : undefined
      out += cup(run[0]!.row, e.col) + drawn
      now.set(id, { key, row: run[0]!.row, col: e.col, cols: e.slot.cols, rows: run.length, ...(kitty ? { kitty } : {}) })
    }
    // Moved or gone: kitty's taken off, the others' cells erased before the text is drawn.
    let before = ''
    for (const [id, p] of this.placed) if (now.get(id) !== p) before += p.kitty ? kittyDelete(p.kitty) : erase(p)
    this.placed = now
    return { lines, before, out }
  }

  private kittyId(slot: Slot): number {
    let id = this.kittyIds.get(slot.file)
    if (!id) {
      id = 0x434c0000 + this.kittyIds.size + 1
      this.kittyIds.set(slot.file, id)
    }
    return id
  }

  /** The sequence that draws rows `k0` to `k1` of an image; undefined when it can't be drawn cropped. */
  private draw(slot: Slot, k0: number, k1: number, whole: boolean): string | undefined {
    const memo = `${this.protocol}|${slot.id}|${k0}-${k1}|${this.cell.w}x${this.cell.h}`
    const known = this.drawn.get(memo)
    if (known !== undefined) return known
    let s: string | undefined
    try {
      s = this.build(slot, k0, k1, whole)
    } catch {
      // A file that isn't what it says: a link from now on.
      this.broken.add(slot.file)
      this.slots.delete(slot.id)
      setImmediate(() => this.changed())
      return ''
    }
    if (s !== undefined && this.protocol !== 'kitty') remember(this.drawn, memo, s, 12)
    return s
  }

  private build(slot: Slot, k0: number, k1: number, whole: boolean): string | undefined {
    const rows = k1 - k0 + 1
    if (this.protocol === 'kitty') {
      const id = this.kittyId(slot)
      let s = ''
      if (!this.sent.has(id)) {
        const data = readFileSync(slot.file)
        if (!isPng(data)) throw new Error('not a PNG')
        s += kittyTransmit(id, data)
        this.sent.add(id)
      }
      const y = Math.round((slot.h * k0) / slot.rows)
      const y1 = Math.round((slot.h * (k1 + 1)) / slot.rows)
      return s + kittyPlace(id, slot.cols, rows, whole ? undefined : { x: 0, y, w: slot.w, h: Math.max(1, y1 - y) })
    }
    if (this.protocol === 'iterm') {
      const data = readFileSync(slot.file)
      // As it is when it fits and isn't big; else drawn at twice the cells' pixels (for a Retina screen).
      if (whole && (!slot.png || data.length <= 1 << 20)) return itermImage(data, slot.cols, slot.rows)
      if (!slot.png) return undefined
      const box = this.bitmap(slot, Math.min(slot.w, slot.cols * this.cell.w * 2), Math.min(slot.h, slot.rows * this.cell.h * 2))
      const crop = cropRows(box, Math.round((box.height * k0) / slot.rows), Math.round((box.height * (k1 + 1)) / slot.rows))
      return itermImage(encodePng(crop), slot.cols, rows)
    }
    // Sixel: the cells' own pixels, exactly, so the image ends where its rows do.
    const box = this.bitmap(slot, slot.cols * this.cell.w, slot.rows * this.cell.h)
    return sixel(cropRows(box, k0 * this.cell.h, (k1 + 1) * this.cell.h))
  }

  /** The image decoded and scaled to `w` × `h` (a few kept). */
  private bitmap(slot: Slot, w: number, h: number): Bitmap {
    const key = `${slot.file}|${Math.round(w)}x${Math.round(h)}`
    const known = this.bitmaps.get(key)
    if (known) return known
    const img = scale(decodePng(readFileSync(slot.file), MAX_PIXELS), w, h)
    remember(this.bitmaps, key, img, 4)
    return img
  }

  /**
   * Images off the screen (the session picker covers it, the window was resized): drawn again next
   * frame. `free`: kitty forgets them too (the app is quitting).
   */
  hide(free = false): string {
    const had = [...this.placed.values()]
    this.placed.clear()
    if (this.protocol !== 'kitty') return had.map(erase).join('')
    if (!had.length && !free) return ''
    if (free) this.sent.clear()
    return kittyDelete(undefined, free)
  }

  /** The window changed size: everything is laid out and drawn again; the cell size is asked again. */
  resized(): string {
    this.drawn.clear()
    const off = this.hide()
    return off + (this.protocol !== 'off' && !this.fixedCell ? '\x1b[16t\x1b[14t' : '')
  }

  private reset() {
    this.drawn.clear()
    this.bitmaps.clear()
  }
}

/** The line under an image: what it is (a click opens it) and where the file is. */
function caption(alt: string, path: string, width: number, open?: (path: string) => void, showPath = true): Line {
  const label = `[image: ${alt}]`
  const where = path.replace(homedir(), '~')
  const head: Span = { text: clip(label, width), style: { fg: C.blue, underline: true }, ...(open ? { action: () => open(path) } : {}) }
  const room = width - cells(head.text) - 1
  return showPath && room > 4 ? [head, { text: ' ' + clip(where, room), style: { fg: C.gray } }] : [head]
}

const fitText = (text: string, w: number) => {
  const t = clip(text, w)
  return t + pad(w - cells(t)).text
}

/** The size in a file's header; undefined when it isn't an image the app knows. */
function headerSize(path: string): { w: number; h: number; type: string } | undefined {
  try {
    // The size is near the start; a JPEG's can come after its EXIF, so up to 256 KB of it.
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(256 << 10)
    let n = 0
    try {
      n = readSync(fd, buf, 0, buf.length, 0)
    } finally {
      closeSync(fd)
    }
    const s = imageSize(buf.subarray(0, n))
    return s && s.width > 0 && s.height > 0 ? { w: s.width, h: s.height, type: s.type } : undefined
  } catch {
    return undefined
  }
}
