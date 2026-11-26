import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVE_MS, AUMID, failureNote, FOCUS_PS, FOCUS_VERSION, focusUri, HANDLER_KEY, handlerCommand, handlerPlace, LINUX_SOUND, linuxCommands, macCommand, oscNotification, registerCommands, removeClickHandler, setupClickHandler, shouldNotify, SOUND, tabId, tabTag, targetOf, TOAST_MAX, toastFailure, toastScript, toastXml, Waits,
} from '../../app/notify.ts'
import type { HandlerIo, Ran } from '../../app/notify.ts'

describe('shouldNotify', () => {
  const now = 1_000_000
  test('on: notifies unless the tab is focused and you typed or clicked in it just now', () => {
    assert.equal(shouldNotify('on', true, now - 1000, now), false)
    assert.equal(shouldNotify('on', true, now - ACTIVE_MS - 1, now), true)
    // Focus alone is not enough: the app starts out counting itself focused.
    assert.equal(shouldNotify('on', true, 0, now), true)
    // You typed, then left the tab.
    assert.equal(shouldNotify('on', false, now - 10, now), true)
    assert.equal(shouldNotify('on', true, now - 2000, now, 1000), true)
  })
  test('always notifies, off never does', () => {
    assert.equal(shouldNotify('always', true, now, now), true)
    assert.equal(shouldNotify('off', false, 0, now), false)
  })
})

test('Waits: each wait is new once', () => {
  const w = new Waits()
  assert.equal(w.isNew('ask:1'), true)
  assert.equal(w.isNew('ask:1'), false)
  assert.equal(w.isNew('perm:1'), true)
  assert.equal(w.isNew('reply:1'), true)
})

test('targetOf: the terminal itself first, then the system', () => {
  assert.equal(targetOf({ KITTY_WINDOW_ID: '1', TERM_PROGRAM: 'iTerm.app' }, 'darwin', false), 'kitty')
  for (const t of ['iTerm.app', 'WezTerm', 'ghostty']) assert.equal(targetOf({ TERM_PROGRAM: t }, 'linux', true), 'osc9')
  assert.equal(targetOf({ WT_SESSION: 'x' }, 'linux', true), 'windows')
  assert.equal(targetOf({}, 'win32', false), 'windows')
  assert.equal(targetOf({}, 'darwin', false), 'mac')
  assert.equal(targetOf({}, 'linux', false), 'linux')
})

test('oscNotification: OSC 99 or OSC 9, then a bell; control characters flattened', () => {
  assert.equal(oscNotification('kitty', 'T', 'a\nb'), '\x1b]99;;T: a b\x1b\\\x07')
  assert.equal(oscNotification('osc9', 'T', 'a\x07b'), '\x1b]9;T: a b\x07\x07')
})

