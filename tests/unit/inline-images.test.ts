import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { cup, detectProtocol, fitCells, InlineImages, itermImage, kittyDelete, kittyPlace, kittyTransmit, localPath, parseReply } from '../../app/inline-images.ts'
import { Renders } from '../../app/diagrams.ts'
import type { Run } from '../../app/diagrams.ts'
import { decodePng, encodePng } from '../../app/png.ts'
import type { Line } from '../../app/text.ts'
import { unsixel } from './sixel-decode.ts'

describe('detectProtocol', () => {
  const cases: [Record<string, string>, string][] = [
    [{ CLUED_IMAGES: 'iterm' }, 'iterm'],
    [{ CLUED_IMAGES: 'iTerm2', TMUX: '1' }, 'iterm'],
    [{ CLUED_IMAGES: 'kitty' }, 'kitty'],
    [{ CLUED_IMAGES: 'sixel' }, 'sixel'],
    [{ CLUED_IMAGES: 'off', TERM_PROGRAM: 'iTerm.app' }, 'off'],
    [{ CLUED_IMAGES: 'nonsense' }, 'off'],
    [{ CLUED_IMAGES: 'auto', TERM: 'xterm-kitty' }, 'kitty'],
    [{ TERM_PROGRAM: 'iTerm.app', TMUX: '/tmp/x' }, 'off'],
    [{ TERM: 'screen-256color' }, 'off'],
    [{ TERM_PROGRAM: 'iTerm.app' }, 'iterm'],
    [{ LC_TERMINAL: 'iTerm2' }, 'iterm'],
    [{ TERM_PROGRAM: 'WezTerm' }, 'iterm'],
    [{ KITTY_WINDOW_ID: '1' }, 'kitty'],
    [{ TERM_PROGRAM: 'ghostty' }, 'kitty'],
    [{ TERM: 'xterm-ghostty' }, 'kitty'],
    [{ WT_SESSION: 'abc', TERM: 'xterm-256color' }, 'sixel'],
    [{ TERM: 'foot' }, 'sixel'],
    [{ TERM: 'mlterm' }, 'sixel'],
    [{ TERM_PROGRAM: 'Apple_Terminal' }, 'off'],
    [{ TERM: 'xterm-256color' }, 'query'],
  ]
  for (const [env, want] of cases) test(`${JSON.stringify(env)} → ${want}`, () => assert.equal(detectProtocol(env), want))
})

describe('fitCells', () => {
  const cell = { w: 10, h: 20 }
  test('as wide as the image in cells, at most the room; rows keep its aspect', () => {
    assert.deepEqual(fitCells(600, 300, 80, cell), { cols: 60, rows: 15 })
    assert.deepEqual(fitCells(1600, 400, 80, cell), { cols: 80, rows: 10 })
    assert.deepEqual(fitCells(1, 1, 80, cell), { cols: 1, rows: 1 })
  })
  test('a tall image is capped at 20 rows, narrower to keep its shape', () => {
    assert.deepEqual(fitCells(400, 2000, 80, cell), { cols: 8, rows: 20 })
    assert.deepEqual(fitCells(400, 2000, 80, cell, 10), { cols: 4, rows: 10 })
  })
})

describe('localPath', () => {
  test('absolute, file:// and ~/ paths; never a URL or a relative path', () => {
    assert.equal(localPath('/tmp/a.png'), '/tmp/a.png')
    assert.equal(localPath('<\/tmp/a b.png>'), '/tmp/a b.png')
    assert.equal(localPath('file:///tmp/a%20b.png'), '/tmp/a b.png')
    assert.equal(localPath('file://localhost/tmp/x.png'), '/tmp/x.png')
    assert.equal(localPath('~/x.png', '/home/u'), '/home/u/x.png')
    assert.equal(localPath('https://example.com/a.png'), undefined)
    assert.equal(localPath('a.png'), undefined)
    assert.equal(localPath('file:///%E0%A4%A'), undefined)
  })
})

