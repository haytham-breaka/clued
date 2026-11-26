import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Claude } from '../../app/claude.ts'
import type { Answer, ClaudeEvent } from '../../app/claude.ts'
import { choice, currentAt, effortLabel, efforts, move, newPicker, parseModels, pickerLines, shiftEffort } from '../../app/models.ts'
import { lineCells } from '../../app/text.ts'
import type { Line } from '../../app/text.ts'

// The initialize answer's `models`, as Claude Code 2.1 sends them (trimmed).
const levels = ['low', 'medium', 'high', 'xhigh', 'max']
const raw = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: levels },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work and everyday tasks', supportsEffort: true, supportedEffortLevels: levels },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: 'Most efficient for simpler tasks', supportsEffort: true, supportedEffortLevels: levels },
  { value: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest for quick answers', supportsThinkingOff: true },
]
const text = (l: Line) => l.map(s => s.text).join('')
const noop = { choose: () => {}, effort: () => {}, cancel: () => {} }

test('parseModels: each model once, with its name, description and effort levels; junk skipped', () => {
  const models = parseModels([...raw, null, 7, { value: '' }, { value: 'opus', displayName: 'again' }, { value: 'bare' }, { value: 'off', supportsEffort: false, supportedEffortLevels: ['low'] }, { value: 'odd', supportedEffortLevels: ['low', 3, ''] }])
  assert.deepEqual(models.map(m => m.value), ['default', 'opus', 'sonnet', 'claude-haiku-4-5-20251001', 'bare', 'off', 'odd'])
  assert.deepEqual(models[0], { value: 'default', resolved: 'claude-opus-5-5', name: 'Default (recommended)', about: 'Opus 5.5 · Best for everyday, complex tasks', efforts: levels })
  assert.deepEqual(models[3]!.efforts, [], 'Haiku 4.5 has no effort levels')
  assert.deepEqual(models[4], { value: 'bare', resolved: 'bare', name: 'bare', about: '', efforts: [] })
  assert.deepEqual(models[5]!.efforts, [], 'supportsEffort: false wins')
  assert.deepEqual(models[6]!.efforts, ['low'])
  assert.deepEqual(parseModels(undefined), [])
  assert.deepEqual(parseModels({ value: 'x' }), [])
})

test('currentAt: what was chosen decides between models that run the same id; else Default, else the running id', () => {
  const models = parseModels(raw)
  assert.equal(currentAt(models, 'opus', 'claude-opus-5-5'), 1)
  assert.equal(currentAt(models, '', 'claude-opus-5-5'), 0, 'nothing chosen: Claude Code\'s default')
  assert.equal(currentAt(models, '', ''), 0)
  assert.equal(currentAt(models, 'claude-sonnet-5-5', ''), 2, 'a model id chosen')
  assert.equal(currentAt(models, '', 'claude-sonnet-5-5'), 2, 'the default runs another model: the one running')
  assert.equal(currentAt(models, 'mystery', 'claude-haiku-4-5-20251001'), 3)
  assert.equal(currentAt(models, 'mystery', ''), -1)
  assert.equal(currentAt(models, 'mystery', 'other'), -1)
  assert.equal(currentAt(models.slice(1), '', 'claude-opus-5-5'), 0, 'no Default listed')
})

test('the picker: arrows move within the list, ←/→ the effort of the model picked, Enter says what changed', () => {
  const models = parseModels(raw)
  const p = newPicker(models, 1, 'high')
  assert.equal(p.at, 1)
  move(p, -1)
  move(p, -1)
  assert.equal(p.at, 0)
  move(p, 1)
  assert.deepEqual(choice(p), {}, 'the model in use, the same effort: nothing to do')
  assert.ok(shiftEffort(p, 1))
  assert.equal(p.effort, 'xhigh')
  shiftEffort(p, 1)
  shiftEffort(p, 1)
  assert.equal(p.effort, 'max', 'stops at the top')
  assert.deepEqual(choice(p), { effort: 'max' })
  move(p, 0, 2)
  assert.deepEqual(choice(p), { model: models[2], effort: 'max' })
  // A model with no levels: ←/→ do nothing and no effort goes with it.
  move(p, 0, 9)
  assert.equal(p.at, 3, 'stops at the last row')
  assert.deepEqual(efforts(p), [])
  assert.equal(shiftEffort(p, -1), false)
  assert.deepEqual(choice(p), { model: models[3] })
  // From an effort not known yet, the first press shows high (or the middle level).
  const q = newPicker(models, -1, '')
  assert.equal(q.at, 0)
  assert.equal(q.current, -1)
  shiftEffort(q, -1)
  assert.equal(q.effort, 'high')
  const odd = newPicker(parseModels([{ value: 'a', supportedEffortLevels: ['x', 'y', 'z'] }]), 0, '')
  shiftEffort(odd, 1)
  assert.equal(odd.effort, 'y')
  assert.deepEqual(choice(newPicker([], -1, '')), {})
  assert.equal(effortLabel('xhigh'), 'Xhigh effort')
})

