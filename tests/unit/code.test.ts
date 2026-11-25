import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { block, clean, codeRows, diffHead, diffRows, hardWrap, highlight, highlightLine, K, langOf, readRows, shellRows } from '../../app/code.ts'
import type { Lang } from '../../app/code.ts'
import { wordDiff } from '../../app/diff.ts'
import { markdown } from '../../app/markdown.ts'
import { cellText, lineCells, markCells } from '../../app/text.ts'
import type { Line, Span } from '../../app/text.ts'

const plain = (l: Line) => l.map(s => s.text).join('')
/** The colour of the span holding `text` on a highlighted line. */
const fgOf = (line: string, lang: Lang, text: string) => highlightLine(line, lang).spans.find(s => s.text.includes(text))?.style?.fg
const joined = (spans: Span[][]) => spans.map(l => l.map(s => s.text).join(''))

describe('langOf', () => {
  test('by extension, by file name, by fence label', () => {
    assert.equal(langOf('/tmp/a/b.tsx'), 'js')
    assert.equal(langOf('x.mjs'), 'js')
    assert.equal(langOf('main.go'), 'go')
    assert.equal(langOf('a.py'), 'py')
    assert.equal(langOf('run.sh'), 'sh')
    assert.equal(langOf('Dockerfile'), 'sh')
    assert.equal(langOf('.env.local'), 'sh')
    assert.equal(langOf('package.json'), 'json')
    assert.equal(langOf('README.md'), 'md')
    assert.equal(langOf('a.scss'), 'css')
    assert.equal(langOf('index.html'), 'html')
    assert.equal(langOf('ci.yml'), 'yaml')
    assert.equal(langOf('lib.rs'), 'rust')
    assert.equal(langOf('Main.java'), 'c')
    assert.equal(langOf('q.sql'), 'sql')
    assert.equal(langOf('fix.patch'), 'diff')
    assert.equal(langOf('typescript'), 'js')
    assert.equal(langOf('bash'), 'sh')
    assert.equal(langOf('notes.txt'), undefined)
    assert.equal(langOf(''), undefined)
    assert.equal(langOf(undefined), undefined)
  })
})

