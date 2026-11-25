import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { keyOf } from '../../hooks/model.ts'
import type { MessageRef } from '../../app/inbox.ts'
import { panelLines, workersOf } from '../../app/panel.ts'
import type { Agent, PanelCtx } from '../../app/panel.ts'
import type { Turn } from '../../app/session.ts'
import { C } from '../../app/text.ts'
import type { Job } from '../../app/scheduled.ts'

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
    openAgent: noop, agentView: '', jumpTo: noop, openRequest: noop, requestView: '', jobs: [], openJob: noop, jobView: '', scroll: {}, height: 60, ...extra,
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

  test('who is on a message in progress: Claude, an agent (its task when it has several), "+1" for more; short when narrow', () => {
    const mine = ref('fix the build', { active: true, homeId: 'T1' })
    const follow = ref('also the tests', { active: true, homeId: 'T1' })
    const other = ref('write docs', { active: true, homeId: 'T2' })
    const task = (n: number, state: 'running' | 'done', keys: string[]) => ({ toolId: `t${n}`, title: `task ${n}`, text: '', at: NOW, for: keys, state })
    const maya: Agent = {
      id: 'a1', name: 'Fix it', type: 'fork', isBackground: true, for: [mine.turn.key], startedAt: NOW, state: 'running', steps: 1, last: '', prompt: '', log: [], person: 'Maya',
      // Its second task is for a follow-up merged into T1: it is on T1's messages.
      tasks: [task(1, 'done', [other.turn.key]), task(2, 'running', [follow.turn.key])] as Agent['tasks'],
    }
    const all = [mine, follow, other]
    assert.deepEqual(workersOf(mine, undefined, [maya], all), ['Maya · task 2'])
    assert.deepEqual(workersOf(other, { for: [other.turn.key] }, [maya], all), ['Claude'])
    assert.deepEqual(workersOf(mine, { for: [follow.turn.key] }, [maya], all), ['Claude', 'Maya · task 2'])
    const p = ctx(all, { spin: '⠙', agents: [maya], main: { for: [follow.turn.key], last: '' } })
    assert.match(text(p, 50).find(l => l.includes('fix the build'))!, /⠙ fix the build +Claude \+1$/)
    assert.match(text({ ...p, main: undefined }, 50).find(l => l.includes('fix the build'))!, /⠙ fix the build +Maya · task 2$/)
    // Narrow: just the name, then nothing, before the message gets too short to read.
    assert.match(text({ ...p, main: undefined }, 26).find(l => l.includes('fix the'))!, /⠙ fix the bu.* Maya$/)
    assert.ok(!text({ ...p, main: undefined }, 18).some(l => l.includes('Maya') && l.includes('fix')))
    // Nobody known (from history): "in progress".
    assert.match(text(ctx([ref('on it', { active: true })]), 40).find(l => l.includes('on it'))!, /on it +in progress$/)
  })

  test('the legend says the name on a row in progress is who is on it', () => {
    assert.ok(text(ctx([ref('a', {})], { isLegend: true }), 60).some(l => /Maya · task 2 +who is on it \(Claude or an agent\)/.test(l)))
  })

  test('Claude (lead) says how many of your messages its turn is on', () => {
    const lines = text(ctx([], { main: { for: ['k1', 'k2'], last: 'thinking' } }), 60)
    assert.ok(lines.some(l => /✻ Claude \(lead\) · on 2 messages +working/.test(l)))
    assert.ok(text(ctx([], { main: { for: ['k1'], last: '' } }), 60).some(l => l.includes('· on 1 message ')))
  })

  test('a message Claude still owes with nothing running on it: "waiting", not ⚠ no update', () => {
    const lines = text(ctx([ref('owed', { stale: true })]))
    const row = lines.find(l => l.includes('▶ owed'))!
    // Nothing is on it: it is under Not started too.
    assert.ok(lines.some(l => l.includes('▷ owed')))
    assert.match(row, /▶ owed +waiting/)
    assert.ok(!lines.some(l => l.includes('no update') || l.includes('⚠')))
  })

  test('under the newest answered messages, the gist of the answer, room allowing', () => {
    let opened = ''
    const ms = Array.from({ length: 10 }, (_, i) => ref(`What is value ${i}?`, { state: 'done', replyId: `r${i}`, replyText: `Value ${i} is ${100 + i}. More words follow here.` }))
    const p = ctx(ms, { openPart: id => (opened = id) })
    const lines = text(p)
    // The restated question goes: just the answer, under its message.
    const at = lines.findIndex(l => l.includes('What is value 0?'))
    assert.match(lines[at + 1]!, /→ 100\.\s*$/)
    // One under each of them; a click opens the reply.
    assert.equal(lines.filter(l => l.includes('→ ')).length, 10)
    panelLines(p, 40).lines.find(l => l.map(s => s.text).join('').includes('→ 100.'))!.find(s => s.action)!.action!()
    assert.equal(opened, 'r0')
    // A lost reply, or no reply, has none.
    assert.ok(!text(ctx([ref('gone', { state: 'lost', replyId: 'x', replyText: 'Lost words.' }), ref('fresh', { state: 'claude' })])).some(l => l.includes('→')))
    // A short panel: your messages first, the answers only in the rows left over (none here).
    const short = text(ctx(ms, { height: 16 }))
    assert.ok(!short.some(l => l.includes('→')))
    // More messages than the box has rows for the answers too: the newest get theirs.
    const many = text(ctx(Array.from({ length: 15 }, (_, i) => ref(`What is value ${i}?`, { state: 'done', replyId: `r${i}`, replyText: `Value ${i} is ${100 + i}.` })), { height: 60 }))
    assert.equal(many.filter(l => l.includes('→ ')).length, 5)
    assert.match(many[many.findIndex(l => l.includes('What is value 0?')) + 1]!, /→ 100\./)
    // Some room left: some answers, and never so many that a message scrolls out of its box.
    const mid = text(ctx(ms.slice(0, 4), { height: 12 }))
    assert.ok(mid.some(l => l.includes('→')) && ['0', '1', '2', '3'].every(i => mid.some(l => l.includes(`What is value ${i}?`))))
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

describe('scheduled jobs', () => {
  const job = (over: Partial<Job>): Job => ({ id: 'a1b2c3d4', toolId: 'tu-1', kind: 'cron', cron: '*/5 * * * *', recurring: true, prompt: 'Check the deploy', createdAt: NOW, nextAt: Date.now() + 3 * 60_000 + 5_000, for: [], state: 'scheduled', runs: [], ...over })

  test('no section until there is a job', () => {
    assert.ok(!text(ctx([])).some(l => l.startsWith('Scheduled')))
  })

  // The panel words times against the clock.
  test('each job: its mark, name, state, and when it runs; a click opens it', () => {
    const opened: string[] = []
    const p = ctx([], {
      openJob: id => opened.push(id),
      jobView: 'tu-2',
      jobs: [
        { job: job({ runs: [{ at: NOW }] }) },
        { job: job({ toolId: 'tu-2', kind: 'wakeup', recurring: false, cron: undefined, reason: 'waiting for CI' }), by: 'James (planner)' },
        { job: job({ toolId: 'tu-3', state: 'deleted', endedAt: NOW }) },
      ],
    })
    const lines = text(p, 56)
    assert.match(lines.find(l => l.startsWith('Scheduled'))!, /Scheduled +2 active/)
    assert.match(lines.find(l => l.includes('⏰ Check the deploy') && l.includes('ran once'))!, /│? ⏰ Check the deploy +ran once/)
    assert.ok(lines.some(l => /every 5 min · next \d\d:\d\d/.test(l)))
    assert.match(lines.find(l => l.includes('waiting for CI'))!, /▸⏲ waiting for CI +scheduled/)
    assert.ok(lines.some(l => /in 3 min · by James \(planner\)/.test(l)))
    assert.ok(lines.some(l => /⏰ Check the deploy +deleted/.test(l)))
    panelLines(p, 56).lines.find(l => l.some(s => s.text.includes('waiting for CI')))!.find(s => s.action)!.action!()
    assert.deepEqual(opened, ['tu-2'])
    // All finished: none active.
    assert.match(text(ctx([], { jobs: [{ job: job({ state: 'expired', endedAt: NOW }) }] })).find(l => l.startsWith('Scheduled'))!, /none active/)
  })

  test('folded, the panel counts the live jobs; a click opens the first', () => {
    const opened: string[] = []
    const p = ctx([], { isFolded: true, openJob: id => opened.push(id), jobs: [{ job: job({ state: 'deleted' }) }, { job: job({ toolId: 'tu-2' }) }] })
    const row = panelLines(p, 7).lines.find(l => l.some(s => s.text === '⏰'))!
    assert.equal(row.map(s => s.text).join('').trim().replace(/\s+/, ' '), '⏰ 1')
    row.find(s => s.text === '⏰')!.action!()
    assert.deepEqual(opened, ['tu-2'])
  })
})
