// /setup and `clued setup` (app/setup.ts, app/setup-cli.ts), against a fake system: a fake Windows
// (cmd.exe, wslpath, reg.exe answer as told, files live in a map), a fake npm, a zip served by
// ranges from memory, and a temp PATH. Nothing here touches the real registry, fonts, Windows
// Terminal settings, ~/.clued or npm.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import { Renders } from '../../app/diagrams.ts'
import { FOCUS_PS, FOCUS_VERSION, HANDLER_KEY } from '../../app/notify.ts'
import type { Ran } from '../../app/notify.ts'
import {
  backupName, CASCADIA, detectWsl, dirs, exec, faceAt, FACE_ARABIC, FACE_COURIER, faceHasCascadia, faceIsGood, fontNames, httpRange, imagesStatus, installedFonts,
  MACHINE_FONTS_KEY, moveAt, NPM_ARGS, plan, runLines, statuses, systemIo, USER_FONTS_KEY, viewLines, wtFace,
} from '../../app/setup.ts'
import type { Plan, Release, SetupIo, View } from '../../app/setup.ts'
import { main } from '../../app/setup-cli.ts'
import { parse } from '../../app/jsonc.ts'
import { makeZip } from './zip-make.ts'

const ok = (stdout = ''): Ran => ({ ok: true, code: 0, stdout, stderr: '' })
const fail = (stderr: string, code: number | string = 1): Ran => ({ ok: false, code, stdout: '', stderr })
const LOCAL = 'D:\\Data\\u\\AppData\\Local'
const HERE = '/tmp/fake-win/Local'
const STABLE = `${HERE}/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json`
const PREVIEW = `${HERE}/Packages/Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe/LocalState/settings.json`
const FONTS = `${HERE}/Microsoft/Windows/Fonts`

/** What reg.exe query prints for a key's values. */
const regList = (key: string, names: string[]) => `\r\n${key.replace('HKCU', 'HKEY_CURRENT_USER').replace('HKLM', 'HKEY_LOCAL_MACHINE')}\r\n${names.map(n => `    ${n}    REG_SZ    x.ttf\r\n`).join('')}\r\n`

/** Two small "fonts" in a zip, and a release pinned to them, as CASCADIA is to the real ones. */
function release(): { rel: Release; zip: Buffer } {
  const a = Buffer.from('regular font bytes '.repeat(50))
  const b = Buffer.from('italic font bytes '.repeat(40))
  const zip = makeZip([{ name: 'ttf/other.ttf', data: Buffer.from('no') }, { name: 'ttf/CascadiaMonoNF.ttf', data: a }, { name: 'ttf/CascadiaMonoNFItalic.ttf', data: b }])
  const h = (x: Buffer) => createHash('sha256').update(x).digest('hex')
  return {
    zip,
    rel: {
      ...CASCADIA,
      url: 'https://example.test/c.zip',
      zipSize: zip.length,
      files: [
        { ...CASCADIA.files[0]!, size: a.length, sha256: h(a) },
        { ...CASCADIA.files[1]!, size: b.length, sha256: h(b) },
      ],
    },
  }
}

type FakeOpts = {
  wt?: boolean
  env?: NodeJS.ProcessEnv
  userFonts?: string[] | null
  machineFonts?: string[]
  machineFails?: boolean
  add?: (args: string[]) => Ran
  cmd?: Ran[]
  files?: Record<string, string | Uint8Array>
  writeFails?: (path: string) => string | undefined
  zip?: Buffer
  npmPrefix?: Ran
  npmInstall?: (bin: string) => Ran
  writable?: boolean
  handler?: boolean
}

function fake(o: FakeOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'clued-setup-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const calls: string[][] = []
  const files = new Map<string, string | Uint8Array>(Object.entries(o.files ?? {}))
  const cmds = [...(o.cmd ?? [])]
  const said: string[] = []
  const io: SetupIo = {
    exec: async (cmd, args) => {
      calls.push([cmd, ...args])
      if (cmd === 'cmd.exe') return cmds.shift() ?? ok(`${LOCAL};C:\\WINDOWS\r\n`)
      if (cmd === 'wslpath') return ok(`${HERE}\n`)
      if (cmd === 'npm') return o.npmPrefix ?? ok('/tmp/fake-npm\n')
      if (cmd === 'reg.exe' && args[0] === 'query') {
        if (args[1] === USER_FONTS_KEY) return o.userFonts === null ? fail('ERROR: The system was unable to find the specified registry key or value.') : ok(regList(USER_FONTS_KEY, o.userFonts ?? []))
        if (args[1] === MACHINE_FONTS_KEY) return o.machineFails ? fail('reg.exe: Invalid argument', 'EINVAL') : ok(regList(MACHINE_FONTS_KEY, o.machineFonts ?? ['Courier New (TrueType)', 'Simplified Arabic Fixed (TrueType)']))
        if (args[1] === HANDLER_KEY) return o.handler ? ok(`    CluedVersion    REG_SZ    ${FOCUS_VERSION}\r\n`) : fail('ERROR: The system was unable to find the specified registry key or value.')
      }
      if (cmd === 'reg.exe' && args[0] === 'add') return o.add?.(args) ?? ok('The operation completed successfully.')
      throw new Error(`unexpected ${cmd} ${args.join(' ')}`)
    },
    run: async (cmd, args, line) => {
      calls.push([cmd, ...args])
      line('added 300 packages in 40s')
      return o.npmInstall?.(bin) ?? ok()
    },
    read: p => {
      const f = files.get(p)
      return typeof f === 'string' ? f : f ? Buffer.from(f).toString('utf8') : undefined
    },
    bytes: p => {
      const f = files.get(p)
      return typeof f === 'string' ? Buffer.from(f) : f
    },
    write: (p, d) => {
      const e = o.writeFails?.(p)
      if (e) throw Object.assign(new Error(e), { code: e })
      files.set(p, d)
    },
    remove: p => void files.delete(p),
    exists: p => files.has(p),
    writable: () => o.writable ?? true,
    range: async (url, from, to) => {
      calls.push(['range', url, `${from}-${to}`])
      if (!o.zip) throw new Error('the server answered 200, not the part of the file asked for')
      return new Uint8Array(o.zip.subarray(from, to + 1))
    },
    now: () => new Date(2026, 10, 26, 9, 30),
    isWsl: true,
    env: { PATH: bin, ...(o.wt === false ? {} : { WT_SESSION: 'abc' }), ...o.env },
  }
  return { io, calls, files, bin, said, done: () => rmSync(dir, { recursive: true, force: true }) }
}

