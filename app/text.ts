// Text on a terminal grid: cell widths, styled spans, wrapping.

export type Style = {
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
  /** 256-colour index, or a named basic colour. */
  fg?: number
  bg?: number
}
/** `noCopy`: drawn but left out of a copied selection (a code block's line numbers, a diff's + and −). */
export type Span = { text: string; style?: Style; action?: () => void; noCopy?: boolean }
export type Line = Span[]

export const C = {
  cyan: 80,
  blue: 75,
  magenta: 177,
  yellow: 221,
  green: 114,
  red: 203,
  gray: 245,
  faint: 239,
  white: 255,
  codeBg: 236,
  meBg: 24,
  claudeBg: 235,
  /** Claude's avatar (the terracotta of its mark) and name. */
  claude: 173,
  claudeName: 216,
} as const

export const sgr = (s: Style = {}) =>
  `\x1b[0${s.bold ? ';1' : ''}${s.dim ? ';2' : ''}${s.italic ? ';3' : ''}${s.underline ? ';4' : ''}${s.inverse ? ';7' : ''}${s.fg != null ? `;38;5;${s.fg}` : ''}${s.bg != null ? `;48;5;${s.bg}` : ''}m`

const isWide = (cp: number) =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  cp === 0x231a || cp === 0x231b || cp === 0x23e9 || cp === 0x23ea || cp === 0x23eb || cp === 0x23ec || cp === 0x23f0 || cp === 0x23f3 ||
  (cp >= 0x25fd && cp <= 0x25fe) || (cp >= 0x2614 && cp <= 0x2615) || (cp >= 0x2648 && cp <= 0x2653) || cp === 0x267f || cp === 0x2693 ||
  cp === 0x26a1 || (cp >= 0x26aa && cp <= 0x26ab) || (cp >= 0x26bd && cp <= 0x26be) || (cp >= 0x26c4 && cp <= 0x26c5) || cp === 0x26ce ||
  cp === 0x26d4 || cp === 0x26ea || (cp >= 0x26f2 && cp <= 0x26f3) || cp === 0x26f5 || cp === 0x26fa || cp === 0x26fd || cp === 0x2705 ||
  (cp >= 0x270a && cp <= 0x270b) || cp === 0x2728 || cp === 0x274c || cp === 0x274e || (cp >= 0x2753 && cp <= 0x2755) || cp === 0x2757 ||
  (cp >= 0x2795 && cp <= 0x2797) || cp === 0x27b0 || cp === 0x27bf || (cp >= 0x2b1b && cp <= 0x2b1c) || cp === 0x2b50 || cp === 0x2b55 ||
  (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f680 && cp <= 0x1f6ff) ||
  (cp >= 0x1f900 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)

const ASCII = /^[\x20-\x7e]*$/

/** Cells one character takes. */
export function charCells(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  if (cp === 0xfe0f || cp === 0x200d || (cp >= 0x300 && cp <= 0x36f)) return 0
  if (cp < 32) return 0
  return isWide(cp) ? 2 : 1
}

export function cells(text: string): number {
  // Most text is plain ASCII: one cell a character.
  if (ASCII.test(text)) return text.length
  let n = 0
  for (const ch of text) n += charCells(ch)
  return n
}

export const lineCells = (line: Line) => line.reduce((n, s) => n + cells(s.text), 0)

/** `text` cut to `width` cells, with … when cut. */
export function clip(text: string, width: number): string {
  if (width <= 0) return ''
  if (cells(text) <= width) return text
  let s = ''
  let w = 0
  for (const ch of text) {
    const c = charCells(ch)
    if (w + c > width - 1) break
    s += ch
    w += c
  }
  return s + '…'
}

/** A line cut to `width` cells. */
export function clipLine(line: Line, width: number): Line {
  const out: Line = []
  let room = width
  for (const sp of line) {
    if (room <= 0) break
    const w = cells(sp.text)
    if (w <= room) {
      out.push(sp)
      room -= w
    } else {
      out.push({ ...sp, text: clip(sp.text, room) })
      room = 0
    }
  }
  return out
}