describe('escape sequences', () => {
  test('iTerm2: OSC 1337 File, inline, its size in cells and bytes, base64', () => {
    assert.equal(itermImage(Buffer.from('hi'), 4, 2), '\x1b]1337;File=inline=1;size=2;width=4;height=2;preserveAspectRatio=1;doNotMoveCursor=1:aGk=\x07')
  })
  test('kitty: a PNG sent in chunks of 4096, then placed (cropped or not), then deleted', () => {
    const small = kittyTransmit(7, Buffer.from('png'))
    assert.equal(small, '\x1b_Ga=t,f=100,t=d,i=7,q=2,m=0;cG5n\x1b\\')
    const big = kittyTransmit(7, Buffer.alloc(7000))
    const chunks = [...big.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)]
    assert.deepEqual(chunks.map(c => c[1]), ['a=t,f=100,t=d,i=7,q=2,m=1', 'm=1,q=2', 'm=0,q=2'])
    assert.equal(chunks.map(c => c[2]).join(''), Buffer.alloc(7000).toString('base64'))
    assert.ok(chunks.every(c => c[2]!.length <= 4096))
    assert.equal(kittyPlace(7, 10, 5), '\x1b_Ga=p,i=7,p=1,c=10,r=5,C=1,q=2\x1b\\')
    assert.equal(kittyPlace(7, 10, 2, { x: 0, y: 30, w: 100, h: 20 }), '\x1b_Ga=p,i=7,p=1,c=10,r=2,x=0,y=30,w=100,h=20,C=1,q=2\x1b\\')
    assert.equal(kittyDelete(7), '\x1b_Ga=d,d=i,i=7,q=2\x1b\\')
    assert.equal(kittyDelete(), '\x1b_Ga=d,d=a,q=2\x1b\\')
    assert.equal(kittyDelete(undefined, true), '\x1b_Ga=d,d=A,q=2\x1b\\')
    assert.equal(cup(3, 9), '\x1b[3;9H')
  })
})

describe('parseReply', () => {
  test('device attributes, cell size, text area, iTerm2 cell size, kitty replies; anything else is none', () => {
    assert.deepEqual(parseReply('\x1b[?61;4;6;7c rest'), { len: 12, sixel: true })
    assert.deepEqual(parseReply('\x1b[?62;22c'), { len: 9, sixel: false })
    // 4 as the conformance level is not Sixel.
    assert.equal(parseReply('\x1b[?4;6c')!.sixel, false)
    assert.deepEqual(parseReply('\x1b[6;20;10t'), { len: 10, cell: { w: 10, h: 20 } })
    assert.deepEqual(parseReply('\x1b[4;800;1200t'), { len: 13, area: { w: 1200, h: 800 } })
    assert.deepEqual(parseReply('\x1b]1337;ReportCellSize=17.0;8.0;2.0\x07'), { len: 35, cell: { w: 16, h: 34 } })
    assert.deepEqual(parseReply('\x1b]1337;ReportCellSize=17;8\x1b\\'), { len: 28, cell: { w: 8, h: 17 } })
    assert.deepEqual(parseReply('\x1b_Gi=1;OK\x1b\\'), { len: 11 })
    assert.equal(parseReply('\x1b[A'), undefined)
  })
})

// ---- The app's images ------------------------------------------------------------