const mmdcIn = (bin: string) => {
  writeFileSync(join(bin, 'mmdc'), '#!/bin/sh\n')
  chmodSync(join(bin, 'mmdc'), 0o755)
}

/** A plan that can be run, or a failed test. */
function runnable(p: Plan): Extract<Plan, { id: string }> {
  if ('error' in p) assert.fail(`no plan: ${p.error}`)
  return p
}

const WT_JSON = `// generated by Windows Terminal
{
    "$help": "https://aka.ms/terminal-documentation",
    "defaultProfile": "{b}",
    "profiles":
    {
        "defaults":
        {
            "font":
            {
                "face": "Consolas"
            }
        },
        "list":
        [
            { "guid": "{a}", "name": "PowerShell" },
            { "guid": "{b}", "name": "Ubuntu", "font": { "face": "Fira Code" } }
        ]
    }
}
`

describe('setup: statuses', () => {
  test('outside Windows Terminal: diagrams by mmdc on PATH, the Windows ones not for here, images by the terminal', async () => {
    const f = fake({ wt: false })
    try {
      let s = await statuses(f.io)
      assert.deepEqual(s.map(x => [x.id, x.state]), [['diagrams', 'missing'], ['font', 'na'], ['face', 'na'], ['notify', 'na'], ['images', 'info']])
      assert.equal(s[0]!.text, 'Diagrams in replies need mmdc: Mermaid blocks show as code')
      assert.equal(s[1]!.text, 'Only for Windows Terminal, from WSL')
      mmdcIn(f.bin)
      s = await statuses(f.io, { protocol: 'kitty' })
      assert.equal(s[0]!.state, 'ok')
      assert.equal(s[0]!.text, `mmdc is on PATH (${join(f.bin, 'mmdc')})`)
      assert.equal(s[4]!.text, 'This terminal gets the kitty graphics protocol')
      // Not a single Windows program asked.
      assert.deepEqual(f.calls, [])
      assert.equal(await wtFace(f.io), undefined)
    } finally {
      f.done()
    }
  })

  test('in Windows Terminal: the font from the registry, the face from settings.json (this profile\'s own first), the click handler', async () => {
    const f = fake({ files: { [STABLE]: WT_JSON }, env: { WT_PROFILE_ID: '{B}' } })
    try {
      let s = await statuses(f.io)
      assert.deepEqual(s.map(x => [x.id, x.state, x.text]).slice(1, 4), [
        ['font', 'missing', 'Arabic in Windows Terminal needs Cascadia Mono NF: Windows\' own Cascadia has no Arabic'],
        ['face', 'missing', '“Fira Code” has no Arabic: the face should be Cascadia Mono NF'],
        ['notify', 'missing', 'A click on a notification opens its tab once the click handler is set up'],
      ])
      // %LOCALAPPDATA% asked once for the font and the face; the click handler asks its own, after.
      assert.equal(f.calls.filter(c => c[0] === 'cmd.exe').length, 2)
      assert.equal(await wtFace(f.io), 'Fira Code')
    } finally {
      f.done()
    }
    const g = fake({ userFonts: ['Cascadia Mono NF (TrueType)'], handler: true, files: { [PREVIEW]: WT_JSON.replace('"Consolas"', `"${FACE_ARABIC}"`), [`${HERE}/clued/focus.ps1`]: FOCUS_PS } })
    try {
      const s = await statuses(g.io)
      assert.deepEqual(s.map(x => [x.id, x.state, x.text]).slice(1, 4), [
        ['font', 'ok', 'Cascadia Mono NF is installed'],
        ['face', 'ok', `Windows Terminal draws with “${FACE_ARABIC}”`],
        ['notify', 'ok', `A click on a notification opens its tab (${LOCAL}\\clued\\focus.ps1)`],
      ])
    } finally {
      g.done()
    }
  })

  test('the face: Cascadia alone wants a second font; none set is the default font; old fontFace counts; errors say why', async () => {
    const cases: [string, string, string][] = [
      ['{"profiles": {"defaults": {"font": {"face": "Cascadia Mono NF"}}}}', 'missing', '“Cascadia Mono NF”: a second font after it makes لا join the letter before it'],
      ['{"profiles": {"defaults": {}}}', 'missing', 'Windows Terminal\'s default font has no Arabic: the face should be Cascadia Mono NF'],
      ['{"profiles": {"defaults": {"fontFace": "Cascadia Mono NF, Courier New"}}}', 'ok', 'Windows Terminal draws with “Cascadia Mono NF, Courier New”'],
      ['{"profiles": [{"name": "x"}]}', 'error', `${LOCAL}\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json: its "profiles" is a list (a settings.json from before Windows Terminal 1.0): set the font face in Windows Terminal's Settings instead`],
      ['{"profiles": 3}', 'error', `${LOCAL}\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json: "profiles" is not an object`],
      ['{\n  "profiles": {\n    "defaults": {,}\n  }\n}', 'error', `could not read ${LOCAL}\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json: expected a key in quotes (line 3). Left it as it is`],
    ]
    for (const [json, state, text] of cases) {
      const f = fake({ files: { [STABLE]: json } })
      try {
        const s = (await statuses(f.io))[2]!
        assert.deepEqual([s.state, s.text], [state, text], json)
      } finally {
        f.done()
      }
    }
    // No settings.json at all; the unpackaged one is found; cmd.exe failing twice; reg.exe blocked.
    let f = fake()
    assert.equal((await statuses(f.io))[2]!.text, `no Windows Terminal settings.json under ${LOCAL}`)
    f = fake({ files: { [`${HERE}/Microsoft/Windows Terminal/settings.json`]: '{}' } })
    assert.equal((await statuses(f.io))[2]!.state, 'missing')
    f = fake({ cmd: [fail('<3>WSL ERROR: UtilAcceptVsock: accept4 failed 110'), fail('<3>WSL ERROR: UtilAcceptVsock: accept4 failed 110')] })
    assert.equal((await statuses(f.io))[2]!.text, 'could not find %LOCALAPPDATA% through cmd.exe (<3>WSL ERROR: UtilAcceptVsock: accept4 failed 110)')
    // Once only: the second try works.
    f = fake({ cmd: [fail('<3>WSL ERROR: UtilAcceptVsock: accept4 failed 110')], files: { [STABLE]: '{}' } })
    assert.equal((await statuses(f.io))[2]!.state, 'missing')
    assert.equal(dirs(f.io), dirs(f.io))
    f = fake({ machineFails: true })
    assert.deepEqual((await statuses(f.io))[1], { id: 'font', name: 'Arabic font', state: 'error', text: 'reg.exe could not read the fonts (reg.exe: Invalid argument)' })
    // No per-user fonts key at all: no per-user fonts.
    f = fake({ userFonts: null, machineFonts: ['Cascadia Mono NF Regular (TrueType)'] })
    assert.equal((await statuses(f.io))[1]!.state, 'ok')
    assert.deepEqual(await installedFonts(f.io), ['Cascadia Mono NF Regular (TrueType)'])
  })

  test('the face lists, and the font names reg.exe prints', () => {
    assert.ok(faceHasCascadia('Cascadia Mono NF'))
    assert.ok(faceHasCascadia('Kawkab Mono, cascadia mono nf '))
    assert.ok(!faceHasCascadia('Cascadia Mono'))
    assert.ok(!faceHasCascadia('Cascadia Mono NF Bold'))
    assert.ok(faceIsGood(FACE_ARABIC) && faceIsGood(FACE_COURIER))
    assert.ok(!faceIsGood('Cascadia Mono NF, '))
    assert.deepEqual(fontNames(regList(USER_FONTS_KEY, ['Cascadia Mono NF (TrueType)', 'A B'])), ['Cascadia Mono NF (TrueType)', 'A B'])
  })

  test('images: the protocol, and what to do when there is none', () => {
    assert.equal(imagesStatus({ TERM_PROGRAM: 'iTerm.app' }).text, 'This terminal gets iTerm2\'s inline images')
    assert.equal(imagesStatus({ CLUED_IMAGES: 'sixel' }).text, 'This terminal gets Sixel (CLUED_IMAGES)')
    assert.equal(imagesStatus({}).text, 'clued asks the terminal whether it draws Sixel as it starts: see /setup inside clued')
    assert.equal(imagesStatus({ TMUX: '/tmp/x' }).text, 'None, so images and diagrams are links that open in your viewer: tmux and screen don\'t pass images through: run clued outside them')
    assert.equal(imagesStatus({ CLUED_IMAGES: 'off' }).text, 'None, so images and diagrams are links that open in your viewer: CLUED_IMAGES turns them off')
    assert.equal(imagesStatus({ TERM_PROGRAM: 'Apple_Terminal' }).text, 'None, so images and diagrams are links that open in your viewer: this terminal draws none: iTerm2, WezTerm, kitty, Ghostty and Windows Terminal 1.22+ do')
    assert.equal(imagesStatus({}, 'off').state, 'info')
  })
})

