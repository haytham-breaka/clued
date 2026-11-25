import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cellText, cells, charCells, clip, clipLine, lineCells, markCells, pad, sgr, wrap } from '../../app/text.ts'
import type { Line } from '../../app/text.ts'

const plain = (l: Line) => l.map(s => s.text).join('')

describe('cell widths', () => {
  test('ASCII is one cell, wide emoji and CJK two, joiners and marks none', () => {
    assert.equal(charCells('a'), 1)
    assert.equal(charCells('⏳'), 2)
    assert.equal(charCells('✋'), 2)
    assert.equal(charCells('漢'), 2)
    assert.equal(charCells('😀'), 2)
    assert.equal(charCells('‍'), 0)
    assert.equal(charCells('️'), 0)
    assert.equal(charCells('́'), 0)
    assert.equal(charCells('\x07'), 0)
    assert.equal(charCells('✓'), 1)
  })
  test('cells sums a string, lineCells a line', () => {
    assert.equal(cells('ab⏳'), 4)
    assert.equal(lineCells([{ text: 'ab' }, { text: '漢字' }]), 6)
    assert.equal(cells(''), 0)
  })
})

describe('sgr', () => {
  test('builds the escape for every style', () => {
    assert.equal(sgr(), '\x1b[0m')
    assert.equal(sgr({ bold: true, dim: true, italic: true, underline: true, inverse: true, fg: 1, bg: 2 }), '\x1b[0;1;2;3;4;7;38;5;1;48;5;2m')
  })
})

describe('clip', () => {
  test('keeps text that fits, cuts with an ellipsis', () => {
    assert.equal(clip('hello', 10), 'hello')
    assert.equal(clip('hello world', 6), 'hello…')
    assert.equal(clip('abc', 0), '')
  })
  test('counts wide characters as two cells', () => {
    assert.equal(clip('漢字漢字', 5), '漢字…')
  })
  test('clipLine cuts across spans and keeps their styles', () => {
    const l = clipLine([{ text: 'abc', style: { bold: true } }, { text: 'defgh' }, { text: 'zzz' }], 6)
    assert.equal(plain(l), 'abcde…')
    assert.deepEqual(l[0]!.style, { bold: true })
    assert.equal(l.length, 2)
  })
  test('pad makes spaces, never negative', () => {
    assert.equal(pad(3).text, '   ')
    assert.equal(pad(-2).text, '')
    assert.deepEqual(pad(1, { bg: 3 }).style, { bg: 3 })
  })
})

describe('wrap', () => {
  test('breaks at spaces and drops trailing spaces', () => {
    const lines = wrap([{ text: 'the quick brown fox jumps' }], 10)
    assert.deepEqual(lines.map(plain), ['the quick', 'brown fox', 'jumps'])
  })
  test('keeps styles per word', () => {
    const lines = wrap([{ text: 'plain ' }, { text: 'bold', style: { bold: true } }], 40)
    assert.equal(lines.length, 1)
    assert.deepEqual(lines[0]!.at(-1), { text: 'bold', style: { bold: true } })
  })
  test('hard-breaks a word longer than the line', () => {
    const lines = wrap([{ text: 'abcdefghijkl' }], 5)
    assert.deepEqual(lines.map(plain), ['abcde', 'fghij', 'kl'])
  })
  test('follows newlines in the text', () => {
    assert.deepEqual(wrap([{ text: 'one\ntwo\n\nthree' }], 20).map(plain), ['one', 'two', '', 'three'])
  })
  test('indents lines after the first', () => {
    const lines = wrap([{ text: '• item that wraps around' }], 12, [pad(2)])
    assert.deepEqual(lines.map(plain), ['• item that', '  wraps', '  around'])
  })
  test('an empty input is one empty line; widths under 4 count as 4', () => {
    assert.deepEqual(wrap([], 10), [[]])
    assert.deepEqual(wrap([{ text: 'abcdef' }], 1).map(plain), ['abcd', 'ef'])
  })
  test('a wide character that cannot fit even alone does not loop', () => {
    assert.deepEqual(wrap([{ text: '漢漢漢漢漢' }], 4).map(plain), ['漢漢', '漢漢', '漢'])
  })
})

describe('selection cells', () => {
  const line: Line = [{ text: 'ab', style: { fg: 1 } }, { text: 'cd⏳e' }]
  test('markCells inverts the chosen cells only', () => {
    const marked = markCells(line, 1, 3)
    assert.equal(plain(marked), 'abcd⏳e')
    const inv = marked.filter(s => s.style?.inverse).map(s => s.text).join('')
    assert.equal(inv, 'bc')
    assert.equal(markCells(line, 3, 3), line)
  })
  test('markCells keeps an inverse span visible by flipping it back', () => {
    const marked = markCells([{ text: 'xy', style: { inverse: true } }], 0, 1)
    assert.equal(marked[0]!.style?.inverse, false)
    assert.equal(marked[1]!.style?.inverse, true)
  })
  test('cellText reads the characters in a cell range', () => {
    assert.equal(cellText(line, 1, 4), 'bcd')
    assert.equal(cellText(line, 4, 7), '⏳e')
    assert.equal(cellText(line, 0, Infinity), 'abcd⏳e')
  })
})
