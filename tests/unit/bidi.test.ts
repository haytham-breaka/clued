import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { bidiLine, bidiMode, bidiSpan, bidiText, cursorCell, detectMode, hasRtl, indexAt, inputRow, isRtl, layout, lineDir, modeSequences, paragraphDir, setBidiMode, shape } from '../../app/bidi.ts'
import { cellText, cells, charCells, lineCells, markCells, wrap } from '../../app/text.ts'
import type { Line } from '../../app/text.ts'
import { markdown } from '../../app/markdown.ts'

/** What a line draws, left to right. */
const shown = (l: Line) => l.map(s => s.text).join('')
/** The same, with Arabic's joined forms back to plain letters (a lam-alef is two again): easier to read and compare. */
const letters = (l: Line) => shown(l).normalize('NFKC')
const rev = (s: string) => [...s].reverse().join('')

afterEach(() => setBidiMode('app'))

describe('the mode', () => {
  test('CLUED_BIDI wins; else the terminals that reorder by themselves get the text as written', () => {
    assert.equal(detectMode({ CLUED_BIDI: 'off' }), 'off')
    assert.equal(detectMode({ CLUED_BIDI: ' Terminal ', TERM_PROGRAM: 'WezTerm' }), 'terminal')
    assert.equal(detectMode({ CLUED_BIDI: 'app', TERM_PROGRAM: 'Apple_Terminal' }), 'app')
    assert.equal(detectMode({ TERM_PROGRAM: 'Apple_Terminal' }), 'terminal')
    assert.equal(detectMode({ KONSOLE_VERSION: '240802' }), 'terminal')
    assert.equal(detectMode({ MLTERM: '3.9.3' }), 'terminal')
    // Windows Terminal, VTE (told by the app to leave it), iTerm2, kitty, WezTerm, an unknown value.
    for (const env of [{ WT_SESSION: 'x' }, { VTE_VERSION: '7600' }, { TERM_PROGRAM: 'iTerm.app' }, { KITTY_WINDOW_ID: '1' }, { CLUED_BIDI: 'maybe' }, {}]) assert.equal(detectMode(env), 'app')
  })
  test('in app mode VTE is told the app reorders (BDSM explicit), and set back on the way out; through tmux too', () => {
    assert.deepEqual(modeSequences({}), { start: '\x1b[8l', end: '\x1b[8h' })
    const t = modeSequences({ TMUX: '/tmp/tmux-1/default,1,0' })
    assert.equal(t.start, '\x1b[8l\x1bPtmux;\x1b\x1b[8l\x1b\\')
    setBidiMode('terminal')
    assert.deepEqual(modeSequences({}), { start: '', end: '' })
    assert.equal(bidiMode(), 'terminal')
  })
})

describe('finding right-to-left text', () => {
  test('hasRtl: Arabic, Hebrew, Persian and their presentation forms, not Latin, CJK or emoji', () => {
    for (const s of ['مرحبا', 'שלום', 'سلام پدر', 'ﻻ', 'a\u200fb']) assert.ok(hasRtl(s), s)
    for (const s of ['hello', '漢字', '😀 ✓', '']) assert.ok(!hasRtl(s), s)
  })
  test("a paragraph's direction is its first strong letter's; numbers and punctuation aren't strong", () => {
    assert.equal(paragraphDir('مرحبا hello'), 'rtl')
    assert.equal(paragraphDir('hello مرحبا'), 'ltr')
    assert.equal(paragraphDir('123, «مرحبا»'), 'rtl')
    assert.equal(paragraphDir('...'), 'ltr')
    // Inline code and paths are isolated: they don't decide it.
    assert.equal(lineDir([{ text: 'npm test', ltr: true }, { text: ' يعمل الآن' }]), 'rtl')
    assert.equal(lineDir([{ text: 'app/main.ts' }, { text: ' يعمل' }]), 'rtl')
  })
})

