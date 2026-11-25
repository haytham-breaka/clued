import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { blocksOf, compare, framesB, hits, judgeTranscript, needsJudge, panelClaim, rates, replayA, ruleTruth, stateAt } from '../../eval/visibility-core.ts'
import type { Ev, Pair, SavedRun, Scenario, Truth } from '../../eval/visibility-core.ts'

// A recorded session, as eval/run.ts saves it: a question, a request sent while Claude works, and a
// small request answered by a reaction only. Claude answers the first two in one marked reply and asks
// something about the second.
const ASK = '<<reply T1>>\nThe port is 8137.\n\n<<reply T2>>\nworkers is now 6. Should I also update the README?\n<clued>{"topics":[{"id":"T1","title":"Port","status":"done"},{"id":"T2","title":"Workers","status":"me"}]}</clued>'
const REACT = '<clued>{"topics":[{"id":"T3","title":"Port 9000","status":"done"}],"react":"✅"}</clued>'

const scenario: Scenario = {
  id: 'tiny', set: 'hard', about: 'test',
  messages: [
    { id: 'm1', send: 'start', text: 'What port does server.toml use?', about: 'port', expect: [{ name: '8137', re: '8137' }] },
    { id: 'm2', send: 'afterTool', text: 'Set workers to 6.', about: 'worker', expect: [{ name: '6', re: '\\b6\\b' }] },
    { id: 'm3', send: 'idle', text: 'Change it to 9000.', about: 'port', expect: [{ name: '9000', re: '9000' }] },
  ],
}

function runOf(arm: 'A' | 'B'): SavedRun {
  return {
    scenario: 'tiny', set: 'hard', arm, rep: 1, startedAt: '2026-11-25T10:00:00.000Z',
    sent: [
      { id: 'm1', t: 0, text: scenario.messages[0]!.text, shown: scenario.messages[0]!.text, topicId: 'T1', midTurn: false },
      { id: 'm2', t: 1200, text: scenario.messages[1]!.text, shown: scenario.messages[1]!.text, topicId: 'T2', midTurn: true },
      { id: 'm3', t: 5000, text: scenario.messages[2]!.text, shown: scenario.messages[2]!.text, topicId: 'T3', midTurn: false },
    ],
    texts: [], results: [], score: { messages: [] },
  }
}

const result = (t: number, text: string): Ev => ({ t, e: { type: 'result', result: text, is_error: false, duration_ms: 10, total_cost_usd: 0, usage: {} } })
const events: Ev[] = [
  { t: 100, e: { type: 'system', subtype: 'init', session_id: 's', model: 'm', cwd: '/tmp/x' } },
  { t: 1000, e: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'cat server.toml' } }] } } },
  { t: 1100, e: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'port = 8137\nworkers = 4' }] } } },
  { t: 3000, e: { type: 'assistant', message: { content: [{ type: 'text', text: ASK }] } } },
  result(3010, ASK),
  { t: 6000, e: { type: 'assistant', message: { content: [{ type: 'text', text: REACT }] } } },
  result(6010, REACT),
]

describe('arm A: the recorded stream through the app', () => {
  const frames = replayA(runOf('A'), events)
  const states = (label: string) => Object.fromEntries(frames.find(f => f.label === label)!.panel!.map(p => [p.id, p.state]))
  test('a moment before each later message, and the end', () => {
    assert.deepEqual(frames.map(f => f.label), ['before m2', 'before m3', 'end'])
    assert.deepEqual(frames.map(f => f.sentIds.length), [1, 2, 3])
  })
  test('the panel: on Claude, then done and waiting on you, then the reaction counts as done', () => {
    assert.deepEqual(states('before m2'), { m1: 'claude' })
    assert.deepEqual(states('before m3'), { m1: 'done', m2: 'me' })
    // m3 is a plain message while one question was open, so the app takes it as the answer at first; the
    // reply's tag leaves T2 out (m3 was about the port), so m2's question is open again.
    assert.deepEqual(states('end'), { m1: 'done', m2: 'me', m3: 'done' })
    const end = frames.at(-1)!.panel!
    assert.match(end.find(p => p.id === 'm1')!.replyText!, /8137/)
    assert.equal(end.find(p => p.id === 'm3')!.reacted, true)
    assert.deepEqual(end.map(panelClaim), ['done', 'waiting', 'done'])
    assert.deepEqual(frames[1]!.panel!.map(panelClaim), ['done', 'waiting'])
  })
  test('the screen holds the panel and the chat; the end frame also holds the whole chat', () => {
    const end = frames.at(-1)!
    assert.match(end.screen, /Your recent messages/)
    assert.match(end.screen, /The port is 8137/)
    assert.ok(end.full && end.full.length >= end.panel!.length)
    assert.equal(frames[0]!.full, undefined)
  })
  test('a topic id the replay would give differently is an error, not a silent mismatch', () => {
    const run = runOf('A')
    run.sent[1] = { ...run.sent[1]!, topicId: 'T9' }
    assert.throws(() => replayA(run, events), /replay gave m2 T2/)
  })
})