describe('highlight', () => {
  test('TypeScript: keywords, strings, comments, numbers, types, calls', () => {
    const line = "export const n: number = parse('a', 0x1f) // done"
    assert.equal(fgOf(line, 'js', 'export'), K.keyword)
    assert.equal(fgOf(line, 'js', "'a'"), K.string)
    assert.equal(fgOf(line, 'js', '// done'), K.comment)
    assert.equal(fgOf(line, 'js', '0x1f'), K.number)
    assert.equal(fgOf(line, 'js', 'number'), K.type)
    assert.equal(fgOf(line, 'js', 'parse'), K.func)
    assert.equal(fgOf('if (x) return true', 'js', 'true'), K.number)
    assert.equal(fgOf('new Widget()', 'js', 'Widget'), K.func)
    assert.equal(fgOf('let w: Widget', 'js', 'Widget'), K.type)
    // The text is kept exactly.
    assert.equal(highlightLine(line, 'js').spans.map(s => s.text).join(''), line)
  })
  test('escapes inside strings, and numbers inside names stay names', () => {
    assert.equal(fgOf('"a \\" b" + c', 'js', '"a \\" b"'), K.string)
    assert.notEqual(fgOf('x1 = 2', 'js', 'x1'), K.number)
    assert.equal(fgOf('const s = "open', 'js', '"open'), K.string)
  })
  test('block comments and template strings carry over lines', () => {
    const l = highlight(['a /* one', 'two', 'three */ b', 'const t = `x', 'y` + 1'], 'js')
    assert.equal(l[1]![0]!.style?.fg, K.comment)
    assert.equal(l[2]![0]!.text, 'three */')
    assert.equal(l[2]!.at(-1)!.style?.fg, K.text)
    assert.equal(l[4]![0]!.text, 'y`')
    assert.equal(l[4]![0]!.style?.fg, K.string)
  })
  test('Python: def, decorators, # comments, triple-quoted strings over lines', () => {
    assert.equal(fgOf('def f(x):  # note', 'py', 'def'), K.keyword)
    assert.equal(fgOf('def f(x):  # note', 'py', '# note'), K.comment)
    assert.equal(fgOf('@cache', 'py', 'cache'), K.func)
    assert.equal(fgOf('x = None', 'py', 'None'), K.number)
    const l = highlight(['s = """doc', 'more', 'end""" + 1'], 'py')
    assert.equal(l[1]![0]!.style?.fg, K.string)
    assert.equal(l[2]![0]!.text, 'end"""')
  })
  test('Go: func, raw strings, nil', () => {
    assert.equal(fgOf('func main() {', 'go', 'func'), K.keyword)
    assert.equal(fgOf('return nil', 'go', 'nil'), K.number)
    assert.equal(fgOf('s := `raw`', 'go', '`raw`'), K.string)
    assert.equal(fgOf('var e error', 'go', 'error'), K.type)
  })
  test('shell: variables, # only at a word start, single quotes without escapes', () => {
    assert.equal(fgOf('echo "$HOME" ${X}', 'sh', '$HOME'), K.string)
    assert.equal(fgOf('echo $HOME ${X}', 'sh', '$HOME'), K.key)
    assert.equal(fgOf('echo $HOME ${X}', 'sh', '${X}'), K.key)
    assert.equal(fgOf('if [ -f a ]; then', 'sh', 'if'), K.keyword)
    assert.equal(fgOf('git log # recent', 'sh', '# recent'), K.comment)
    assert.equal(fgOf('git log # recent', 'sh', 'git'), K.type)
    assert.notEqual(fgOf('echo a#b', 'sh', '#b'), K.comment)
    assert.equal(fgOf("echo 'a\\' b", 'sh', "'a\\'"), K.string)
  })
  test('JSON: keys apart from string values', () => {
    const l = highlightLine('{"name": "clued", "n": 2, "ok": true}', 'json').spans
    assert.equal(l.find(s => s.text === '"name"')?.style?.fg, K.key)
    assert.equal(l.find(s => s.text === '"clued"')?.style?.fg, K.string)
    assert.equal(l.find(s => s.text === '2')?.style?.fg, K.number)
    assert.equal(l.find(s => s.text === 'true')?.style?.fg, K.number)
  })
  test('markdown: headings, bullets, inline code, links, fenced code', () => {
    assert.equal(fgOf('## Title', 'md', 'Title'), K.heading)
    assert.equal(fgOf('- item `code` and [a](b)', 'md', '- '), K.type)
    assert.equal(fgOf('- item `code` and [a](b)', 'md', '`code`'), K.attr)
    assert.equal(fgOf('- item `code` and [a](b)', 'md', '[a](b)'), K.func)
    assert.equal(highlightLine('**bold** *it*', 'md').spans[0]!.style?.bold, true)
    assert.equal(fgOf('> quoted', 'md', 'quoted'), K.comment)
    const l = highlight(['```js', '# not a heading', '```', '# heading'], 'md')
    assert.equal(l[1]![0]!.style?.fg, K.attr)
    assert.equal(l[2]![0]!.style?.fg, K.comment)
    assert.equal(l[3]![0]!.style?.fg, K.heading)
  })
  test('CSS: selectors, properties, values, at-rules, comments over lines', () => {
    assert.equal(fgOf('.box > a:hover {', 'css', '.box'), K.attr)
    assert.equal(fgOf('.box > a:hover {', 'css', 'a'), K.tag)
    assert.equal(fgOf('.box > a:hover {', 'css', ':hover'), K.func)
    assert.equal(fgOf('  color: #fff;', 'css', 'color'), K.key)
    assert.equal(fgOf('  color: #fff;', 'css', '#fff'), K.number)
    assert.equal(fgOf('  margin: 4px auto !important;', 'css', '4px'), K.number)
    assert.equal(fgOf('  margin: 4px auto !important;', 'css', '!important'), K.keyword)
    assert.equal(fgOf('  background: url("a.png");', 'css', 'url'), K.func)
    assert.equal(fgOf('  background: url("a.png");', 'css', '"a.png"'), K.string)
    assert.equal(fgOf('@media (x) {', 'css', '@media'), K.keyword)
    const l = highlight(['/* a', 'b */ p {'], 'css')
    assert.equal(l[1]![0]!.style?.fg, K.comment)
  })
  test('HTML: tags, attributes, strings, entities, comments, tags over lines', () => {
    const l = highlightLine('<a href="x" hidden>Tom &amp; me</a>', 'html').spans
    assert.equal(l.find(s => s.text === '<a')?.style?.fg, K.tag)
    assert.equal(l.find(s => s.text === 'href')?.style?.fg, K.attr)
    assert.equal(l.find(s => s.text === '"x"')?.style?.fg, K.string)
    assert.equal(l.find(s => s.text === '&amp;')?.style?.fg, K.number)
    assert.equal(l.find(s => s.text.includes('Tom'))?.style?.fg, K.text)
    const m = highlight(['<div', '  class="a">', '<!-- note', 'end -->'], 'html')
    assert.equal(m[1]!.find(s => s.text === 'class')?.style?.fg, K.attr)
    assert.equal(m[1]!.at(-1)!.text, '>')
    assert.equal(m[3]![0]!.style?.fg, K.comment)
  })
  test('YAML and TOML: keys, sections, comments, values', () => {
    assert.equal(fgOf('name: clued # the app', 'yaml', 'name'), K.key)
    assert.equal(fgOf('name: clued # the app', 'yaml', '# the app'), K.comment)
    assert.equal(fgOf('  - run: npm test', 'yaml', 'run'), K.key)
    assert.equal(fgOf('  - item', 'yaml', '- '), K.type)
    assert.equal(fgOf('on: true', 'yaml', 'true'), K.number)
    assert.equal(fgOf('[tool.x]', 'yaml', '[tool.x]'), K.heading)
    assert.equal(fgOf('port = 80', 'yaml', 'port'), K.key)
    assert.equal(fgOf('just text', 'yaml', 'just'), K.text)
  })
  test('C, Rust and SQL', () => {
    assert.equal(fgOf('#include <stdio.h>', 'c', '#include'), K.keyword)
    assert.equal(fgOf('int x = 1; // c', 'c', '// c'), K.comment)
    assert.equal(fgOf('fn main() -> Result<()>', 'rust', 'fn'), K.keyword)
    assert.equal(fgOf('fn main() -> Result<()>', 'rust', 'Result'), K.type)
    assert.equal(fgOf('SELECT id FROM t -- all', 'sql', 'SELECT'), K.keyword)
    assert.equal(fgOf('SELECT id FROM t -- all', 'sql', '-- all'), K.comment)
  })
  test('a diff: added green, removed red, hunks', () => {
    assert.equal(fgOf('+ new', 'diff', '+ new'), K.addSign)
    assert.equal(fgOf('- old', 'diff', '- old'), K.delSign)
    assert.equal(fgOf('@@ -1 +1 @@', 'diff', '@@'), K.type)
    assert.equal(highlightLine('--- a/x', 'diff').spans[0]!.style?.bold, true)
  })
  test('plain text and empty lines', () => {
    assert.deepEqual(highlightLine('', 'js').spans, [])
    assert.equal(highlightLine('anything', undefined).spans[0]!.style?.fg, K.text)
  })
})

