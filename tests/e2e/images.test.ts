// The images you send: a click on [image N] (in your bubble, the panel, a request's view, a held
// message, after a resume) opens that image in the system's viewer, or says the file is gone.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { keyOf } from '../../hooks/model.ts'
import { withApp, WAIT_MS, writeSession } from './harness.ts'
import type { App } from './harness.ts'

/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

/** Whether the app takes this machine for WSL (as it does: WSL_DISTRO_NAME, or a Microsoft kernel). */
const isWsl = (env: Record<string, string> = {}) => !!env.WSL_DISTRO_NAME || /microsoft/i.test((() => { try { return readFileSync('/proc/version', 'utf8') } catch { return '' } })())

/** What the app asked to open a file with: PowerShell's Start-Process (WSL), open or xdg-open (logged by the fakes). */
const opened = (app: App) =>
  [...app.read('notify.log').split('\n').filter(l => l.includes('Start-Process')), ...app.read('open.log').split('\n').filter(Boolean)].map(l => l.replace(`${app.dir}/bin/`, ''))

/** The line that opens `path` on this machine: Start-Process with its Windows path (the fake wslpath's), else xdg-open. */
const opener = (path: string, wsl: boolean) =>
  wsl ? `powershell.exe -NoProfile -Command Start-Process -FilePath '\\\\wsl.localhost\\Fake${path.replace(/\//g, '\\').replace(/'/g, "''")}'` : `xdg-open ${path}`

/** Waits until the app has asked to open files `n` times; returns those requests. */
async function waitOpened(app: App, n: number): Promise<string[]> {
  const until = Date.now() + WAIT_MS
  while (Date.now() < until) {
    const l = opened(app)
    if (l.length >= n) return l
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`Opened ${opened(app).length} times, not ${n}:\n${opened(app).join('\n')}`)
}

/** Pastes an image file's path into the box: it goes with the next message as [image N]. */
async function attach(app: App, path: string) {
  app.raw(`\x1b[200~${path}\x1b[201~`)
  await app.waitFor('Image added: it goes with your next message.')
}

describe('images', () => {
  test('on WSL a click on [image 1] opens it on Windows (its wslpath -w path), from the bubble, the panel and the request; a gone one says so', () => {
    const env = { WSL_DISTRO_NAME: 'Fake' }
    return withApp({ env, unfocused: true }, async app => {
      // A quote in the name: PowerShell gets it doubled, inside its single quotes.
      const pic = join(app.work, "it's here.png")
      writeFileSync(pic, PNG)
      await attach(app, pic)
      app.type('remember this')
      app.keys('Enter')
      await app.waitFor('I got 1 image(s).')
      // A link, as the app's links are: blue (75) and underlined.
      assert.match(app.read('output.log'), /;4;38;5;75[;\d]*m\[image/)
      await app.click('[image 1] remember', { area: 'chat' })
      await app.waitFor('Opening image 1…')
      assert.deepEqual(await waitOpened(app, 1), [opener(pic, true)])
      // From the panel's list of your messages too.
      await app.click('[image 1] remember', { area: 'panel' })
      assert.equal((await waitOpened(app, 2))[1], opener(pic, true))
      // The request's view (its status mark in the panel): its header and the bubble in its chain.
      await app.click('✓ [image 1] remember', { area: 'panel' })
      await app.waitFor('▣ Request T1')
      await app.click('[image 1] remember', { area: 'chat', nth: 1 })
      assert.equal((await waitOpened(app, 3))[2], opener(pic, true))
      await app.click('[image 1] remember', { area: 'chat' })
      assert.equal((await waitOpened(app, 4))[3], opener(pic, true))
      // The file deleted since: a toast says so, and nothing is opened. (A cell over from the bubble's
      // last click: the same cell again so soon would be a double-click.)
      rmSync(pic)
      await app.click('[image 1] remember', { area: 'chat', nth: 1, dx: 3 })
      await app.waitFor(`Image 1 is gone: ${pic} isn't there anymore.`)
      await app.settle()
      assert.equal(opened(app).length, 4)
    })
  })

  test('after a resume, and on a held message, [image N] opens with the system viewer (xdg-open off WSL)', () => {
    const text = '[image 1] what was this'
    let old = ''
    return withApp({
      args: ['--resume', 'img-1'],
      env: { CLUED_HOLD_MS: '60000' },
      ready: 'It is a cat.',
      setup: ({ home, work }) => {
        old = join(work, 'old.png')
        writeFileSync(old, PNG)
        writeSession(home, work, 'img-1', [
          { type: 'user', timestamp: new Date(Date.now() - 60_000).toISOString(), message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }, { type: 'text', text }] } },
          { type: 'assistant', timestamp: new Date(Date.now() - 50_000).toISOString(), message: { content: [{ type: 'text', text: 'It is a cat.' }] } },
        ])
        // What the app kept for it: the file the image was sent from.
        mkdirSync(join(home, '.clued', 'sessions'), { recursive: true })
        writeFileSync(join(home, '.clued', 'sessions', 'img-1.json'), JSON.stringify({ board: {}, reactions: {}, links: {}, images: { [keyOf(text)]: [old] } }))
      },
    }, async app => {
      const wsl = isWsl()
      await app.click('[image 1] what', { area: 'chat' })
      assert.deepEqual(await waitOpened(app, 1), [opener(old, wsl)])
      // A message held back (/hold) shows its image as a link already.
      const pic = join(app.work, 'new.png')
      writeFileSync(pic, PNG)
      await attach(app, pic)
      app.type('and this one')
      app.keys('Enter')
      await app.waitFor('◌ sending in')
      await app.click('[image 1] and this', { area: 'chat' })
      assert.equal((await waitOpened(app, 2))[1], opener(pic, wsl))
    })
  })
})