test('pickerLines: every model with its description, the one in use ticked, the effort row, all inside the width', () => {
  const models = parseModels(raw)
  const p = newPicker(models, 1, 'high')
  const picked: (number | string)[] = []
  const L = pickerLines(p, 90, 10, { choose: i => picked.push(i), effort: l => picked.push(l), cancel: () => picked.push('cancel') })
  const rows = L.map(text)
  assert.match(rows[0]!, /^╭─ Select model · for this session +✕ $/)
  assert.match(rows[1]!, /^│ {3}1\. Default \(recommended\) +Opus 5\.5 · Best for everyday, complex tasks$/)
  assert.match(rows[2]!, /^│ ▸ 2\. Opus 5\.5 ✔ +For complex work and everyday tasks$/)
  assert.match(rows[4]!, /4\. Haiku 4\.5 +Fastest for quick answers/)
  assert.match(rows[5]!, /^│ High effort {2} low {2} medium {2}\[high\] {2}xhigh {2} max {3}← → to adjust$/)
  assert.match(rows[6]!, /^╰─ ↑↓ choose · ←→ effort · Enter switch · Esc cancel$/)
  for (const l of L) assert.ok(lineCells(l) <= 90, text(l))
  // The descriptions line up.
  assert.equal(rows[1]!.indexOf('Opus 5.5 ·'), rows[2]!.indexOf('For complex'))
  // Clicks: a row chooses it, a level picks it, ✕ cancels.
  L[3]!.find(s => s.text.includes('Sonnet'))!.action!()
  L[5]!.find(s => s.text.includes('max'))!.action!()
  L[0]!.at(-1)!.action!()
  assert.deepEqual(picked, [2, 'max', 'cancel'])
  // On a model with no levels; and when none has any, no effort row at all.
  move(p, 0, 3)
  assert.match(pickerLines(p, 90, 10, noop).map(text).join('\n'), /This model has no effort levels\.\n╰─ ↑↓ choose · Enter switch · Esc cancel/)
  assert.doesNotMatch(pickerLines(newPicker(models.slice(3), 0, ''), 90, 10, noop).map(text).join('\n'), /effort/)
  // An effort not known yet: the levels, none marked.
  assert.match(pickerLines(newPicker(models, 0, ''), 90, 10, noop).map(text)[5]!, /^│ Effort {3}low/)
})

test('pickerLines: a long list shows a window around the row picked; narrow, everything is cut to fit', () => {
  const many = parseModels(Array.from({ length: 12 }, (_, i) => ({ value: `m${i}`, displayName: `Model ${i}`, description: 'A model with a rather long description that goes on' })))
  const p = newPicker(many, 0, '')
  let rows = pickerLines(p, 60, 4, noop).map(text)
  assert.equal(rows.filter(r => /\d+\. Model/.test(r)).length, 4)
  assert.match(rows.join('\n'), /│ 8 more ↓/)
  move(p, 0, 6)
  rows = pickerLines(p, 60, 4, noop).map(text)
  assert.match(rows.join('\n'), /▸ {2}7\. Model 6/)
  assert.match(rows.join('\n'), /│ ↑ 8 more ↓/)
  move(p, 0, 11)
  rows = pickerLines(p, 60, 4, noop).map(text)
  assert.match(rows.join('\n'), /│ ↑ 8 more\n/)
  assert.match(rows.join('\n'), /▸ 12\. Model 11/)
  for (const l of pickerLines(p, 24, 4, noop)) assert.ok(lineCells(l) <= 24, text(l))
  for (const l of pickerLines(newPicker(parseModels(raw), 0, 'high'), 30, 4, noop)) assert.ok(lineCells(l) <= 30, text(l))
})

// The process side: a `claude` on PATH that answers set_model, apply_flag_settings and get_settings as Claude Code 2.1 does.
const dir = mkdtempSync(join(tmpdir(), 'clued-models-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const fake = join(dir, 'fake.mjs')
writeFileSync(fake, `
import { createInterface } from 'node:readline'
const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
createInterface({ input: process.stdin }).on('line', l => {
  const e = JSON.parse(l)
  if (e.type !== 'control_request') return
  const r = e.request, id = e.request_id
  if (r.subtype === 'set_model' && r.model === 'sonnet') out({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { model: 'claude-sonnet-5-5' } } })
  else if (r.subtype === 'set_model') out({ type: 'control_response', response: { subtype: 'error', request_id: id, error: "Model '" + r.model + "' not found", error_code: 'not_found' } })
  else if (r.subtype === 'apply_flag_settings') out({ type: 'control_response', response: { subtype: 'success', request_id: id } })
  else if (r.subtype === 'get_settings') out({ type: 'control_response', response: { subtype: 'error', request_id: id } })
}).on('close', () => process.exit(0))
`)
writeFileSync(join(dir, 'claude'), `#!/bin/sh\nexec node ${JSON.stringify(fake)} "$@"\n`)
chmodSync(join(dir, 'claude'), 0o755)

test('Claude: setModel, setEffort and settings send their control requests and give back the answer or the error', async () => {
  const path = process.env.PATH
  process.env.PATH = `${dir}:${path}`
  let claude: Claude
  const exited = new Promise<void>(done => {
    claude = new Claude({ args: [], cwd: dir, appendSystemPrompt: '' }, (e: ClaudeEvent) => {
      if (e.kind === 'exit') done()
    })
  })
  process.env.PATH = path
  const ask = (f: (done: (r: Answer) => void) => void) => new Promise<Answer>(done => f(done))
  assert.deepEqual(await ask(d => claude.setModel('sonnet', d)), { ok: true, response: { model: 'claude-sonnet-5-5' } })
  assert.deepEqual(await ask(d => claude.setModel('nope', d)), { ok: false, error: "Model 'nope' not found", code: 'not_found' })
  assert.deepEqual(await ask(d => claude.setEffort('low', d)), { ok: true, response: {} })
  assert.deepEqual(await ask(d => claude.settings(d)), { ok: false, error: 'Claude Code refused' })
  claude!.close()
  await exited
  assert.deepEqual(await ask(d => claude.setModel('sonnet', d)), { ok: false, error: 'Claude Code is not running' })
})