describe('Arabic shaping', () => {
  test('each letter takes the form its neighbours give it', () => {
    // ب alone, then بب, then ببب: isolated; initial and final; initial, medial and final.
    assert.deepEqual(shape(['ب']), ['\ufe8f'])
    assert.deepEqual(shape([...'بب']), ['\ufe91', '\ufe90'])
    assert.deepEqual(shape([...'ببب']), ['\ufe91', '\ufe92', '\ufe90'])
    // د joins only the letter before it: the ب after it starts again.
    assert.deepEqual(shape([...'بدب']), ['\ufe91', '\ufeaa', '\ufe8f'])
    // A space, or a Latin letter, breaks the join.
    assert.deepEqual(shape([...'ب ب']), ['\ufe8f', ' ', '\ufe8f'])
  })
  test('marks between letters keep the join, and stay as they are', () => {
    // شَب: the fatha on the sheen doesn't stop it joining the beh.
    assert.deepEqual(shape([...'شَب']), ['\ufeb7', 'َ', '\ufe90'])
  })
  test('lam and alef make one ligature; isolated, or final after a letter that joins', () => {
    assert.deepEqual(shape([...'لا']), ['\ufefb', ''])
    assert.deepEqual(shape([...'سلا']), ['\ufeb3', '\ufefc', ''])
    assert.deepEqual(shape([...'لأ']), ['\ufef7', ''])
  })
  test('Persian and Urdu letters too; tatweel joins; other text is left alone', () => {
    assert.deepEqual(shape([...'پی']), ['\ufb58', '\ufbfd'])
    assert.deepEqual(shape([...'بـ']), ['\ufe91', 'ـ'])
    assert.deepEqual(shape([...'abc']), ['a', 'b', 'c'])
    assert.deepEqual(shape([...'שלום']), [...'שלום'])
  })
})

describe('reordering a line', () => {
  test('a right-to-left paragraph reads from the right; its punctuation ends on the left', () => {
    const l = bidiLine([{ text: 'שלום עולם!' }], 'rtl')
    assert.equal(shown(l), '!םלוע םולש')
    assert.ok(isRtl(l))
  })
  test('English words in Arabic keep their order and spelling, and sit where the sentence puts them', () => {
    const l = bidiLine([{ text: 'مرحبا hello world عالم' }])
    assert.equal(letters(l), `${rev('عالم')} hello world ${rev('مرحبا')}`)
    // An English paragraph with an Arabic word: only the word turns round.
    const e = bidiLine([{ text: 'Say مرحبا to them' }])
    assert.equal(letters(e), `Say ${rev('مرحبا')} to them`)
    assert.ok(!isRtl(e))
  })
  test('numbers read left to right, brackets mirror so they still open and close', () => {
    const l = bidiLine([{ text: 'العدد 123 و 4.5 (تقريباً)' }])
    assert.equal(letters(l), `(${rev('تقريباً')}) 4.5 ${rev('و')} 123 ${rev('العدد')}`.replace(/ً(.)/u, '$1ً'))
  })
  test('a mark stays after the letter it sits on', () => {
    const l = bidiLine([{ text: 'شُكر' }])
    // Drawn: ر ك ش then the damma, which the terminal puts on the sheen.
    assert.equal(letters(l), 'ركشُ')
    assert.equal(lineCells(l), 3)
  })
  test('inline code and paths stay left to right inside Arabic; the full stop goes to the end of the sentence', () => {
    const l = bidiLine([{ text: 'شغّل ' }, { text: 'npm', ltr: true }, { text: ' ', ltr: true }, { text: 'run', ltr: true }, { text: ' هنا' }])
    assert.equal(letters(l), `${rev('هنا')} npm run ${rev('شغّل').replace('ّغ', 'غّ')}`)
    const p = bidiLine([{ text: 'افتح ./bin/run.sh.' }])
    assert.equal(letters(p), `../bin/run.sh ${rev('افتح')}`)
    const u = bidiLine([{ text: 'انظر https://example.com/a?b=1 هنا' }])
    assert.equal(letters(u), `${rev('هنا')} https://example.com/a?b=1 ${rev('انظر')}`)
  })
  test('lines without right-to-left text come back as they are', () => {
    const l: Line = [{ text: 'hello' }]
    assert.equal(bidiLine(l), l)
    // Forced right to left (a line of an Arabic paragraph that is all English), it is laid out.
    assert.equal(shown(bidiLine([{ text: 'hello.' }], 'rtl')), '.hello')
  })
  test('each span keeps its style, its action and the text it stands for', () => {
    const act = () => {}
    const l = bidiLine([{ text: 'שלום ', style: { bold: true } }, { text: 'עולם', action: act }])
    assert.deepEqual(l.map(s => s.text), ['םלוע', ' םולש'])
    assert.equal(l[0]!.action, act)
    assert.deepEqual(l[1]!.style, { bold: true })
    assert.deepEqual(l[0]!.units!.toSorted((a, b) => a.at - b.at).map(u => u.src).join(''), 'עולם')
  })
  test("bidi controls steer the order and aren't drawn", () => {
    const l = bidiLine([{ text: 'א\u200fב' }])
    assert.equal(shown(l), 'בא')
    assert.equal(cellText(l, 0, 9), 'א\u200fב')
  })
  test('in terminal or off mode nothing is reordered', () => {
    setBidiMode('terminal')
    const l: Line = [{ text: 'שלום' }]
    assert.equal(bidiLine(l), l)
    assert.equal(bidiText('שלום'), 'שלום')
    setBidiMode('off')
    assert.equal(bidiLine(l), l)
  })
})

