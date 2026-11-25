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
  test('what a caller adds to its lines (the caret) is not in the next one\'s: each gets its own copy', () => {
    const first = markdown('The deploy is green.', 40)
    first.at(-1)!.push({ text: '▍' })
    first.push([{ text: 'extra' }])
    assert.deepEqual(markdown('The deploy is green.', 40).map(plain), ['The deploy is green.'])
  })
})

describe('images in markdown', () => {
  test('without a way to draw: a local image is [image: alt] (a click opens it), a remote one a link never fetched', () => {
    const opened: string[] = []
    const lines = markdown('See ![the chart](/tmp/c.png) and ![](https://example.com/x.png "t").', 80, undefined, { key: 'links', open: p => opened.push(p) })
    assert.deepEqual(lines.map(plain), ['See [image: the chart] and image (https://example.com/x.png).'])
    lines[0]!.find(s => s.text === 'chart]')!.action!()
    assert.deepEqual(opened, ['/tmp/c.png'])
    // No alt: the file's name. No opener: no click.
    const bare = markdown('![](/tmp/d.png)', 40)
    assert.deepEqual(bare.map(plain), ['[image: d.png]'])
    assert.equal(bare[0]![0]!.action, undefined)
  })

  test('drawn: an image goes under its paragraph, its words without it; several, a line apart', () => {
    const rows = (alt: string): Line[] => [[{ text: `<${alt}>` }]]
    const media = { key: 'k1', image: (alt: string, src: string) => (src.startsWith('/') ? rows(alt) : undefined) }
    assert.deepEqual(markdown('Look: ![a](/a.png) ok ![b](/b.png)\n\n![c](https://x/c.png)', 40, undefined, media).map(plain), ['Look: ok', '<a>', '', '<b>', '', 'c (https://x/c.png)'])
    // A paragraph that is only the image: no empty line above it.
    assert.deepEqual(markdown('![a](/a.png)', 40, undefined, media).map(plain), ['<a>'])
    // The media's key is part of the cache: a new key lays it out again.
    assert.deepEqual(markdown('![a](/a.png)', 40, undefined, { ...media, key: 'k2', image: () => rows('new') }).map(plain), ['<new>'])
  })

  test('a mermaid block: replaced by its diagram (⧉ copy copies the source), or the code with a note under it', () => {
    const copied: string[] = []
    const src = 'Flow:\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nEnd.'
    const drawn = markdown(src, 40, t => copied.push(t), { key: 'd1', diagram: () => ({ lines: [[{ text: '[pic]' }], [{ text: '[image: diagram]' }]], replace: true }) })
    assert.deepEqual(drawn.map(plain), ['Flow:', '', '[pic]', '[image: diagram]  ⧉ copy', '', 'End.'])
    drawn[3]!.at(-1)!.action!()
    assert.deepEqual(copied, ['graph TD\n  A-->B'])
    const noted = markdown(src, 40, undefined, { key: 'd2', diagram: () => ({ lines: [[{ text: '◌ drawing' }]], replace: false }) }).map(plain)
    assert.deepEqual(noted.slice(2, 6).map(l => l.trim()), ['mermaid', 'graph TD', 'A-->B', '◌ drawing'])
    // Another language is never a diagram.
    let asked = 0
    markdown('```ts\nx\n```', 40, undefined, { key: 'd3', diagram: () => (asked++, undefined) })
    assert.equal(asked, 0)
  })
})
