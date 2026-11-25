// Images in Claude's replies: rows kept for one in the chat, and the escape sequence of the protocol
// asked for (CLUED_IMAGES) written at its cells, once; a Mermaid block drawn by mmdc (a fake here).
// Off (as inside tmux, where these tests run), an image is a link and nothing else is written.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodePng } from '../../app/png.ts'
import { unsixel } from '../unit/sixel-decode.ts'
import { withApp, WAIT_MS } from './harness.ts'
import type { App } from './harness.ts'

/** 200 × 100: red on the left, blue on the right. At 10 × 20 pixels a cell: 20 columns, 5 rows. */
function chart(path: string) {
  const data = new Uint8Array(200 * 100 * 4)
  for (let i = 0; i < 200 * 100; i++) data.set(i % 200 < 100 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4)
  writeFileSync(path, encodePng({ width: 200, height: 100, data }))
}

const env = (protocol: string) => ({ CLUED_IMAGES: protocol, CLUED_IMAGE_CELL: '10x20' })
const setup = ({ dir }: { dir: string }) => chart(join(dir, 'chart.png'))

/** Waits until the app's output holds `re` `n` times; returns the matches. */
async function waitOutput(app: App, re: RegExp, n = 1) {
  const until = Date.now() + WAIT_MS
  let all: RegExpMatchArray[] = []
  while (Date.now() < until) {
    all = [...app.output().matchAll(re)]
    if (all.length >= n) return all
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`The output holds ${all.length} of ${re}, not ${n}`)
}

/** Where `text` is in the chat: its 1-based row and column. */
const where = (app: App, text: string) => app.find(text, { area: 'chat' })!

describe('inline images', () => {
  test('Sixel: 5 rows kept under the paragraph, the image written at them once, a caption that opens it; a URL stays a link', () =>
    withApp({ env: env('sixel'), setup }, async app => {
      await app.send('show me a chart')
      await app.waitIdle('[image: sales by month]')
      const text = where(app, 'Here is the chart.')
      const cap = where(app, '[image: sales by month]')
      // The paragraph, a blank line, then 5 rows for the image, then its caption.
      assert.equal(cap.row - text.row, 7)
      for (let r = text.row; r < cap.row - 1; r++) assert.match(app.lines()[r]!, /│\s+│\s*$/)
      assert.match(app.screen(), /A remote one stays a link: logo \(https:\/\/example\.com\/logo\.png\)/)
      const [m] = await waitOutput(app, /\x1b\[(\d+);(\d+)H(\x1bP0;1;0q[^\x1b]*\x1b\\)/g)
      assert.deepEqual([Number(m![1]), Number(m![2])], [text.row + 2, text.col])
      const img = unsixel(m![3]!)
      assert.deepEqual([img.width, img.height], [200, 100])
      assert.deepEqual([...img.data.slice(0, 3)], [255, 0, 0])
      assert.deepEqual([...img.data.slice(199 * 4, 199 * 4 + 3)], [0, 0, 255])
      // Later frames step over its cells and draw it no more.
      await app.hover('Here is the chart.')
      await app.hover('[image: sales by month]')
      await app.settle()
      assert.equal([...app.output().matchAll(/\x1bP0;1;0q/g)].length, 1)
      assert.match(app.output(), /\x1b\[20C/)
      // The caption opens the file in the system's viewer.
      await app.click('[image: sales by month]')
      await app.waitFor('Opening the image…')
      const opened = () => app.read('open.log') + app.read('notify.log')
      const until = Date.now() + WAIT_MS
      while (!opened().includes('chart.png') && Date.now() < until) await new Promise(r => setTimeout(r, 50))
      assert.match(opened(), /chart\.png/)
    }))

  test('iTerm2: OSC 1337 File at its cells, 20 × 5', () =>
    withApp({ env: env('iterm'), setup }, async app => {
      await app.send('show me a chart')
      await app.waitIdle('[image: sales by month]')
      const text = where(app, 'Here is the chart.')
      const [m] = await waitOutput(app, /\x1b\[(\d+);(\d+)H\x1b\]1337;File=inline=1;size=(\d+);width=20;height=5;preserveAspectRatio=1;doNotMoveCursor=1:([A-Za-z0-9+/=]+)\x07/g)
      assert.deepEqual([Number(m![1]), Number(m![2])], [text.row + 2, text.col])
      assert.equal(Buffer.from(m![4]!, 'base64').length, Number(m![3]))
    }))

  test('kitty: the PNG sent once, placed over 20 × 5 cells', () =>
    withApp({ env: env('kitty'), setup }, async app => {
      await app.send('show me a chart')
      await app.waitIdle('[image: sales by month]')
      const text = where(app, 'Here is the chart.')
      await waitOutput(app, /\x1b_Ga=t,f=100,t=d,i=\d+,q=2/g)
      const [m] = await waitOutput(app, /\x1b\[(\d+);(\d+)H(?:\x1b_G[^\x1b]*\x1b\\)*\x1b_Ga=p,i=\d+,p=1,c=20,r=5,C=1,q=2\x1b\\/g)
      assert.deepEqual([Number(m![1]), Number(m![2])], [text.row + 2, text.col])
    }))

  test('off (inside tmux): a link in the words, no rows kept, nothing asked of the terminal or drawn', () =>
    withApp({ setup }, async app => {
      await app.send('show me a chart')
      const s = await app.waitIdle('[image: sales by month]')
      assert.match(s, /Here is the chart\./)
      assert.equal(where(app, '[image: sales by month]').row - where(app, 'Here is the chart.').row, 2)
      const out = app.output()
      assert.doesNotMatch(out, /\x1bP0;1;0q|\x1b\]1337;File|\x1b_G|\x1b\[16t|\x1b\[c/)
    }))

  test('a Mermaid block: drawn by mmdc into the cache, shown in place of the code, ⧉ copy beside it', () =>
    withApp({
      env: env('sixel'),
      setup: ({ dir }) => {
        chart(join(dir, 'diagram.png'))
        // A fake mmdc: logs its arguments, and "draws" the diagram by copying a PNG to its -o.
        const mmdc = join(dir, 'bin', 'mmdc')
        writeFileSync(mmdc, `#!/usr/bin/env bash\necho "$*" >> '${dir}/mmdc.log'\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && cp '${dir}/diagram.png' "$2"; shift; done\n`)
        chmodSync(mmdc, 0o755)
      },
    }, async app => {
      await app.send('draw a diagram')
      await app.waitIdle('[image: diagram]  ⧉ copy')
      assert.doesNotMatch(app.screen(), /graph TD/)
      assert.match(app.read('mmdc.log'), /-t dark -b transparent/)
      await waitOutput(app, /\x1bP0;1;0q"1;1;200;100/g)
      await app.click('⧉ copy', { area: 'chat' })
      await app.waitClipboard('graph TD\n  A --> B')
    }))
})
