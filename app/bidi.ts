// Right-to-left text (Arabic, Hebrew, Persian, Urdu…) on a terminal grid.
//
// Most terminals draw each row's cells left to right as they come, with no bidi reordering
// (Windows Terminal, kitty, WezTerm, Alacritty, xterm, VS Code's), and join Arabic letters by
// the order they get them in, if at all. So in `app` mode clued does it itself: the Unicode
// Bidirectional Algorithm (UAX #9, from the vendored bidi-js) on each wrapped line, Arabic
// letters in their joined forms (Presentation Forms, chosen from the letters around them in
// reading order), and a line whose paragraph reads right to left aligned to the right.
// Terminals that reorder by themselves (macOS Terminal, Konsole, mlterm) get the text as
// written instead (`terminal`), or else they would reverse it back. CLUED_BIDI sets it.
//
// Lines stay what they say: a span drawn reordered keeps, for each cell, the characters it
// shows in reading order (`units`), so a selection copies the text as written.

import bidiFactory from './vendor/bidi-js.mjs'
import type { EmbeddingLevels } from './vendor/bidi-js.mjs'
import { cells, remember } from './text.ts'
import type { Line, Span } from './text.ts'

export type BidiMode = 'app' | 'terminal' | 'off'
export type Dir = 'ltr' | 'rtl'

/**
 * How right-to-left text is drawn. CLUED_BIDI=app|terminal|off wins; else `terminal` where the
 * terminal is known to reorder on its own, and `app` everywhere else.
 */
export function detectMode(env: Record<string, string | undefined> = process.env): BidiMode {
  const set = env.CLUED_BIDI?.trim().toLowerCase()
  if (set === 'app' || set === 'terminal' || set === 'off') return set
  if (env.TERM_PROGRAM === 'Apple_Terminal' || env.KONSOLE_VERSION || env.MLTERM) return 'terminal'
  return 'app'
}

let mode: BidiMode = detectMode()
export const bidiMode = () => mode
export const setBidiMode = (m: BidiMode) => {
  mode = m
  seen.clear()
}

/**
 * What the app writes as it starts and quits, in `app` mode: VTE (GNOME Terminal, Tilix, Ptyxis…)
 * reorders by itself unless told the app does it (BDSM, ECMA-48 mode 8: reset is explicit); other
 * terminals ignore it. Inside tmux it goes through to the terminal too, where tmux lets it.
 */
export function modeSequences(env: Record<string, string | undefined> = process.env): { start: string; end: string } {
  if (mode !== 'app') return { start: '', end: '' }
  const wrap = (s: string) => (env.TMUX ? `${s}\x1bPtmux;${s.replace(/\x1b/g, '\x1b\x1b')}\x1b\\` : s)
  return { start: wrap('\x1b[8l'), end: wrap('\x1b[8h') }
}

const bidi = bidiFactory()