/** A temp dir with a 200 × 100 PNG (left half red, right half blue), a fake JPEG and an SVG. */
function files() {
  const dir = mkdtempSync(join(tmpdir(), 'clued-inline-'))
  const data = new Uint8Array(200 * 100 * 4)
  for (let i = 0; i < 200 * 100; i++) data.set((i % 200) < 100 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4)
  const png = join(dir, 'chart.png')
  writeFileSync(png, encodePng({ width: 200, height: 100, data }))
  const jpg = join(dir, 'photo.jpg')
  writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 100, 0, 200, 3, 0, 0, 0, 0]))
  const svg = join(dir, 'pic.svg')
  writeFileSync(svg, '<svg/>')
  return { dir, png, jpg, svg, done: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Renders whose tools are fakes: `out` decides what a conversion or a diagram writes. */
function renders(dir: string, tools: string[], out: (args: string[]) => Buffer | undefined) {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const t of tools) {
    writeFileSync(join(bin, t), '#!/bin/sh\n')
    chmodSync(join(bin, t), 0o755)
  }
  const pending: (() => void)[] = []
  const run: Run = (_cmd, args, done) => {
    pending.push(() => {
      const o = args.indexOf('-o')
      const file = o >= 0 ? args[o + 1]! : args.at(-1)!
      const data = out(args)
      if (data) writeFileSync(file, data)
      done(data ? undefined : 'boom: it failed')
    })
  }
  let images: InlineImages | undefined
  const r = new Renders(join(dir, 'cache'), () => images?.['changed'](), { path: bin, run, platform: 'linux' })
  return { r, flush: () => pending.splice(0).forEach(f => f()), bind: (i: InlineImages) => (images = i) }
}

const make = (protocol: string, extra: Partial<ConstructorParameters<typeof InlineImages>[0]> = {}) =>
  new InlineImages({ env: { CLUED_IMAGES: protocol, CLUED_IMAGE_CELL: '10x20' }, ...extra })

/** Screen rows for lines: the first at `top`. */
const at = (lines: Line[], top: number) => lines.map((line, i) => ({ line, row: top + i }))

describe('InlineImages: layout', () => {
  test('a local PNG: rows kept for it (no copy, a click opens it), and a caption with its path', () => {
    const f = files()
    const opened: string[] = []
    try {
      const img = make('sixel', { open: p => opened.push(p) })
      // Wide: macOS's temp paths are long.
    const lines = img.image('a chart', f.png, 200)!
      // 200 × 100 pixels at 10 × 20 a cell: 20 columns, 5 rows.
      assert.equal(lines.length, 6)
      assert.ok(lines.slice(0, 5).every((l, k) => l[0]!.text === ' '.repeat(20) && l[0]!.noCopy && l[0]!.image?.row === k))
      const cap = lines[5]!
      assert.equal(cap[0]!.text, '[image: a chart]')
      assert.equal(cap[1]!.text, ` ${f.png.replace(homedir(), '~')}`)
      lines[0]![0]!.action!()
      cap[0]!.action!()
      assert.deepEqual(opened, [f.png, f.png])
      // No alt: the file's name.
      assert.equal(img.image('', f.png, 200)!.at(-1)![0]!.text, '[image: chart.png]')
      // Narrow: the caption has no room for the path.
      assert.equal(img.image('x', f.png, 12)!.at(-1)!.length, 1)
    } finally {
      f.done()
    }
  })

  test('what stays a link: images off, a URL, a relative path, a missing file, another type, too big, not an image', () => {
    const f = files()
    try {
      assert.equal(make('off').image('x', f.png, 40), undefined)
      const img = make('sixel')
      assert.equal(img.image('x', 'https://example.com/a.png', 40), undefined)
      assert.equal(img.image('x', 'chart.png', 40), undefined)
      assert.equal(img.image('x', join(f.dir, 'gone.png'), 40), undefined)
      writeFileSync(join(f.dir, 'notes.txt'), 'x')
      assert.equal(img.image('x', join(f.dir, 'notes.txt'), 40), undefined)
      writeFileSync(join(f.dir, 'huge.png'), Buffer.alloc((10 << 20) + 1))
      assert.equal(img.image('x', join(f.dir, 'huge.png'), 40), undefined)
      writeFileSync(join(f.dir, 'fake.png'), 'not a png at all')
      assert.equal(img.image('x', join(f.dir, 'fake.png'), 40), undefined)
      mkdirSync(join(f.dir, 'folder.png'))
      assert.equal(img.image('x', join(f.dir, 'folder.png'), 40), undefined)
      // A header claiming 30000 × 30000.
      const big = encodePng({ width: 1, height: 1, data: new Uint8Array(4) })
      big.writeUInt32BE(30000, 16)
      big.writeUInt32BE(30000, 20)
      writeFileSync(join(f.dir, 'wide.png'), big)
      assert.equal(img.image('x', join(f.dir, 'wide.png'), 40), undefined)
    } finally {
      f.done()
    }
  })

  test('a JPEG: as it is in iTerm2; converted to PNG for Sixel (a link until then, or with no tool)', () => {
    const f = files()
    try {
      assert.equal(make('iterm').image('p', f.jpg, 40)!.length, 6)
      const none = renders(f.dir, [], () => undefined)
      assert.equal(make('sixel', { renders: none.r }).image('p', f.jpg, 40), undefined)
      const conv = renders(join(f.dir, 'b'), ['ffmpeg'], () => encodePng({ width: 100, height: 100, data: new Uint8Array(40000) }))
      let changed = 0
      const img = make('sixel', { renders: conv.r, onChange: () => changed++ })
      conv.bind(img)
      assert.equal(img.image('p', f.jpg, 40), undefined)
      conv.flush()
      assert.equal(changed, 1)
      // 100 × 100: 10 columns, 5 rows.
      assert.equal(img.image('p', f.jpg, 40)!.length, 6)
      // An SVG, likewise, by rsvg-convert.
      const svg = renders(join(f.dir, 'c'), ['rsvg-convert'], () => encodePng({ width: 10, height: 10, data: new Uint8Array(400) }))
      const img2 = make('kitty', { renders: svg.r })
      img2.image('s', f.svg, 40)
      svg.flush()
      assert.equal(img2.image('s', f.svg, 40)!.length, 2)
    } finally {
      f.done()
    }
  })
})

