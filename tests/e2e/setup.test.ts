// /setup: a view in the chat's place with each optional extra's status; one installed after a yes,
// against fakes (npm, reg.exe, cmd.exe, a settings.json under a temp %LOCALAPPDATA%); Esc back. And
// the one-time hints: a mermaid block with no mmdc, Arabic in Windows Terminal with no font for it.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rowOf, withApp } from './harness.ts'

const script = (path: string, body: string) => {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(path, 0o755)
}

/** A fake npm: `prefix -g` says <dir>/npm; `i -g …` logs, prints a line, and leaves an mmdc that draws nothing. */
const fakeNpm = (dir: string) =>
  script(join(dir, 'bin', 'npm'), [
    `echo "npm $*" >> '${dir}/npm.log'`,
    `[ "$1" = prefix ] && { echo '${dir}/npm'; exit 0; }`,
    'echo "added 1 package in 1s"',
    `printf '#!/bin/sh\\necho "$*" >> ${dir}/mmdc.log\\n' > '${dir}/bin/mmdc'`,
    `chmod +x '${dir}/bin/mmdc'`,
  ].join('\n'))

const SETTINGS = ['win', 'Local', 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState']
const WT_JSON = '{\n    // mine\n    "profiles": {\n        "defaults": {\n            "font": {\n                "face": "Consolas"\n            }\n        },\n        "list": []\n    }\n}\n'

describe('/setup', () => {
  test('the extras and their statuses; the diagram tool installed after a yes, with its steps shown; Esc back', () =>
    withApp({ isolatePath: true, env: { CLUED_IMAGES: 'sixel' }, setup: ({ dir }) => fakeNpm(dir) }, async app => {
      // A mermaid block with no mmdc: once, the note under it says what to do.
      await app.send('draw a diagram')
      let s = await app.waitIdle('Diagrams need mmdc: /setup installs the diagram tool')
      assert.match(s, /graph TD/)
      await app.waitFor(() => /"hints":\["diagrams"\]/.test(app.read('home/.clued/panel.json')))
      await app.send('/setup')
      s = await app.waitFor('ℹ Inline images')
      assert.match(rowOf(s, '← back'), /← back {2}⚙ Setup · optional extras/)
      assert.match(s, /The optional extras clued uses\. ↑↓ choose · Enter install · Esc back/)
      assert.match(rowOf(s, 'Diagrams  '), /▸ — Diagrams {12}Diagrams in replies need mmdc: Mermaid blocks show as code/)
      assert.match(rowOf(s, 'Arabic font'), /· Arabic font {9}Only for Windows Terminal, from WSL/)
      assert.match(rowOf(s, 'Inline images'), /ℹ Inline images {7}This terminal gets Sixel \(CLUED_IMAGES\)/)
      assert.match(s, /Setup: ↑↓ choose · Enter install · Esc back to chat/)
      assert.ok(!s.includes('graph TD'), 'the chat is not drawn under it')
      // Enter on the diagram tool: what it does, and nothing run yet but npm prefix.
      app.keys('Enter')
      s = await app.waitFor('Install the diagram tool (mmdc)?')
      assert.match(s, /• Runs: npm i -g @mermaid-js\/mermaid-cli/)
      assert.match(s, /• Downloads about 150 MB: mmdc, and the headless Chromium/)
      assert.match(s, /Install \(y\) {4}Cancel \(n\)/)
      assert.equal(app.read('npm.log'), 'npm prefix -g\n')
      // n: nothing installed; again, and y.
      app.type('n')
      await app.waitFor('Nothing installed.')
      await app.waitGone('Install the diagram tool (mmdc)?')
      app.keys('Enter')
      await app.waitFor('Install the diagram tool (mmdc)?')
      app.type('y')
      s = await app.waitFor(s => s.includes('✓ Diagrams: mmdc is installed') && /✓ Diagrams {12}mmdc is on PATH/.test(s))
      assert.match(s, /added 1 package in 1s/)
      assert.match(app.read('npm.log'), /^npm prefix -g\nnpm prefix -g\nnpm i -g @mermaid-js\/mermaid-cli\n$/)
      // Esc: back to the chat, the result there too, and the diagram tried at once with the new mmdc.
      app.keys('Escape')
      s = await app.waitFor('setup · Diagrams: installed')
      assert.ok(!s.includes('⚙ Setup'))
      await app.waitFor("⚠ couldn't draw the diagram: it made no image")
      assert.match(app.read('mmdc.log'), /-b transparent/)
    }))

  test('a hint shown before is not shown again', () =>
    withApp({ isolatePath: true, setup: ({ home }) => { mkdirSync(join(home, '.clued'), { recursive: true }); writeFileSync(join(home, '.clued', 'panel.json'), '{"hints":["diagrams"]}') }, env: { CLUED_IMAGES: 'sixel' } }, async app => {
      await app.send('draw a diagram')
      const s = await app.waitIdle('That is it.')
      assert.match(s, /graph TD/)
      assert.ok(!s.includes('/setup installs'))
    }))

  test('in Windows Terminal: Arabic hints at /setup once; the font face set after a yes, settings.json backed up, its comment kept', () =>
    withApp({
      isolatePath: true,
      env: { WT_SESSION: 'fake-session', WSL_DISTRO_NAME: 'Fake' },
      setup: ({ dir }) => {
        mkdirSync(join(dir, ...SETTINGS), { recursive: true })
        writeFileSync(join(dir, ...SETTINGS, 'settings.json'), WT_JSON)
        // The registry: Windows' own fonts (Simplified Arabic Fixed among them), no per-user ones, no click handler; adds logged.
        script(join(dir, 'bin', 'reg.exe'), [
          `printf '%s\\n' "reg.exe $*" >> '${dir}/reg.log'`,
          'case "$1 $2" in',
          `  'query HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts') printf '\\r\\nHKEY_LOCAL_MACHINE\\\\Fonts\\r\\n    Courier New (TrueType)    REG_SZ    cour.ttf\\r\\n    Simplified Arabic Fixed (TrueType)    REG_SZ    simpfxo.ttf\\r\\n' ;;`,
          "  query*) echo 'ERROR: The system was unable to find the specified registry key or value.' >&2; exit 1 ;;",
          'esac',
          'exit 0',
        ].join('\n'))
      },
    }, async app => {
      // Arabic shows, and the face has no Cascadia Mono NF: a note in the chat, once.
      await app.send('مرحبا')
      let s = await app.waitFor('open /setup')
      assert.match(s, /setup · Arabic in Windows Terminal/)
      assert.match(s, /“Consolas”: \/setup installs Cascadia Mono NF and sets the font face\./)
      await app.waitFor(() => /"hints":\["arabic"\]/.test(app.read('home/.clued/panel.json')))
      await app.send('/setup')
      s = await app.waitFor('ℹ Inline images')
      assert.match(rowOf(s, 'Arabic font'), /— Arabic font {9}Arabic in Windows Terminal needs Cascadia Mono NF/)
      assert.match(rowOf(s, 'Font face'), /— Font face {11}“Consolas” has no Arabic: the face should be Cascadia/)
      // Inside the tests' tmux: no images.
      assert.match(rowOf(s, 'Inline images'), /ℹ Inline images {7}None, so images and diagrams are links/)
      // 3: the font face. It says what it replaces, and where.
      app.type('3')
      s = await app.waitFor('Replace your font face “Consolas”?')
      // Its steps wrap in the view: what it changes, read as one text.
      const flat = s.split('\n').map(l => l.slice(l.indexOf('│') + 1).trim()).join(' ')
      assert.match(flat, /profiles\.defaults\.font\.face from “Consolas” to “Cascadia Mono NF, Simplified Arabic Fixed”/)
      assert.match(flat, /settings\.json\.bak-clued-\d{4}-\d\d-\d\d first/)
      assert.match(s, /⚠ Cascadia Mono NF isn't installed yet/)
      assert.match(s, /Replace \(y\) {4}Cancel \(n\)/)
      app.type('y')
      s = await app.waitFor(s => /✓ Font face {11}Windows Terminal draws with “Cascadia Mono NF, Simplified/.test(s))
      const after = app.read(join(...SETTINGS, 'settings.json'))
      assert.equal(after, WT_JSON.replace('"Consolas"', '"Cascadia Mono NF, Simplified Arabic Fixed"'))
      const day = new Date()
      const stamp = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
      assert.equal(app.read(join(...SETTINGS, `settings.json.bak-clued-${stamp}`)), WT_JSON)
      // No registry change for the face, and no PowerShell for any of it.
      assert.doesNotMatch(app.read('reg.log'), /add HKCU\\Software\\Microsoft\\Windows NT/)
      app.keys('Escape')
      await app.waitFor('setup · Font face: installed')
    }))
})