const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefe\u200f\u202b\u202e\u2067]|[\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u
/** Whether the text has a right-to-left letter (or mark) in it: the rest is drawn as it is. */
export const hasRtl = (s: string) => RTL.test(s)

const MARK = /^[\p{Mn}\p{Me}]$/u
/** A combining mark (Arabic harakat, Hebrew points, accents): drawn on the character before it. */
export const isMark = (ch: string) => MARK.test(ch)
/** Bidi controls: they steer the algorithm, and are not drawn. */
const CONTROL = /^[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]$/
export const isControl = (ch: string) => CONTROL.test(ch)

// ---- Arabic shaping --------------------------------------------------------------

/**
 * Each Arabic letter's Presentation Forms: isolated, final, and for letters that join on both
 * sides initial and medial (from Unicode's compatibility decompositions of FB50–FDFF, FE70–FEFF).
 */
const TABLE =
  '622:fe81,fe82 623:fe83,fe84 624:fe85,fe86 625:fe87,fe88 626:fe89,fe8a,fe8b,fe8c 627:fe8d,fe8e 628:fe8f,fe90,fe91,fe92 ' +
  '629:fe93,fe94 62a:fe95,fe96,fe97,fe98 62b:fe99,fe9a,fe9b,fe9c 62c:fe9d,fe9e,fe9f,fea0 62d:fea1,fea2,fea3,fea4 ' +
  '62e:fea5,fea6,fea7,fea8 62f:fea9,feaa 630:feab,feac 631:fead,feae 632:feaf,feb0 633:feb1,feb2,feb3,feb4 ' +
  '634:feb5,feb6,feb7,feb8 635:feb9,feba,febb,febc 636:febd,febe,febf,fec0 637:fec1,fec2,fec3,fec4 638:fec5,fec6,fec7,fec8 ' +
  '639:fec9,feca,fecb,fecc 63a:fecd,fece,fecf,fed0 641:fed1,fed2,fed3,fed4 642:fed5,fed6,fed7,fed8 643:fed9,feda,fedb,fedc ' +
  '644:fedd,fede,fedf,fee0 645:fee1,fee2,fee3,fee4 646:fee5,fee6,fee7,fee8 647:fee9,feea,feeb,feec 648:feed,feee ' +
  '649:feef,fef0,fbe8,fbe9 64a:fef1,fef2,fef3,fef4 671:fb50,fb51 679:fb66,fb67,fb68,fb69 67a:fb5e,fb5f,fb60,fb61 ' +
  '67b:fb52,fb53,fb54,fb55 67e:fb56,fb57,fb58,fb59 67f:fb62,fb63,fb64,fb65 680:fb5a,fb5b,fb5c,fb5d 683:fb76,fb77,fb78,fb79 ' +
  '684:fb72,fb73,fb74,fb75 686:fb7a,fb7b,fb7c,fb7d 687:fb7e,fb7f,fb80,fb81 688:fb88,fb89 68c:fb84,fb85 68d:fb82,fb83 ' +
  '68e:fb86,fb87 691:fb8c,fb8d 698:fb8a,fb8b 6a4:fb6a,fb6b,fb6c,fb6d 6a6:fb6e,fb6f,fb70,fb71 6a9:fb8e,fb8f,fb90,fb91 ' +
  '6ad:fbd3,fbd4,fbd5,fbd6 6af:fb92,fb93,fb94,fb95 6b1:fb9a,fb9b,fb9c,fb9d 6b3:fb96,fb97,fb98,fb99 6ba:fb9e,fb9f ' +
  '6bb:fba0,fba1,fba2,fba3 6be:fbaa,fbab,fbac,fbad 6c0:fba4,fba5 6c1:fba6,fba7,fba8,fba9 6c5:fbe0,fbe1 6c6:fbd9,fbda ' +
  '6c7:fbd7,fbd8 6c8:fbdb,fbdc 6c9:fbe2,fbe3 6cb:fbde,fbdf 6cc:fbfc,fbfd,fbfe,fbff 6d0:fbe4,fbe5,fbe6,fbe7 6d2:fbae,fbaf 6d3:fbb0,fbb1'
const FORMS = new Map<number, number[]>(
  TABLE.split(' ').map(e => {
    const [base, forms] = e.split(':')
    return [parseInt(base!, 16), forms!.split(',').map(f => parseInt(f, 16))]
  }),
)
/** Lam with an alef after it is one ligature: isolated and final. */
const LAM = 0x644
const LAM_ALEF: Record<number, [number, number]> = { 0x622: [0xfef5, 0xfef6], 0x623: [0xfef7, 0xfef8], 0x625: [0xfef9, 0xfefa], 0x627: [0xfefb, 0xfefc] }
/** Tatweel and the zero width joiner join on both sides, and have no forms of their own. */
const isJoiner = (cp: number) => cp === 0x640 || cp === 0x200d
const joinsNext = (cp: number) => isJoiner(cp) || FORMS.get(cp)?.length === 4
const joinsPrev = (cp: number) => isJoiner(cp) || FORMS.has(cp)

/**
 * Arabic letters in the forms their neighbours give them, in reading order: the glyph to draw for
 * each character, '' for an alef that a lam before it took into their ligature. Marks between
 * letters don't break a join; anything else that isn't a letter does.
 */
export function shape(chars: string[]): string[] {
  const out = [...chars]
  const cps = chars.map(c => c.codePointAt(0)!)
  const near = (i: number, step: number) => {
    for (let j = i + step; j >= 0 && j < chars.length; j += step) if (!isMark(chars[j]!)) return j
    return -1
  }
  for (let i = 0; i < chars.length; i++) {
    const forms = FORMS.get(cps[i]!)
    if (!forms) continue
    const p = near(i, -1)
    const n = near(i, 1)
    const before = p >= 0 && joinsNext(cps[p]!)
    const lig = cps[i] === LAM && n >= 0 ? LAM_ALEF[cps[n]!] : undefined
    if (lig) {
      out[i] = String.fromCodePoint(lig[before ? 1 : 0])
      out[n] = ''
      i = n
      continue
    }
    const after = forms.length === 4 && n >= 0 && joinsPrev(cps[n]!)
    out[i] = String.fromCodePoint(forms[before && after ? 3 : after ? 2 : before ? 1 : 0]!)
  }
  return out
}

// ---- Reordering ------------------------------------------------------------------

/** A cell's worth of a reordered span: what it draws, and the characters it stands for, in reading order. */
export type Unit = { text: string; src: string; at: number }
/** Where a character cluster went: its cells, and its place in the text as written. */
export type Cluster = { x: number; w: number; from: number; to: number; odd: boolean }

/**
 * A URL or a path: kept left to right, whole, inside right-to-left text. Its trailing full stop or
 * comma isn't part of it: that ends the sentence, where the sentence's own direction puts it.
 */
const LTR_RUN = /[A-Za-z][\w+.-]*:\/\/\S*[^\s.,;:!?)\]'"،؛؟]|(?:~|\.{1,2})?\/[\w.@%+~-][\w.@%+~/-]*[\w/]|[\w.@%+~-]+\/[\w.@%+~/-]*[\w/]/g
const LRI = '\u2066'
const PDI = '\u2069'

