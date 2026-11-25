// Markdown to styled terminal lines: headings, lists, quotes, code blocks, tables,
// inline `code`, **bold**, *italic*, [links](url). Enough for Claude's answers.

import { C, cells, clipLine, lineCells, pad, remember, wrap } from './text.ts'
import type { Line, Span, Style } from './text.ts'
import { clean, hardWrap, highlight, K, langOf } from './code.ts'
import { bidiLine, bidiMode, isRtl } from './bidi.ts'
import { localPath } from './inline-images.ts'

/**
 * Images in markdown (inline-images.ts gives these): `image` lays out `![alt](src)` under its
 * paragraph, `diagram` a ```mermaid block; either gives undefined to leave it as it is. Without
 * them an image is a `[image: alt]` link that `open` opens. `key` changes whenever what they give can.
 */
export type Media = {
  key: string
  open?: (path: string) => void
  image?: (alt: string, src: string, width: number) => Line[] | undefined
  diagram?: (code: string, width: number) => { lines: Line[]; replace: boolean } | undefined
}

/** `![alt](src)`, and `![alt](src "title")`. */
const IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g

/**
 * Whether a block is worth a copy button: a labelled code block always is; an unlabelled one or a
 * quote is not when it draws an interface (box lines, blocks, spinners, ✻, emoji), which is a picture.
 */
export function isCopyable(text: string, lang = ''): boolean {
  if (lang && !/^(text|txt|plain)$/i.test(lang)) return true
  return !/[\u2500-\u259f\u2800-\u28ff\u2731\u273b\u23f3\u270b]|\p{Extended_Pictographic}/u.test(text)
}

/** The copy action of the markdown() call in progress: inline code copies itself on a click. */
let copyNow: ((text: string) => void) | undefined
/** And its opener: a click on `[image: alt]` opens the file. */
let openNow: ((path: string) => void) | undefined

const INLINE = /(`+)([^`]+?)\1|\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w*])\*([^*\s][^*]*?)\*(?!\w)|(?<!\w)_([^_\s][^_]*?)_(?!\w)|\[([^\]]+)\]\(([^)\s]+)\)|~~([^~]+)~~/
/** Inline markdown, an image last (`!` before a link). */
const INLINE_ALL = new RegExp(`${INLINE.source}|${IMAGE.source}`, 'g')

/** Inline markdown in one paragraph to spans. */
export function inline(text: string, base: Style = {}): Span[] {
  const out: Span[] = []
  let at = 0
  for (const m of text.matchAll(INLINE_ALL)) {
    if (m.index! > at) out.push({ text: text.slice(at, m.index), style: base })
    if (m[2] != null) {
      const code = m[2]
      const copy = copyNow
      // Left to right even inside right-to-left words.
      out.push({ text: code, style: { ...base, fg: C.yellow, bg: C.codeBg }, ltr: true, ...(copy ? { action: () => copy(code) } : {}) })
    }
    else if (m[3] != null || m[4] != null) out.push(...inline(m[3] ?? m[4]!, { ...base, bold: true }))
    else if (m[5] != null || m[6] != null) out.push(...inline(m[5] ?? m[6]!, { ...base, italic: true }))
    else if (m[7] != null) {
      out.push({ text: m[7], style: { ...base, fg: C.blue, underline: true } })
      if (m[8] !== m[7] && !/^#/.test(m[8]!)) out.push({ text: ` (${m[8]})`, style: { ...base, fg: C.gray } })
    } else if (m[9] != null) out.push({ text: m[9], style: { ...base, dim: true } })
    else if (m[11] != null) out.push(...imageLink(m[10]!, m[11], base))
    at = m.index! + m[0].length
  }
  if (at < text.length) out.push({ text: text.slice(at), style: base })
  return out
}

/**
 * An image not drawn: a local file is `[image: alt]`, a click opens it; a remote one stays a link,
 * never fetched.
 */
function imageLink(alt: string, src: string, base: Style): Span[] {
  const path = localPath(src)
  const open = openNow
  if (path) return [{ text: `[image: ${alt.trim() || path.split('/').pop()}]`, style: { ...base, fg: C.blue, underline: true }, ...(open ? { action: () => open(path) } : {}) }]
  return [{ text: alt.trim() || 'image', style: { ...base, fg: C.blue, underline: true } }, { text: ` (${src})`, style: { ...base, fg: C.gray } }]
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l)
const isTableRule = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)

