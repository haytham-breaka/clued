import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { answer, answeredInput, askLines, current, DISMISSED, newAsk, pick, questionsIn } from '../../app/ask.ts'
import { Claude } from '../../app/claude.ts'
import type { ClaudeEvent } from '../../app/claude.ts'
import { stepLabel } from '../../app/chat.ts'
import { REPLY_GUIDE } from '../../app/inbox.ts'
import { lineCells } from '../../app/text.ts'
import type { Line } from '../../app/text.ts'

// The input Claude Code sends with AskUserQuestion (as seen from claude -p).
const color = { question: 'Which color do you prefer?', header: 'Color', options: [{ label: 'Red', description: 'Warm.' }, { label: 'Blue', description: 'Cool.' }], multiSelect: false }
const fruit = { question: 'Which fruits do you like?', header: 'Fruit', options: [{ label: 'Apple', description: '' }, { label: 'Banana', description: '' }, { label: 'Cherry', description: '' }], multiSelect: true }
const text = (l: Line) => l.map(s => s.text).join('')
// The card's text without its left edge, rows joined: to read what wrapped.
const flat = (rows: string[]) => rows.map(r => r.replace(/^│ /, '').trim()).join(' ')
const noop = { pick: () => {}, send: () => {}, dismiss: () => {} }

test('questionsIn keeps questions with text and fills in what is missing', () => {
  assert.deepEqual(questionsIn({}), [])
  assert.deepEqual(questionsIn({ questions: 'no' }), [])
  const qs = questionsIn({ questions: [null, { question: '  ' }, { question: 'Why?', options: [{ label: 'A' }, { nope: 1 }, null], multiSelect: 'yes' }, color] })
  assert.deepEqual(qs, [
    { question: 'Why?', header: '', options: [{ label: 'A', description: '' }], multiSelect: false },
    color,
  ])
  assert.equal(newAsk('r0', { questions: [] }), undefined)
})

test('one question: a pick replaces the last one, and the answer is its label', () => {
  const a = newAsk('r1', { questions: [color] })!
  assert.equal(answer(a), 'empty')
  assert.equal(pick(a, 5), false)
  assert.equal(pick(a, -1), false)
  assert.equal(pick(a, 0), true)
  pick(a, 1)
  assert.deepEqual(a.picks, [1])
  assert.equal(answer(a), 'done')
  assert.deepEqual(answeredInput(a), { questions: [color], answers: { 'Which color do you prefer?': 'Blue' } })
})

test('several allowed: picks toggle and join with ", " in the card order', () => {
  const a = newAsk('r2', { questions: [fruit] })!
  pick(a, 2)
  pick(a, 0)
  pick(a, 1)
  pick(a, 1)
  assert.deepEqual(a.picks, [0, 2])
  assert.equal(answer(a), 'done')
  assert.equal(a.answers['Which fruits do you like?'], 'Apple, Cherry')
})

test('typed text is the answer ("Other"), even with an option picked', () => {
  const a = newAsk('r3', { questions: [color] })!
  pick(a, 0)
  assert.equal(answer(a, '   '), 'done')
  assert.equal(a.answers['Which color do you prefer?'], 'Red')
  const b = newAsk('r4', { questions: [color] })!
  pick(b, 0)
  assert.equal(answer(b, '  Green, actually '), 'done')
  assert.equal(b.answers['Which color do you prefer?'], 'Green, actually')
})

test('several questions are asked one after another, and the card says which one it is on', () => {
  const a = newAsk('r5', { questions: [color, fruit] })!
  let lines = askLines(a, 80, noop)
  assert.match(text(lines[0]!), /❓ Claude asks · question 1 of 2 · waiting for your answer/)
  pick(a, 0)
  assert.equal(answer(a), 'next')
  assert.equal(current(a).question, 'Which fruits do you like?')
  assert.deepEqual(a.picks, [], 'picks start again on the next question')
  lines = askLines(a, 80, noop)
  assert.match(text(lines[0]!), /question 2 of 2/)
  assert.ok(lines.some(l => text(l).includes('✓ Color: Red')), 'the answered one stays on the card')
  assert.match(text(lines.at(-1)!), /Send \(Enter\)/)
  assert.equal(answer(a, 'None'), 'done')
  assert.deepEqual(answeredInput(a).answers, { 'Which color do you prefer?': 'Red', 'Which fruits do you like?': 'None' })
})

