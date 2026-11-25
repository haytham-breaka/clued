import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { keyOf } from '../../hooks/model.ts'
import type { MessageRef } from '../../app/inbox.ts'
import { panelLines } from '../../app/panel.ts'
import type { PanelCtx } from '../../app/panel.ts'
import type { Turn } from '../../app/session.ts'
import { C } from '../../app/text.ts'

const NOW = 1_700_000_000_000
const noop = () => {}

function turn(text: string): Turn {
  return { key: keyOf(text), text, at: NOW, steps: [], live: '', pending: '', isDone: true, isOpen: false }
}

function ctx(messages: MessageRef[], extra: Partial<PanelCtx> = {}): PanelCtx {
  return {
    isResultsOnly: false, isWorking: false, isFolded: false, hscroll: 0, results: noop, fold: noop, side: noop,
    box: { unread: [], waiting: [], messages }, openPart: noop, dismiss: noop, openMessage: noop, openWork: noop,
    picked: '', query: null, search: noop, isLegend: false, legend: noop, next: noop, readParts: noop, unreadParts: noop,
    readList: [], isReadTab: false, readTab: noop, work: 'folded', setWork: noop, agents: [], turnOf: () => undefined,
    openAgent: noop, agentView: '', jumpTo: noop, openRequest: noop, requestView: '', scroll: {}, height: 60, ...extra,
  }
}

const text = (p: PanelCtx, width = 40) => panelLines(p, width).lines.map(l => l.map(s => s.text).join(''))
const rowWith = (p: PanelCtx, what: string) => panelLines(p, 40).lines.find(l => l.map(s => s.text).join('').includes(what))!

describe('your recent messages', () => {
  const ref = (text: string, extra: Partial<MessageRef>): MessageRef => ({ turn: turn(text), state: 'progress', updatedAt: NOW, event: 'sent', ...extra })

  test('a message something works on now: the spinner and "in progress"', () => {
    const p = ctx([ref('on it now', { active: true })], { spin: '⠙' })
    assert.match(text(p).find(l => l.includes('on it now'))!, /⠙ on it now +in progress/)
    assert.equal(rowWith(p, 'in progress').find(s => s.text === 'in progress')!.style?.fg, C.cyan)
    // With no spinner frame given, its usual mark.
    assert.match(text(ctx([ref('on it now', { active: true })])).find(l => l.includes('on it now'))!, /▶ on it now +in progress/)
  })

  test('a message Claude still owes with nothing running on it: "waiting", not ⚠ no update', () => {
    const lines = text(ctx([ref('owed', { stale: true })]))
    const row = lines.find(l => l.includes('owed'))!
    assert.match(row, /▶ owed +waiting/)
    assert.ok(!lines.some(l => l.includes('no update') || l.includes('⚠')))
  })

  test('a lost reply still says so', () => {
    assert.match(text(ctx([ref('gone', { state: 'lost' })])).find(l => l.includes('gone'))!, /⚠ gone +reply lost/)
  })

  test('the legend has the spinner for in progress, and ⚠ for a lost reply only', () => {
    const lines = text(ctx([ref('x', {})], { isLegend: true }), 60)
    assert.ok(lines.some(l => l.includes('in progress: being worked on')))
    assert.ok(lines.some(l => /⚠ reply lost\s*$/.test(l)))
    assert.ok(!lines.some(l => l.includes('no update')))
  })
})
