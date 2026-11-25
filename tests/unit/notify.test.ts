import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVE_MS, AUMID, FOCUS_PS, FOCUS_VERSION, focusUri, installScript, LINUX_SOUND, linuxCommands, macCommand, oscNotification, shouldNotify, SOUND, tabId, tabTag, targetOf, toastScript, toastXml, uninstallScript, Waits,
} from '../../app/notify.ts'

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

  test('toastScript: the XML in base64, shown by PowerShell\'s notifier; the click handler set up only with a link', () => {
    const decode = (s: string) => [...s.matchAll(/FromBase64String\('([^']*)'\)/g)].map(m => Buffer.from(m[1]!, 'base64').toString('utf8'))
    const plain = toastScript('T', 'B')
    assert.ok(plain.includes(`CreateToastNotifier('${AUMID}')`))
    assert.deepEqual(decode(plain), [toastXml('T', 'B')])
    assert.ok(!plain.includes('HKCU'))
    const linked = toastScript('T', 'B', focusUri('ab12', 'w'))
    assert.ok(linked.startsWith(`try { ${installScript()} } catch {}`))
    assert.deepEqual(decode(linked), [FOCUS_PS, toastXml('T', 'B', focusUri('ab12', 'w'))])
  })

  test('installScript: per user (HKCU), only when missing or older, headless, the link passed as one argument', () => {
    const s = installScript()
    assert.ok(s.includes("$k='HKCU:\\Software\\Classes\\clued-focus'"))
    assert.ok(s.includes(`-ne '${FOCUS_VERSION}' -or -not (Test-Path $f)`))
    assert.ok(s.includes("'URL Protocol'"))
    assert.ok(s.includes('\\System32\\conhost.exe" --headless'))
    assert.ok(s.includes('-File "\' + $f + \'" "%1"'))
    assert.match(FOCUS_VERSION, /^[0-9a-f]{8}$/)
  })

  test('uninstallScript: removes the key, the script and its empty folder', () => {
    const s = uninstallScript()
    assert.ok(s.includes("Remove-Item -Path 'HKCU:\\Software\\Classes\\clued-focus' -Recurse -Force"))
    assert.ok(s.includes("Join-Path $d 'focus.ps1'"))
    assert.ok(s.includes('-not (Get-ChildItem $d)'))
  })

  test('FOCUS_PS: ASCII only, checks its input, finds the tab by tag, then folder, then any window', () => {
    assert.match(FOCUS_PS, /^[\x00-\x7f]*$/)
    assert.ok(FOCUS_PS.includes("$id -notmatch '^[0-9a-f]{4}$'"))
    assert.ok(FOCUS_PS.includes("'CASCADIA_HOSTING_WINDOW_CLASS'"))
    assert.ok(FOCUS_PS.includes('SelectionItemPattern'))
    assert.ok(FOCUS_PS.includes('SetForegroundWindow'))
  })
})
