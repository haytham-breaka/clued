import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lineDiff } from '../../app/diff.ts'

const show = (before: string, after: string) => lineDiff(before, after).map(d => `${d.kind}${d.text}`)

test('identical text has no changes', () => {
  assert.deepEqual(show('a\nb', 'a\nb'), [' a', ' b'])
})

test('a changed line is removed then added, with context around it', () => {
  assert.deepEqual(show('1\n2\n3\n4\n5\nold\n6\n7\n8\n9', '1\n2\n3\n4\n5\nnew\n6\n7\n8\n9'), [' 3', ' 4', ' 5', '-old', '+new', ' 6', ' 7', ' 8'])
})

test('keeps the common lines in the middle of a change', () => {
  assert.deepEqual(show('a\nx\nb\ny', 'a\nb\nz'), [' a', '-x', ' b', '-y', '+z'])
})

test('added and removed lines on their own', () => {
  assert.deepEqual(show('a', 'a\nb'), [' a', '+b'])
  assert.deepEqual(show('a\nb', 'b'), ['-a', ' b'])
  assert.deepEqual(show('', 'x'), ['-', '+x'])
})

test('a very large change skips the table: all removed, then all added', () => {
  const a = Array.from({ length: 600 }, (_, i) => `a${i}`).join('\n')
  const b = Array.from({ length: 600 }, (_, i) => `b${i}`).join('\n')
  const d = lineDiff(a, b)
  assert.equal(d.length, 1200)
  assert.ok(d.slice(0, 600).every(x => x.kind === '-'))
  assert.ok(d.slice(600).every(x => x.kind === '+'))
})
