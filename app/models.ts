// /model: Claude Code's models, as its answer to the initialize request lists them, and the card
// that picks one (↑↓, ←→ for the effort, Enter), as Claude Code's own /model does. The app switches
// with Claude Code's set_model control request, and the effort with apply_flag_settings: no restart.

import { C, cells, clip, clipLine, lineCells, pad } from './text.ts'
import type { Line, Span } from './text.ts'

/** `value`: what Claude Code takes (an alias, or a model id); `resolved`: the model id it runs. */
export type Model = { value: string; resolved: string; name: string; about: string; efforts: string[] }

/** The models in the initialize answer (its `models`), skipping any without a value; each once. */
export function parseModels(raw: unknown): Model[] {
  const seen = new Set<string>()
  const list: Model[] = []
  for (const m of Array.isArray(raw) ? raw : []) {
    if (!m || typeof m !== 'object' || typeof m.value !== 'string' || !m.value || seen.has(m.value)) continue
    seen.add(m.value)
    const levels = Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((l: unknown) => typeof l === 'string' && l) : []
    list.push({
      value: m.value,
      resolved: typeof m.resolvedModel === 'string' && m.resolvedModel ? m.resolvedModel : m.value,
      name: typeof m.displayName === 'string' && m.displayName ? m.displayName : m.value,
      about: typeof m.description === 'string' ? m.description : '',
      efforts: m.supportsEffort === false ? [] : levels,
    })
  }
  return list
}

/**
 * The model in use, as an index into `models` (-1 when none fits). `chosen`: what Claude Code was
 * told (--model, /model, or your settings' model; '' for none: its default); `running`: the model id
 * it reports. Several values can run the same model (Default and Opus), so what was chosen decides.
 */
export function currentAt(models: Model[], chosen: string, running: string): number {
  if (chosen) {
    const at = models.findIndex(m => m.value === chosen)
    if (at >= 0) return at
    const same = models.findIndex(m => m.resolved === chosen)
    if (same >= 0) return same
  } else {
    const at = models.findIndex(m => m.value === 'default' && (!running || m.resolved === running))
    if (at >= 0) return at
  }
  return running ? models.findIndex(m => m.resolved === running || m.value === running) : -1
}

export type Picker = {
  models: Model[]
  /** The row picked, the model in use (-1: none listed), the effort picked and the effort in use ('' unknown). */
  at: number
  current: number
  effort: string
  was: string
}

export function newPicker(models: Model[], current: number, effort: string): Picker {
  return { models, at: Math.max(0, current), current, effort, was: effort }
}

/** One row up (-1) or down (1), or to row `to`. */
export function move(p: Picker, d: number, to?: number) {
  p.at = Math.max(0, Math.min(p.models.length - 1, to ?? p.at + d))
}

/** The effort levels the picked model has ([] when it has none). */
export const efforts = (p: Picker) => p.models[p.at]?.efforts ?? []

/**
 * A level lower (-1) or higher (1), for the picked model. From an effort not known yet, the first
 * press shows where it starts: high, else the middle one. False when the model has no levels.
 */
export function shiftEffort(p: Picker, d: number): boolean {
  const levels = efforts(p)
  if (!levels.length) return false
  const i = levels.indexOf(p.effort)
  if (i < 0) p.effort = levels.includes('high') ? 'high' : levels[Math.floor(levels.length / 2)]!
  else p.effort = levels[Math.max(0, Math.min(levels.length - 1, i + d))]!
  return true
}

/** What Enter does: the model to switch to (unless it is the one in use) and the effort to set, if it changed. */
export function choice(p: Picker): { model?: Model; effort?: string } {
  const m = p.models[p.at]
  if (!m) return {}
  return {
    ...(p.at !== p.current ? { model: m } : {}),
    ...(p.effort && p.effort !== p.was && m.efforts.includes(p.effort) ? { effort: p.effort } : {}),
  }
}

/** "High effort" for "high". */
export const effortLabel = (level: string) => `${level.slice(0, 1).toUpperCase()}${level.slice(1)} effort`

/**
 * The card, `w` cells wide and at most `room` rows of models: each row a click that switches to it,
 * each effort level a click that picks it.
 */
export function pickerLines(p: Picker, w: number, room: number, on: { choose: (i: number) => void; effort: (level: string) => void; cancel: () => void }): Line[] {
  const L: Line[] = []
  const edge = { fg: C.cyan }
  const bar: Span = { text: '│ ', style: edge }
  const inner = w - 2
  const close: Span = { text: ' ✕ ', style: { bold: true }, action: on.cancel }
  const lead: Line = [{ text: '╭─ ', style: edge }, { text: 'Select model', style: { fg: C.cyan, bold: true } }]
  const about = clip(' · for this session', w - lineCells(lead) - cells(close.text))
  L.push([...lead, { text: about, style: { fg: C.gray } }, pad(w - lineCells(lead) - cells(about) - cells(close.text)), close])
  // The names in one column (with room for the ✔), the descriptions after them.
  const num = String(p.models.length).length
  const nameW = Math.min(Math.max(...p.models.map(m => cells(m.name))) + 4, Math.floor(inner / 2))
  const shown = Math.max(1, Math.min(room, p.models.length))
  const first = Math.max(0, Math.min(p.at - Math.floor(shown / 2), p.models.length - shown))
  p.models.slice(first, first + shown).forEach((m, k) => {
    const i = first + k
    const isOn = i === p.at
    const act = () => on.choose(i)
    const head = `${isOn ? '▸' : ' '} ${String(i + 1).padStart(num)}. `
    const mark = i === p.current ? ' ✔' : ''
    const name = clip(m.name, nameW - cells(mark) - 1)
    const room2 = inner - cells(head) - nameW
    L.push([
      bar,
      { text: head, style: isOn ? { fg: C.cyan, bold: true } : { fg: C.gray }, action: act },
      { text: name, style: isOn ? { fg: C.cyan, bold: true } : { bold: true }, action: act },
      { text: mark, style: { fg: C.green, bold: true }, action: act },
      { ...pad(Math.max(1, nameW - cells(name) - cells(mark))), action: act },
      { text: clip(m.about, Math.max(0, room2)), style: { fg: C.gray }, action: act },
    ])
  })
  if (first + shown < p.models.length || first > 0) L.push([bar, { text: `${first > 0 ? '↑ ' : ''}${p.models.length - shown} more${first + shown < p.models.length ? ' ↓' : ''}`, style: { fg: C.faint } }])
  // The effort, for the picked model, when it has levels (as Claude Code shows it).
  const levels = efforts(p)
  if (levels.length) {
    const row: Line = [bar, { text: p.effort && levels.includes(p.effort) ? `${effortLabel(p.effort)}  ` : 'Effort  ', style: { bold: true } }]
    levels.forEach((l, i) => {
      const isOn = l === p.effort
      row.push({ text: isOn ? `[${l}]` : ` ${l} `, style: isOn ? { fg: C.cyan, bold: true } : { fg: C.gray }, action: () => on.effort(l) })
      if (i < levels.length - 1) row.push(pad(1))
    })
    row.push({ text: '  ← → to adjust', style: { fg: C.faint } })
    L.push(clipLine(row, w))
  } else if (p.models.some(m => m.efforts.length)) L.push([bar, { text: 'This model has no effort levels.', style: { fg: C.faint } }])
  L.push([{ text: '╰─ ', style: edge }, { text: clip(`↑↓ choose · ${levels.length ? '←→ effort · ' : ''}Enter switch · Esc cancel`, w - 3), style: { fg: C.faint } }])
  return L
}
