// clued's own /help, /status, /plan, /copy, /export and /diff: headless Claude Code refuses them
// ("/help isn't available in this environment"), so the app runs them itself and sends nothing.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rowOf, withApp } from './harness.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], { encoding: 'utf8' })

describe('clued\'s own commands', () => {
  test('/help lists clued\'s commands and Claude Code\'s with their descriptions; /status says what the app knows', () =>
    withApp({}, async app => {
      await app.send('/help')
      let s = await app.waitFor('╭ help')
      // clued's own, with their arguments and what they do.
      assert.match(rowOf(s, '/export [file]'), /the chat as Markdown/)
      assert.match(rowOf(s, '/plan [description]'), /plan mode/)
      assert.match(s, /\/btw <question>/)
      // Claude Code's, from its answer to the initialize request (descriptions and argument hints).
      app.keys('PageDown', 'PageDown', 'PageDown')
      s = await app.waitFor(/Esc closes this\.\n/)
      assert.match(rowOf(s, '/compact <optional custom'), /Clear conversation history but keep a summary/)
      assert.match(rowOf(s, '/cost'), /Show the total cost and duration/)
      // A command clued runs itself is listed once, as clued's.
      assert.doesNotMatch(s, /free up context/)
      app.keys('End')
      // Nothing went to Claude.
      assert.deepEqual(app.sent(), [])
      app.keys('Escape')
      await app.waitGone('╭ help')

      await app.send('/status')
      s = await app.waitFor('╭ status')
      assert.match(rowOf(s, '9.9.9'), /│ Claude Code +9\.9\.9-fake/)
      assert.match(rowOf(s, 'Session'), /s1/)
      assert.match(rowOf(s, 'Account'), /you@example\.com · Claude Max/)
      assert.match(rowOf(s, 'Model'), /claude-fake-1-0 · Fake 1\.0 · for tests/)
      assert.match(rowOf(s, 'Permission mode'), /default: asks before edits and commands/)
      assert.match(rowOf(s, 'MCP servers'), /✔ fake-docs/)
      assert.match(s, /△ fake-mail \(needs-auth\)/)
      assert.match(rowOf(s, 'Folder'), /clued-e2e-.*\/work/)
      // Once more: the card is replaced, not doubled.
      await app.send('/status')
      await app.settle()
      assert.equal(app.screen().split('\n').filter(l => l.includes('╭ status')).length, 1)
      await app.click('✕ close', { area: 'chat' })
      await app.waitGone('╭ status')
      assert.deepEqual(app.sent(), [])
      // Both are in the slash menu.
      app.type('/he')
      await app.waitFor(/│ {2}\/help$/m)
      app.keys('C-u')
      app.type('/sta')
      await app.waitFor(/│ {2}\/status$/m)
    }))

  test('/plan sets plan mode, then sends the description as a message', () =>
    withApp({}, async app => {
      await app.send('/plan design the cache')
      await app.waitFor('Echo: design the cache')
      await app.waitFor('⏸ plan mode on')
      const log = app.claudeLog()
      const mode = log.findIndex(e => e.request?.subtype === 'set_permission_mode' && e.request.mode === 'plan')
      const msg = log.findIndex(e => e.type === 'user')
      assert.ok(mode >= 0 && mode < msg, 'plan mode goes before the message')
      assert.equal(app.sent()[0]!.text, 'design the cache')
      await app.send('/plan')
      await app.waitFor('Already in plan mode.')
      assert.equal(app.sent().length, 1)
    }))

  test('/copy copies Claude\'s last reply, or the Nth back', () =>
    withApp({}, async app => {
      await app.send('/copy')
      await app.waitFor('Claude hasn\'t replied yet')
      await app.send('first one')
      await app.waitFor('Echo: first one')
      await app.send('second one')
      await app.waitFor('Echo: second one')
      await app.send('/copy')
      await app.waitClipboard('Echo: second one')
      await app.waitFor('Copied Claude\'s last reply (1 lines).')
      await app.send('/copy 2')
      await app.waitClipboard('Echo: first one')
      await app.waitFor('Copied Claude\'s 2nd last reply')
      await app.send('/copy 5')
      await app.waitFor('Claude has replied 2 times in this chat: /copy 2 is the first reply.')
      await app.send('/copy x')
      await app.waitFor('Usage: /copy [N]')
      assert.deepEqual(app.sent().map(m => m.text), ['first one', 'second one'])
    }))

  test('/export writes the chat as Markdown to a file, or offers the clipboard', () =>
    // Wide enough for its toasts, the temp path and all (macOS's is /private/tmp/…).
    withApp({ width: 130 }, async app => {
      await app.send('/export')
      await app.waitFor('Nothing to export yet')
      await app.send('first message here')
      await app.waitFor('Echo: first message here')
      // A file named: written there (.md added), and said where.
      await app.send('/export chat')
      await app.waitFor(/Exported the chat to .*\/work\/chat\.md/)
      const md = readFileSync(join(app.work, 'chat.md'), 'utf8')
      assert.match(md, /^# first message here\n/)
      assert.match(md, /## You · \d{4}-\d\d-\d\d \d\d:\d\d\n\nfirst message here\n\n## Claude\n\nEcho: first message here\n/)
      assert.match(md, /session s1/)
      assert.doesNotMatch(md, /<clued>|topics/)
      // A folder that isn't there: said so.
      await app.send('/export nowhere/at/all.md')
      await app.waitFor('Couldn\'t export to')
      await app.waitFor('no such folder')
      // No file: as Claude Code does, a choice between the clipboard and a file.
      await app.send('/export')
      let s = await app.waitFor('╭ export')
      assert.match(s, /1 message of yours and 1 reply of Claude's/)
      const name = s.match(/⤓ save to (\d{4}-\d\d-\d\d-first-message-here\.md)/)![1]!
      await app.click('⤓ save to', { area: 'chat' })
      await app.waitFor(`Exported the chat to`)
      await app.waitGone('╭ export')
      assert.ok(existsSync(join(app.work, name)))
      // Never over another file: the next one gets a number.
      await app.send('/export')
      s = await app.waitFor('╭ export')
      assert.match(s, /-first-message-here-2\.md/)
      await app.click('⧉ copy to the clipboard', { area: 'chat' })
      await app.waitFor('Copied the chat as Markdown.')
      assert.match(app.clipboard(), /^# first message here\n[\s\S]*Echo: first message here\n$/)
      assert.equal(readdirSync(app.work).filter(f => f.endsWith('.md')).length, 2)
      assert.deepEqual(app.sent().map(m => m.text), ['first message here'])
    }))

  test('/diff shows the uncommitted changes as diffs; says so outside a repository or when clean', () =>
    withApp({}, async app => {
      await app.send('/diff')
      await app.waitFor('Not a git repository')
      git(app.work, 'init', '-q')
      writeFileSync(join(app.work, 'notes.txt'), 'old line\nkeep me\n')
      git(app.work, 'add', '.')
      git(app.work, 'commit', '-qm', 'first')
      await app.send('/diff')
      await app.waitFor('Nothing uncommitted: the working tree is clean.')
      writeFileSync(join(app.work, 'notes.txt'), 'new line\nkeep me\n')
      writeFileSync(join(app.work, 'fresh.txt'), 'brand new\n')
      await app.send('/diff')
      const s = await app.waitFor('╭ diff')
      assert.match(rowOf(s, '╭ diff'), /2 files changed, \+2 −1, uncommitted in/)
      assert.match(rowOf(s, 'notes.txt'), /\+1 −1/)
      assert.match(s, /- old line/)
      assert.match(s, /\+ new line/)
      assert.match(rowOf(s, 'fresh.txt'), /\(new, untracked\)/)
      assert.match(s, /\+ brand new/)
      assert.deepEqual(app.sent(), [])
      app.keys('Escape')
      await app.waitGone('╭ diff')
      // Back to the empty chat's hello.
      await app.waitFor(/clued {2}on Claude Code/)
    }))
})