describe('InlineImages: diagrams', () => {
  test('drawn: the diagram replaces the code; meanwhile, failed or without mmdc, a note under it', () => {
    const f = files()
    try {
      const diagram = encodePng({ width: 300, height: 200, data: new Uint8Array(300 * 200 * 4) })
      let fail = false
      const m = renders(f.dir, ['mmdc'], () => (fail ? undefined : diagram))
      const img = make('sixel', { renders: m.r })
      const note = (d: ReturnType<InlineImages['diagram']>) => d!.lines[0]![0]!.text
      assert.equal(note(img.diagram('graph TD', 40)), '◌ drawing the diagram…')
      m.flush()
      const done = img.diagram('graph TD', 40)!
      assert.equal(done.replace, true)
      assert.equal(done.lines.length, 11)
      assert.deepEqual(done.lines.at(-1)!.map(s => s.text), ['[image: diagram]'])
      fail = true
      img.diagram('graph LR', 60)
      m.flush()
      assert.equal(note(img.diagram('graph LR', 60)), "⚠ couldn't draw the diagram: boom: it failed")
      const bare = renders(join(f.dir, 'x'), [], () => undefined)
      // Without mmdc: the hint that /setup installs it, when it may show (once: the app remembers it), else nothing.
      let may = true
      const hinted = make('kitty', { renders: bare.r, hint: () => may })
      assert.equal(note(hinted.diagram('graph TD', 60)), 'Diagrams need mmdc: /setup installs the diagram tool')
      assert.equal(note(make('off', { renders: bare.r, hint: () => true }).diagram('graph TD', 60)), 'Diagrams need mmdc: /setup installs the diagram tool')
      may = false
      assert.equal(hinted.diagram('graph TD', 60), undefined)
      assert.equal(make('kitty', { renders: bare.r }).diagram('graph TD', 60), undefined)
      // Images off: the code as it is, and once drawn, a link to the picture under it.
      const off = make('off', { renders: m.r })
      assert.equal(off.diagram('graph XY', 40), undefined)
      assert.deepEqual(off.diagram('graph TD', 40), { lines: [[{ text: '[image: diagram]', style: { fg: 75, underline: true } }]], replace: false })
    } finally {
      f.done()
    }
  })

  test('a drawn diagram that is no PNG: a note', () => {
    const f = files()
    try {
      const m = renders(f.dir, ['mmdc'], () => Buffer.from('junk'))
      const img = make('sixel', { renders: m.r })
      img.diagram('graph TD', 40)
      m.flush()
      assert.equal(img.diagram('graph TD', 40)!.lines[0]![0]!.text, '⚠ the diagram came out empty')
    } finally {
      f.done()
    }
  })
})

