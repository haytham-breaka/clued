// Comet: a small game to play while Claude works (Ctrl+G opens it in the chat's place). A comet flies
// across a night sky that wraps round at its edges; each ✦ spark it gathers makes its fading tail
// longer, every fifth one lights a ★ star worth more for a few seconds, and the run ends when the
// comet flies into its own tail. Pure: no timers and no I/O. The app steps it about 10 times a second
// and draws gameLines where the chat goes; the best score is kept in ~/.clued/panel.json.

import { C, clipLine, lineCells, pad } from './text.ts'
import type { Line, Span } from './text.ts'

export const GAME_NAME = 'Comet'
/** One step each 100 ms: 10 a second. */
export const TICK_MS = 100

export type Dir = 'up' | 'down' | 'left' | 'right'
export type Pt = { x: number; y: number }
/** ready: not started yet; over: the comet broke up. */
export type GameState = 'ready' | 'playing' | 'paused' | 'over'
export type Game = {
  /** The sky's size, in game cells (each drawn two terminal cells wide, so they look square). */
  w: number
  h: number
  /** The comet, head first. */
  body: Pt[]
  dir: Dir
  /** Turns pressed since the last step, at most two: a quick ↑→ makes both. */
  turns: Dir[]
  /** null when the sky is full. */
  spark: Pt | null
  /** A bonus star, for `ttl` more steps. */
  star: { at: Pt; ttl: number } | null
  /** Cells the tail still grows by. */
  grow: number
  sparks: number
  score: number
  /** The best score before this run (bestOf has this run's too). */
  best: number
  state: GameState
  /** Why it paused, when the app paused it (Claude answered); '' otherwise. */
  note: string
  /** The random generator's state: the same seed plays the same game. */
  seed: number
}

const START_LEN = 3
const GROW = 2
const SPARK_POINTS = 1
const STAR_POINTS = 5
const STAR_EVERY = 5
/** 6 seconds at 10 steps a second. */
const STAR_TTL = 60
/** The smallest sky worth playing in, and the largest (a huge one takes too long to cross). */
export const MIN_W = 10
export const MIN_H = 6
const MAX_W = 32
const MAX_H = 18
/** Rows besides the sky: its top and bottom edges, the line under it, and the keys. */
const CHROME = 4

const STEP: Record<Dir, Pt> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }
const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' }