test('the card: title, header chip, numbered options with descriptions, ✕, and every line fits', () => {
  const calls: string[] = []
  const a = newAsk('r6', { questions: [color, fruit] })!
  pick(a, 1)
  const lines = askLines(a, 60, { pick: n => calls.push(`pick ${n}`), send: () => calls.push('send'), dismiss: () => calls.push('dismiss') })
  const all = lines.map(text)
  assert.ok(all[0]!.startsWith('╭─ ❓ Claude asks'))
  assert.ok(all[0]!.endsWith(' ✕ '))
  assert.ok(all.some(l => l.includes(' Color  Which color do you prefer?')))
  assert.ok(all.some(l => l.includes('1  ○ Red  Warm.')))
  assert.ok(all.some(l => l.includes('2  ● Blue  Cool.')))
  assert.match(flat(all), /1-2 or click to choose, then Enter\. Or type your own answer below\./)
  assert.match(all.at(-1)!, /Next \(Enter\).*Dismiss \(Esc\)/)
  for (const l of lines) assert.ok(lineCells(l) <= 60, `fits: ${text(l)}`)
  // Clicks: the ✕, an option (any part of its row), Next, Dismiss.
  lines[0]!.at(-1)!.action!()
  lines.find(l => text(l).includes('Red'))!.at(-1)!.action!()
  lines.at(-1)!.find(s => s.text.includes('Next'))!.action!()
  lines.at(-1)!.find(s => s.text.includes('Dismiss'))!.action!()
  assert.deepEqual(calls, ['dismiss', 'pick 0', 'send', 'dismiss'])
})

test('the card for several allowed: tick boxes, and a long description wraps under its label', () => {
  const long = { ...fruit, header: '', options: [{ label: 'Apple', description: 'a crisp and sweet fruit that keeps well through the winter' }, { label: 'Pear', description: '' }] }
  const a = newAsk('r7', { questions: [long] })!
  pick(a, 0)
  const lines = askLines(a, 40, noop).map(text)
  assert.ok(lines.some(l => l.includes('1  ☑ Apple')))
  assert.ok(lines.some(l => l.includes('2  ☐ Pear')))
  assert.ok(lines.some(l => /^│ {7}\S/.test(l)), 'the wrapped description lines up under the label')
  assert.match(flat(lines), /1-2 or click to tick each one that applies, then Enter\./)
  const one = newAsk('r8', { questions: [{ question: 'Go?', options: [{ label: 'Yes' }] }] })!
  assert.ok(askLines(one, 60, noop).map(text).some(l => l.includes('1 or click to choose')))
})

test('the step line names the question, and the guide asks Claude to use the tool for choices', () => {
  const step = (input: Record<string, unknown>) => stepLabel({ tool: { id: 'u', name: 'AskUserQuestion', input } } as any, '/tmp/w')
  assert.deepEqual(step({ questions: [color, fruit] }), { icon: '?', text: 'Asked you: Which color do you prefer? · Which fruits do you like?' })
  assert.deepEqual(step({}), { icon: '?', text: 'Asked you: ' })
  assert.match(REPLY_GUIDE, /AskUserQuestion tool/)
})

// The process side: a `claude` on PATH that sends one AskUserQuestion request and logs what comes back.
const dir = mkdtempSync(join(tmpdir(), 'clued-ask-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const request = { type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [color] }, tool_use_id: 't1', requires_user_interaction: true } }
const plain = { type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } }
const fake = join(dir, 'fake.mjs')
writeFileSync(fake, `
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
process.stdout.write(${JSON.stringify(JSON.stringify(request) + '\n' + JSON.stringify(plain) + '\n')})
createInterface({ input: process.stdin }).on('line', l => appendFileSync(${JSON.stringify(join(dir, 'stdin.jsonl'))}, l + '\\n')).on('close', () => process.exit(0))
`)
writeFileSync(join(dir, 'claude'), `#!/bin/sh\nexec node ${JSON.stringify(fake)} "$@"\n`)
chmodSync(join(dir, 'claude'), 0o755)

test('AskUserQuestion comes as an ask event; the answer goes back as allow with answers, a dismissal as deny', async () => {
  const path = process.env.PATH
  process.env.PATH = `${dir}:${path}`
  const events: ClaudeEvent[] = []
  let claude: Claude
  const exited = new Promise<void>(done => {
    claude = new Claude({ args: [], cwd: dir, appendSystemPrompt: '' }, e => {
      events.push(e)
      if (e.kind === 'exit') done()
    })
  })
  process.env.PATH = path
  while (events.length < 2) await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(events[0], { kind: 'ask', requestId: 'q1', input: { questions: [color] } })
  assert.equal(events[1]!.kind, 'permission', 'other tools still ask for permission')
  const a = newAsk('q1', (events[0] as any).input)!
  pick(a, 1)
  answer(a)
  claude!.answerAsk('q1', answeredInput(a))
  claude!.answerAsk('q2', {}, DISMISSED)
  claude!.answerPermission('p1', true, { command: 'ls' })
  claude!.close()
  await exited
  const file = join(dir, 'stdin.jsonl')
  assert.ok(existsSync(file))
  const sent = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(m => m.type === 'control_response')
  assert.deepEqual(sent.map(m => m.response), [
    { subtype: 'success', request_id: 'q1', response: { behavior: 'allow', updatedInput: { questions: [color], answers: { 'Which color do you prefer?': 'Blue' } } } },
    { subtype: 'success', request_id: 'q2', response: { behavior: 'deny', message: DISMISSED } },
    { subtype: 'success', request_id: 'p1', response: { behavior: 'allow', updatedInput: { command: 'ls' } } },
  ])
})