function table(rows: string[], width: number): Line[] {
  const cellsOf = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
  const body = rows.filter(r => !isTableRule(r)).map(cellsOf)
  const n = Math.max(...body.map(r => r.length))
  const widths = Array.from({ length: n }, (_, i) => Math.max(3, ...body.map(r => cells(r[i] ?? ''))))
  // Shrink the widest columns until the table fits.
  const total = () => widths.reduce((a, b) => a + b, 0) + (n - 1) * 3
  while (total() > width && Math.max(...widths) > 6) widths[widths.indexOf(Math.max(...widths))]!--
  const out: Line[] = []
  body.forEach((r, ri) => {
    const line: Line = []
    r.forEach((c, i) => {
      if (i > 0) line.push({ text: ' │ ', style: { fg: C.faint } })
      // A cell in display order: one in a right-to-left language on the right of its column.
      const spans = bidiLine(clipLine(inline(c, ri === 0 ? { bold: true } : {}), widths[i]!))
      const room = pad(widths[i]! - lineCells(spans))
      line.push(...(isRtl(spans) ? [room, ...spans] : [...spans, room]))
    })
    out.push(line)
    if (ri === 0) out.push([{ text: widths.map(w => '─'.repeat(w)).join('─┼─'), style: { fg: C.faint } }])
  })
  return out
}

/** Renders markdown into lines of at most `width` cells. */
const rendered = new Map<string, Line[]>()

export function markdown(src: string, width: number, copy?: (text: string) => void, media?: Media): Line[] {
  // The chat draws every reply on every frame: each text is rendered once per width. (A cached line's
  // copy action holds an earlier frame's copy function, which does the same.)
  const key = `${width}${copy ? 'c' : ''}${bidiMode()}${media ? `|${media.key}` : ''}\0${src}`
  // Callers add to the lines they get (the caret while a reply streams): each gets its own copy,
  // or the final reply, the same words, would keep the caret.
  const known = rendered.get(key)
  if (known) return known.map(l => [...l])
  copyNow = copy
  openNow = media?.open
  try {
    const lines = render(src, width, copy, media)
    remember(rendered, key, lines)
    return lines.map(l => [...l])
  } finally {
    copyNow = undefined
    openNow = undefined
  }
}