export const pad = (n: number, style?: Style): Span => ({ text: ' '.repeat(Math.max(0, n)), style })

/**
 * Wraps styled spans into lines of at most `width` cells, breaking at spaces where it can.
 * `indent` starts every line after the first (a list item's hanging indent).
 */
export function wrap(spans: Span[], width: number, indent: Span[] = []): Line[] {
  width = Math.max(4, width)
  // Words that keep their style: split each span at spaces, keeping the spaces.
  const words: Span[] = []
  for (const sp of spans) for (const part of sp.text.split(/(\s+)/)) if (part) words.push({ ...sp, text: part })

  const lines: Line[] = []
  let line: Line = []
  let w = 0
  const indentW = lineCells(indent)
  const flush = () => {
    // No trailing spaces.
    while (line.length && /^\s+$/.test(line.at(-1)!.text)) line.pop()
    lines.push(line)
    line = [...indent]
    w = indentW
  }
  for (const word of words) {
    if (word.text.includes('\n')) {
      const parts = word.text.split('\n')
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) flush()
        if (parts[i]) {
          line.push({ ...word, text: parts[i]!.replace(/\s/g, ' ') })
          w += cells(parts[i]!)
        }
      }
      continue
    }
    const ww = cells(word.text)
    const isSpace = /^\s+$/.test(word.text)
    if (isSpace) {
      if (w === indentW && lines.length > 0) continue // no leading space on a wrapped line
      if (w + ww <= width) {
        line.push({ ...word, text: ' '.repeat(ww) })
        w += ww
      }
      continue
    }
    if (w + ww <= width) {
      line.push(word)
      w += ww
      continue
    }
    if (w > indentW) flush()
    // A word longer than the line: hard-break it.
    let rest = word.text
    while (cells(rest) > width - w) {
      let piece = ''
      let pw = 0
      for (const ch of rest) {
        const c = charCells(ch)
        if (w + pw + c > width) break
        piece += ch
        pw += c
      }
      if (!piece) break
      line.push({ ...word, text: piece })
      rest = rest.slice(piece.length)
      w += pw
      flush()
    }
    if (rest) {
      line.push({ ...word, text: rest })
      w += cells(rest)
    }
  }
  if (line.length > indent.length || lines.length === 0) flush()
  return lines
}

/** The line with its cells from `from` up to (not including) `to` drawn in reverse: a selection. */
export function markCells(line: Line, from: number, to: number): Line {
  if (to <= from) return line
  const out: Line = []
  let at = 0
  for (const sp of line) {
    let cur = ''
    let isCur: boolean | undefined
    if (sp.noCopy) {
      // Not part of what a selection copies, so not drawn as selected either.
      out.push(sp)
      at += cells(sp.text)
      continue
    }
    const flush = () => {
      if (cur) out.push({ ...sp, text: cur, style: isCur ? { ...sp.style, inverse: !sp.style?.inverse } : sp.style })
      cur = ''
    }
    for (const ch of sp.text) {
      const isSel = at >= from && at < to
      if (isCur !== undefined && isSel !== isCur) flush()
      isCur = isSel
      cur += ch
      at += charCells(ch)
    }
    flush()
  }
  return out
}

/** The characters in a line's cells from `from` up to (not including) `to`. */
export function cellText(line: Line, from: number, to: number): string {
  let s = ''
  let at = 0
  for (const sp of line)
    for (const ch of sp.text) {
      if (at >= from && at < to && !sp.noCopy) s += ch
      at += charCells(ch)
    }
  return s
}

/** Keeps `value` under `key`, forgetting the oldest entries past `max`. */
export function remember<K, V>(cache: Map<K, V>, key: K, value: V, max = 5000) {
  cache.set(key, value)
  if (cache.size > max) for (const k of [...cache.keys()].slice(0, cache.size - max)) cache.delete(k)
}
