// Slash commands drawn in their own colour, as Claude Code does: in the box as you type, and in your sent message.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { withApp } from './harness.ts'
import { C } from '../../app/text.ts'

/** The command's colour, as the terminal got it. */
const CMD = `38;5;${C.command}m`
const rowWith = (rows: string[], text: string) => rows.find(r => r.replace(/\x1b\[[0-9;]*m/g, '').includes(text)) ?? ''

describe('slash commands', () => {
  test('a known command is drawn in its colour, its arguments plain; a typo or a path stays plain', () =>
    withApp({ unfocused: true }, async app => {
      await app.send('hello there')
      await app.waitIdle('Echo: hello there')
      // In the box: the command coloured, what follows it not.
      app.type('/compact keep the plan')
      await app.waitFor('│ /compact keep the plan')
      let row = rowWith(app.styled(), '│ /compact keep the plan')
      assert.match(row, new RegExp(`${CMD.replace('[', '\\[')}/compact\\x1b\\[[0-9;]*m keep the plan`), JSON.stringify(row))
      // An unknown command: plain, so the typo shows.
      app.keys('C-u')
      app.type('/compcat keep it')
      await app.waitFor('│ /compcat keep it')
      row = rowWith(app.styled(), '│ /compcat keep it')
      assert.ok(!row.includes(CMD), JSON.stringify(row))
      // A path is not a command.
      app.keys('C-u')
      app.type('/tmp/x is a file')
      await app.waitFor('│ /tmp/x is a file')
      assert.ok(!rowWith(app.styled(), '│ /tmp/x is a file').includes(CMD))
      // Arabic after the command: the row is drawn reordered by the app (on the right), the command still coloured.
      app.keys('C-u')
      app.type('/btw ما هذا')
      await app.waitFor(s => s.includes('/btw │') && !s.includes('/tmp/x'))
      const rtl = rowWith(app.styled(), '/btw │')
      assert.match(rtl, new RegExp(`${CMD.replace('[', '\\[')}/btw\\x1b\\[`), JSON.stringify(rtl))
      assert.ok(!/38;5;105m[^\x1b]*[\ufe70-\ufeff]/.test(rtl), 'the Arabic is not coloured')
      // Sent: your message's bubble shows the command the same way.
      app.keys('C-u')
      await app.send('/compact keep the plan')
      await app.waitIdle('Echo: /compact keep the plan')
      const rows = app.styled()
      const bubble = rowWith(rows, '│ /compact keep the plan │')
      assert.match(bubble, new RegExp(`${CMD.replace('[', '\\[')}/compact\\x1b\\[[0-9;]*m keep the plan`), JSON.stringify(bubble))
      // Claude's reply quoting it is Claude's words: not coloured.
      assert.ok(!rowWith(rows, 'Echo: /compact').includes(`${CMD}/compact`))
    }))
})