type Item = { ch: string; span: number; off: number }

/** The line's text for the algorithm: inline code (`ltr` spans) and URLs and paths isolated left to right. */
function prepare(line: Line): { str: string; items: Item[]; at: number[] } {
  const items: Item[] = []
  /** For each UTF-16 unit of `str`: its item, or -1 for an isolate the app put in. */
  const at: number[] = []
  let str = ''
  let off = 0
  const put = (ch: string, item: number) => {
    str += ch
    for (let k = 0; k < ch.length; k++) at.push(item)
  }
  line.forEach((sp, s) => {
    const iso = new Map<number, string>()
    if (sp.ltr) {
      if (!line[s - 1]?.ltr) put(LRI, -1)
    } else if (/[/:]/.test(sp.text))
      for (const m of sp.text.matchAll(LTR_RUN)) {
        iso.set(m.index!, LRI)
        iso.set(m.index! + m[0].length, (iso.get(m.index! + m[0].length) ?? '') + PDI)
      }
    let i = 0
    for (const ch of sp.text) {
      const mark = iso.get(i)
      // A run that ends where the next starts: closed first.
      if (mark) for (const c of [...mark].sort((a, b) => (a === PDI ? -1 : b === PDI ? 1 : 0))) put(c, -1)
      items.push({ ch, span: s, off })
      put(ch, items.length - 1)
      i += ch.length
      off += ch.length
    }
    if (iso.get(i)) put(PDI, -1)
    if (sp.ltr && !line[s + 1]?.ltr) put(PDI, -1)
  })
  return { str, items, at }
}

/** The direction of a paragraph: from its first strong letter (UAX #9 P2, P3), left to right when it has none. */
export function lineDir(line: Line): Dir {
  if (!hasRtl(line.map(s => s.text).join(''))) return 'ltr'
  const { str } = prepare(line)
  return bidi.getEmbeddingLevels(str).paragraphs[0]!.level & 1 ? 'rtl' : 'ltr'
}
export const paragraphDir = (text: string): Dir => lineDir([{ text }])

/**
 * One line in display order, for a terminal that draws left to right: reordered (L1, L2), with
 * mirrored brackets in right-to-left runs (L4), Arabic joined, and each combining mark kept after
 * the character it sits on. `rtl`: its paragraph reads right to left.
 */
export function layout(line: Line, base: Dir | 'auto' = 'auto'): { spans: Line; clusters: Cluster[]; rtl: boolean; width: number } {
  const { str, items, at } = prepare(line)
  const lv: EmbeddingLevels = bidi.getEmbeddingLevels(str, base)
  const rtl = !!((lv.paragraphs[0]?.level ?? (base === 'rtl' ? 1 : 0)) & 1)
  const glyphs = shape(items.map(i => i.ch))
  // Clusters, in reading order: a character with the marks (and joined emoji) after it, a lam with its alef.
  const clusterOf: number[] = []
  const members: number[][] = []
  items.forEach((it, i) => {
    const prev = items[i - 1]
    const joins = i > 0 && (isMark(it.ch) || isControl(it.ch) || glyphs[i] === '' || it.ch === '\u200d' || prev!.ch === '\u200d')
    if (joins) members[clusterOf[i - 1]!]!.push(i)
    else members.push([i])
    clusterOf.push(members.length - 1)
  })
  const firstUnit: number[] = []
  for (let k = at.length - 1; k >= 0; k--) if (at[k]! >= 0) firstUnit[at[k]!] = k
  // L2: each segment reversed in turn.
  const idx = [...Array(str.length).keys()]
  for (const [a, b] of bidi.getReorderSegments(str, lv)) for (let i = a, j = b; i < j; i++, j--) [idx[i], idx[j]] = [idx[j]!, idx[i]!]
  // Each cluster where its first character went.
  const shown = [...new Set(idx.filter(k => at[k]! >= 0 && members[clusterOf[at[k]!]!]![0] === at[k]).map(k => clusterOf[at[k]!]!))]
  const spans: Line = []
  const clusters: Cluster[] = []
  let x = 0
  let from = -1
  let units: Unit[] = []
  for (const c of shown) {
    const ids = members[c]!
    const head = items[ids[0]!]!
    const odd = !!(lv.levels[firstUnit[ids[0]!]!]! & 1)
    // Mirrored brackets in a right-to-left run; bidi controls not drawn.
    const text = ids.map((i, n) => {
      const g = isControl(items[i]!.ch) ? '' : glyphs[i]!
      return n === 0 && odd && g === head.ch ? (bidi.getMirroredCharacter(g) ?? g) : g
    }).join('')
    const last = items[ids.at(-1)!]!
    const w = cells(text)
    clusters.push({ x, w, from: head.off, to: last.off + last.ch.length, odd })
    x += w
    // Clusters of one span, side by side, are one span.
    if (head.span !== from) {
      const { units: _units, rtl: _rtl, ...orig } = line[head.span]!
      units = []
      spans.push({ ...orig, text: '', units, ...(rtl ? { rtl: true } : {}) })
      from = head.span
    }
    spans.at(-1)!.text += text
    units.push({ text, src: ids.map(i => items[i]!.ch).join(''), at: ids[0]! })
  }
  return { spans, clusters, rtl, width: x }
}

