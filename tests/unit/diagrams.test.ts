import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onPath, Renders } from '../../app/diagrams.ts'
import type { Run } from '../../app/diagrams.ts'

/** A temp folder with a bin/ of empty programs named `tools`, and a cache folder. */
function setup(tools: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'clued-diagrams-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  for (const t of tools) {
    writeFileSync(join(bin, t), '#!/bin/sh\n')
    chmodSync(join(bin, t), 0o755)
  }
  return { dir, bin, cache: join(dir, 'cache'), done: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A runner that records its calls and writes the output file (the arg after -o, or the last). */
function fakeRun(result: (args: string[], n: number) => string | undefined = () => undefined) {
  const calls: { cmd: string; args: string[] }[] = []
  let finish: (() => void)[] = []
  const run: Run = (cmd, args, done) => {
    calls.push({ cmd, args })
    const err = result(args, calls.length)
    const o = args.indexOf('-o')
    const out = args.includes('--out') ? args[args.indexOf('--out') + 1]! : o >= 0 ? args[o + 1]! : args.at(-1)!
    finish.push(() => {
      if (!err) writeFileSync(out, 'png')
      done(err)
    })
  }
  return { run, calls, flush: () => { const f = finish; finish = []; f.forEach(x => x()) } }
}

describe('onPath', () => {
  test('finds an executable on PATH, not a plain file or a folder', () => {
    const s = setup(['mmdc'])
    try {
      writeFileSync(join(s.bin, 'plain'), '')
      mkdirSync(join(s.bin, 'dir'))
      assert.equal(onPath(['nope', 'mmdc'], `/nonexistent:${s.bin}`), join(s.bin, 'mmdc'))
      assert.equal(onPath(['plain', 'dir'], s.bin), undefined)
    } finally {
      s.done()
    }
  })
})

describe('Renders.diagram', () => {
  test('no mmdc: missing; with it, drawing, then ready from the cache (drawn once)', () => {
    const none = setup([])
    try {
      assert.deepEqual(new Renders(none.cache, () => {}, { path: none.bin }).diagram('graph TD'), { state: 'missing' })
    } finally {
      none.done()
    }
    const s = setup(['mmdc'])
    try {
      let changed = 0
      const f = fakeRun()
      const r = new Renders(s.cache, () => changed++, { path: s.bin, run: f.run })
      assert.equal(r.hasMermaid, true)
      assert.deepEqual(r.diagram('graph TD\n A-->B'), { state: 'drawing' })
      assert.deepEqual(r.diagram('graph TD\n A-->B'), { state: 'drawing' })
      // One at a time: the second waits for the first.
      r.diagram('graph LR\n C-->D')
      assert.equal(f.calls.length, 1)
      assert.deepEqual(f.calls[0]!.args.slice(-7), ['-t', 'dark', '-b', 'transparent', '-s', '2', '-q'])
      f.flush()
      assert.equal(f.calls.length, 2)
      f.flush()
      assert.equal(changed, 2)
      const done = r.diagram('graph TD\n A-->B')
      assert.equal(done.state, 'ready')
      assert.ok(existsSync((done as { png: string }).png))
      // Its source file is gone; a new app finds the PNG in the cache, without drawing it again.
      assert.deepEqual(readdirSync(join(s.cache, 'mermaid')).filter(n => n.endsWith('.mmd')), [])
      const again = new Renders(s.cache, () => {}, { path: s.bin, run: f.run })
      assert.equal(again.diagram('graph TD\n A-->B').state, 'ready')
      assert.equal(f.calls.length, 2)
    } finally {
      s.done()
    }
  })

  test('a failed drawing says why; a sandbox failure is tried once more without the sandbox', () => {
    const s = setup(['mmdc'])
    try {
      const f = fakeRun((_args, n) => (n === 1 ? 'Parse error on line 1' : n === 2 ? 'No usable sandbox!' : undefined))
      const r = new Renders(s.cache, () => {}, { path: s.bin, run: f.run })
      r.diagram('bad')
      f.flush()
      assert.deepEqual(r.diagram('bad'), { state: 'failed', error: 'Parse error on line 1' })
      r.diagram('good')
      f.flush()
      assert.equal(f.calls.length, 3)
      assert.ok(f.calls[2]!.args.includes('-p'))
      f.flush()
      assert.equal(r.diagram('good').state, 'ready')
    } finally {
      s.done()
    }
  })

  test('a runner that makes no file: failed', () => {
    const s = setup(['mmdc'])
    try {
      const r = new Renders(s.cache, () => {}, { path: s.bin, run: (_c, _a, done) => done() })
      r.diagram('x')
      assert.deepEqual(r.diagram('x'), { state: 'failed', error: 'it made no image' })
    } finally {
      s.done()
    }
  })
})

describe('Renders.convert', () => {
  test('picks sips on macOS, ImageMagick, then ffmpeg; rsvg-convert for SVG; none: missing', () => {
    const s = setup(['sips', 'ffmpeg', 'rsvg-convert'])
    try {
      const pic = join(s.dir, 'a.jpg')
      const svg = join(s.dir, 'b.svg')
      writeFileSync(pic, 'jpeg')
      writeFileSync(svg, '<svg/>')
      const f = fakeRun()
      const mac = new Renders(s.cache, () => {}, { path: s.bin, run: f.run, platform: 'darwin' })
      assert.deepEqual(mac.convert(pic), { state: 'drawing' })
      f.flush()
      assert.equal(f.calls[0]!.cmd, join(s.bin, 'sips'))
      assert.equal(mac.convert(pic).state, 'ready')
      const linux = new Renders(join(s.dir, 'c2'), () => {}, { path: s.bin, run: f.run, platform: 'linux' })
      linux.convert(pic)
      f.flush()
      assert.equal(f.calls[1]!.cmd, join(s.bin, 'ffmpeg'))
      linux.convert(svg)
      f.flush()
      assert.equal(f.calls[2]!.cmd, join(s.bin, 'rsvg-convert'))
      assert.deepEqual(new Renders(s.cache, () => {}, { path: '/nonexistent' }).convert(join(s.dir, 'z.webp')), { state: 'failed', error: 'no such file' })
      const bare = setup([])
      try {
        assert.deepEqual(new Renders(bare.cache, () => {}, { path: bare.bin }).convert(pic), { state: 'missing' })
      } finally {
        bare.done()
      }
    } finally {
      s.done()
    }
  })

  test('ImageMagick takes the first frame', () => {
    const s = setup(['magick'])
    try {
      const pic = join(s.dir, 'a.gif')
      writeFileSync(pic, 'gif')
      const f = fakeRun()
      new Renders(s.cache, () => {}, { path: s.bin, run: f.run, platform: 'linux' }).convert(pic)
      assert.equal(f.calls[0]!.args.at(-2), `${pic}[0]`)
    } finally {
      s.done()
    }
  })
})
