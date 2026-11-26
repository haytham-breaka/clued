// Slash commands in what you write: the command in its own colour, as Claude Code draws it, and
// the rest as plain text. Only a command the app knows (its own, or one Claude Code listed: skills
// and plugin commands too), so a typo or a path (/tmp/x) stays plain.

import { C } from './text.ts'
import type { Span, Style } from './text.ts'
import type { Cluster } from './bidi.ts'

export const COMMAND: Style = { fg: C.command }

/**
 * Where the slash command at the very start of `text` ends: `/name` up to the first space, when
 * `known(name)`; 0 when it has none. A name with a slash in it is a path, not a command.
 */
export function commandEnd(text: string, known: (name: string) => boolean): number {
  const m = /^\/([^\s/]+)(?=\s|$)/.exec(text)
  return m && known(m[1]!) ? m[0].length : 0
}

/** Spans with their first `n` characters (of their text) drawn `style` too, over their own. */
export function styleHead(spans: Span[], n: number, style: Style = COMMAND): Span[] {
  if (n <= 0) return spans
  const out: Span[] = []
  let at = 0
  for (const sp of spans) {
    const k = Math.max(0, Math.min(sp.text.length, n - at))
    at += sp.text.length
    if (k) out.push({ ...sp, text: sp.text.slice(0, k), style: { ...sp.style, ...style } })
    if (k < sp.text.length) out.push(k ? { ...sp, text: sp.text.slice(k) } : sp)
  }
  return out
}

/**
 * A row laid out in display order (bidi.ts inputRow) with the characters before `n` in its text
 * drawn `style` too: each cell's place in the text is its cluster's, in the same order as the units.
 */
export function styleLaidHead(lay: { spans: Span[]; clusters: Cluster[] }, n: number, style: Style = COMMAND): Span[] {
  if (n <= 0) return lay.spans
  const out: Span[] = []
  let g = 0
  for (const sp of lay.spans) {
    if (!sp.units) {
      out.push(sp)
      continue
    }
    let run: { on: boolean; units: NonNullable<Span['units']> } | undefined
    const flush = () => {
      if (run) out.push({ ...sp, text: run.units.map(u => u.text).join(''), units: run.units, ...(run.on ? { style: { ...sp.style, ...style } } : {}) })
    }
    for (const u of sp.units) {
      const on = (lay.clusters[g++]?.from ?? n) < n
      if (run?.on !== on) {
        flush()
        run = { on, units: [] }
      }
      run!.units.push(u)
    }
    flush()
  }
  return out
}