describe('setup: the diagram tool', () => {
  test('says what npm does, runs npm i -g, and finds mmdc after', async () => {
    const f = fake({ wt: false, npmInstall: bin => (mmdcIn(bin), ok()) })
    try {
      const p = runnable(await plan(f.io, 'diagrams'))
      assert.deepEqual(p.steps, [
        'Runs: npm i -g @mermaid-js/mermaid-cli',
        'Downloads about 150 MB: mmdc, and the headless Chromium it draws with (Puppeteer keeps it in ~/.cache/puppeteer).',
        'Writes to npm\'s global folder: /tmp/fake-npm',
      ])
      assert.equal(p.warn, undefined)
      const lines: string[] = []
      const r = await p.run(l => lines.push(l))
      assert.deepEqual(r, { ok: true, text: `Diagrams: mmdc is installed (${join(f.bin, 'mmdc')}). The next Mermaid block is drawn.` })
      assert.deepEqual(lines, ['npm i -g @mermaid-js/mermaid-cli', 'added 300 packages in 40s'])
      assert.deepEqual(f.calls, [['npm', 'prefix', '-g'], ['npm', ...NPM_ARGS]])
    } finally {
      f.done()
    }
  })

  test('a folder npm can\'t write to is said before; npm failing, missing, or mmdc off PATH', async () => {
    let f = fake({ wt: false, writable: false, files: { '/tmp/fake-npm/lib': '' } })
    let p = runnable(await plan(f.io, 'diagrams'))
    assert.equal(p.warn, '/tmp/fake-npm/lib isn\'t writable by you, so npm will fail. Run sudo npm i -g @mermaid-js/mermaid-cli yourself, or give npm a folder of yours first (npm config set prefix ~/.local).')
    f = fake({ wt: false, npmInstall: () => fail('npm ERR! code EACCES\nnpm ERR! permission denied') })
    p = runnable(await plan(f.io, 'diagrams'))
    assert.deepEqual(await p.run(() => {}), { ok: false, text: 'npm failed: npm ERR! permission denied' })
    f = fake({ wt: false })
    p = runnable(await plan(f.io, 'diagrams'))
    assert.deepEqual(await p.run(() => {}), { ok: true, text: 'npm installed mmdc in /tmp/fake-npm/bin, which isn\'t on your PATH: add it (export PATH="/tmp/fake-npm/bin:$PATH"), then /reload.' })
    f = fake({ wt: false, npmPrefix: fail('spawn npm ENOENT', 'ENOENT') })
    assert.deepEqual(await plan(f.io, 'diagrams'), { error: 'npm isn\'t working here (spawn npm ENOENT): it comes with Node' })
    assert.deepEqual(await plan(f.io, 'images'), { error: 'Nothing to install: it only says what this terminal can do' })
  })

  test('the app looks on PATH again after an install', () => {
    const f = fake({ wt: false })
    try {
      let changed = 0
      const r = new Renders(join(f.bin, 'cache'), () => changed++, { path: f.bin })
      assert.equal(r.hasMermaid, false)
      mmdcIn(f.bin)
      assert.equal(r.hasMermaid, false, 'it remembers what it found')
      r.rescan()
      assert.equal(r.hasMermaid, true)
      assert.equal(changed, 1)
    } finally {
      f.done()
    }
  })
})

