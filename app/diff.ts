// A line diff for showing Claude's edits: what an Edit replaced, line by line.

export type DiffLine = { kind: ' ' | '-' | '+'; text: string }

/** Lines kept around a change. */
const CONTEXT = 3
/** Past this many cells in the table, the middle is shown as all removed then all added. */
const MAX_TABLE = 250_000

export function lineDiff(before: string, after: string): DiffLine[] {
  const A = before.split('\n')
  const B = after.split('\n')
  let p = 0
  while (p < A.length && p < B.length && A[p] === B[p]) p++
  let s = 0
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++
  const a = A.slice(p, A.length - s)
  const b = B.slice(p, B.length - s)
  const mid: DiffLine[] = []
  if (a.length * b.length > MAX_TABLE) {
    for (const t of a) mid.push({ kind: '-', text: t })
    for (const t of b) mid.push({ kind: '+', text: t })
  } else {
    // Longest common subsequence, from the end: dp[i][j] for a[i:] and b[j:].
    const m = b.length + 1
    const dp = new Int32Array((a.length + 1) * m)
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        dp[i * m + j] = a[i] === b[j] ? dp[(i + 1) * m + j + 1]! + 1 : Math.max(dp[(i + 1) * m + j]!, dp[i * m + j + 1]!)
    let i = 0
    let j = 0
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        mid.push({ kind: ' ', text: a[i]! })
        i++
        j++
      } else if (j >= b.length || (i < a.length && dp[(i + 1) * m + j]! >= dp[i * m + j + 1]!)) mid.push({ kind: '-', text: a[i++]! })
      else mid.push({ kind: '+', text: b[j++]! })
    }
  }
  const ctx = (lines: string[]): DiffLine[] => lines.map(text => ({ kind: ' ', text }))
  return [...ctx(A.slice(Math.max(0, p - CONTEXT), p)), ...mid, ...ctx(A.slice(A.length - s, Math.min(A.length, A.length - s + CONTEXT)))]
}

export type Piece = { text: string; isChanged: boolean }

/** Past this many cells in a line pair's table, its words are not compared. */
const MAX_WORDS = 40_000

/**
 * What changed inside a changed line pair, word by word: each side's pieces, the changed ones marked.
 * `likeness`: how much of the longer line is kept (0 to 1). Undefined when the lines have too little
 * in common for marking words to help (a rewritten line).
 */
export function wordDiff(before: string, after: string): { before: Piece[]; after: Piece[]; likeness: number } | undefined {
  const split = (s: string) => s.match(/\w+|\s+|[^\w\s]/g) ?? []
  const a = split(before)
  const b = split(after)
  if (!a.length || !b.length || a.length * b.length > MAX_WORDS) return undefined
  const m = b.length + 1
  const dp = new Int32Array((a.length + 1) * m)
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i * m + j] = a[i] === b[j] ? dp[(i + 1) * m + j + 1]! + 1 : Math.max(dp[(i + 1) * m + j]!, dp[i * m + j + 1]!)
  const A: Piece[] = []
  const B: Piece[] = []
  const add = (to: Piece[], text: string, isChanged: boolean) => {
    const last = to.at(-1)
    if (last && last.isChanged === isChanged) last.text += text
    else to.push({ text, isChanged })
  }
  let i = 0
  let j = 0
  let same = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      if (a[i]!.trim()) same += a[i]!.length
      add(A, a[i++]!, false)
      add(B, b[j++]!, false)
    } else if (j >= b.length || (i < a.length && dp[(i + 1) * m + j]! >= dp[i * m + j + 1]!)) add(A, a[i++]!, true)
    else add(B, b[j++]!, true)
  }
  // Mostly rewritten: marking nearly every word would only add noise.
  const longest = Math.max(before.replace(/\s/g, '').length, after.replace(/\s/g, '').length)
  const likeness = longest ? same / longest : 0
  if (likeness < 0.4) return undefined
  // A changed run of spaces between two kept words reads as nothing changed.
  for (const side of [A, B]) for (const p of side) if (p.isChanged && !p.text.trim()) p.isChanged = false
  return { before: A, after: B, likeness }
}