describe('clean and hardWrap', () => {
  test('clean drops terminal codes and turns tabs into spaces', () => {
    assert.equal(clean('\x1b[32mok\x1b[0m\tdone\r'), 'ok  done')
    assert.equal(clean('\x1b]0;title\x07x'), 'x')
  })
  test('wraps after a space in the second half of a row, else anywhere, never past the width', () => {
    assert.deepEqual(joined(hardWrap([{ text: 'echo one two three' }], 10)), ['echo one ', 'two three'])
    assert.deepEqual(joined(hardWrap([{ text: 'x'.repeat(25) }], 10)), ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
    // The space a row breaks at is dropped.
    assert.deepEqual(joined(hardWrap([{ text: 'abc def' }], 3)), ['abc', 'def'])
    assert.deepEqual(joined(hardWrap([], 5)), [''])
  })
  test('keeps each span its style across a break', () => {
    const rows = hardWrap([{ text: 'abc', style: { fg: 1 } }, { text: 'defgh', style: { fg: 2 } }], 4)
    assert.deepEqual(rows.map(r => r.map(s => [s.text, s.style?.fg])), [[['abc', 1], ['d', 2]], [['efgh', 2]]])
    for (const r of hardWrap([{ text: '日本語のテキスト' }], 5)) assert.ok(lineCells(r) <= 5)
  })
})

describe('blocks', () => {
  test('rows fill the block, snug to the longest line, with a gutter that is not copied', () => {
    const lines = block(codeRows(['const a = 1', '  b()'], 'js', 9), 60)
    assert.equal(lines.length, 2)
    const w = lineCells(lines[0]!)
    assert.equal(w, 40) // the narrowest a block gets, room allowing
    for (const l of lines) assert.equal(lineCells(l), w)
    assert.equal(plain(lines[0]!).slice(0, 5), '  9  ')
    assert.equal(plain(lines[1]!).slice(0, 7), ' 10    ')
    assert.equal(cellText(lines[1]!, 0, 99), '  b()')
    // A selection is not drawn over the gutter.
    assert.ok(!markCells(lines[0]!, 0, 99)[0]!.style?.inverse)
    assert.ok(markCells(lines[0]!, 0, 99).some(s => s.style?.inverse))
    for (const sp of lines[0]!) assert.ok(sp.style?.bg != null)
  })
  test('long lines wrap under a blank gutter; narrow spaces stay within width', () => {
    const lines = block(codeRows(['x'.repeat(30)], undefined, 1), 20)
    assert.equal(lines.length, 2)
    for (const l of lines) assert.equal(lineCells(l), 20)
    assert.match(plain(lines[1]!), /^ {3} x+ *$/)
    assert.equal(cellText(lines[1]!, 0, 99), 'x'.repeat(14))
  })
  test('a header: its path cut to fit, the counts on the right', () => {
    const [head] = block(codeRows(['a'], undefined), 30, diffHead('a/very/long/path/to/some/file.ts', 2, 1))
    assert.equal(lineCells(head!), 30)
    assert.match(plain(head!), /…\s+\+2 −1 $/)
    assert.ok(head!.every(s => s.style?.bg === K.headBg))
    assert.match(plain(block([], 30, diffHead('new.ts', 3, 0))[0]!), /^ new\.ts +\+3 $/)
    assert.match(plain(block([], 30, diffHead('gone.ts', 0, 2))[0]!), /gone\.ts +−2 $/)
  })
  test('a Read result: numbers to the gutter, reminders dropped, other lines as notes', () => {
    const r = readRows('     1→import x\n     2→\tgo()\n\n<system-reminder>\nbe careful\n</system-reminder>\n', 'js')
    assert.deepEqual(r.map(x => x.gutter.trim()), ['1', '2'])
    assert.equal(r[1]!.spans.map(s => s.text).join(''), '  go()')
    assert.equal(r[0]!.spans[0]!.style?.fg, K.keyword)
    const n = readRows('    40\tfunc main() {\nFile truncated', 'go')
    assert.deepEqual(n.map(x => x.gutter.trim()), ['40', ''])
    assert.equal(n[1]!.spans[0]!.style?.italic, true)
  })
  test('a command after $, its output after it, red when it failed', () => {
    const r = shellRows('npm test\n  --watch', '\x1b[32mok\x1b[0m\n', false)
    assert.deepEqual(r.map(x => x.gutter), [' $', '  ', '  '])
    assert.equal(r[2]!.spans[0]!.text, 'ok')
    assert.equal(r[2]!.spans[0]!.style?.fg, K.output)
    assert.equal(shellRows('false', 'boom', true)[1]!.spans[0]!.style?.fg, K.error)
    assert.equal(shellRows('true', undefined).length, 1)
  })
})

describe('diffs', () => {
  test('wordDiff marks only what changed in a line pair', () => {
    const w = wordDiff('if (n > limit) break', 'if (n >= limit) break')!
    assert.deepEqual(w.before.filter(p => p.isChanged).map(p => p.text), [])
    assert.deepEqual(w.after.filter(p => p.isChanged).map(p => p.text), ['='])
    assert.equal(w.after.map(p => p.text).join(''), 'if (n >= limit) break')
    const v = wordDiff('display: none', 'display: flex')!
    assert.deepEqual(v.before.filter(p => p.isChanged).map(p => p.text), ['none'])
    assert.deepEqual(v.after.filter(p => p.isChanged).map(p => p.text), ['flex'])
  })
  test('wordDiff gives up on rewritten lines, empty lines and huge ones', () => {
    assert.equal(wordDiff('old line gone', 'completely different text'), undefined)
    assert.equal(wordDiff('', 'x'), undefined)
    const big = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ')
    assert.equal(wordDiff(big, big + ' x'), undefined)
    // A space that moved between kept words is not marked.
    const s = wordDiff('a  b c', 'a b c')!
    assert.ok(s.before.every(p => !p.isChanged))
  })
  test('diffRows: signs, colours, counts, the changed words brighter, context dimmed', () => {
    const d = diffRows('keep\nconst x = 1\nold footer\nfooter { a }\nend', 'keep\nconst x = 2\nfooter { b }\nend')
    assert.equal(d.added, 2)
    assert.equal(d.removed, 3)
    assert.deepEqual(d.rows.map(r => r.gutter.trim()), ['', '-', '-', '-', '+', '+', ''])
    const [ctx, del, , delFooter, add, addFooter] = d.rows
    assert.equal(ctx!.spans[0]!.style?.fg, K.context)
    assert.equal(del!.bg, K.delBg)
    assert.equal(add!.bg, K.addBg)
    assert.equal(del!.spans.find(s => s.text === '1')?.style?.bg, K.delWordBg)
    assert.equal(add!.spans.find(s => s.text === '2')?.style?.bg, K.addWordBg)
    assert.equal(add!.spans[0]!.style?.fg, K.addFg)
    // "footer { b }" pairs with "footer { a }", not with "old footer" before it.
    assert.equal(delFooter!.spans.find(s => s.text === 'a')?.style?.bg, K.delWordBg)
    assert.equal(addFooter!.spans.find(s => s.text === 'b')?.style?.bg, K.addWordBg)
    assert.ok(d.rows[2]!.spans.every(s => s.style?.bg == null))
  })
  test('diffRows: added and removed lines on their own, and empty lines', () => {
    const d = diffRows('a', 'a\n\nb')
    assert.deepEqual(d.rows.map(r => r.gutter.trim()), ['', '+', '+'])
    assert.deepEqual(d.rows[1]!.spans, [])
    const e = diffRows('a\n\nb', 'b')
    assert.equal(e.removed, 2)
    assert.deepEqual(e.rows[1]!.spans, [])
  })
})

describe('markdown code fences', () => {
  test('highlighted by their language, on the code background, header lighter', () => {
    const l = markdown('```ts\nconst a = "s" // c\n```', 40)
    assert.equal(l[0]![0]!.style?.bg, K.headBg)
    const spans = l[1]!
    assert.equal(spans.find(s => s.text === 'const')?.style?.fg, K.keyword)
    assert.equal(spans.find(s => s.text === '"s"')?.style?.fg, K.string)
    assert.ok(spans.every(s => s.style?.bg === K.bg))
    assert.equal(lineCells(l[1]!), lineCells(l[0]!))
  })
  test('the copy button copies the code as written, tabs and all', () => {
    const copied: string[] = []
    const l = markdown('```make\nall:\n\tgo build\n```', 40, t => copied.push(t))
    assert.equal(plain(l[2]!).trim(), 'go build')
    l[0]!.find(s => s.action)!.action!()
    assert.deepEqual(copied, ['all:\n\tgo build'])
  })
  test('an unlabelled fence stays plain', () => {
    const l = markdown('```\nconst a\n```', 40)
    assert.ok(l[1]!.every(s => s.style?.fg === 255 || s.style?.fg == null || s.style?.fg === K.text))
  })
})
