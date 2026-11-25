import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { inline, isCopyable, markdown } from '../../app/markdown.ts'
import type { Line } from '../../app/text.ts'
import { lineCells } from '../../app/text.ts'

const plain = (l: Line) => l.map(s => s.text).join('')
const text = (src: string, width = 40) => markdown(src, width).map(plain)

describe('inline', () => {
  test('code, bold, italic, links and strikethrough', () => {
    const spans = inline('a `x` **b** *i* _j_ __u__ [t](https://example.com) [s](#here) [u](u) ~~gone~~')
    const by = (t: string) => spans.find(s => s.text === t)
    assert.equal(by('x')?.style?.bg, 236)
    assert.equal(by('b')?.style?.bold, true)
    assert.equal(by('i')?.style?.italic, true)
    assert.equal(by('j')?.style?.italic, true)
    assert.equal(by('u')?.style?.bold, true)
    assert.equal(by('t')?.style?.underline, true)
    assert.ok(by(' (https://example.com)'))
    assert.ok(!spans.some(s => s.text === ' (#here)'))
    assert.equal(by('gone')?.style?.dim, true)
  })
  test('bold wraps italic, and the base style carries through', () => {
    const spans = inline('**a _b_**', { fg: 1 })
    assert.equal(spans.find(s => s.text === 'b')?.style?.italic, true)
    assert.equal(spans.find(s => s.text === 'b')?.style?.bold, true)
    assert.equal(spans[0]!.style?.fg, 1)
  })
  test('snake_case and 2*3*4 stay plain', () => {
    assert.equal(inline('snake_case_name').map(s => s.text).join(''), 'snake_case_name')
    assert.equal(inline('2*3*4').length, 1)
  })
})

describe('isCopyable', () => {
  test('a labelled block always is; a drawing is not', () => {
    assert.equal(isCopyable('╭──╮', 'ts'), true)
    assert.equal(isCopyable('npm test'), true)
    assert.equal(isCopyable('╭──╮'), false)
    assert.equal(isCopyable('done ✅', 'text'), false)
  })
})

describe('markdown', () => {
  test('paragraphs wrap and are separated by one blank line', () => {
    assert.deepEqual(text('one two three four\n\n\n\nnext', 10), ['one two', 'three four', '', 'next'])
  })
  test('headings', () => {
    const l = markdown('# Big\n## Mid\n### Small', 40)
    // A blank line before each heading but the first.
    assert.deepEqual(l.map(plain), ['Big', '', 'Mid', '', 'Small'])
    assert.equal(l[0]![0]!.style?.underline, true)
    assert.equal(l[4]![0]!.style?.fg, 255)
  })
  test('lists: bullets by depth, numbers, task boxes, continuation lines', () => {
    assert.deepEqual(text('- a\n  - b\n    - c\n      - d\n1. one\n2) two\n- [x] done\n- [ ] todo\n- long item\n  continued here'), [
      '• a', '  ◦ b', '    ▪ c', '      • d', '1. one', '2) two', '• ☑ done', '• ☐ todo', '• long item continued here',
    ])
  })
  test('a fenced code block gets a header with its language and a copy button', () => {
    const copied: string[] = []
    const l = markdown('```sh\nnpm test\n```', 30, t => copied.push(t))
    assert.match(plain(l[0]!), /^ sh +⧉ copy $/)
    assert.equal(plain(l[1]!).trim(), 'npm test')
    l[0]!.find(s => s.action)!.action!()
    assert.deepEqual(copied, ['npm test'])
    // No copy function: no button.
    assert.ok(!plain(markdown('```\nx\n```', 30)[0]!).includes('copy'))
  })
  test('long code lines wrap rather than being cut', () => {
    const l = markdown('~~~\n' + 'x'.repeat(50) + '\n~~~', 20)
    const body = l.slice(1).map(plain).join('').replace(/\s/g, '')
    assert.equal(body, 'x'.repeat(50))
    for (const line of l) assert.ok(lineCells(line) <= 20)
  })
  test('a code block drawing an interface has no copy button', () => {
    assert.ok(!plain(markdown('```\n╭──╮\n```', 30, () => {})[0]!).includes('copy'))
  })
  test('tables line up, and shrink to fit', () => {
    const l = text('| name | value |\n|---|:---:|\n| a | 1 |\n| bb | 22 |')
    assert.deepEqual(l, ['name │ value', '─────┼──────', 'a    │ 1    ', 'bb   │ 22   '])
    for (const line of markdown('| ' + 'x'.repeat(40) + ' | ' + 'y'.repeat(40) + ' |', 30)) assert.ok(lineCells(line) <= 30)
  })
  test('a quote has a bar and copies the quoted text', () => {
    const copied: string[] = []
    const l = markdown('> first\n> second\n>\n> third', 40, t => copied.push(t))
    assert.ok(plain(l[0]!).startsWith('▎ first second'))
    assert.ok(plain(l[0]!).endsWith('⧉'))
    l[0]!.find(s => s.action)!.action!()
    assert.equal(copied[0], 'first\nsecond\n\nthird')
  })
  test('inline code copies itself on a click', () => {
    const copied: string[] = []
    const l = markdown('run `npm ci` now', 40, t => copied.push(t))
    // Wrapping splits it into words; each copies the whole code.
    l[0]!.find(s => s.text === 'npm')!.action!()
    assert.deepEqual(copied, ['npm ci'])
    // Outside a markdown() call there is no copy action.
    assert.equal(inline('`x`')[0]!.action, undefined)
  })
  test('a rule, and no trailing blank lines', () => {
    assert.deepEqual(text('a\n\n---\n\n'), ['a', '', '─'.repeat(40)])
    assert.deepEqual(text('a\r\nb'), ['a b'])
  })
})
