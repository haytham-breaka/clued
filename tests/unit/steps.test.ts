import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { fieldLines, stepDetail } from '../../app/chat.ts'
import type { ChatCtx } from '../../app/chat.ts'
import { K } from '../../app/code.ts'
import type { Step } from '../../app/session.ts'
import { cellText, lineCells } from '../../app/text.ts'
import type { Line } from '../../app/text.ts'

const plain = (l: Line) => l.map(s => s.text).join('')
const copied: string[] = []
let pokes = 0
const ctx = { cwd: '/tmp/work', copy: (t: string) => copied.push(t), poke: () => pokes++ } as unknown as ChatCtx
const step = (name: string, input: Record<string, unknown>, result?: string, isError = false): Step => ({ tool: { id: 'x', name, input }, result, isError })
const detail = (s: Step, width = 60) => stepDetail(s, width, 4, ctx)
const texts = (s: Step, width = 60) => detail(s, width).map(plain)

describe('step details', () => {
  test('an Edit: a header with its path and counts, then the diff', () => {
    const l = detail(step('Edit', { file_path: '/tmp/work/app/a.ts', old_string: 'x\nconst a = 1', new_string: 'x\nconst a = 2' }))
    assert.match(plain(l[0]!), /^ {4} app\/a\.ts +\+1 −1 $/)
    assert.match(plain(l[1]!), /^ {7}x/)
    assert.match(plain(l[2]!), /^ {4} - const a = 1/)
    assert.match(plain(l[3]!), /^ {4} \+ const a = 2/)
    assert.equal(l[2]!.find(s => s.text === '1')?.style?.bg, K.delWordBg)
    // Copying a code row gives the code alone: no indent, no gutter.
    assert.equal(cellText(l[2]!, 0, 99).trimEnd(), 'const a = 1')
    // The header copies as text.
    assert.match(cellText(l[0]!, 0, 99), /app\/a\.ts/)
  })
  test('a failed edit says why', () => {
    const t = texts(step('Edit', { file_path: '/tmp/work/a.ts', old_string: 'a', new_string: 'b' }, 'String to replace not found in file.', true))
    assert.match(t.at(-1)!, /String to replace not found/)
    const r = texts(step('Read', { file_path: '/tmp/work/empty.ts' }, '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>'))
    assert.deepEqual(r.map(x => x.trim()), ['Warning: the file exists but the contents are empty.'])
  })
  test('a MultiEdit: one header with the totals, its edits apart', () => {
    const t = texts(step('MultiEdit', { file_path: '/tmp/work/m.txt', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c\nd', new_string: 'e' }] }))
    assert.match(t[0]!, /m\.txt +\+2 −3 $/)
    assert.match(t[3]!, /^ {4} ⋯/)
    assert.equal(t.length, 7)
  })
  test('a Write: every line added, numbered in a green gutter, highlighted by its extension', () => {
    const l = detail(step('Write', { file_path: '/tmp/work/x.py', content: 'def f():\n    return 1\n' }))
    assert.match(plain(l[0]!), /^ {4} x\.py +\+2 $/)
    assert.match(plain(l[1]!), /^ {4} 1 \+ def f\(\):/)
    assert.equal(l[1]![1]!.style?.bg, K.addBg)
    assert.equal(l[1]!.find(s => s.text === 'def')?.style?.fg, K.keyword)
    assert.equal(l.length, 3)
  })
  test('a NotebookEdit: Python, or markdown for a markdown cell', () => {
    const py = detail(step('NotebookEdit', { notebook_path: '/tmp/work/n.ipynb', new_source: 'import os' }))
    assert.equal(py[1]!.find(s => s.text === 'import')?.style?.fg, K.keyword)
    const md = detail(step('NotebookEdit', { notebook_path: '/tmp/work/n.ipynb', new_source: '# Title', cell_type: 'markdown' }))
    assert.equal(md[1]!.find(s => s.text === '# Title')?.style?.fg, K.heading)
  })
  test('a Read: the file with its line numbers in the gutter, and the range asked for', () => {
    const s = step('Read', { file_path: '/tmp/work/main.go', offset: 40, limit: 2 }, '    40→func main() {\n    41→}')
    const l = detail(s)
    assert.match(plain(l[0]!), /from line 40, 2 lines/)
    assert.match(plain(l[1]!), /^ {4} 40  func main\(\) \{/)
    assert.equal(l[1]!.find(s => s.text === 'func')?.style?.fg, K.keyword)
    assert.equal(cellText(l[1]!, 0, 99).trimEnd(), 'func main() {')
    // A failed read shows its message.
    const e = detail(step('Read', { file_path: '/tmp/work/gone' }, 'File does not exist.', true))
    assert.match(plain(e[0]!), /File does not exist\./)
    assert.equal(e[0]!.at(-1)!.style?.fg, 203)
  })
  test('a Bash step: copy in its header, the command after $, its output', () => {
    const l = detail(step('Bash', { command: 'echo hi\necho there' }, 'hi\nthere'))
    assert.match(plain(l[0]!), /bash +⧉ copy $/)
    l[0]!.find(s => s.action)!.action!()
    assert.equal(copied.at(-1), 'echo hi\necho there')
    assert.match(plain(l[1]!), /^ {4} \$ echo hi/)
    assert.match(plain(l[2]!), /^ {7}echo there/)
    assert.match(plain(l[3]!), /hi/)
    assert.equal(l[3]!.find(s => s.text === 'hi')?.style?.fg, K.output)
    const e = detail(step('Bash', { command: 'false' }, 'boom', true))
    assert.equal(e[2]!.find(s => s.text === 'boom')?.style?.fg, K.error)
  })
  test('a plan: its items with their state', () => {
    const t = texts(step('TodoWrite', { todos: [{ content: 'one', status: 'completed' }, { content: 'two', status: 'in_progress' }, { content: 'three', status: 'pending' }] }))
    assert.deepEqual(t.map(x => x.trim()), ['☑ one', '◐ two', '☐ three'])
  })
  test('other tools: their input as key: value lines, then their result', () => {
    const t = texts(step('Grep', { pattern: 'main', '-n': true, head_limit: 5, glob: undefined }, 'app/main.ts:1:x'))
    assert.deepEqual(t.map(x => x.trim()), ['pattern: main', '-n: true', 'head_limit: 5', 'app/main.ts:1:x'])
  })
  test("an agent's step: its prompt, and what it handed back as markdown", () => {
    const t = texts(step('Agent', { description: 'Look', prompt: 'Find it.\nThen report.' }, 'Found **it**:\n\n```ts\nconst a = 1\n```'))
    assert.ok(t.some(x => x.trim() === 'prompt:'))
    assert.ok(t.some(x => x.trim() === 'Find it.'))
    assert.ok(t.some(x => x.trim() === 'Found it:'))
    assert.ok(t.some(x => x.includes('const a = 1')))
  })
  test('long details stop at 40 rows, with a click to show all', () => {
    const s = step('Bash', { command: 'seq 60' }, Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n'))
    const l = detail(s)
    assert.equal(l.length, 41)
    assert.match(plain(l[40]!), /… 22 more lines, show all/)
    const before = pokes
    l[40]!.find(x => x.action)!.action!()
    assert.equal(pokes, before + 1)
    assert.equal(detail(s).length, 62)
  })
  test('narrow: every row fits', () => {
    const s = step('Edit', { file_path: '/tmp/work/a/really/long/path/name.ts', old_string: 'const value = computeSomething(argumentOne, argumentTwo)', new_string: 'const value = computeSomething(argumentOne, argumentThree)' })
    for (const l of detail(s, 24)) assert.ok(lineCells(l) <= 28, plain(l))
  })
})

describe('fieldLines', () => {
  test('strings as they are, numbers and flags, objects as short JSON, multi-line values indented', () => {
    const t = fieldLines({ url: 'https://example.com', n: 2, deep: { a: [1, 2] }, body: 'line one\nline two', empty: '', none: null }, 40).map(plain)
    assert.deepEqual(t, ['url: https://example.com', 'n: 2', 'deep: {"a":[1,2]}', 'body: ', '  line one', '  line two'])
  })
  test('long values wrap under a hanging indent, and the whole is cut at 2000 characters', () => {
    const t = fieldLines({ q: 'word '.repeat(20) }, 30).map(plain)
    assert.ok(t.length > 1)
    assert.ok(t.slice(1).every(x => x.startsWith('  ')))
    const big = fieldLines({ a: 'x'.repeat(3000), b: 'never shown' }, 100).map(plain).join('')
    assert.ok(big.includes('…'))
    assert.ok(!big.includes('never shown'))
  })
})