/** A line in display order, when it needs it (it has right-to-left text, or its paragraph reads right to left). */
export function bidiLine(line: Line, base: Dir | 'auto' = 'auto'): Line {
  if (mode !== 'app' || (base !== 'rtl' && !hasRtl(line.map(s => s.text).join('')))) return line
  return layout(line, base).spans
}

/** Whether a line is from a paragraph that reads right to left: it goes on the right of its box. */
export const isRtl = (line: Line) => line.some(s => s.rtl)

/**
 * Wrapped lines in display order, paragraph by paragraph (`para`: which paragraph each line is
 * of): a paragraph's direction comes from its own first strong letter, and all its lines keep it.
 * In `terminal` mode the text stays as written, and only says which lines go on the right.
 */
export function bidiParagraphs(lines: Line[], para: number[]): Line[] {
  if (mode === 'off' || !lines.some(l => hasRtl(l.map(s => s.text).join('')))) return lines
  const dirs = new Map<number, Dir>()
  const of = (p: number) => {
    if (!dirs.has(p)) dirs.set(p, lineDir(lines.filter((_, i) => para[i] === p).flat()))
    return dirs.get(p)!
  }
  return lines.map((l, i) => {
    const dir = of(para[i]!)
    if (mode === 'terminal') return dir === 'rtl' ? l.map(s => ({ ...s, rtl: true })) : l
    return bidiLine(l, dir)
  })
}

/** Reordered text, by itself: for a span drawn as it came (a preview, a title). */
const seen = new Map<string, string>()
export function bidiText(text: string): string {
  if (mode !== 'app' || !hasRtl(text)) return text
  let v = seen.get(text)
  if (v == null) {
    v = layout([{ text }]).spans.map(s => s.text).join('')
    // As many cells as before (a lam-alef is one cell, not two): what follows it stays where it was.
    v += ' '.repeat(Math.max(0, cells(text) - cells(v)))
    remember(seen, text, v, 2000)
  }
  return v
}

/** A span not yet reordered, reordered in its own cells (a span from a line laid out already stays). */
export const bidiSpan = (sp: Span): Span => (sp.units || mode !== 'app' || !hasRtl(sp.text) ? sp : { ...sp, text: bidiText(sp.text) })

// ---- The input box ---------------------------------------------------------------

/** An input row as drawn: `sel`, from and to in the row's text, drawn selected. */
export function inputRow(text: string, dir: Dir, sel?: [number, number]): ReturnType<typeof layout> {
  const parts: Line = []
  const cut = sel ? [0, Math.max(0, sel[0]), Math.min(text.length, sel[1]), text.length] : [0, text.length]
  for (let i = 0; i + 1 < cut.length; i++) if (cut[i + 1]! > cut[i]!) parts.push({ text: text.slice(cut[i], cut[i + 1]), ...(sel && i === 1 ? { style: { inverse: true } } : {}) })
  return layout(parts.length ? parts : [{ text: '' }], dir)
}

/**
 * The cell of the cursor before `k` (in the row's text, `len` long): on the character it is
 * before, or past the last one in its direction (left of a right-to-left one).
 */
export function cursorCell(lay: ReturnType<typeof layout>, k: number, len: number): number {
  const hit = lay.clusters.find(c => k >= c.from && k < c.to)
  if (hit) return hit.x
  const last = lay.clusters.find(c => len - 1 >= c.from && len - 1 < c.to)
  if (!last) return lay.rtl ? lay.width - 1 : 0
  return last.odd ? last.x - 1 : last.x + last.w
}

/** The place in the row's text of the cell `col` (from the row's left), `len` past its characters. */
export function indexAt(lay: ReturnType<typeof layout>, col: number, len: number): number {
  const hit = lay.clusters.find(c => col >= c.x && col < c.x + Math.max(1, c.w))
  return hit ? hit.from : len
}
