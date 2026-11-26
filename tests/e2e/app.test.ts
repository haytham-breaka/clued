// The app around the chat: slash commands, sessions (/resume, -c), permission prompts, notifications,
// images, the status line, typing, and quitting.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { keyOf } from '../../hooks/model.ts'
import { withApp, writeSession } from './harness.ts'
import type { App } from './harness.ts'

const MAIN = join(import.meta.dirname, '..', '..', 'app', 'main.ts')
/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

const IS_WSL = !!process.env.WSL_DISTRO_NAME || (process.platform === 'linux' && /microsoft/i.test(readFileSync('/proc/version', 'utf8')))

/** Whether the fake notifier (notify-send on Linux, powershell.exe on WSL) was asked to show `title`. */
function notified(app: App, title: string): boolean {
  return app.read('notify.log').split('\n').some(l => {
    if (l.includes('notify-send') || l.includes('osascript')) return l.includes(title)
    if (!l.includes('powershell.exe') || l.includes('Clipboard')) return false
    // The toast's XML goes base64-encoded in the PowerShell script.
    return toasts(l).some(x => x.includes(`<text>${title}</text>`))
  })
}

/** The toasts (their XML) in a line of the fake powershell.exe's log. */
const toasts = (l: string) => [...l.matchAll(/FromBase64String\('([^']*)'\)/g)].map(m => Buffer.from(m[1]!, 'base64').toString('utf8')).filter(x => x.startsWith('<toast'))

/** Two earlier sessions in this folder, the newer one with what the app kept for it. */
function sessions({ home, work }: { home: string; work: string }) {
  const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
  writeSession(home, work, 'old-1', [
    { type: 'user', timestamp: at(90), message: { content: [{ type: 'text', text: 'the old question' }, { type: 'text', text: '[clued] This message is topic T1.' }] } },
    { type: 'assistant', timestamp: at(89), message: { content: [{ type: 'text', text: 'The old answer.\n<clued>{"topics":[{"id":"T1","status":"done"}]}</clued>' }] } },
  ])
  writeSession(home, work, 'new-2', [
    { type: 'ai-title', title: 'Fixing the login page' },
    { type: 'user', timestamp: at(5), message: { content: [{ type: 'text', text: 'fix the login page' }, { type: 'text', text: '[clued] This message is topic T1.' }] } },
    { type: 'assistant', timestamp: at(5), message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: `${work}/login.ts` } }], usage: { input_tokens: 5000, cache_read_input_tokens: 15000 } } },
    { type: 'user', timestamp: at(4), message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'code' }] } },
    { type: 'assistant', timestamp: at(4), message: { content: [{ type: 'text', text: 'The login page is fixed.\n<clued>{"topics":[{"id":"T1","status":"done"}]}</clued>' }] } },
  ])
  // The older one is older on disk too.
  const old = join(home, '.claude', 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'), 'old-1.jsonl')
  const twoHoursAgo = (Date.now() - 2 * 3600_000) / 1000
  utimesSync(old, twoHoursAgo, twoHoursAgo)
  // What the app kept for new-2: a mid-turn reply the transcript lost, and your reaction.
  mkdirSync(join(home, '.clued', 'sessions'), { recursive: true })
  const key = keyOf('fix the login page')
  writeFileSync(join(home, '.clued', 'sessions', 'new-2.json'), JSON.stringify({
    board: { topics: [{ id: 'T1', title: 'Login', threadId: 0, status: 'done', messageKeys: [key], updatedAt: Date.now() - 240_000 }], threads: [], answers: [], nextTopic: 2, turnTopics: [], replies: {} },
    reactions: { [`claude:${key}`]: [{ emoji: '👍', by: 'me' }] },
    links: {},
    early: { [key]: ['<<reply T1>>\nAn early reply the app kept.'], gone: ['nothing'] },
  }))
}