/** mulberry32: small, fast and good enough for where a spark lands. */
function rand(g: Game): number {
  g.seed = (g.seed + 0x6d2b79f5) | 0
  let t = g.seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const same = (a: Pt, b: Pt) => a.x === b.x && a.y === b.y
const wrap = (n: number, size: number) => ((n % size) + size) % size

/** A random cell nothing is in, or null when there is none. */
function place(g: Game): Pt | null {
  const taken = new Set(g.body.map(p => p.y * g.w + p.x))
  if (g.spark) taken.add(g.spark.y * g.w + g.spark.x)
  if (g.star) taken.add(g.star.at.y * g.w + g.star.at.x)
  const free: Pt[] = []
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (!taken.has(y * g.w + x)) free.push({ x, y })
  return free.length ? free[Math.floor(rand(g) * free.length)]! : null
}

/** A new game in a sky of w × h, flying right from its middle; it starts with the first key. */
export function newGame(w: number, h: number, best = 0, seed = Date.now()): Game {
  const head = { x: Math.floor(w / 2), y: Math.floor(h / 2) }
  const body = Array.from({ length: Math.min(START_LEN, w) }, (_, i) => ({ x: wrap(head.x - i, w), y: head.y }))
  const g: Game = { w, h, body, dir: 'right', turns: [], spark: null, star: null, grow: 0, sparks: 0, score: 0, best, state: 'ready', note: '', seed: seed | 0 }
  g.spark = place(g)
  return g
}

/** An arrow or WASD: turns at the next step. Going straight back into the tail is ignored. */
export function steer(g: Game, d: Dir) {
  if (g.state === 'over' || g.state === 'paused') return
  if (g.state === 'ready') g.state = 'playing'
  const last = g.turns.at(-1) ?? g.dir
  if (d === last || d === OPPOSITE[last] || g.turns.length >= 2) return
  g.turns.push(d)
}

/** Space: pause, play on, start; after a run, a new one. */
export function togglePause(g: Game): Game {
  if (g.state === 'over') return again(g)
  g.state = g.state === 'playing' ? 'paused' : 'playing'
  g.note = ''
  return g
}

/** The best score, this run's included. */
export const bestOf = (g: Game) => Math.max(g.best, g.score)

/** A new run in the same sky, playing at once, the best score kept. */
export function again(g: Game): Game {
  const n = newGame(g.w, g.h, bestOf(g), g.seed)
  n.state = 'playing'
  return n
}

/** The app pauses the game when Claude answers or asks: `note` says so until you play on. */
export function pauseFor(g: Game, note: string) {
  if (g.state === 'playing') g.state = 'paused'
  g.note = note
}

/** One step: the comet moves a cell, gathers what it flies into, or breaks up on its tail. Its state after. */
export function step(g: Game): GameState {
  if (g.state !== 'playing') return g.state
  g.dir = g.turns.shift() ?? g.dir
  const d = STEP[g.dir]
  const head = { x: wrap(g.body[0]!.x + d.x, g.w), y: wrap(g.body[0]!.y + d.y, g.h) }
  // The tail's last cell moves out of the way this step, unless the tail is growing.
  const tail = g.grow > 0 ? g.body : g.body.slice(0, -1)
  if (tail.some(p => same(p, head))) return (g.state = 'over')
  g.body.unshift(head)
  if (g.grow > 0) g.grow--
  else g.body.pop()
  if (g.star) {
    if (same(g.star.at, head)) {
      g.score += STAR_POINTS
      g.star = null
    } else if (--g.star.ttl <= 0) g.star = null
  }
  if (g.spark && same(g.spark, head)) {
    g.score += SPARK_POINTS
    g.sparks++
    g.grow += GROW
    g.spark = null
    if (g.sparks % STAR_EVERY === 0 && !g.star) {
      const at = place(g)
      if (at) g.star = { at, ttl: STAR_TTL }
    }
    g.spark = place(g)
    // Nowhere left for a spark: the sky is full, and that is the best a run can end.
    if (!g.spark) g.state = 'over'
  }
  return g.state
}

/**
 * The window changed size: the sky takes the new size. What no longer fits wraps round into it, and
 * the tail is cut where it would cross itself; a spark or star left outside moves in.
 */
export function resize(g: Game, w: number, h: number) {
  if (g.w === w && g.h === h) return
  g.w = w
  g.h = h
  const seen = new Set<number>()
  const body: Pt[] = []
  for (const p of g.body) {
    const q = { x: wrap(p.x, w), y: wrap(p.y, h) }
    if (seen.has(q.y * w + q.x)) break
    seen.add(q.y * w + q.x)
    body.push(q)
  }
  g.body = body
  g.grow = Math.min(g.grow, w * h - body.length)
  if (g.star && (g.star.at.x >= w || g.star.at.y >= h || seen.has(g.star.at.y * w + g.star.at.x))) g.star = null
  if (!g.spark || g.spark.x >= w || g.spark.y >= h || seen.has(g.spark.y * w + g.spark.x)) {
    g.spark = null
    g.spark = place(g)
  }
}

/** The sky that fits `cols` × `rows` terminal cells, or null when even the smallest does not. */
export function boardSize(cols: number, rows: number): { w: number; h: number } | null {
  const w = Math.min(MAX_W, Math.floor((cols - 2) / 2))
  const h = Math.min(MAX_H, rows - CHROME)
  return w < MIN_W || h < MIN_H ? null : { w, h }
}

/** What the game needs, in terminal cells, for the "make the window bigger" line. */
export const MIN_COLS = MIN_W * 2 + 2
export const MIN_ROWS = MIN_H + CHROME

/** The banner after ← back: the game's name, the score and the best score. */
export function gameBanner(g: Game | null): Span[] {
  return [
    { text: ` ✦ ${GAME_NAME} `, style: { bg: C.yellow, fg: 16, bold: true } },
    { text: `  score ${g?.score ?? 0}`, style: { fg: C.cyan, bold: true } },
    { text: `  best ${g ? bestOf(g) : 0}`, style: { fg: C.gray } },
  ]
}

/** A faint star in the sky's background, at fixed places. */
const isBackStar = (x: number, y: number) => (((x * 73856093) ^ (y * 19349663)) >>> 0) % 19 === 0

/** One sky cell, two terminal cells wide. */
function cell(g: Game, x: number, y: number, at: Map<number, number>): Span {
  const i = at.get(y * g.w + x)
  if (i != null) {
    const over = g.state === 'over'
    if (i === 0) return { text: '██', style: { fg: over ? C.red : C.yellow } }
    // The tail fades toward its end.
    const f = i / g.body.length
    return { text: f < 0.34 ? '▓▓' : f < 0.67 ? '▒▒' : '░░', style: { fg: over ? C.red : f < 0.34 ? C.claudeName : C.claude } }
  }
  if (g.star && g.star.at.x === x && g.star.at.y === y) return { text: '★ ', style: { fg: C.magenta, bold: true } }
  if (g.spark && g.spark.x === x && g.spark.y === y) return { text: '✦ ', style: { fg: C.cyan, bold: true } }
  return { text: isBackStar(x, y) ? '· ' : '  ', style: { fg: C.faint } }
}

/** A line centred in `cols` (cut at its end when it is wider). */
function centred(spans: Span[], cols: number): Line {
  const w = lineCells(spans)
  return w > cols ? clipLine(spans, cols) : [pad(Math.floor((cols - w) / 2)), ...spans]
}

/** How to start, that it is paused, or how the run ended; while it flies, a star's time left. */
function stateLine(g: Game): Span[] {
  switch (g.state) {
    case 'ready':
      return [{ text: 'Arrows or WASD to fly, Space to start. Gather ✦, and keep off your tail.', style: { fg: C.cyan } }]
    case 'paused':
      return [{ text: g.note ? 'Space to play on' : 'Paused · Space to play on', style: { fg: C.yellow, bold: !g.note } }]
    case 'over':
      return [{ text: g.spark ? `The comet broke up at ${g.score}` : `The sky is full at ${g.score}`, style: { fg: C.red, bold: true } }, ...(g.score > g.best ? [{ text: ' · a new best', style: { fg: C.green, bold: true } }] : []), { text: ' · Space or Enter to fly again', style: { fg: C.gray } }]
    default:
      return g.star ? [{ text: `★ worth ${STAR_POINTS} for ${Math.ceil(g.star.ttl / 10)} s`, style: { fg: C.magenta } }] : []
  }
}

const KEYS: Span[] = [{ text: '←↑↓→ or WASD steer · Space pause · Esc back to the chat', style: { fg: C.faint } }]

/**
 * The game's `rows` lines, `cols` cells wide: the sky in a frame, centred, the state under it and the
 * keys last. No game, or a sky that doesn't fit (the window is too small for any): one line asking
 * for a bigger window.
 */
export function gameLines(g: Game | null, cols: number, rows: number): Line[] {
  const out: Line[] = Array.from({ length: rows }, () => [])
  if (!g || !boardSize(cols, rows) || g.w * 2 + 2 > cols || g.h + CHROME > rows) {
    const say = `Make the window bigger to play ${GAME_NAME}: it needs ${MIN_COLS} columns and ${MIN_ROWS} rows here. Esc back to the chat.`
    if (rows > 0) out[Math.floor((rows - 1) / 2)] = centred([{ text: say, style: { fg: C.yellow } }], cols)
    return out
  }
  const at = new Map(g.body.map((p, i) => [p.y * g.w + p.x, i]))
  const left = pad(Math.floor((cols - (g.w * 2 + 2)) / 2))
  const edge = { fg: g.state === 'playing' ? C.faint : C.gray }
  const lines: Line[] = [[left, { text: `╭${'─'.repeat(g.w * 2)}╮`, style: edge }]]
  for (let y = 0; y < g.h; y++) {
    const row: Line = [left, { text: '│', style: edge }]
    for (let x = 0; x < g.w; x++) row.push(cell(g, x, y, at))
    row.push({ text: '│', style: edge })
    lines.push(row)
  }
  lines.push([left, { text: `╰${'─'.repeat(g.w * 2)}╯`, style: edge }])
  // Under the sky: why the app paused it (Claude answered), in the keys' place; else the state, then the keys.
  if (g.note) lines.push(centred([{ text: g.note, style: { fg: C.yellow, bold: true } }], cols), centred(stateLine(g), cols))
  else lines.push(centred(stateLine(g), cols), centred(KEYS, cols))
  const top = Math.floor((rows - lines.length) / 2)
  lines.forEach((l, i) => (out[top + i] = l))
  return out
}

/** The direction a key steers in: the arrows (as the app reads them) and WASD, either case. */
export function keyDir(k: string): Dir | undefined {
  switch (k) {
    case '\x1b[A':
    case 'w':
    case 'W':
      return 'up'
    case '\x1b[B':
    case 's':
    case 'S':
      return 'down'
    case '\x1b[D':
    case 'a':
    case 'A':
      return 'left'
    case '\x1b[C':
    case 'd':
    case 'D':
      return 'right'
  }
  return undefined
}