describe('InlineImages: frames', () => {
  const sixelAt = (out: string) => [...out.matchAll(/\x1b\[(\d+);(\d+)H(\x1bP[^\x1b]*\x1b\\)/g)].map(m => ({ row: Number(m[1]), col: Number(m[2]), img: unsixel(m[3]!) }))

  test('Sixel: drawn after the text at its cells; the next frame steps over them; moved, drawn again', () => {
    const f = files()
    try {
      const img = make('sixel')
      const lines: Line[] = [[{ text: 'Here:' }], ...img.image('c', f.png, 40)!.map(l => [{ text: '│ ' }, ...l])]
      const first = img.frame(at(lines, 3), 5)
      const drawn = sixelAt(first.out)
      assert.equal(drawn.length, 1)
      // Row 4 (after "Here:"), the cell after "│ " (column 5 + 2).
      assert.deepEqual([drawn[0]!.row, drawn[0]!.col, drawn[0]!.img.width, drawn[0]!.img.height], [4, 7, 200, 100])
      const p = (x: number, y: number) => [...drawn[0]!.img.data.slice((y * 200 + x) * 4, (y * 200 + x) * 4 + 3)]
      assert.deepEqual([p(10, 50), p(190, 50)], [[255, 0, 0], [0, 0, 255]])
      assert.equal(first.lines.size, 0)
      // Still there: nothing written, its cells skipped.
      const second = img.frame(at(lines, 3), 5)
      assert.equal(second.out, '')
      assert.equal(second.lines.size, 5)
      assert.ok([...second.lines.values()].every(l => l[1]!.image?.skip))
      // Moved down a row: its old cells erased first, drawn again there, nothing skipped.
      const third = img.frame(at(lines, 4), 5)
      assert.equal(third.before, [4, 5, 6, 7, 8].map(r => `\x1b[${r};7H\x1b[20X`).join(''))
      assert.equal(sixelAt(third.out)[0]!.row, 5)
      assert.equal(third.lines.size, 0)
    } finally {
      f.done()
    }
  })

  test('partly in view: cropped to its rows; under the ↓ tag: those rows left out', () => {
    const f = files()
    try {
      const img = make('sixel')
      const rows = img.image('c', f.png, 40)!.slice(0, 5)
      // Its last 2 rows at the top of the screen.
      const top = sixelAt(img.frame(at(rows.slice(3), 1), 1).out)[0]!
      assert.deepEqual([top.row, top.img.height], [1, 40])
      // Its first 3 rows, the third under the tag.
      const cut = sixelAt(img.frame(at(rows.slice(0, 3), 8), 1, [{ row: 10, col0: 15, col1: 30 }]).out)[0]!
      assert.deepEqual([cut.row, cut.img.height], [8, 40])
      // Out of view: its cells erased (ECH) before the text, nothing drawn.
      assert.deepEqual(img.frame([], 1), { lines: new Map(), before: '\x1b[8;1H\x1b[20X\x1b[9;1H\x1b[20X', out: '' })
      // The picker covers the screen: an image there is erased, and drawn again after.
      img.frame(at(rows, 1), 1)
      assert.equal(img.hide(), Array.from({ length: 5 }, (_, i) => `\x1b[${i + 1};1H\x1b[20X`).join(''))
      assert.equal(img.hide(), '')
    } finally {
      f.done()
    }
  })

  test('iTerm2: the file as it is when whole; a crop is a new PNG of those rows', () => {
    const f = files()
    try {
      const img = make('iterm')
      const rows = img.image('c', f.png, 40)!.slice(0, 5)
      const whole = img.frame(at(rows, 2), 3).out
      assert.match(whole, /^\x1b\[2;3H\x1b\]1337;File=inline=1;size=\d+;width=20;height=5;preserveAspectRatio=1;doNotMoveCursor=1:/)
      const sent = (s: string) => decodePng(Buffer.from(s.match(/:([A-Za-z0-9+/=]+)\x07/)![1]!, 'base64'))
      assert.equal(sent(whole).height, 100)
      img.hide()
      const part = img.frame(at(rows.slice(2), 1), 3).out
      assert.match(part, /height=3;/)
      // Twice the cells' pixels, at most the image's own: 100 rows of 5, the last 3 of them.
      assert.deepEqual([sent(part).width, sent(part).height], [200, 60])
    } finally {
      f.done()
    }
  })

  test('iTerm2 and a JPEG partly in view: a note until all of it is', () => {
    const f = files()
    try {
      const img = make('iterm')
      const rows = img.image('p', f.jpg, 40)!.slice(0, 5)
      const r = img.frame(at(rows.slice(1), 1), 1)
      assert.equal(r.out, '')
      assert.match(r.lines.get(0)![0]!.text, /^▒ p \(scroll to see/)
      assert.match(img.frame(at(rows, 1), 1).out, /1337;File=inline=1;size=16;/)
    } finally {
      f.done()
    }
  })

  test('kitty: sent once, placed (moved: taken off first, cropped by a source rect), taken off when gone', () => {
    const f = files()
    try {
      const img = make('kitty')
      const rows = img.image('c', f.png, 40)!.slice(0, 5)
      const a = img.frame(at(rows, 2), 1).out
      assert.match(a, /^\x1b\[2;1H\x1b_Ga=t,f=100,t=d,i=(\d+),q=2,m=0;[^\x1b]+\x1b\\\x1b_Ga=p,i=\1,p=1,c=20,r=5,C=1,q=2\x1b\\$/)
      const id = a.match(/i=(\d+)/)![1]
      assert.equal(img.frame(at(rows, 2), 1).out, '')
      const b = img.frame(at(rows.slice(1), 1), 1)
      assert.equal(b.before, `\x1b_Ga=d,d=i,i=${id},q=2\x1b\\`)
      assert.equal(b.out, `\x1b[1;1H\x1b_Ga=p,i=${id},p=1,c=20,r=4,x=0,y=20,w=200,h=80,C=1,q=2\x1b\\`)
      assert.deepEqual(img.frame([], 1), { lines: new Map(), before: `\x1b_Ga=d,d=i,i=${id},q=2\x1b\\`, out: '' })
      img.frame(at(rows, 2), 1)
      assert.equal(img.hide(), '\x1b_Ga=d,d=a,q=2\x1b\\')
      assert.equal(img.hide(), '')
      assert.equal(img.hide(true), '\x1b_Ga=d,d=A,q=2\x1b\\')
      // Forgotten: sent again.
      assert.match(img.frame(at(rows, 2), 1).out, /a=t,/)
    } finally {
      f.done()
    }
  })

  test('a file that turns out not to decode: dropped, and a link from then on', async () => {
    const f = files()
    try {
      let changed = 0
      const img = make('sixel', { onChange: () => changed++ })
      const rows = img.image('c', f.png, 40)!.slice(0, 5)
      writeFileSync(f.png, Buffer.concat([encodePng({ width: 1, height: 1, data: new Uint8Array(4) }).subarray(0, 33)]))
      // Its header still says 200 × 100 for the layout made before; drawing it fails.
      const r = img.frame(at(rows, 1), 1)
      assert.equal(r.out, '\x1b[1;1H')
      await new Promise(res => setImmediate(res))
      assert.equal(changed, 1)
    } finally {
      f.done()
    }
  })

  test('images off: frames write nothing', () => {
    assert.deepEqual(make('off').frame([{ line: [{ text: ' ', image: { id: 'x', row: 0 } }], row: 1 }], 1).out, '')
  })
})

describe('InlineImages: the terminal', () => {
  test('queries: cell size, iTerm2 its own, Sixel asked; none when off or the cell size is set', () => {
    assert.equal(new InlineImages({ env: { CLUED_IMAGES: 'off' } }).queries(), '')
    assert.equal(new InlineImages({ env: { CLUED_IMAGES: 'sixel' } }).queries(), '\x1b[16t\x1b[14t')
    assert.equal(new InlineImages({ env: { CLUED_IMAGES: 'iterm' } }).queries(), '\x1b[16t\x1b[14t\x1b]1337;ReportCellSize\x07')
    assert.equal(new InlineImages({ env: { TERM: 'xterm-256color' } }).queries(), '\x1b[16t\x1b[14t\x1b[c')
    assert.equal(make('kitty').queries(), '')
  })

  test('a terminal that says it draws Sixel gets Sixel; one that doesn\'t, or never answers, none', () => {
    let changed = 0
    const yes = new InlineImages({ env: { TERM: 'xterm' }, onChange: () => changed++ })
    assert.equal(yes.protocol, 'off')
    assert.equal(yes.reply('\x1b[?62;4;22c'), 11)
    assert.equal(yes.protocol, 'sixel')
    assert.equal(changed, 1)
    const no = new InlineImages({ env: { TERM: 'xterm' } })
    no.reply('\x1b[?62;22c')
    assert.equal(no.protocol, 'off')
    const late = new InlineImages({ env: { TERM: 'xterm' } })
    late.giveUp()
    late.reply('\x1b[?62;4c')
    assert.equal(late.protocol, 'off')
    assert.equal(late.reply('hello'), 0)
    assert.equal(late.reply('\x1b[A'), 0)
  })

  test('the cell size: CSI 6 t wins over the text area divided by cells; a set one stays', () => {
    let changed = 0
    const img = new InlineImages({ env: { CLUED_IMAGES: 'sixel' }, size: () => ({ cols: 100, rows: 40 }), onChange: () => changed++ })
    img.reply('\x1b[4;800;900t')
    assert.deepEqual(img.cell, { w: 9, h: 20 })
    img.reply('\x1b[6;18;8t')
    assert.deepEqual(img.cell, { w: 8, h: 18 })
    img.reply('\x1b[4;800;1000t')
    assert.deepEqual(img.cell, { w: 8, h: 18 })
    assert.equal(changed, 2)
    const media = img.media()
    assert.match(media.key, /^sixel8x18\.\d+$/)
    const fixed = make('sixel')
    fixed.reply('\x1b[6;18;8t')
    assert.deepEqual(fixed.cell, { w: 10, h: 20 })
  })

  test('resized: images drawn again, the cell size asked again', () => {
    assert.equal(new InlineImages({ env: { CLUED_IMAGES: 'sixel' } }).resized(), '\x1b[16t\x1b[14t')
    assert.equal(make('sixel').resized(), '')
    assert.equal(new InlineImages({ env: { CLUED_IMAGES: 'off' } }).resized(), '')
  })

  test('media: what markdown() is given, opener included', () => {
    const f = files()
    try {
      const open = () => {}
      const m = make('sixel', { open }).media()
      assert.equal(m.open, open)
      assert.equal(m.image!('x', f.png, 30)!.length, 6)
      assert.equal(make('off').media().open, undefined)
      // No mmdc (an empty PATH): the hint, under the code.
      assert.equal(make('sixel', { renders: new Renders(join(f.dir, 'c'), () => {}, { path: '' }), hint: () => true }).media().diagram!('graph', 30)!.replace, false)
    } finally {
      f.done()
    }
  })
})
