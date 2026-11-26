import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { COMMAND, commandEnd, styleHead, styleLaidHead } from '../../app/command.ts'
import { inputRow, setBidiMode } from '../../app/bidi.ts'
import { C } from '../../app/text.ts'
import type { Line } from '../../app/text.ts'

const known = (name: string) => ['btw', 'model', 'compact', 'review-pr', 'pr-review-toolkit:review-pr'].includes(name)
/** Each span as text, `*text*` when drawn in the command's colour. */
const marked = (l: Line) => l.map(s => (s.style?.fg === C.command ? `*${s.text}*` : s.text)).join('')

describe('commandEnd: the slash command at the start of a message', () => {
  test('a known command by itself, or with its arguments: the token up to the first space', () => {
    assert.equal(commandEnd('/btw', known), 4)
    assert.equal(commandEnd('/btw what is this?', known), 4)
    assert.equal(commandEnd('/model\nopus', known), 6)
    assert.equal(commandEnd('/review-pr 12', known), 10)
  })
  test('skills and plugin commands too', () => {
    assert.equal(commandEnd('/pr-review-toolkit:review-pr 81', known), 28)
  })
  test('an unknown command stays plain: a typo shows', () => {
    assert.equal(commandEnd('/bwt what', known), 0)
    assert.equal(commandEnd('/', known), 0)
    assert.equal(commandEnd('/ btw', known), 0)
  })
  test('only at the very start: a slash further on is just text', () => {
    assert.equal(commandEnd('try /btw later', known), 0)
    assert.equal(commandEnd(' /btw x', known), 0)
  })
  test('a path is not a command, even when it starts like one', () => {
    assert.equal(commandEnd('/tmp/x', known), 0)
    assert.equal(commandEnd('/btw/notes.txt is here', known), 0)
    assert.equal(commandEnd('/model/', known), 0)
  })
})

describe('styleHead', () => {
  test('restyles the first characters, the rest keeps its own style', () => {
    const l = styleHead([{ text: '/btw why', style: { italic: true } }], 4)
    assert.equal(marked(l), '*/btw* why')
    assert.deepEqual(l[0]!.style, { italic: true, ...COMMAND })
    assert.deepEqual(l[1]!.style, { italic: true })
  })
  test('across spans, and nothing when there is no command', () => {
    const spans = [{ text: '/b' }, { text: 'tw x' }, { text: 'y' }]
    assert.equal(marked(styleHead(spans, 4)), '*/b**tw* xy')
    assert.equal(styleHead(spans, 0), spans)
    assert.equal(styleHead(spans, -3), spans)
  })
  test('a row past the command (a wrapped line) is left as it is', () => {
    const spans = [{ text: 'later words' }]
    assert.deepEqual(styleHead(spans, 0), spans)
  })
})

describe('styleLaidHead: a right-to-left input row', () => {
  test('the command keeps its colour in a row the app reorders; the Arabic after it stays plain', () => {
    setBidiMode('app')
    const text = '/btw ما هذا'
    const lay = inputRow(text, 'ltr')
    const l = styleLaidHead(lay, 4)
    assert.match(marked(l), /^\*\/btw\* /)
    assert.equal(l.map(s => s.text).join(''), lay.spans.map(s => s.text).join(''), 'the same cells')
    // What a selection copies is still the text as written.
    assert.equal(l.flatMap(s => s.units ?? []).map(u => u.src).join(''), lay.spans.flatMap(s => s.units ?? []).map(u => u.src).join(''))
    assert.equal(styleLaidHead(lay, 0), lay.spans)
  })
  test('a selection over the command is drawn selected and in its colour', () => {
    setBidiMode('app')
    const l = styleLaidHead(inputRow('/btw ما', 'ltr', [1, 3]), 4)
    const bt = l.find(s => s.text === 'bt')!
    assert.ok(bt.style?.inverse && bt.style.fg === C.command)
  })
  test('spans laid out without units are left alone', () => {
    const sp = { text: 'x' }
    assert.deepEqual(styleLaidHead({ spans: [sp], clusters: [] }, 1), [sp])
  })
})