describe('arm A: the app asks again for a reply that never arrived', () => {
  // The first answer's tag settles both messages but writes only m1's part; the app asks for m2's.
  const LOSE = '<<reply T1>>\nThe port is 8137.\n<clued>{"topics":[{"id":"T1","status":"done"},{"id":"T2","status":"done"}]}</clued>'
  const AGAIN = '<<reply T2>>\nworkers is now 6.\n<clued>{"topics":[{"id":"T2","status":"done"}]}</clued>'
  const evs: Ev[] = [
    { t: 3000, e: { type: 'assistant', message: { content: [{ type: 'text', text: LOSE }] } } },
    result(3010, LOSE),
    { t: 4000, e: { type: 'assistant', message: { content: [{ type: 'text', text: AGAIN }] } } },
    result(4010, AGAIN),
  ]
  const run = { ...runOf('A'), sent: runOf('A').sent.slice(0, 2), retries: [{ t: 3010, ids: ['T2'], text: 'Your reply to T2 never reached the app.' }] }
  test('lost, then answered by the reply to the ask', () => {
    const frames = replayA(run, evs)
    assert.deepEqual(frames.at(-1)!.panel!.map(p => [p.id, p.state]), [['m1', 'done'], ['m2', 'done']])
    assert.match(frames.at(-1)!.panel![1]!.replyText!, /workers is now 6/)
    assert.match(frames.at(-1)!.screen, /↻ asked Claude again for a reply that never arrived/)
    // Without the ask, m2 stays lost.
    assert.equal(replayA({ ...run, retries: [] }, evs.slice(0, 2)).at(-1)!.panel![1]!.state, 'lost')
  })
})

describe('arm B: the same stream as Claude Code shows it', () => {
  const frames = framesB(runOf('B'), events)
  test('prompts, tool lines with their result, and text; nothing from after the moment', () => {
    assert.match(frames[0]!.screen, /^> What port/m)
    assert.match(frames[0]!.screen, /⏺ Bash\(cat server\.toml\)/)
    assert.match(frames[0]!.screen, /⎿ {2}port = 8137 … \+1 lines/)
    assert.doesNotMatch(frames[0]!.screen, /8137\./)
    assert.match(frames.at(-1)!.screen, /^ {2}The port is 8137\./m)
    assert.ok(frames.at(-1)!.full)
  })
})

describe('ground truth', () => {
  const run = runOf('B')
  const { blocks, tools } = blocksOf(run, events)
  test('Claude\'s visible blocks: a reply and a reaction', () => {
    assert.deepEqual(blocks.map(b => [b.id, b.reply, b.react ?? '', b.turn.join(',')]), [['C1', true, '', 'm1,m2'], ['C2', true, '✅', 'm3']])
    assert.equal(tools.length, 1)
  })
  test('the rules: the block with the facts, or the reaction on a small request', () => {
    assert.deepEqual(ruleTruth(scenario, run, blocks).map(t => t.answeredIn), ['C1', 'C1', 'C2'])
  })
  test('a question mark sends the run to the careful judge', () => {
    assert.deepEqual(needsJudge(run, blocks, ruleTruth(scenario, run, blocks)), ['Claude asked a question'])
    assert.match(judgeTranscript(run, blocks, tools), /\[C2\] Claude, at 6\.0 s: reacted ✅/)
  })
  test('state over time: working, then waiting until the user answers, then done', () => {
    const tr: Truth = { id: 'm2', answeredAt: 3000, asksAt: 3000, resolvedAt: 5000, source: 'judge' }
    assert.equal(stateAt(tr, 2000), 'working')
    assert.equal(stateAt(tr, 4000), 'waiting')
    assert.equal(stateAt(tr, 6000), 'done')
    assert.equal(stateAt({ id: 'm1', source: 'rules' }, Infinity), 'working')
  })
  test('facts match with markdown and underscores dropped, as the panel previews show them', () => {
    const m = { id: 'x', send: 'start', text: 'x', expect: [{ name: 'f', re: 'discount_price' }] }
    assert.equal(hits(m, 'added discountprice'), true)
    assert.equal(hits(m, 'added price'), false)
    assert.equal(hits({ ...m, expect: [{ name: 'q', re: '\\?' }] }, 'anything?'), false)
  })
})

describe('scores', () => {
  const pair = (truth: Pair['truth']): Pair => ({ run: 'r', scenario: 's', arm: 'A', rep: 1, frame: 'end', msg: 'm', truth, checkable: true, byReaction: false })
  test('answered, open, links, and each kind of miss', () => {
    const r = rates([
      { p: pair('done'), v: { claim: 'done', link: true } },
      { p: pair('done'), v: { claim: 'unknown' } },
      { p: pair('waiting'), v: { claim: 'done', link: true } },
      { p: pair('working'), v: { claim: 'done' } },
    ])
    assert.equal(r.n, 4)
    assert.equal(r.answered, 0.5)
    assert.equal(r.open, 0.25)
    assert.equal(r.unknown, 0.25)
    assert.equal(r.found, 0.5)
    assert.equal(r.falseAnswered, 1)
    assert.equal(r.falseDone, 2)
    assert.equal(r.falseOpen, 0)
  })
  test('the stratified permutation test', () => {
    const rows = ['a', 'b', 'c'].flatMap(scenario => [1, 2, 3].flatMap(i => [{ scenario, side: 'X' as const, v: 1 + i / 100 }, { scenario, side: 'Y' as const, v: i / 100 }]))
    const c = compare(rows)
    assert.ok(Math.abs(c.diff - 1) < 1e-9)
    assert.ok(c.p < 0.01)
    assert.ok(Number.isNaN(compare([]).diff))
  })
})