describe('app', () => {
  test('a permission prompt: y allows, a click on Deny denies, and Claude Code gets the answer', () =>
    withApp({}, async app => {
      await app.send('need permission')
      let s = await app.waitFor('Allow (y)')
      assert.match(s, /╭─ Claude wants to use Bash/)
      assert.match(s, /│ Remove the fake target/)
      assert.match(s, /│ rm -rf \/tmp\/fake-target/)
      assert.match(s, /Deny \(n\)/)
      // The tab title shows something waits on you.
      await app.waitFor(() => app.title().startsWith('✋ 1 · clued · work'))
      app.type('y')
      s = await app.waitFor('Permission was allowed.')
      assert.ok(!s.includes('Allow (y)'))
      const allow = app.claudeLog().find(e => e.type === 'control_response')
      assert.deepEqual(allow.response.response, { behavior: 'allow', updatedInput: { command: 'rm -rf /tmp/fake-target', description: 'Remove the fake target' } })
      await app.waitFor(() => app.title() === 'clued · work')
      await app.send('need permission again')
      await app.waitFor('Allow (y)')
      await app.click('Deny (n)')
      await app.waitFor('Permission was denied.')
      assert.deepEqual(app.claudeLog().filter(e => e.type === 'control_response')[1].response.response, { behavior: 'deny', message: 'The user denied this.' })
    }))

  test('AskUserQuestion: a card of questions; a number, a click or your own words answer it, Esc dismisses it', () =>
    withApp({ height: 44 }, async app => {
      await app.send('offer choices please')
      let s = await app.waitFor('❓ Claude asks')
      assert.match(s, /question 1 of 2 · waiting for your answer/)
      assert.match(s, / Database  Which database should we use\?/)
      assert.match(s, /1  ○ Postgres  Relational, the usual pick/)
      assert.match(s, /2  ○ SQLite  One file, no server/)
      assert.match(s, /Next \(Enter\)/)
      assert.match(s, /Pick an answer above, or type your own here/)
      // The tab title counts the question as waiting on you.
      await app.waitFor(() => app.title().startsWith('✋ 1 · clued · work'))
      // A number picks an option; Enter goes on to the next question.
      app.type('2')
      await app.waitFor('2  ● SQLite')
      app.keys('Enter')
      s = await app.waitFor('question 2 of 2')
      assert.match(s, /✓ Database: SQLite/)
      assert.match(s, /☐ Backups/)
      // Several can be ticked: a click on each, and a second click takes one back out.
      await app.click('Backups', { area: 'chat' })
      await app.click('Logs', { area: 'chat' })
      await app.waitFor('☑ Logs')
      await app.click('Metrics', { area: 'chat' })
      await app.waitFor('☑ Metrics')
      await app.click('Metrics', { area: 'chat' })
      await app.waitFor('☐ Metrics')
      await app.click('Send (Enter)', { area: 'chat' })
      s = await app.waitFor('You chose: SQLite / Backups, Logs')
      assert.ok(!s.includes('❓ Claude asks'))
      const r = app.claudeLog().filter(e => e.type === 'control_response').at(-1)
      assert.equal(r.response.response.behavior, 'allow')
      assert.deepEqual(r.response.response.updatedInput.answers, { 'Which database should we use?': 'SQLite', 'Which extras do you want?': 'Backups, Logs' })
      assert.equal(r.response.response.updatedInput.questions.length, 2)
      // Your own words, typed in the box, are the answer.
      await app.send('offer choices again')
      await app.waitFor('question 1 of 2')
      await app.send('MySQL, please')
      await app.waitFor('question 2 of 2')
      await app.waitFor('✓ Database: MySQL, please')
      // Enter with nothing picked or typed says what to do.
      app.keys('Enter')
      await app.waitFor('Pick an option, or type your own answer.')
      // Esc dismisses the question: Claude Code is told the tool was refused.
      app.keys('Escape')
      s = await app.waitFor('No answer: The user dismissed the question without answering it.')
      assert.ok(!s.includes('❓ Claude asks'))
      const d = app.claudeLog().filter(e => e.type === 'control_response').at(-1)
      assert.deepEqual(d.response.response, { behavior: 'deny', message: 'The user dismissed the question without answering it.' })
    }))

  test('a long command in a permission prompt is cut, with a way to copy it whole', () =>
    withApp({}, async app => {
      await app.send('need long permission')
      const s = await app.waitFor('⧉ copy all')
      assert.match(s, /│ echo line 0\n/)
      assert.match(s, /… 20 more lines {2}⧉ copy all/)
      await app.click('⧉ copy all')
      await app.waitFor('Copied the whole command.')
      assert.equal(app.clipboard(), Array.from({ length: 30 }, (_, i) => `echo line ${i}`).join('\n'))
      app.type('n')
      await app.waitFor('Permission was denied.')
    }))

  test('notifications: /notify test, /notify goes round its modes, and a permission while away notifies', () =>
    withApp({ unfocused: true }, async app => {
      await app.send('/notify test')
      await app.waitFor('Sent a test notification.')
      await app.waitFor(() => notified(app, 'Claude asks you · test'))
      await app.send('/notify')
      await app.waitFor('Notifications always: each time Claude waits on you, even while you type.')
      await app.send('/notify')
      await app.waitFor('Notifications off.')
      await app.waitFor(() => app.read('home/.clued/panel.json').includes('"notify":"off"'))
      await app.send('/notify on')
      await app.waitFor("Notifications on: each time Claude waits on you, unless you're typing here.")
      await app.send('need permission')
      await app.waitFor('Allow (y)')
      await app.waitFor(() => notified(app, 'Claude wants to use Bash · work'))
      app.type('y')
      await app.waitFor('Permission was allowed.')
    }))

  test('a question while the window is in the background notifies (not in the first seconds)', () =>
    withApp({ unfocused: true }, async app => {
      // Questions already there at start are only noted: wait out those first 5 seconds.
      await new Promise(r => setTimeout(r, 5200))
      await app.send('ask me')
      await app.waitFor('Waiting on you')
      await app.waitFor(() => notified(app, 'Claude asks you · work'))
      assert.equal(app.title(), '✋ 1 · clued · work')
      // With its sound: notify-send plays none, so a sound player follows; osascript names one.
      const log = () => app.read('notify.log')
      if (process.platform === 'darwin') assert.match(log(), /sound name "Glass"/)
      else if (!IS_WSL) await app.waitFor(() => log().includes('canberra-gtk-play -i message-new-instant -d clued'))
    }))

  test('WSL in Windows Terminal: an AskUserQuestion card notifies once, with sound and a click to this tab, even in a focused window', () =>
    withApp({ env: { WSL_DISTRO_NAME: 'Fake', WT_SESSION: '0b7c0b6e-0000-4000-8000-000000000001', CLUED_ACTIVE_MS: '3000' }, height: 44 }, async app => {
      // You type, then look away without leaving the tab (or the terminal never says it lost focus).
      await app.send('offer choices later')
      await new Promise(r => setTimeout(r, 3300))
      writeFileSync(join(app.dir, 'release-ask'), '')
      await app.waitFor('❓ Claude asks')
      await app.waitFor(() => notified(app, 'Claude asks you · work'))
      // Only one toast, however often the app draws meanwhile.
      await new Promise(r => setTimeout(r, 800))
      const sent = app.read('notify.log').split('\n').flatMap(toasts)
      assert.equal(sent.length, 1)
      assert.match(sent[0]!, /<audio src="ms-winsoundevent:Notification.Default"\/>/)
      assert.match(sent[0]!, /activationType="protocol" launch="clued-focus:\?id=[0-9a-f]{4}&amp;where=work"/)
      assert.match(sent[0]!, /<text>Which database should we use\? · Which extras do you want\?<\/text>/)
      // The tab's title ends with its invisible tag. The click handler was set up as the app started,
      // apart from the toast: focus.ps1 written from here, the scheme registered with reg.exe.
      assert.match(app.title(), /^✋ 1 · clued · work[\u200b\u2060]{16}$/)
      const log = app.read('notify.log')
      assert.match(log, /cmd\.exe \/d \/c echo %LOCALAPPDATA%;%SystemRoot%/)
      assert.match(log, /reg\.exe add HKCU\\Software\\Classes\\clued-focus\\shell\\open\\command \/ve \/d "C:\\WINDOWS\\System32\\conhost\.exe" --headless .* -ExecutionPolicy RemoteSigned -File "C:\\fake\\Local\\clued\\focus\.ps1" "%1" \/f/)
      assert.match(log, /reg\.exe add HKCU\\Software\\Classes\\clued-focus \/v CluedVersion/)
      assert.match(app.read('win/Local/clued/focus.ps1'), /^param\(\[string\]\$Uri/)
      // The toast's own command is only the toast.
      const ps = log.split('\n').filter(l => toasts(l).length)
      assert.equal(ps.length, 1)
      assert.ok(!/HKCU|WriteAllText|Bypass/.test(ps[0]!) && ps[0]!.length < 2000)
      // Typing right as Claude asks again: you are looking, no toast.
      app.type('1')
      app.keys('Enter')
      app.type('1')
      app.keys('Enter')
      await app.waitFor('You chose:')
      await app.send('offer choices now')
      await app.waitFor('❓ Claude asks')
      await new Promise(r => setTimeout(r, 800))
      assert.equal(app.read('notify.log').split('\n').flatMap(toasts).length, 1)
      // /notify uninstall removes the handler and turns notifications off.
      app.keys('Escape')
      await app.send('/notify uninstall')
      await app.waitFor('Removed the click handler')
      assert.ok(app.read('notify.log').includes('reg.exe delete HKCU\\Software\\Classes\\clued-focus /f'))
      await app.waitFor(() => app.read('home/.clued/panel.json').includes('"notify":"off"'))
      assert.ok(!existsSync(join(app.dir, 'win/Local/clued')))
    }))

  test('WSL: a toast antivirus blocks says so once, in the app and sent.log; later toasts still go, and /notify status explains', () =>
    withApp({ env: { WSL_DISTRO_NAME: 'Fake', WT_SESSION: '0b7c0b6e-0000-4000-8000-000000000002' }, setup: ({ dir }) => writeFileSync(join(dir, 'ps-blocked'), '') }, async app => {
      const tries = () => app.read('notify.log').split('\n').flatMap(toasts).length
      await app.send('/notify test')
      await app.waitFor('Windows notifications were blocked (antivirus?): see /notify status')
      await app.waitFor(() => app.read('home/.clued/sent.log').includes('notify-failed'))
      assert.match(app.read('home/.clued/sent.log'), /notify-failed .*"blocked":true.*powershell\.exe: Invalid argument/)
      // The next toast still tries, and the warning isn't said again.
      await app.send('/notify test')
      await app.waitFor(() => tries() === 2)
      await app.waitFor(() => app.read('home/.clued/sent.log').split('\n').filter(l => l.includes('notify-failed')).length === 2)
      await new Promise(r => setTimeout(r, 300))
      assert.ok(!app.screen().includes('were blocked'))
      let s = await app.send('/notify status').then(() => app.waitFor('Last toast: blocked'))
      assert.match(s, /powershell\.exe was stopped before it ran/)
      assert.match(s, /Click to the tab: set up/)
      // Allowed again: toasts go, and status says so.
      rmSync(join(app.dir, 'ps-blocked'))
      app.keys('Escape')
      await app.send('/notify test')
      await app.waitFor(() => tries() === 3)
      await new Promise(r => setTimeout(r, 300))
      s = await app.send('/notify status').then(() => app.waitFor('Last toast: shown at'))
      assert.ok(!s.includes('stopped before it ran'))
    }))

  test('/resume lists this folder\'s sessions and opens one with its history', () =>
    withApp({ setup: sessions }, async app => {
      await app.send('/resume')
      let s = await app.waitFor('Resume a session')
      assert.match(s, /↑↓ choose · Enter open · Esc new session/)
      assert.match(s, /▸ Fixing the login page {2}\dm ago/)
      assert.match(s, /the old question {2}(1|2)h ago/)
      app.keys('Down')
      await app.waitFor('▸ the old question')
      app.keys('Up')
      await app.waitFor('▸ Fixing the login page')
      app.keys('Enter')
      s = await app.waitFor('The login page is fixed.')
      // History, with what the app kept: the early reply and your reaction; all of it counts as read.
      assert.match(s, /An early reply the app kept\./)
      assert.match(s, /⚙ 1 step · read 1 file/)
      assert.match(s, /👍 you/)
      assert.match(s, /Unread  Read +none│/)
      assert.match(s, /✓ fix the login page/)
      await app.waitLog(e => e.args?.includes('new-2'))
      assert.deepEqual(app.claudeLog().filter(e => e.args).at(-1).args.slice(-2), ['--resume', 'new-2'])
      await app.waitFor(' Fake 1.0  new-2')
    }))

  test('clued -c continues the last session; --resume <id> opens that one', async () => {
    await withApp({ setup: sessions, args: ['-c'] }, async app => {
      await app.waitFor('The login page is fixed.')
      assert.ok(app.claudeLog()[0].args.includes('new-2'))
    })
    await withApp({ setup: sessions, args: ['--resume', 'old-1'] }, async app => {
      await app.waitFor('The old answer.')
      assert.ok(app.claudeLog()[0].args.includes('old-1'))
    })
  })

  test('clued --resume with no id opens the picker; Esc there starts a new session', async () => {
    await withApp({ setup: sessions, args: ['--resume'], ready: 'Resume a session' }, async app => {
      app.keys('Escape')
      await app.waitFor('Fake 1.0  s1')
      assert.ok(!app.claudeLog()[0].args.includes('--resume'))
    })
    // No sessions: straight to a new one.
    await withApp({ args: ['--resume'] }, async app => {
      assert.match(app.screen(), /clued {2}on Claude Code/)
    })
  })

  test('/clear starts a new session, with the model /model chose', () =>
    withApp({}, async app => {
      await app.send('hello')
      await app.waitFor('Echo: hello')
      await app.send('/model opal')
      await app.waitFor('Model: Opal 2.0')
      await app.send('/clear')
      await app.waitFor('New session.')
      await app.waitFor(/clued {2}on Claude Code/)
      await app.waitFor(() => app.claudeLog().filter(e => e.args).length === 2)
      const second = app.claudeLog().filter(e => e.args)[1].args
      assert.ok(!second.includes('--resume'))
      assert.deepEqual(second.slice(-2), ['--model', 'opal'])
    }))

  test('the slash menu: matches as you type, arrows and Tab pick, Esc clears; Claude Code\'s own commands go to Claude', () =>
    withApp({}, async app => {
      app.type('/')
      // Menu rows: " /name", one a line.
      const item = (name: string) => new RegExp(`│  /${name}$`, 'm')
      let s = await app.waitFor(item('exit'))
      assert.match(s, item('demo'))
      assert.match(s, item('cost'))
      app.type('wo')
      // The menu for "/" lists /work too: wait for the one that matches "/wo", without /exit.
      s = await app.waitFor(s => item('work').test(s) && !item('exit').test(s))
      assert.match(s, /│ \/wo /)
      app.keys('Tab')
      await app.waitFor('│ /work ')
      app.keys('C-u')
      app.type('/re')
      await app.waitFor(item('reload'))
      app.keys('Down')
      app.keys('Down')
      app.keys('Up')
      app.keys('Escape')
      await app.waitGone(item('reload'))
      // Enter on a partial name runs the one picked: /resu is /resume.
      app.type('/resu')
      app.keys('Enter')
      await app.waitFor('Resume a session')
      app.keys('Escape')
      await app.waitGone('Resume a session')
      // A click on a menu item fills it in.
      app.type('/dem')
      // Only once the menu is on screen is there an item to click.
      await app.waitFor(item('demo'))
      await app.click('/demo', { area: 'chat' })
      await app.waitFor('│ /demo ')
      app.keys('C-u')
      await app.send('/cost')
      await app.waitFor('Echo: /cost')
      const sent = app.sent().at(-1)!
      assert.equal(sent.text, '/cost')
      assert.equal(sent.note, '', 'a command goes without the note')
      // It is not one of your messages in the panel.
      assert.ok(!app.screen().includes('Your recent messages'))
    }))

  test('typing: cursor keys, words, lines, history, and a message of several lines', () =>
    withApp({}, async app => {
      const box = () => app.lines().filter(l => /│ [^─]/.test(l) && !l.includes('Fake')).map(l => l.split('│')[2]?.trim()).filter(Boolean)
      const expect = async (text: string) => app.waitFor(() => box().at(-1) === text)
      app.type('hello world')
      await expect('hello world')
      app.keys('C-a')
      app.type('>')
      await expect('>hello world')
      app.keys('C-e')
      app.type('!')
      await expect('>hello world!')
      app.keys('Home', 'Right', 'Delete')
      await expect('>ello world!')
      app.keys('End', 'Left', 'BSpace')
      await expect('>ello worl!')
      app.keys('C-w')
      await expect('>ello !')
      app.keys('C-Left', 'C-Right', 'M-b', 'M-f')
      app.keys('C-a', 'C-k')
      await expect('Message Claude   (/ commands · Alt+Enter new line · Esc cancels a reply)')
      // Ctrl+U deletes up to the cursor: at the start, nothing.
      app.type('one two')
      app.keys('C-a', 'C-u')
      await expect('one two')
      app.keys('C-e', 'C-u')
      // Alt+Enter: a new line; the arrows move between the rows.
      app.type('line one')
      app.keys('M-Enter')
      app.type('line two')
      await app.waitFor(() => box().slice(-2).join('|') === 'line one|line two')
      app.keys('Up')
      app.type('X')
      await app.waitFor(() => box().slice(-2).join('|') === 'line oneX|line two')
      app.keys('Down')
      app.keys('Enter')
      await app.waitFor('Echo: line oneX')
      assert.equal(app.sent().at(-1)!.text, 'line oneX\nline two')
      // Up brings back what you sent; Down goes back to an empty box.
      app.keys('Up')
      await app.waitFor(() => box().slice(-2).join('|') === 'line oneX|line two')
      app.keys('Down')
      await expect('Message Claude   (/ commands · Alt+Enter new line · Esc cancels a reply)')
      // Ctrl+C clears what you typed.
      app.type('scrap this')
      await expect('scrap this')
      app.keys('C-c')
      await expect('Message Claude   (/ commands · Alt+Enter new line · Esc cancels a reply)')
      // A long message wraps over several rows of the box.
      app.type('word '.repeat(40).trim())
      await app.waitFor(() => box().length >= 3)
      app.keys('C-a', 'Down', 'Down', 'Up')
    }))

  test('deleting a word: Ctrl+Backspace, Alt+Backspace and CSI 127;5u before the cursor, Alt+D and Ctrl+Delete after it', () =>
    withApp({}, async app => {
      const box = () => app.lines().filter(l => /│ [^─]/.test(l) && !l.includes('Fake')).map(l => l.split('│')[2]?.trim()).filter(Boolean)
      const expect = async (text: string) => app.waitFor(() => box().at(-1) === text)
      app.type('alpha beta gamma')
      await expect('alpha beta gamma')
      // Ctrl+Backspace as Windows Terminal sends it (^H): the word before the cursor.
      app.raw('\b')
      app.type('X')
      await expect('alpha beta X')
      // Alt+Backspace (ESC DEL), twice: the word, then the word and the space after it.
      app.raw('\x1b\x7f')
      await expect('alpha beta')
      app.raw('\x1b\x7f')
      app.type('Y')
      await expect('alpha Y')
      // Ctrl+Backspace as kitty-style terminals send it (CSI 127;5u): a run of marks is a word of its own.
      app.raw('\x1b[127;5u')
      app.type('path/to')
      await expect('alpha path/to')
      app.raw('\x1b[127;5u')
      await expect('alpha path/')
      app.raw('\x1b[127;5u')
      await expect('alpha path')
      // Alt+D at the start: the word after the cursor, and the cursor stays.
      app.keys('C-a')
      app.raw('\x1bd')
      await expect('path')
      app.type('Z')
      await expect('Z path')
      // Ctrl+Delete: the spaces and the word after the cursor.
      app.raw('\x1b[3;5~')
      await expect('Z')
      // The Alt forms of the same keys: CSI 127;3u, ESC ^H, and Alt+Delete.
      app.type(' one two three')
      await expect('Z one two three')
      app.raw('\x1b[127;3u')
      await expect('Z one two')
      app.raw('\x1b\b')
      app.type('W')
      await expect('Z one W')
      app.keys('C-a')
      app.raw('\x1b[3;3~')
      app.type('V')
      await expect('V one W')
      // Nothing more to delete: the keys do nothing at either end.
      app.keys('C-e')
      app.raw('\x1b[3;5~')
      app.keys('C-a')
      app.raw('\b')
      app.type('>')
      await expect('>V one W')
    }))

  test('images: a pasted image path goes with the message as the image; text pastes as text', () =>
    withApp({ setup: ({ work, home }) => { writeFileSync(join(work, 'pic one.png'), PNG); writeFileSync(join(home, 'pic.jpg'), PNG) } }, async app => {
      app.raw(`\x1b[200~'${app.work}/pic one.png'\x1b[201~`)
      let s = await app.waitFor('Image added: it goes with your next message.')
      assert.match(s, /│ \[image 1\]/)
      app.raw('\x1b[200~~/pic.jpg\x1b[201~')
      await app.waitFor('[image 1] [image 2]')
      app.type('what are these')
      app.keys('Enter')
      s = await app.waitFor('I got 2 image(s).')
      const user = app.claudeLog().find(e => e.type === 'user')
      assert.deepEqual(user.message.content.slice(0, 2).map((b: any) => b.source.media_type), ['image/png', 'image/jpeg'])
      assert.equal(user.message.content[0].source.data, PNG.toString('base64'))
      // An image whose [image N] was deleted from the text does not go.
      app.raw(`\x1b[200~${app.work}/pic one.png\x1b[201~`)
      await app.waitFor('│ [image 1]')
      app.keys('C-u')
      await app.send('no picture after all')
      await app.waitFor('Echo: no picture after all')
      assert.equal(app.sent().at(-1)!.images, 0)
      // Text, over several lines (and a path to no file is just text).
      app.raw('\x1b[200~first line\r\nsecond line\x1b[201~')
      await app.waitFor('│ second line')
      app.keys('C-u', 'BSpace', 'C-u')
      app.raw('\x1b[200~/tmp/no-such-file.png\x1b[201~')
      await app.waitFor('│ /tmp/no-such-file.png')
    }))

  test('Ctrl+V and Alt+V add the image on the clipboard, or say there is none', () =>
    withApp({}, async app => {
      app.keys('M-v')
      await app.waitFor('No image on the clipboard.')
      writeFileSync(join(app.dir, 'clip.png'), PNG)
      app.keys('C-v')
      await app.waitFor('│ [image 1]')
      app.type('from the clipboard')
      app.keys('Enter')
      await app.waitFor('I got 1 image(s).')
    }))

  test('the status line: your statusLine command, fed what Claude Code would feed it', () =>
    withApp({
      setup: ({ home, dir }) => {
        mkdirSync(join(home, '.claude'), { recursive: true })
        writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'high', statusLine: { type: 'command', command: `cat > '${dir}/status-in.json'; echo "STATUS model=$COLUMNS"; echo second row` } }))
      },
      ready: 'STATUS model=',
    }, async app => {
      let s = app.screen()
      assert.match(s, /STATUS model=\d+\n.*second row/)
      assert.ok(!s.includes('Fake 1.0  '), 'the default status line is replaced')
      await app.send('rate limit please')
      await app.waitFor('Here is the rate limit.')
      await app.waitFor('Compacting the conversation…')
      // Fed again after the reply: the session, model, effort, context, cost and rate limits.
      await app.waitFor(() => /"five_hour"/.test(app.read('status-in.json')), 20_000)
      const input = JSON.parse(app.read('status-in.json'))
      assert.equal(input.session_id, 's1')
      assert.equal(input.cwd, app.work)
      assert.deepEqual(input.model, { id: 'claude-fake-1-0', display_name: 'Fake 1.0' })
      assert.deepEqual(input.effort, { level: 'high' })
      assert.equal(input.context_window.context_window_size, 200_000)
      assert.equal(input.context_window.used_percentage, 1)
      assert.equal(input.cost.total_cost_usd, 0.0123)
      assert.equal(input.rate_limits.five_hour.used_percentage, 42)
      assert.equal(input.permission_mode, 'default')
      assert.ok(input.prompt_cache.hit_ratio > 0)
      // The context size Claude Code reported is kept for next time.
      assert.match(app.read('home/.clued/panel.json'), /"windows":\{"claude-fake-1-0":200000\}/)
      s = app.screen()
    }))

  test('the permission mode shows under the status line, and Shift+Tab cycles it', () =>
    withApp({}, async app => {
      await app.waitFor('default mode: asks before edits and commands (shift+tab to cycle)')
      app.keys('BTab')
      await app.waitFor('⏵⏵ accept edits on (shift+tab to cycle)')
      app.keys('BTab')
      await app.waitFor('⏸ plan mode on')
      // Only the modes Claude Code started in or reported join the cycle: back to the default.
      app.keys('BTab')
      await app.waitFor('default mode: asks before edits')
      assert.match(app.read('claude.log'), /"subtype":"set_permission_mode","mode":"plan"/)
    }))

  test('the status line gets the folder Claude Code is in now, and the project folder', () =>
    withApp({
      setup: ({ home, work, dir }) => {
        mkdirSync(join(home, '.claude'), { recursive: true })
        writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `cat > '${dir}/status-in.json'; echo STATUS` } }))
        // Claude Code's session file: its shell moved to a subfolder; an agent works somewhere else.
        writeSession(home, work, 's1', [
          { type: 'user', cwd: work, message: { content: 'hi' } },
          { type: 'assistant', cwd: `${work}/sub`, message: { content: [{ type: 'text', text: 'moved' }] } },
          { type: 'assistant', cwd: '/tmp/agent-elsewhere', isSidechain: true, message: { content: [{ type: 'text', text: 'agent' }] } },
        ])
      },
      ready: 'STATUS',
    }, async app => {
      await app.send('hello')
      await app.waitFor(() => app.read('status-in.json').includes('/sub"'), 20_000)
      const input = JSON.parse(app.read('status-in.json'))
      assert.equal(input.cwd, `${app.work}/sub`)
      assert.deepEqual(input.workspace, { current_dir: `${app.work}/sub`, project_dir: app.work })
    }))

  test('/exit quits and says how to resume; /reload exits 75 for the launcher to restart', async () => {
    await withApp({}, async app => {
      await app.send('hello')
      await app.waitFor('Echo: hello')
      await app.send('/exit')
      assert.equal(await app.waitExit(), 0)
      await app.waitFor(() => app.output().includes('\x1b[?1049lResume this conversation with: clued --resume s1\r\n'))
    })
    await withApp({}, async app => {
      // A background agent still at work when it reloads: kept as stopped by the reload.
      await app.send('background agent please')
      await app.waitFor('Started it in the background.')
      await app.send('/reload')
      assert.equal(await app.waitExit(), 75)
      assert.equal(app.read('home/.clued/reload'), 's1')
      assert.deepEqual(JSON.parse(app.read('home/.clued/sessions/s1.json')).stopped, { 'bg-1': 'reload' })
    })
  })

  test('Ctrl+C twice or Ctrl+D quits; SIGTERM and SIGHUP quit cleanly (exit 0)', async () => {
    await withApp({}, async app => {
      app.keys('C-c')
      await app.waitFor('Press Ctrl+C again to quit.')
      app.keys('C-c')
      assert.equal(await app.waitExit(), 0)
    })
    await withApp({}, async app => {
      app.keys('C-d')
      assert.equal(await app.waitExit(), 0)
    })
    for (const signal of ['SIGTERM', 'SIGHUP'] as const)
      await withApp({}, async app => {
        await app.send('hello')
        await app.waitFor('Echo: hello')
        process.kill(app.pid, signal)
        // A listener given quit itself got the signal's name as the exit code: exit 1 and a stack trace.
        assert.equal(await app.waitExit(), 0)
        await app.waitFor(() => app.output().includes('Resume this conversation with: clued --resume s1'))
        assert.ok(!app.output().includes('ERR_INVALID_ARG_TYPE'))
      })
  })

  test('clued needs a terminal', () => {
    const r = spawnSync(process.execPath, ['--no-warnings', MAIN], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: '/tmp/clued-no-home' } })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /clued needs a terminal\./)
  })
})
