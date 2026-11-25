// Claude's multiple-choice questions (its AskUserQuestion tool): the card that asks them, and the
// answer Claude Code wants back. Claude Code asks the app for permission to run the tool; the app
// allows it with the tool's input plus `answers`, by question text: one option's label, several
// labels joined with ", " (multiSelect), or the user's own words. Claude then reads
// `"<question>"="<answer>"` as the tool's result.

import { C, cells, clip, lineCells, pad, wrap } from './text.ts'
import type { Line, Span } from './text.ts'

export type AskOption = { label: string; description: string }
export type AskQuestion = { question: string; header: string; options: AskOption[]; multiSelect: boolean }
export type Ask = {
  requestId: string
  input: Record<string, unknown>
  questions: AskQuestion[]
  /** The question on the card now: they are asked one after another. */
  at: number
  /** The options picked on it (indexes, in the order the card lists them). */
  picks: number[]
  /** Answers so far, by question text. */
  answers: Record<string, string>
}

/** What Claude reads when the user closes the card without answering. */
export const DISMISSED = 'The user dismissed the question without answering it.'

/** The questions in the tool's input, skipping any without text. */
export function questionsIn(input: Record<string, unknown>): AskQuestion[] {
  const list = Array.isArray(input.questions) ? input.questions : []
  return list
    .filter((q: any) => q && typeof q.question === 'string' && q.question.trim())
    .map((q: any) => ({
      question: q.question,
      header: typeof q.header === 'string' ? q.header : '',
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((o: any) => o && typeof o.label === 'string')
        .map((o: any) => ({ label: o.label, description: typeof o.description === 'string' ? o.description : '' })),
      multiSelect: q.multiSelect === true,
    }))
}

/** A card for the request, or undefined when its input holds no question. */
export function newAsk(requestId: string, input: Record<string, unknown>): Ask | undefined {
  const questions = questionsIn(input)
  return questions.length ? { requestId, input, questions, at: 0, picks: [], answers: {} } : undefined
}

export const current = (a: Ask) => a.questions[a.at]!

/** Picks option n (from 0) on the current question: the only pick, or toggled when several are allowed. */
export function pick(a: Ask, n: number): boolean {
  const q = current(a)
  if (n < 0 || n >= q.options.length) return false
  if (!q.multiSelect) a.picks = [n]
  else a.picks = a.picks.includes(n) ? a.picks.filter(x => x !== n) : [...a.picks, n].sort((x, y) => x - y)
  return true
}

/**
 * Answers the current question: with `typed` (the user's own answer) when there is any, else with the
 * picked options. 'empty' when there is neither, 'next' when another question follows, 'done' after the last.
 */
export function answer(a: Ask, typed = ''): 'empty' | 'next' | 'done' {
  const q = current(a)
  const text = typed.trim() || a.picks.map(i => q.options[i]!.label).join(', ')
  if (!text) return 'empty'
  a.answers[q.question] = text
  a.picks = []
  if (a.at + 1 < a.questions.length) {
    a.at++
    return 'next'
  }
  return 'done'
}

/** The input Claude Code runs the tool with: the original one, plus the answers. */
export const answeredInput = (a: Ask) => ({ ...a.input, answers: { ...a.answers } })

/** The card, `w` cells wide: the question, its options (each one a click target), and the ways out. */
export function askLines(a: Ask, w: number, on: { pick: (n: number) => void; send: () => void; dismiss: () => void }): Line[] {
  const L: Line[] = []
  const edge = { fg: C.yellow }
  const bar: Span = { text: '│ ', style: edge }
  const inner = w - 4
  const q = current(a)
  const n = a.questions.length
  // The ✕ sits at the right edge; what doesn't fit before it is cut.
  const close: Span = { text: ' ✕ ', style: { bold: true }, action: on.dismiss }
  const lead: Line = [{ text: '╭─ ', style: edge }, { text: '❓ Claude asks', style: { fg: C.yellow, bold: true } }]
  const about = clip(`${n > 1 ? ` · question ${a.at + 1} of ${n}` : ''} · waiting for your answer`, w - lineCells(lead) - cells(close.text))
  L.push([...lead, { text: about, style: { fg: C.gray } }, pad(w - lineCells(lead) - cells(about) - cells(close.text)), close])
  // The questions already answered on this card.
  for (const done of a.questions.slice(0, a.at))
    for (const l of wrap([{ text: `✓ ${done.header || done.question}: `, style: { fg: C.green } }, { text: a.answers[done.question] ?? '', style: { fg: C.gray } }], inner)) L.push([bar, ...l])
  const chip: Span[] = q.header ? [{ text: ` ${q.header} `, style: { bg: C.yellow, fg: 16, bold: true } }, { text: ' ' }] : []
  for (const l of wrap([...chip, { text: q.question, style: { bold: true } }], inner)) L.push([bar, ...l])
  q.options.forEach((o, i) => {
    const isOn = a.picks.includes(i)
    const mark = q.multiSelect ? (isOn ? '☑' : '☐') : isOn ? '●' : '○'
    const act = () => on.pick(i)
    const head: Span = { text: ` ${i + 1}  ${mark} `, style: isOn ? { fg: C.cyan, bold: true } : { fg: C.gray }, action: act }
    const indent = [pad(cells(head.text))]
    const body: Span[] = [{ text: o.label, style: isOn ? { fg: C.cyan, bold: true } : { bold: true }, action: act }]
    if (o.description) body.push({ text: `  ${o.description}`, style: { fg: C.gray }, action: act })
    wrap([head, ...body], inner, indent).forEach(l => L.push([bar, ...l.map(s => ({ ...s, action: act }))]))
  })
  const keys = q.options.length > 1 ? `1-${q.options.length}` : '1'
  const hint = q.multiSelect ? `${keys} or click to tick each one that applies, then Enter.` : `${keys} or click to choose, then Enter.`
  for (const l of wrap([{ text: `${hint} Or type your own answer below.`, style: { fg: C.faint } }], inner)) L.push([bar, ...l])
  L.push([
    { text: '╰─ ', style: edge },
    { text: n > 1 && a.at + 1 < n ? ' Next (Enter) ' : ' Send (Enter) ', style: { bg: C.green, fg: 16, bold: true }, action: on.send },
    pad(2),
    { text: ' Dismiss (Esc) ', style: { bg: C.faint, fg: C.white }, action: on.dismiss },
  ])
  return L
}