describe('setup: Cascadia Mono NF', () => {
  test('two fonts by ranges, checked, copied to the user\'s fonts folder, registered with plain reg.exe', async () => {
    const { rel, zip } = release()
    const f = fake({ zip })
    const p = runnable(await plan(f.io, 'font', { release: rel }))
    assert.equal(p.title, 'Install Cascadia Mono NF, for your Windows user?')
    assert.deepEqual(p.steps, [
      'Downloads about 2.5 MB from github.com/microsoft/cascadia-code, release 2407.24: only the 2 Cascadia Mono NF fonts (0.0 MB unpacked) out of its 150 MB zip, each checked against its pinned SHA-256.',
      `Writes CascadiaMonoNF.ttf and CascadiaMonoNFItalic.ttf to ${LOCAL}\\Microsoft\\Windows\\Fonts`,
      `Adds 2 registry values under ${USER_FONTS_KEY}, with reg.exe: “Cascadia Mono NF Regular (TrueType)” and “Cascadia Mono NF Italic (TrueType)”`,
      'No admin rights, nothing for other users. Restart Windows Terminal afterwards to see the font.',
    ])
    const lines: string[] = []
    const r = await p.run(l => lines.push(l))
    assert.deepEqual(r, { ok: true, text: 'Cascadia Mono NF is installed. Restart Windows Terminal to see it, and set it as the font face (Font face, in /setup).' })
    for (const x of rel.files) assert.equal(createHash('sha256').update(f.files.get(`${FONTS}/${x.file}`)!).digest('hex'), x.sha256)
    assert.deepEqual(f.calls.filter(c => c[0] === 'reg.exe'), [
      ['reg.exe', 'add', USER_FONTS_KEY, '/v', 'Cascadia Mono NF Regular (TrueType)', '/t', 'REG_SZ', '/d', `${LOCAL}\\Microsoft\\Windows\\Fonts\\CascadiaMonoNF.ttf`, '/f'],
      ['reg.exe', 'add', USER_FONTS_KEY, '/v', 'Cascadia Mono NF Italic (TrueType)', '/t', 'REG_SZ', '/d', `${LOCAL}\\Microsoft\\Windows\\Fonts\\CascadiaMonoNFItalic.ttf`, '/f'],
    ])
    // No PowerShell, nothing encoded.
    assert.ok(!f.calls.some(c => /powershell|-enc/i.test(c.join(' '))))
    // The tail, then for each font its header and its bytes: never the whole zip.
    assert.equal(f.calls.filter(c => c[0] === 'range').length, 5)
    assert.equal(lines[0], 'Reading the release zip\'s list of files…')
    assert.match(lines[1]!, /^Downloading CascadiaMonoNF\.ttf \(0\.0 MB\)…$/)
    // Again: the fonts there are kept, only registered again.
    f.calls.length = 0
    const again: string[] = []
    assert.equal((await p.run(l => again.push(l))).ok, true)
    assert.deepEqual(again.filter(l => l.includes('there already')), ['CascadiaMonoNF.ttf is there already.', 'CascadiaMonoNFItalic.ttf is there already.'])
    assert.equal(f.calls.filter(c => c[0] === 'range').length, 1)
  })

  test('a font that isn\'t the pinned one, or anything failing, writes nothing more and says why', async () => {
    const { rel, zip } = release()
    const bad = { ...rel, files: [{ ...rel.files[0]!, sha256: '0'.repeat(64) }] }
    let f = fake({ zip })
    let r = await runnable(await plan(f.io, 'font', { release: bad })).run(() => {})
    assert.equal(r.ok, false)
    assert.match(r.text, /^CascadiaMonoNF\.ttf isn't the pinned one \(its SHA-256 is [0-9a-f]{64}\): nothing written\.$/)
    assert.equal(f.files.size, 0)
    assert.ok(!f.calls.some(c => c[0] === 'reg.exe'))
    f = fake()
    r = await runnable(await plan(f.io, 'font', { release: rel })).run(() => {})
    assert.deepEqual(r, { ok: false, text: 'Could not read https://example.test/c.zip: the server answered 200, not the part of the file asked for' })
    f = fake({ zip })
    r = await runnable(await plan(f.io, 'font', { release: { ...rel, files: [{ ...rel.files[0]!, entry: 'ttf/Nope.ttf' }] } })).run(() => {})
    assert.deepEqual(r, { ok: false, text: 'The release zip has no ttf/Nope.ttf.' })
    f = fake({ zip, writeFails: () => 'EBUSY' })
    r = await runnable(await plan(f.io, 'font', { release: rel })).run(() => {})
    assert.deepEqual(r, { ok: false, text: `Could not write ${LOCAL}\\Microsoft\\Windows\\Fonts\\CascadiaMonoNF.ttf (EBUSY): close Windows Terminal's other windows using it, or sign out and in, then try again.` })
    f = fake({ zip, writeFails: () => 'ENOSPC' })
    r = await runnable(await plan(f.io, 'font', { release: rel })).run(() => {})
    assert.deepEqual(r, { ok: false, text: `Could not write ${LOCAL}\\Microsoft\\Windows\\Fonts\\CascadiaMonoNF.ttf (ENOSPC).` })
    f = fake({ zip, add: () => fail('ERROR: Access is denied.') })
    r = await runnable(await plan(f.io, 'font', { release: rel })).run(() => {})
    assert.deepEqual(r, { ok: false, text: 'reg.exe add failed (ERROR: Access is denied.)' })
    // The bytes of one entry cut short.
    const cut = Buffer.from(zip)
    f = fake({ zip: cut })
    const short = { ...f.io, range: async (u: string, a: number, b: number) => (a > 0 && b - a !== 29 ? new Uint8Array(cut.subarray(a, a + 3)) : f.io.range(u, a, b)) }
    r = await runnable(await plan(short, 'font', { release: rel })).run(() => {})
    assert.match(r.text, /^Could not download CascadiaMonoNF(Italic)?\.ttf: ttf\/CascadiaMonoNF(Italic)?\.ttf came short/)
    // Outside Windows Terminal, or no %LOCALAPPDATA%.
    assert.deepEqual(await plan(fake({ wt: false }).io, 'font'), { error: 'Only for Windows Terminal, from WSL' })
    assert.deepEqual(await plan(fake({ cmd: [fail('x'), fail('x')] }).io, 'font'), { error: 'could not find %LOCALAPPDATA% through cmd.exe (x)' })
  })

  test('the pinned release is 2407.24, its two Cascadia Mono NF fonts by size and SHA-256', () => {
    assert.equal(CASCADIA.url, 'https://github.com/microsoft/cascadia-code/releases/download/v2407.24/CascadiaCode-2407.24.zip')
    assert.deepEqual(CASCADIA.files.map(f => [f.entry, f.size, f.sha256.length]), [['ttf/CascadiaMonoNF.ttf', 2_526_924, 64], ['ttf/CascadiaMonoNFItalic.ttf', 2_336_432, 64]])
  })
})

describe('setup: Windows Terminal\'s font face', () => {
  test('replaces a different face only after saying which, backs settings.json up first, keeps the rest', async () => {
    const f = fake({ files: { [STABLE]: WT_JSON } })
    const p = runnable(await plan(f.io, 'face'))
    assert.equal(p.title, 'Replace your font face “Consolas”?')
    assert.equal(p.replaces, 'Consolas')
    assert.deepEqual(p.steps, [
      `Changes ${LOCAL}\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json: profiles.defaults.font.face from “Consolas” to “${FACE_ARABIC}”`,
      'Simplified Arabic Fixed after Cascadia draws لا so it joins the letter before it (Cascadia has no lam-alef).',
      'Copies settings.json to settings.json.bak-clued-2026-11-26 first. Comments and the rest of the file stay as they are.',
      'Windows Terminal picks the change up at once.',
    ])
    assert.equal(p.warn, 'Cascadia Mono NF isn\'t installed yet: install the Arabic font too, or Windows Terminal draws with its own default.')
    const lines: string[] = []
    assert.deepEqual(await p.run(l => lines.push(l)), { ok: true, text: `Windows Terminal's font face is “${FACE_ARABIC}” (a copy of the old settings is settings.json.bak-clued-2026-11-26).` })
    assert.equal(f.files.get(`${STABLE}.bak-clued-2026-11-26`), WT_JSON)
    assert.equal(f.files.get(STABLE), WT_JSON.replace('"Consolas"', `"${FACE_ARABIC}"`))
    assert.deepEqual(lines, ['Copied settings.json to settings.json.bak-clued-2026-11-26', `Set the font face to “${FACE_ARABIC}”`])
    // Now it's done: nothing more to do.
    assert.deepEqual(await plan(f.io, 'face'), { error: `the font face is “${FACE_ARABIC}” already` })
  })

  test('Courier New when Simplified Arabic Fixed isn\'t there; the profile\'s own face; a new key in a file with comments', async () => {
    const f = fake({ machineFonts: ['Courier New (TrueType)'], userFonts: ['Cascadia Mono NF (TrueType)'], env: { WT_PROFILE_ID: '{b}' }, files: { [STABLE]: WT_JSON } })
    const p = runnable(await plan(f.io, 'face'))
    assert.equal(p.steps[0], `Changes ${LOCAL}\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json: font.face of the profile “Ubuntu” from “Fira Code” to “${FACE_COURIER}”`)
    assert.equal(p.steps[1], 'Courier New after Cascadia draws لا so it joins the letter before it (Cascadia has no lam-alef); Simplified Arabic Fixed would be better, and isn\'t installed.')
    assert.equal(p.warn, undefined)
    await p.run(() => {})
    assert.equal(f.files.get(STABLE), WT_JSON.replace('"Fira Code"', `"${FACE_COURIER}"`))
    // No face anywhere, comments in the file: a font object made in defaults, the comment kept.
    const commented = '{\n    // my settings\n    "profiles": {\n        "defaults": {\n            /* dark */ "colorScheme": "One Half Dark"\n        }\n    }\n}\n'
    const g = fake({ files: { [STABLE]: commented } })
    const q = runnable(await plan(g.io, 'face'))
    assert.equal(q.title, 'Set Windows Terminal\'s font face?')
    assert.equal(q.replaces, undefined)
    await q.run(() => {})
    const out = g.files.get(STABLE) as string
    assert.equal(out, '{\n    // my settings\n    "profiles": {\n        "defaults": {\n            /* dark */ "font": {\n                "face": "Cascadia Mono NF, Simplified Arabic Fixed"\n            },\n            "colorScheme": "One Half Dark"\n        }\n    }\n}\n')
    assert.equal(faceAt(parse(out), undefined) && (faceAt(parse(out), undefined) as any).face, FACE_ARABIC)
  })

  test('the backup never overwrites an earlier one; a file changed since, or unwritable, is left as it is', async () => {
    const f = fake({ files: { [STABLE]: WT_JSON, [`${STABLE}.bak-clued-2026-11-26`]: 'older', [`${STABLE}.bak-clued-2026-11-26-2`]: 'older 2' } })
    assert.equal(backupName(f.io, STABLE, f.io.now()), `${STABLE}.bak-clued-2026-11-26-3`)
    let p = runnable(await plan(f.io, 'face'))
    assert.match(p.steps[2]!, /settings\.json\.bak-clued-2026-11-26-3 first/)
    f.files.set(STABLE, WT_JSON.replace('Consolas', 'Hack'))
    assert.deepEqual(await p.run(() => {}), { ok: false, text: `${LOCAL}\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json changed since: open /setup again.` })
    assert.equal(f.files.get(`${STABLE}.bak-clued-2026-11-26`), 'older')
    assert.ok(!f.files.has(`${STABLE}.bak-clued-2026-11-26-3`))
    const g = fake({ files: { [STABLE]: WT_JSON }, writeFails: path => (path === STABLE ? 'EACCES' : undefined) })
    p = runnable(await plan(g.io, 'face'))
    assert.deepEqual(await p.run(() => {}), { ok: false, text: `Could not write ${LOCAL}\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json (EACCES).` })
    assert.equal(g.files.get(STABLE), WT_JSON)
    // Unreadable settings, or one whose face can't be set: nothing to plan.
    assert.match(String((await plan(fake({ files: { [STABLE]: '{"profiles": {' } }).io, 'face') as any).error), /^could not read .*settings\.json: expected a key in quotes \(line 1\)\. Left it as it is$/)
    assert.match(String((await plan(fake({ files: { [STABLE]: '{"profiles": {"defaults": {"font": 3}}}' } }).io, 'face') as any).error), /could not set the face in .*: profiles\.defaults\.font is not an object/)
    assert.deepEqual(await plan(fake({ wt: false }).io, 'face'), { error: 'Only for Windows Terminal, from WSL' })
    // A file that can't be read at all.
    const h = fake({ files: { [STABLE]: '{}' } })
    h.io.read = () => undefined
    assert.equal((await statuses(h.io))[2]!.text, `could not read ${LOCAL}\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json`)
  })
})

describe('setup: the notification click handler', () => {
  test('its status from the registry (or the app), set up by notify.ts', async () => {
    const f = fake()
    let p = runnable(await plan(f.io, 'notify'))
    assert.equal(p.steps.length, 3)
    assert.deepEqual(await p.run(() => {}), { ok: true, text: `The click handler is set up (${LOCAL}\\clued\\focus.ps1).` })
    assert.equal(f.files.get(`${HERE}/clued/focus.ps1`), FOCUS_PS)
    assert.ok(f.calls.some(c => c.join(' ').startsWith(`reg.exe add ${HANDLER_KEY}`)))
    const g = fake({ add: () => fail('ERROR: Access is denied.') })
    p = runnable(await plan(g.io, 'notify'))
    assert.deepEqual(await p.run(() => {}), { ok: false, text: 'Could not set up the click handler: reg.exe add failed (ERROR: Access is denied.)' })
    // The app's own word on it, and its own way of setting it up.
    const hooks = { status: () => ({ id: 'notify' as const, name: 'Notification click', state: 'ok' as const, text: 'from the app' }), install: async () => ({ ok: true, text: 'the app did it' }) }
    assert.equal((await statuses(g.io, { notify: hooks }))[3]!.text, 'from the app')
    assert.deepEqual(await runnable(await plan(g.io, 'notify', { notify: hooks })).run(() => {}), { ok: true, text: 'the app did it' })
    assert.equal((await statuses(fake({ cmd: [fail('x'), fail('x'), fail('x'), fail('x')] }).io))[3]!.text, 'could not find %LOCALAPPDATA% through cmd.exe (x)')
    assert.deepEqual(await plan(fake({ wt: false }).io, 'notify'), { error: 'Only in Windows Terminal' })
  })
})

describe('setup: the view', () => {
  const text = (lines: ReturnType<typeof viewLines>) => lines.map(l => l.map(s => s.text).join('')).join('\n')
  const act = { pick: () => {}, yes: () => {}, no: () => {} }

  test('the rows with their marks, the confirmation, the progress and the result; ↑↓ stay in the list', async () => {
    const f = fake({ files: { [STABLE]: WT_JSON } })
    const rows = await statuses(f.io, { protocol: 'sixel' })
    const v: View = { at: 1, rows: undefined }
    assert.match(text(viewLines(v, 100, act)), /◌ checking…/)
    v.rows = rows
    let s = text(viewLines(v, 100, act))
    assert.match(s, /The optional extras clued uses\. ↑↓ choose · Enter install · Esc back/)
    assert.match(s, /^ {3}— Diagrams {12}Diagrams in replies need mmdc: Mermaid blocks show as code$/m)
    assert.match(s, /^ ▸ — Arabic font {9}Arabic in Windows Terminal needs Cascadia Mono NF/m)
    assert.match(s, /^ {3}ℹ Inline images {7}This terminal gets Sixel$/m)
    // A long status wraps under itself.
    assert.match(text(viewLines(v, 50, act)), /\n {25}\S/)
    moveAt(v, -5)
    assert.equal(v.at, 0)
    moveAt(v, 9)
    assert.equal(v.at, 4)
    v.planning = 'face'
    assert.match(text(viewLines(v, 100, act)), /◌ working out what Font face takes…/)
    delete v.planning
    v.confirm = runnable(await plan(f.io, 'face'))
    s = text(viewLines(v, 100, act))
    assert.match(s, /Replace your font face “Consolas”\?/)
    assert.match(s, /• Changes\s+D:[\s\S]*: profiles\.defaults\.font\.face/)
    assert.match(s, /⚠ Cascadia Mono NF isn't installed yet/)
    assert.match(s, / Replace \(y\) {4}Cancel \(n\) /)
    let yes = 0
    const buttons = viewLines(v, 100, { ...act, yes: () => yes++ }).flat().filter(x => x.action)
    buttons.find(x => x.text.includes('Replace'))!.action!()
    assert.equal(yes, 1)
    v.confirm = runnable(await plan(f.io, 'diagrams'))
    assert.match(text(viewLines(v, 100, act)), / Install \(y\) /)
    delete v.confirm
    v.busy = { id: 'diagrams', lines: ['one', 'two'] }
    assert.match(text(viewLines(v, 100, act)), /◌ Diagrams: installing…\n {4}one\n {4}two/)
    v.busy.done = { ok: false, text: 'npm failed: boom' }
    s = text(viewLines(v, 100, act))
    assert.match(s, /✗ Diagrams\n/)
    assert.match(s, /npm failed: boom/)
    v.busy.done = { ok: true, text: 'fine' }
    assert.match(text(viewLines(v, 100, act)), /✓ Diagrams/)
    // A click on a row picks it.
    let picked = -1
    viewLines(v, 100, { ...act, pick: i => (picked = i) }).flat().find(x => x.text.includes('Font face'))!.action!()
    assert.equal(picked, 2)
  })
})

describe('setup: clued setup', () => {
  const answers = (...a: string[]) => {
    const s = new PassThrough()
    s.end(a.map(x => `${x}\n`).join(''))
    return s
  }
  const output = () => {
    const s = new PassThrough()
    let text = ''
    s.on('data', c => (text += c))
    return { s, text: () => text }
  }

  test('--check only prints the statuses; anything else is a usage line', async () => {
    const f = fake({ wt: false })
    const o = output()
    assert.equal(await main(['--check'], f.io, answers(), o.s), 0)
    assert.equal(o.text(), 'clued: the optional extras\n\n— Diagrams: Diagrams in replies need mmdc: Mermaid blocks show as code\n· Arabic font: Only for Windows Terminal, from WSL\n· Font face: Only for Windows Terminal, from WSL\n· Notification click: Only in Windows Terminal: elsewhere a click on a notification needs nothing set up\nℹ Inline images: clued asks the terminal whether it draws Sixel as it starts: see /setup inside clued\n')
    assert.ok(!f.calls.some(c => c[0] === 'npm'))
    const u = output()
    assert.equal(await main(['--force'], f.io, answers(), u.s), 2)
    assert.equal(u.text(), 'usage: clued setup [--check]\n')
  })

  test('walks the missing extras: says what each does, installs on y only', async () => {
    const { zip } = release()
    const f = fake({ zip, files: { [STABLE]: WT_JSON }, npmInstall: bin => (mmdcIn(bin), ok()) })
    const o = output()
    // y to the diagram tool, Enter (no) to the font, y to the face, and stdin ends before the click handler.
    assert.equal(await main([], f.io, answers('y', '', 'yes'), o.s), 0)
    const s = o.text()
    assert.match(s, /\nInstall the diagram tool \(mmdc\)\?\n {2}• Runs: npm i -g @mermaid-js\/mermaid-cli\n/)
    assert.match(s, /Install\? \[y\/N\] {3}npm i -g @mermaid-js\/mermaid-cli\n {2}added 300 packages in 40s\n✓ Diagrams: mmdc is installed/)
    assert.match(s, /Install Cascadia Mono NF, for your Windows user\?[\s\S]*Install\? \[y\/N\] {3}Skipped\./)
    assert.match(s, /Replace your font face “Consolas”\?[\s\S]* {2}⚠ Cascadia Mono NF isn't installed yet[\s\S]*Replace “Consolas”\? \[y\/N\] {3}Copied settings\.json/)
    assert.match(s, /Set up the notification click handler\?[\s\S]*Install\? \[y\/N\] \n {2}Skipped\.\n$/)
    assert.ok(!f.calls.some(c => c[0] === 'range'), 'nothing downloaded for the font')
    assert.equal(f.files.get(STABLE), WT_JSON.replace('"Consolas"', `"${FACE_ARABIC}"`))
    assert.ok(!f.files.has(`${HERE}/clued/focus.ps1`))
  })

  test('nothing missing: nothing asked; a failed install exits 1; a plan that can\'t be made is said', async () => {
    const f = fake({ wt: false })
    mmdcIn(f.bin)
    const o = output()
    assert.equal(await main([], f.io, answers(), o.s), 0)
    assert.match(o.text(), /\nNothing to install\.\n$/)
    const g = fake({ wt: false, npmInstall: () => fail('npm ERR! boom') })
    const p = output()
    assert.equal(await main([], g.io, answers('y'), p.s), 1)
    assert.match(p.text(), /✗ npm failed: npm ERR! boom\n$/)
    const h = fake({ wt: false, npmPrefix: fail('no npm') })
    const q = output()
    assert.equal(await main([], h.io, answers(), q.s), 0)
    assert.match(q.text(), /\nDiagrams: npm isn't working here \(no npm\): it comes with Node\.\n$/)
    // Answers typed after the question, as a person does.
    const k = fake({ wt: false, npmInstall: () => ok() })
    const slow = new PassThrough()
    const r = output()
    const done = main([], k.io, slow, r.s)
    setTimeout(() => slow.end('n\n'), 50)
    assert.equal(await done, 0)
    assert.match(r.text(), /Skipped\./)
  })

  test('the command itself: node app/setup-cli.ts --check, on the real system calls but a temp HOME and PATH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clued-setup-cli-'))
    try {
      const { spawnSync } = await import('node:child_process')
      const r = spawnSync(process.execPath, ['--no-warnings', join(import.meta.dirname, '..', '..', 'app', 'setup-cli.ts'), '--check'], { encoding: 'utf8', env: { ...process.env, HOME: dir, PATH: '/usr/bin:/bin', WT_SESSION: '', CLUED_IMAGES: 'kitty', WSL_DISTRO_NAME: '' } })
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /^clued: the optional extras\n\n— Diagrams: Diagrams in replies need mmdc/)
      assert.match(r.stdout, /ℹ Inline images: This terminal gets the kitty graphics protocol \(CLUED_IMAGES\)\n$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('setup: the real system\'s pieces', () => {
  test('files, programs, WSL, and ranges over HTTP', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clued-setup-io-'))
    const server = createServer((req, res) => {
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '')
      if (req.url === '/whole' || !m) return void res.end('everything')
      res.writeHead(206, { 'content-range': `bytes ${m[1]}-${m[2]}/10` })
      res.end('0123456789'.slice(Number(m[1]), Number(m[2]) + 1))
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    try {
      const io = systemIo({ PATH: '/usr/bin:/bin' }, false)
      const p = join(dir, 'a', 'b.txt')
      assert.equal(io.read(p), undefined)
      assert.equal(io.bytes(p), undefined)
      io.write(p, 'hi')
      assert.equal(io.read(p), 'hi')
      assert.equal(Buffer.from(io.bytes(p)!).toString(), 'hi')
      assert.ok(io.exists(p))
      assert.ok(io.writable(dir))
      assert.ok(!io.writable(join(dir, 'nope')))
      io.remove(p)
      assert.ok(!existsSync(join(dir, 'a')))
      assert.ok(io.now() instanceof Date)
      assert.deepEqual(await exec('sh', ['-c', 'echo out; exit 0']), { ok: true, code: 0, stdout: 'out\n', stderr: '' })
      assert.equal((await exec('sh', ['-c', 'echo bad >&2; exit 3'])).code, 3)
      assert.equal((await exec('/nonexistent/x', [])).ok, false)
      const lines: string[] = []
      const r = await runLines('sh', ['-c', 'echo one; echo two >&2; printf "three\\rfour"'], l => lines.push(l))
      assert.deepEqual([r.ok, lines.sort()], [true, ['four', 'one', 'three', 'two']])
      assert.equal((await runLines('/nonexistent/x', [], () => {})).ok, false)
      assert.equal((await runLines('sh', ['-c', 'exit 4'], () => {})).code, 4)
      const port = (server.address() as any).port
      assert.equal(Buffer.from(await httpRange(`http://127.0.0.1:${port}/f`, 2, 4)).toString(), '234')
      await assert.rejects(httpRange(`http://127.0.0.1:${port}/whole`, 2, 4), /the server answered 200, not the part of the file asked for/)
      assert.equal(detectWsl({ WSL_DISTRO_NAME: 'Ubuntu' }), true)
      assert.equal(typeof detectWsl({}), 'boolean')
      assert.equal(readFileSync(join(import.meta.dirname, '..', '..', 'bin', 'clued'), 'utf8').includes('app/setup-cli.ts'), true)
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