describe('wrapping', () => {
  test('wrapped as written, top line first, each line reordered and on the right', () => {
    const words = ['אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש']
    const lines = wrap([{ text: words.join(' ') }], 12)
    assert.deepEqual(lines.map(shown), ['םייתש תחא', 'עברא שולש', 'שש שמח'])
    for (const l of lines) {
      assert.ok(isRtl(l))
      assert.ok(lineCells(l) <= 12)
    }
  })
  test('each paragraph has its own direction; the lines of one keep it, English ones too', () => {
    const lines = wrap([{ text: 'Hello עולם\nשלום world and more words here' }], 14)
    assert.ok(!isRtl(lines[0]!))
    assert.ok(lines.slice(1).every(isRtl))
    // The second paragraph's last line is all English, still on the right.
    assert.match(shown(lines.at(-1)!), /^[a-z ]+$/)
  })
  test('in terminal mode the text stays as written, its lines still marked for the right', () => {
    setBidiMode('terminal')
    const [l] = wrap([{ text: 'שלום עולם' }], 20)
    assert.equal(shown(l!), 'שלום עולם')
    assert.ok(isRtl(l!))
    setBidiMode('off')
    assert.ok(!isRtl(wrap([{ text: 'שלום עולם' }], 20)[0]!))
  })
  test('harakat take no cell, so the width counts what is drawn', () => {
    assert.equal(charCells('َ'), 0)
    assert.equal(charCells('ّ'), 0)
    assert.equal(charCells('ָ'), 0)
    assert.equal(charCells('\u200f'), 0)
    assert.equal(cells('شَعْر'), 3)
    const [l] = wrap([{ text: 'مَرْحَباً بِكُم' }], 40)
    assert.equal(lineCells(l!), 9)
  })
})

describe('copying', () => {
  test('a whole reordered line copies as written', () => {
    const [l] = wrap([{ text: 'مرحبا hello عالم 42' }], 40)
    assert.equal(cellText(l!, 0, 99), 'مرحبا hello عالم 42')
  })
  test('part of one copies the characters in those cells, in reading order', () => {
    const l = bidiLine([{ text: 'שלום עולם' }])
    // Drawn "םלוע םולש": the first four cells are עולם.
    assert.equal(cellText(l, 0, 4), 'עולם')
    assert.equal(cellText(l, 5, 9), 'שלום')
    // A lam-alef is one cell, and copies as both letters.
    const la = bidiLine([{ text: 'لا' }])
    assert.equal(lineCells(la), 1)
    assert.equal(cellText(la, 0, 1), 'لا')
  })
  test('with borders around it, the borders copy where they are', () => {
    const l: Line = [{ text: '│ ' }, ...bidiLine([{ text: 'שלום' }]), { text: ' │' }]
    assert.equal(cellText(l, 0, 99), '│ שלום │')
  })
  test('a selection marks whole clusters, a letter with its marks', () => {
    const l = bidiLine([{ text: 'شُكر' }])
    const m = markCells(l, 2, 3)
    assert.equal(m.at(-1)!.text.normalize('NFKC'), 'شُ')
    assert.ok(m.at(-1)!.style?.inverse)
  })
})