test('macCommand: Notification Center with the Glass sound, the text as arguments (never in the script)', () => {
  const c = macCommand('Claude asks you · work', 'Which "one"?')
  assert.equal(c.cmd, 'osascript')
  assert.deepEqual(c.args, ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"', '-e', 'end run', 'Claude asks you · work', 'Which "one"?'])
})

test('linuxCommands: notify-send, then canberra-gtk-play, then paplay when the sound file is there', () => {
  const c = linuxCommands('T', 'B', p => p === LINUX_SOUND)
  assert.deepEqual(c.show, { cmd: 'notify-send', args: ['-a', 'clued', 'T', 'B'] })
  assert.deepEqual(c.sounds, [
    { cmd: 'canberra-gtk-play', args: ['-i', 'message-new-instant', '-d', 'clued'] },
    { cmd: 'paplay', args: [LINUX_SOUND] },
  ])
  assert.deepEqual(linuxCommands('T', 'B', () => false).sounds.map(s => s.cmd), ['canberra-gtk-play'])
  assert.ok(Array.isArray(linuxCommands('T', 'B').sounds))
})

describe('Windows', () => {
  test('tabId and tabTag: 4 hex digits from WT_SESSION, as 16 invisible characters', () => {
    const id = tabId('0b7c0b6e-0000-4000-8000-000000000001')
    assert.match(id, /^[0-9a-f]{4}$/)
    assert.equal(tabId('0b7c0b6e-0000-4000-8000-000000000001'), id)
    assert.notEqual(tabId('another'), id)
    assert.equal(tabTag('8001'), '⁠' + '​'.repeat(14) + '⁠')
    assert.equal(tabTag('0000'), '​'.repeat(16))
  })

  test('focusUri: the scheme, the tab id and the folder, encoded', () => {
    assert.equal(focusUri('ab12', 'my app&co'), 'clued-focus:?id=ab12&where=my%20app%26co')
  })

  test('toastXml: ToastGeneric, title and body escaped, explicit sound, and the click link', () => {
    assert.equal(
      toastXml('Claude asks you · a<b>', 'x & "y"\n\'z\'', 'clued-focus:?id=ab12&where=w'),
      '<toast activationType="protocol" launch="clued-focus:?id=ab12&amp;where=w"><visual><binding template="ToastGeneric">' +
        '<text>Claude asks you · a&lt;b&gt;</text><text>x &amp; &quot;y&quot; &apos;z&apos;</text></binding></visual>' +
        `<audio src="${SOUND}"/></toast>`,
    )
    assert.equal(SOUND, 'ms-winsoundevent:Notification.Default')
    // Without a link (not in Windows Terminal): a plain toast, still with its sound.
    assert.match(toastXml('T', 'B'), /^<toast><visual>.*<audio src="ms-winsoundevent:Notification.Default"\/><\/toast>$/)
  })

  test('toastScript: only the toast, small and plain, with or without a link: never the click handler\'s setup', () => {
    const decode = (s: string) => [...s.matchAll(/FromBase64String\('([^']*)'\)/g)].map(m => Buffer.from(m[1]!, 'base64').toString('utf8'))
    const plain = toastScript('T', 'B')
    assert.ok(plain.includes(`CreateToastNotifier('${AUMID}')`))
    assert.deepEqual(decode(plain), [toastXml('T', 'B')])
    const long = 'x'.repeat(200)
    const linked = toastScript(long, long, focusUri('ab12', 'some-folder'))
    assert.deepEqual(decode(linked), [toastXml(long, long, focusUri('ab12', 'some-folder'))])
    for (const s of [plain, linked]) {
      assert.ok(s.length < TOAST_MAX, `${s.length} chars`)
      // What antivirus (Bitdefender) blocks: a script written from base64, the registry, hidden or bypassing PowerShell.
      for (const bad of ['HKCU', 'WriteAllText', 'focus.ps1', 'conhost', 'Bypass', 'Hidden', 'Set-ItemProperty', 'clued-focus\\'] ) assert.ok(!s.includes(bad), bad)
    }
  })

  test('handlerCommand: focus.ps1 with the link as one argument, headless, RemoteSigned, nothing hidden or bypassed', () => {
    const c = handlerCommand('C:\\WINDOWS', 'D:\\Data\\a b\\AppData\\Local\\clued\\focus.ps1')
    assert.equal(c, '"C:\\WINDOWS\\System32\\conhost.exe" --headless "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "D:\\Data\\a b\\AppData\\Local\\clued\\focus.ps1" "%1"')
    assert.ok(!/Bypass|Hidden|EncodedCommand/i.test(c))
    assert.match(FOCUS_VERSION, /^[0-9a-f]{8}$/)
  })

  test('registerCommands: plain reg.exe adds, per user, the version last', () => {
    const cmds = registerCommands('the command')
    assert.ok(cmds.every(c => c.cmd === 'reg.exe' && c.args[0] === 'add' && c.args.at(-1) === '/f'))
    assert.equal(HANDLER_KEY, 'HKCU\\Software\\Classes\\clued-focus')
    assert.deepEqual(cmds.map(c => c.args.slice(1, -1)), [
      [HANDLER_KEY, '/ve', '/d', 'URL:clued focus'],
      [HANDLER_KEY, '/v', 'URL Protocol', '/d', ''],
      [`${HANDLER_KEY}\\shell\\open\\command`, '/ve', '/d', 'the command'],
      [HANDLER_KEY, '/v', 'CluedVersion', '/d', FOCUS_VERSION],
    ])
  })

  test('FOCUS_PS: ASCII only, checks its input, finds the tab by tag, then folder, then any window', () => {
    assert.match(FOCUS_PS, /^[\x00-\x7f]*$/)
    assert.ok(FOCUS_PS.includes("$id -notmatch '^[0-9a-f]{4}$'"))
    assert.ok(FOCUS_PS.includes("'CASCADIA_HOSTING_WINDOW_CLASS'"))
    assert.ok(FOCUS_PS.includes('SelectionItemPattern'))
    assert.ok(FOCUS_PS.includes('SetForegroundWindow'))
  })
})

/** A fake Windows: cmd.exe, wslpath and reg.exe answer as told; files live in a map. */
function fakeWindows(o: { wsl?: boolean; cmd?: Ran; wslpath?: Ran; query?: Ran; add?: (args: string[]) => Ran; del?: Ran; files?: Map<string, string>; env?: NodeJS.ProcessEnv; writeFails?: boolean } = {}) {
  const ok = (stdout = ''): Ran => ({ ok: true, code: 0, stdout, stderr: '' })
  const calls: string[][] = []
  const files = o.files ?? new Map<string, string>()
  const removed: string[] = []
  const io: HandlerIo = {
    exec: async (cmd, args) => {
      calls.push([cmd, ...args])
      if (cmd === 'cmd.exe') return o.cmd ?? ok('D:\\Data\\u\\AppData\\Local;C:\\WINDOWS\r\n')
      if (cmd === 'wslpath') return o.wslpath ?? ok('/mnt/d/Data/u/AppData/Local\n')
      if (args[0] === 'query') return o.query ?? { ok: false, code: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.' }
      if (args[0] === 'add') return o.add?.(args) ?? ok('The operation completed successfully.')
      if (args[0] === 'delete') return o.del ?? ok()
      throw new Error(`unexpected ${cmd}`)
    },
    read: p => files.get(p),
    write: (p, t) => {
      if (o.writeFails) throw Object.assign(new Error('nope'), { code: 'EACCES' })
      files.set(p, t)
    },
    remove: p => void (files.delete(p), removed.push(p)),
    isWsl: o.wsl ?? true,
    env: o.env ?? {},
  }
  return { io, calls, files, removed }
}

describe('the click handler, set up apart from the toasts', () => {
  const ps1 = '/mnt/d/Data/u/AppData/Local/clued/focus.ps1'
  const win = 'D:\\Data\\u\\AppData\\Local\\clued\\focus.ps1'

  test('from WSL: finds %LOCALAPPDATA% with cmd.exe, writes focus.ps1 there itself, registers with reg.exe', async () => {
    const w = fakeWindows()
    const r = await setupClickHandler(w.io)
    assert.deepEqual(r, { ok: true, wrote: true, place: { systemRoot: 'C:\\WINDOWS', win, here: ps1 } })
    assert.equal(w.files.get(ps1), FOCUS_PS)
    assert.deepEqual(w.calls[0], ['cmd.exe', '/d', '/c', 'echo', '%LOCALAPPDATA%;%SystemRoot%'])
    assert.deepEqual(w.calls[1], ['wslpath', '-u', 'D:\\Data\\u\\AppData\\Local'])
    assert.deepEqual(w.calls.slice(3), registerCommands(handlerCommand('C:\\WINDOWS', win)).map(c => [c.cmd, ...c.args]))
    // Never PowerShell, nothing encoded.
    assert.ok(w.calls.every(c => !/powershell/i.test(c[0]!) && !c.join(' ').includes('Base64')))
  })

  test('already set up, this version: nothing is written again', async () => {
    const w = fakeWindows({ query: { ok: true, code: 0, stdout: `    CluedVersion    REG_SZ    ${FOCUS_VERSION}\r\n`, stderr: '' }, files: new Map([[ps1, FOCUS_PS]]) })
    const r = await setupClickHandler(w.io)
    assert.equal(r.ok && r.wrote, false)
    assert.equal(w.calls.length, 3)
  })

  test('an older version, or focus.ps1 gone or changed: set up again', async () => {
    for (const w of [
      fakeWindows({ query: { ok: true, code: 0, stdout: '    CluedVersion    REG_SZ    76bcc04f', stderr: '' }, files: new Map([[ps1, FOCUS_PS]]) }),
      fakeWindows({ query: { ok: true, code: 0, stdout: FOCUS_VERSION, stderr: '' } }),
      fakeWindows({ query: { ok: true, code: 0, stdout: FOCUS_VERSION, stderr: '' }, files: new Map([[ps1, 'old']]) }),
    ]) {
      const r = await setupClickHandler(w.io)
      assert.equal(r.ok && r.wrote, true)
      assert.equal(w.files.get(ps1), FOCUS_PS)
    }
  })

  test('on Windows itself: LOCALAPPDATA and SystemRoot from the environment, no cmd.exe nor wslpath', async () => {
    const w = fakeWindows({ wsl: false, env: { LOCALAPPDATA: 'D:\\Data\\u\\AppData\\Local', SystemRoot: 'C:\\Windows' } })
    const r = await setupClickHandler(w.io)
    assert.deepEqual(r, { ok: true, wrote: true, place: { systemRoot: 'C:\\Windows', win, here: win } })
    assert.ok(w.calls.every(c => c[0] === 'reg.exe'))
    assert.deepEqual(await handlerPlace(fakeWindows({ wsl: false, env: { LOCALAPPDATA: 'C:\\L' } }).io), { systemRoot: 'C:\\Windows', win: 'C:\\L\\clued\\focus.ps1', here: 'C:\\L\\clued\\focus.ps1' })
    assert.equal(await handlerPlace(fakeWindows({ wsl: false }).io), 'LOCALAPPDATA is not set')
  })

  test('each failure is said, and nothing is registered after it', async () => {
    const blocked: Ran = { ok: false, code: 1, stdout: '', stderr: '/mnt/c/WINDOWS/system32/cmd.exe: Invalid argument\n' }
    assert.deepEqual(await setupClickHandler(fakeWindows({ cmd: blocked }).io), { ok: false, error: 'could not find %LOCALAPPDATA% through cmd.exe (/mnt/c/WINDOWS/system32/cmd.exe: Invalid argument)' })
    assert.deepEqual(await setupClickHandler(fakeWindows({ cmd: { ok: true, code: 0, stdout: '%LOCALAPPDATA%;%SystemRoot%\r\n', stderr: '' } }).io), { ok: false, error: 'could not find %LOCALAPPDATA% through cmd.exe (%LOCALAPPDATA%;%SystemRoot%)' })
    assert.deepEqual(await setupClickHandler(fakeWindows({ wslpath: { ok: false, code: 1, stdout: '', stderr: '' } }).io), { ok: false, error: 'wslpath could not convert D:\\Data\\u\\AppData\\Local (exit 1)' })
    const w = fakeWindows({ writeFails: true })
    assert.deepEqual(await setupClickHandler(w.io), { ok: false, error: `could not write ${win} (EACCES)` })
    assert.ok(!w.calls.some(c => c[1] === 'add'))
    const denied = fakeWindows({ add: a => (a.includes('URL Protocol') ? { ok: false, code: 1, stdout: '', stderr: 'ERROR: Access is denied.\r\n' } : { ok: true, code: 0, stdout: '', stderr: '' }) })
    assert.deepEqual(await setupClickHandler(denied.io), { ok: false, error: 'reg.exe add failed (ERROR: Access is denied.)' })
    assert.ok(!denied.calls.some(c => c.includes('CluedVersion') && c[1] === 'add'))
  })

  test('removeClickHandler: reg.exe delete and focus.ps1 removed; not there is fine', async () => {
    const w = fakeWindows({ files: new Map([[ps1, FOCUS_PS]]) })
    assert.deepEqual(await removeClickHandler(w.io), { ok: true })
    assert.ok(w.calls.some(c => c.join(' ') === `reg.exe delete ${HANDLER_KEY} /f`))
    assert.deepEqual(w.removed, [ps1])
    assert.deepEqual(await removeClickHandler(fakeWindows({ del: { ok: false, code: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.' } }).io), { ok: true })
    assert.deepEqual(await removeClickHandler(fakeWindows({ del: { ok: false, code: 1, stdout: '', stderr: 'ERROR: Access is denied.' } }).io), { ok: false, error: 'reg.exe delete failed (ERROR: Access is denied.)' })
    assert.deepEqual(await removeClickHandler(fakeWindows({ wsl: false }).io), { ok: false, error: 'LOCALAPPDATA is not set' })
  })
})

describe('a toast that fails', () => {
  test('toastFailure: blocked when powershell.exe never ran (WSL: Invalid argument; Windows: EACCES, EPERM)', () => {
    assert.deepEqual(toastFailure({ ok: false, code: 1, stdout: '', stderr: '/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0//powershell.exe: Invalid argument\n' }), {
      blocked: true,
      detail: '/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0//powershell.exe: Invalid argument',
    })
    assert.equal(toastFailure({ ok: false, code: 'EACCES', stdout: '', stderr: 'spawn powershell EACCES' }).blocked, true)
    assert.equal(toastFailure({ ok: false, code: 'EPERM', stdout: '', stderr: '' }).blocked, true)
    // PowerShell ran and failed, or isn't there: failed, not blocked.
    const ran = toastFailure({ ok: false, code: 1, stdout: '', stderr: 'Exception calling "Show"\r\n  + FullyQualifiedErrorId : Exception\r\n' })
    assert.deepEqual(ran, { blocked: false, detail: '+ FullyQualifiedErrorId : Exception' })
    assert.deepEqual(toastFailure({ ok: false, code: 'ENOENT', stdout: '', stderr: '' }), { blocked: false, detail: 'exit ENOENT' })
  })

  test('failureNote: points at /notify status', () => {
    assert.equal(failureNote(true), 'Windows notifications were blocked (antivirus?): see /notify status')
    assert.equal(failureNote(false), 'Windows notifications failed: see /notify status')
  })
})