function render(src: string, width: number, copy?: (text: string) => void, media?: Media): Line[] {
  const lines = src.replace(/\r/g, '').split('\n')
  const out: Line[] = []
  let para: string[] = []
  let blank = false
  const gap = () => {
    if (out.length && !blank) out.push([])
    blank = true
  }
  const flushPara = () => {
    if (!para.length) return
    // Its images drawn under it, each with its caption (the words without them above).
    const pics: Line[] = []
    const text = !media?.image ? para.join(' ') : para.join(' ').replace(IMAGE, (all, alt: string, at: string) => {
      const rows = media.image!(alt, at, width)
      if (!rows) return all
      if (pics.length) pics.push([])
      pics.push(...rows)
      return ''
    })
    const words = pics.length ? text.replace(/ {2,}/g, ' ').trim() : text.trim()
    if (words) out.push(...wrap(inline(words), width))
    out.push(...pics)
    para = []
    blank = false
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const fence = raw.match(/^\s*(```|~~~)\s*([\w+-]*)/)
    if (fence) {
      flushPara()
      gap()
      const code: string[] = []
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!); i++) code.push(lines[i]!)
      // Drawn without tabs and terminal codes; copied as written.
      const shown = code.map(clean)
      const w = Math.min(width, Math.max(20, ...shown.map(c => cells(c) + 2)))
      // The block's header: its language, and ⧉ copy on the right.
      const lang = fence[2] ? ` ${fence[2]}` : ''
      const whole = code.join('\n')
      // A Mermaid block: its diagram in its place once drawn, or a note under the code.
      const drawn = /^mermaid$/i.test(fence[2] ?? '') ? media?.diagram?.(whole, width) : undefined
      if (drawn?.replace) {
        out.push(...drawn.lines)
        // Its source can still be copied, beside its caption.
        const last = out.at(-1)
        if (copy && last && lineCells(last) + 8 <= width) last.push({ text: '  ⧉ copy', style: { fg: C.cyan }, action: () => copy(whole) })
        blank = false
        gap()
        continue
      }
      const canCopy = !!copy && isCopyable(whole, fence[2])
      const btn = canCopy ? '⧉ copy ' : ''
      out.push([
        { text: lang, style: { fg: C.gray, bg: K.headBg, italic: true } },
        pad(w - cells(lang) - cells(btn), { bg: K.headBg }),
        ...(canCopy ? [{ text: btn, style: { fg: C.cyan, bg: K.headBg }, action: () => copy!(whole) }] : []),
      ])
      // Highlighted by its language; long lines wrap (never cut, so a command can be read and copied whole).
      highlight(shown, langOf(fence[2])).forEach(spans => {
        // Code reads left to right; a string in Arabic in it reads right to left inside that.
        for (const raw of hardWrap(spans, w - 1)) {
          const piece = bidiLine(raw, 'ltr')
          const pw = lineCells(piece)
          out.push([{ text: ' ', style: { bg: C.codeBg } }, ...piece.map(sp => ({ ...sp, style: { fg: C.white, ...sp.style, bg: C.codeBg } })), pad(w - 1 - pw, { bg: C.codeBg })])
        }
      })
      if (drawn) out.push(...drawn.lines)
      blank = false
      gap()
      continue
    }
    if (!raw.trim()) {
      flushPara()
      gap()
      continue
    }
    const heading = raw.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushPara()
      gap()
      const level = heading[1]!.length
      out.push(...wrap(inline(heading[2]!, { bold: true, fg: level <= 2 ? C.cyan : C.white, underline: level === 1 }), width))
      blank = false
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      flushPara()
      out.push([{ text: '─'.repeat(Math.min(width, 40)), style: { fg: C.faint } }])
      blank = false
      continue
    }
    if (isTableRow(raw)) {
      flushPara()
      const rows: string[] = []
      for (; i < lines.length && isTableRow(lines[i]!); i++) rows.push(lines[i]!)
      i--
      out.push(...table(rows, width))
      blank = false
      continue
    }
    if (/^\s*>/.test(raw)) {
      // A quote: its lines together, ⧉ copy beside its first line.
      flushPara()
      const said: string[] = []
      for (; i < lines.length && /^\s*>/.test(lines[i]!); i++) said.push(lines[i]!.replace(/^\s*>\s?/, ''))
      i--
      const bar: Span = { text: '▎ ', style: { fg: C.faint } }
      const quoted = said.join('\n')
      const canCopy = !!copy && isCopyable(quoted)
      const btn = canCopy ? ' ⧉' : ''
      const rows: Line[] = []
      for (const para of quoted.split(/\n\s*\n/)) rows.push(...wrap(inline(para.replace(/\n/g, ' '), { italic: true, fg: C.gray }), width - 2 - cells(btn)))
      rows.forEach((l, n) => out.push([bar, ...l, ...(n === 0 && canCopy ? [pad(width - 2 - cells(btn) - lineCells(l)), { text: btn, style: { fg: C.cyan }, action: () => copy!(quoted) }] : [])]))
      blank = false
      continue
    }
    const item = raw.match(/^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/)
    if (item) {
      flushPara()
      const depth = Math.floor(item[1]!.replace(/\t/g, '  ').length / 2)
      const ordered = /\d/.test(item[2]!)
      const box = item[3] ? (/[xX]/.test(item[3]) ? '☑ ' : '☐ ') : ''
      const bullet = ordered ? `${item[2]} ` : ['• ', '◦ ', '▪ '][depth % 3]!
      const lead = '  '.repeat(depth)
      // Continuation lines of the item (indented, not a new item).
      let body = item[4]!
      while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]!) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i + 1]!)) body += ' ' + lines[++i]!.trim()
      const first: Span[] = [{ text: lead }, { text: bullet, style: { fg: C.cyan } }, ...(box ? [{ text: box }] : [])]
      const hang = pad(cells(lead + bullet + box))
      const wrapped = wrap([...first, ...inline(body)], width, [hang])
      out.push(...wrapped)
      blank = false
      continue
    }
    para.push(raw.trim())
  }
  flushPara()
  while (out.length && out.at(-1)!.length === 0) out.pop()
  return out
}