describe('drawn as it came', () => {
  test('bidiText reorders a span in its own cells: a lam-alef leaves a space, so nothing after it moves', () => {
    assert.equal(bidiText('hello'), 'hello')
    assert.equal(bidiText('שלום'), 'םולש')
    const t = bidiText('لا')
    assert.equal(cells(t), 2)
    assert.equal(bidiText('لا'), t)
  })
  test('bidiSpan leaves a span laid out already, and one without right-to-left text', () => {
    const [done] = bidiLine([{ text: 'שלום' }])
    assert.equal(bidiSpan(done!), done)
    const plain = { text: 'abc' }
    assert.equal(bidiSpan(plain), plain)
    assert.equal(bidiSpan({ text: '“שלום”' }).text, '”םולש“')
  })
})

describe('markdown', () => {
  test('an Arabic reply: on the right, inline code left to right and still copied whole', () => {
    let copied = ''
    const lines = markdown('شغّل `npm run test` الآن', 40, t => (copied = t))
    assert.equal(lines.length, 1)
    assert.ok(isRtl(lines[0]!))
    assert.match(letters(lines[0]!), /npm run test/)
    lines[0]!.find(s => s.text === 'npm')!.action!()
    assert.equal(copied, 'npm run test')
  })
  test('a table cell in Arabic is reordered and right-aligned in its column', () => {
    const lines = markdown('| a | b |\n|---|---|\n| שלום | x |', 40)
    const row = shown(lines[2]!)
    assert.match(row, /^ {0,3}םולש │ x/)
  })
  test('a code block reads left to right, an Arabic string in it right to left in its place', () => {
    const lines = markdown('```js\nprint("שלום")\n```', 40)
    assert.match(shown(lines[1]!), /print\("םולש"\)/)
    assert.ok(!isRtl(lines[1]!))
  })
  test('the cache knows the mode', () => {
    const a = shown(markdown('שלום עולם', 30)[0]!)
    setBidiMode('terminal')
    const b = shown(markdown('שלום עולם', 30)[0]!)
    assert.notEqual(a, b)
    assert.equal(b, 'שלום עולם')
  })
})

describe('the input box', () => {
  test('a right-to-left row: the cursor on the character it is before, past the end on its left', () => {
    const lay = inputRow('שלום', 'rtl')
    assert.equal(shown(lay.spans), 'םולש')
    assert.ok(lay.rtl)
    assert.equal(cursorCell(lay, 0, 4), 3)
    assert.equal(cursorCell(lay, 1, 4), 2)
    assert.equal(cursorCell(lay, 4, 4), -1)
    // A click on a cell: the character drawn there.
    assert.equal(indexAt(lay, 3, 4), 0)
    assert.equal(indexAt(lay, 0, 4), 3)
    assert.equal(indexAt(lay, 9, 4), 4)
  })
  test('English in it: the cursor follows the run it is in', () => {
    const lay = inputRow('שלום abc', 'rtl')
    assert.equal(shown(lay.spans), 'abc םולש')
    // Before "b": on it, the second cell.
    assert.equal(cursorCell(lay, 6, 8), 1)
    // At the end, after "c" (a left-to-right run): right of it.
    assert.equal(cursorCell(lay, 8, 8), 3)
    // An empty row.
    assert.equal(cursorCell(inputRow('', 'rtl'), 0, 0), -1)
    assert.equal(cursorCell(inputRow('', 'ltr'), 0, 0), 0)
  })
  test('a selection is drawn on the characters selected, wherever they went', () => {
    const lay = inputRow('שלום עולם', 'rtl', [0, 4])
    const sel = lay.spans.filter(s => s.style?.inverse).map(s => s.text).join('')
    assert.equal(sel, 'םולש')
  })
  test('layout gives each cluster its cells and its place in the text', () => {
    const { clusters, width } = layout([{ text: 'aשb' }])
    assert.equal(width, 3)
    assert.deepEqual(clusters.map(c => [c.x, c.from, c.odd]), [[0, 0, false], [1, 1, true], [2, 2, false]])
  })
})
