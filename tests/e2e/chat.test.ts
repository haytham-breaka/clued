// The chat: sending, replies (whole, split, streamed, early), Claude's work, Markdown, failures, queueing.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chatRowsWith, rowOf, withApp } from './harness.ts'

describe('chat', () => {
  test('sends a message and shows the reply, quoting it', () =>
    withApp({ unfocused: true }, async app => {
      // The empty chat says hello.
      assert.match(app.screen(), /clued {2}on Claude Code/)
      await app.send('hello there')
      // Settled: the answer in its bubble, and the message answered in the panel (a slow runner can
      // paint the streamed words a frame before).
      const s = await app.waitFor(s => s.includes('Echo: hello there') && /✓ hello there +↩/.test(s))
      assert.ok(rowOf(s, '╭─ ● new  ↩ “hello there”'), 'the reply quotes the message and is new')
      assert.match(rowOf(s, 'Your recent messages'), /\?  ⌕  1/)
      assert.match(s, /✓ hello there +↩ \d\d:\d\d/)
      assert.match(s, /1 next ▸/)
      assert.match(s, / Fake 1\.0 {2}s1/)
      // What went to Claude: the text, and the hidden note naming its topic.
      const [sent] = app.sent()
      assert.equal(sent!.text, 'hello there')
      assert.match(sent!.note, /^\[clued\] This message is topic T1\./)
      const start = app.claudeLog()[0]
      assert.deepEqual(start.args.slice(0, 5), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json'])
      assert.ok(start.args.includes('--append-system-prompt'))
      // The app keeps its state for the session, and logs what it sent.
      await app.waitFor(() => app.read('home/.clued/sessions/s1.json').includes('"T1"'))
      assert.match(app.read('home/.clued/sent.log'), /sent \{"session":"s1","topic":"T1","text":"hello there"/)
    }))

  test('short parts of a reply keep their bubble, each quoting its message', () =>
    withApp({ unfocused: true }, async app => {
      for (const m of ['alpha', 'beta']) {
        await app.send(m)
        await app.waitFor(`Echo: ${m}`)
      }
      await app.send('short answers please')
      const s = await app.waitFor('Long line 4 of the last answer.')
      const div = app.divider()
      const lines = s.split('\n').map(l => [...l].slice(div + 1).join(''))
      const one = lines.findIndex(l => l.includes('Short answer 1.'))
      assert.ok(one > 0, 'the short part is shown')
      assert.ok(lines[one]!.includes('│'), 'in a box')
      assert.ok(lines[one - 1]!.includes('╭─') && lines[one - 1]!.includes('↩ “alpha”'), 'its bubble quotes its message')
    }))

  test('a reply the tag settled but that never arrived is asked for again, once, by the app', () =>
    withApp({ unfocused: true }, async app => {
      await app.send('think it only')
      const s = await app.waitFor('Here is the reply to T1 again.')
      assert.match(s, /↻ asked Claude again for a reply that never arrived/)
      assert.match(s, /✓ think it only/)
      assert.ok(!s.includes('⚠'), 'no longer shown as lost')
      // What went to Claude: one message naming it.
      const asks = app.sent().filter(x => x.text.includes('never reached the app'))
      assert.equal(asks.length, 1)
      assert.match(asks[0]!.text, /Your reply to T1 never reached the app.*<<reply T1>>/)
    }))

  test('a reply in two parts with <<reply T1>>: one bubble each, quoting its own message', () =>
    withApp({ unfocused: true }, async app => {
      await app.send('first message')
      await app.waitFor('Echo: first message')
      await app.send('please split')
      const s = await app.waitFor('And this part answers the split request.')
      const lines = s.split('\n')
      const one = lines.findIndex(l => l.includes('More about your first message: part one.'))
      const two = lines.findIndex(l => l.includes('And this part answers the split request.'))
      assert.ok(one > 0 && two > one)
      assert.ok(lines[one - 1]!.includes('↩ “first message”'), 'part one quotes the first message')
      assert.ok(lines[two - 1]!.includes('↩ “please split”'), 'part two quotes the second')
      assert.ok(!s.includes('<<reply'), 'the marks are not shown')
      // The unread count can trail the reply by a frame: wait for it rather than read it at once.
      const after = await app.waitFor(/3 next ▸/)
      // The first message now has a chain: its own reply and the part answering it later.
      assert.match(rowOf(after, '⛓ chain · 2'), /● answered {2}⛓ chain · 2/)
      // A message with a single reply has its chain link too: one click reads the whole chain.
      assert.match(after, /● answered {2}⛓ chain · 1/)
    }))

  test('streams the reply as it is written, with a caret, then the final bubble', () =>
    withApp({}, async app => {
      await app.send('stream it')
      let s = await app.waitFor('Streaming the answer slowly▍')
      assert.match(s, /Claude is typing…/)
      assert.match(s, /● working/)
      assert.match(s, /Claude is working… you can still send a message \(Esc to interrupt\)/)
      assert.ok(rowOf(s, '╭─ ↩ “stream it”'), 'the live bubble quotes the message')
      app.release('stream')
      // The whole text can show a frame before the turn's end does (still with its caret): wait for the end.
      s = await app.waitFor(x => x.includes('Streaming the answer slowly, now finished.') && x.includes('○ idle'))
      assert.ok(!s.includes('▍'), 'no caret once it is done')
    }))

  test('tool steps fold into one line; Ctrl+O and a click open them', () =>
    withApp({}, async app => {
      await app.send('run a tool')
      let s = await app.waitFor('Ran the tools.')
      assert.match(s, /⚙ 9 steps · ran 1 command · read 1 file · 3 searches · \d+s {2}▸ show/)
      assert.ok(!s.includes('Say hi'))
      app.keys('C-o')
      s = await app.waitFor('$ Say hi ▸')
      assert.match(s, /▾ hide/)
      assert.match(s, /└ hi there/)
      assert.match(s, /Now reading the readme\./)
      assert.match(s, /◔ Read README\.md ▸/)
      assert.match(s, /└ no matches/)
      for (const step of ['Found files **/*.ts', 'Fetched https://example.com', 'Searched the web for clued', 'Updated the plan', 'Skill review', 'github: get_issue'])
        assert.ok(s.includes(step), step)
      // One step opened shows a bash block: a header with a copy button, the command, and its output.
      await app.click('$ Say hi', { area: 'chat' })
      s = await app.waitFor(/bash +⧉ copy/)
      assert.match(s, /\$ echo hi\n.*echo there\n.*hi\n.*there/)
      await app.click('⧉ copy', { area: 'chat' })
      await app.waitClipboard('echo hi\necho there')
      // The folded line closes it again.
      await app.click('▾ hide', { area: 'chat' })
      await app.waitGone('$ Say hi')
      app.keys('C-o')
      await app.waitFor('$ Say hi')
      app.keys('C-o')
      await app.waitGone('$ Say hi')
    }))

  test('/work edits shows file changes as diffs; /work all shows every step; /work goes round', () =>
    withApp({ height: 60 }, async app => {
      await app.send('/work edits')
      await app.waitFor("Claude's work: file changes shown as diffs.")
      await app.send('edit a file')
      let s = await app.waitFor('Edited the files.')
      assert.match(s, /✎ Edited notes\.txt ▾/)
      assert.match(s, /- old line/)
      assert.match(s, /\+ new line/)
      assert.match(s, /  keep me/)
      // Each change has a header row: the path and how many lines it adds and removes.
      assert.match(s, /✎ Edited notes\.txt ▾\n.*notes\.txt +\+1 −1\n.*- old line/)
      assert.match(s, /✎ Wrote fresh\.txt ▾\n.*fresh\.txt +\+1\n.*1 \+ brand new file/)
      assert.match(s, /✎ Edited multi\.txt ▾\n.*multi\.txt +\+2 −2\n.*- a\n.*\+ b\n.*⋯\n.*- c\n.*\+ d/)
      assert.match(s, /✎ Edited nb\.ipynb ▾\n.*nb\.ipynb +\+1\n.*1 \+ print\(1\)/)
      assert.ok(!s.includes('Count to sixty'), 'edits lists only the file changes')
      // The panel's work row switches too.
      await app.click(' all ', { area: 'panel', nth: 1 })
      s = await app.waitFor('Count to sixty ▾')
      assert.match(s, /… 22 more lines, show all/)
      await app.click('… 22 more lines, show all', { area: 'chat' })
      s = await app.waitGone('more lines, show all')
      assert.match(s, /line 59/)
      await app.send('/work')
      s = await app.waitFor("Claude's work: folded into one line.")
      assert.match(s, /⚙ 5 steps · edited 4 files · ran 1 command · \d+s {2}▸ show/)
      // A diff can be folded by a click on its step.
      await app.click('▸ show', { area: 'chat' })
      await app.click('✎ Edited notes.txt', { area: 'chat' })
      await app.waitFor('- old line')
    }))

  test('an early reply shows at once, before the work ends, and keeps its place', () =>
    withApp({}, async app => {
      await app.send('early reply')
      const s = await app.waitFor('All finished after the early answer.')
      const lines = s.split('\n')
      const early = lines.findIndex(l => l.includes('Here is an early answer.'))
      const last = lines.findIndex(l => l.includes('All finished after the early answer.'))
      assert.ok(early > 0 && last > early)
      assert.match(s, /⚙ 1 step · ran 1 command/)
    }))

  test('a reply part Claude finished shows at once, also while your next message waits in queue', () =>
    withApp({}, async app => {
      await app.send('part then pause')
      await app.waitFor('First step  1 step')
      await app.send('A second message.')
      await app.waitFor('queued: Claude reads it at its next step')
      // The part is written, the next step hasn't started: the part shows, under its own message.
      app.release('part')
      const s = await app.waitFor('The part written before the pause.')
      assert.match(s, /↩ “part then pause”/)
      // Claude Code hasn't taken the next message in yet: it still waits, honestly marked.
      assert.match(s, /queued: Claude reads it at its next step/)
      // Its tag settled it: answered in the panel too, with the answer under it.
      assert.match(s, /✓ part then pause/)
      assert.match(rowOf(s, '✓ part then pause'), /↩/)
      app.release('pause')
      const end = await app.waitFor('Finished after the pause.')
      assert.equal(chatRowsWith(end, 'The part written before the pause.'), 1, 'shown once')
      assert.ok(!end.includes('queued: Claude reads it'), 'taken in at the next step')
    }))

  test('a turn that ends on a part already shown: it is the answer, shown once', () =>
    withApp({}, async app => {
      await app.send('end on a part')
      const s = await app.waitFor(s => s.includes('The only part.') && s.includes('○ idle'))
      assert.equal(chatRowsWith(s, 'The only part.'), 1, 'shown once')
      assert.match(s, /✓ end on a part/)
    }))

  test('an early reply that only streamed is kept as its own reply, and its message is answered', () =>
    withApp({}, async app => {
      // Its <<reply>> text and tag come only as deltas, then a tool runs, then the turn ends with a tag
      // and no reply of its own.
      await app.send('a reply in deltas only')
      const s = await app.waitFor(s => /✓ a reply in deltas only/.test(s) && s.includes('○ idle'))
      const lines = s.split('\n')
      const head = lines.findIndex(l => l.includes('╭─') && l.includes('↩ “a reply in deltas only”'))
      const early = lines.findIndex(l => l.includes('An early part that only streamed.'))
      assert.ok(head > 0 && early === head + 1, 'the streamed part is a reply to the message')
      assert.ok(!s.includes('<clued>') && !s.includes('<<reply'), 'its marks are not shown')
      assert.ok(!s.includes('reply lost') && !s.includes('no reply arrived'), 'not marked reply lost')
    }))

  test('Markdown in a reply: headings, lists, quotes, code with copy, tables', () =>
    withApp({ height: 50 }, async app => {
      await app.send('long answer')
      const s = await app.waitFor('The end.')
      for (const bit of ['A heading', 'Some bold, italic, code and a link (https://example.com).', '• one', '◦ nested', '1. first', '☑ done item', '▎ a quote more quote', ' ts', 'const x = 1', 'a   │ b', '────'])
        assert.ok(s.includes(bit), bit)
      await app.click('⧉ copy', { area: 'chat' })
      await app.waitClipboard('const x = 1')
      await app.waitFor('Copied.')
    }))

  test('a failed turn says so; when Claude Code stops, the next message starts it again', () =>
    withApp({}, async app => {
      await app.send('please fail')
      let s = await app.waitFor('✕ Something went wrong on purpose')
      assert.match(rowOf(s, 'please fail'), /please fail/)
      await app.send('crash now')
      s = await app.waitFor('✕ Claude Code stopped (exit 3): fatal: fake crash. Send a message to start it')
      assert.match(s, /✕ crash now/)
      await app.send('hello again')
      await app.waitFor('Echo: hello again')
      const starts = app.claudeLog().filter(e => e.args)
      assert.equal(starts.length, 2, 'a second claude was started')
      // On the same session.
      assert.deepEqual(starts[1].args.slice(-2), ['--resume', 's1'])
    }))

  test('Claude reacts to a message from its tag', () =>
    withApp({}, async app => {
      await app.send('react to this')
      const s = await app.waitFor('✅ Claude')
      assert.match(rowOf(s, '✅ Claude'), /✅ Claude {2}↪? ?[●↪] answered/)
    }))

  test('a message sent as Claude writes its last words gets a turn of its own: its answer counts, no asking again', () =>
    withApp({ unfocused: true }, async app => {
      await app.send('wrap up late')
      await app.waitFor('Build it')
      await app.send('one more question')
      await app.waitFor('⏸ queued')
      app.release('wrap')
      let s = await app.waitFor('Echo: one more question')
      s = await app.waitFor(/✓ one more question/)
      await new Promise(r => setTimeout(r, 800))
      s = app.screen()
      assert.ok(!s.includes('asked Claude again'), 'its answer counted: no asking again')
      assert.ok(!app.sent().some(x => x.text.includes('never reached the app')))
      // The chat side only (right of the panel's divider).
      const div = app.divider()
      const chat = s.split('\n').map(l => [...l].slice(div + 1).join(''))
      assert.equal(chat.filter(l => l.includes('Echo: one more question')).length, 1, 'shown once')
      // Each answer quotes only its own message; the second isn't a "follow-up".
      assert.ok(chat.some(l => l.includes('↩ “wrap up late”')) && !chat.some(l => l.includes('↩ 2 messages')), 'the first answer is for the first message only')
      assert.ok(chat.some(l => l.includes('↩ “one more question”')))
      assert.ok(!s.includes('followed up'))
    }))

  test('a message sent while Claude works is queued, then answered with the work', () =>
    withApp({}, async app => {
      await app.send('hold on')
      let s = await app.waitFor('Slow work')
      // Claude Code took the first one in: ✓✓ under it.
      assert.match(s, /✓✓/)
      assert.ok(!s.includes('✓ sent') && !s.includes('◌ sending'))
      await app.send('and another thing')
      s = await app.waitFor('⏸ queued: Claude reads it at its next step')
      assert.match(s, /Claude is working… your next message is queued ↓/)
      // Written to Claude Code, not taken in yet: ✓ sent, until Claude's next step.
      assert.match(rowOf(s, '⏸ queued'), /⏸ queued: Claude reads it at its next step +✓ sent/)
      app.release('slow')
      s = await app.waitFor('Also got: and another thing')
      assert.match(s, /The slow work is done\./)
      assert.ok(!s.includes('⏸ queued'))
      assert.ok(!s.includes('✓ sent'), 'both taken in')
      // Claude Code echoed it with the id it was sent with.
      const sent = app.claudeLog().filter(e => e.type === 'user')
      assert.equal(sent.length, 2)
      assert.ok(sent.every(e => /^[0-9a-f-]{36}$/.test(e.uuid)))
      // The one sent while Claude worked says so in its note, and asks for its own reply part; the first doesn't.
      const notes = app.sent().map(m => m.note)
      assert.doesNotMatch(notes[0]!, /Sent while you were working/)
      assert.match(notes[1]!, /Sent while you were working on T1: answer it in its own part \(<<reply T2>>\)/)
      // And the system prompt says why.
      const start = app.claudeLog()[0].args as string[]
      assert.match(start[start.indexOf('--append-system-prompt') + 1]!, /A message the user sends while you work reaches you at your next step/)
      // Both messages are answered.
      assert.match(s, /✓ and another thing/)
      assert.match(s, /✓ hold on/)
    }))

  test('a queued message Claude Code takes in is no longer in queue: Claude is on it', () =>
    withApp({}, async app => {
      await app.send('two steps please')
      await app.waitFor('First step')
      await app.send('and one more')
      let s = await app.waitFor(/⏳ and one more +in queue/)
      app.release('step1')
      // Taken in at the step's end (✓✓), the second step still running.
      s = await app.waitFor(s => s.includes('Second step') && !s.includes('✓ sent'))
      assert.doesNotMatch(s, /and one more +in queue/)
      assert.ok(!s.includes('⏸ queued'))
      app.release('step2')
      s = await app.waitFor('Also got: and one more')
      assert.match(s, /✓ and one more/)
    }))

  test('a message Claude Code never echoes back stays ✓ sent: received means Claude Code took it in', () =>
    withApp({ env: { FAKE_NO_ECHO: '1' } }, async app => {
      await app.send('hello there')
      const s = await app.waitFor('Echo: hello there')
      assert.match(s, /✓ sent/)
      assert.ok(!s.includes('✓✓'))
    }))

  test('Esc interrupts Claude while it works', () =>
    withApp({}, async app => {
      await app.send('hold on')
      await app.waitFor('Slow work')
      app.keys('Escape')
      await app.waitFor('Interrupted.')
      await app.waitLog(e => e.type === 'control_request' && e.request?.subtype === 'interrupt')
      await app.waitFor('○ idle')
      // Ctrl+C interrupts too, while it works.
      await app.send('hold on again')
      await app.waitFor('● working')
      app.keys('C-c')
      await app.waitFor(() => app.claudeLog().filter(e => e.request?.subtype === 'interrupt').length === 2)
    }))

  test('a message Claude tags as about an earlier one is linked to it', () =>
    withApp({}, async app => {
      await app.send('the original question')
      await app.waitFor('Echo: the original question')
      await app.send('about earlier')
      // The toast and the link can land on different frames.
      await app.waitFor('Linked to your earlier message.')
      await app.waitFor('↩ about: “the original question”')
    }))

  test('a reply that never arrived is flagged, and can be asked for again', () =>
    withApp({}, async app => {
      await app.send('lose my reply')
      // The app asked again by itself, once; that reply went astray too, so it is still flagged.
      let s = await app.waitFor(x => x.includes('⚠ no reply arrived · ↻ ask again') && x.includes('wrong message again'))
      assert.match(s, /⚠ lose my reply +reply lost/)
      assert.equal(app.sent().filter(x => x.text.includes('never reached the app')).length, 1)
      await app.click('↻ ask again', { area: 'chat' })
      s = await app.waitFor('never reached the app')
      const last = app.sent().at(-1)!
      assert.match(last.text, /^Your reply to this message \(T1\) never reached the app: .* starting with <<reply T1>>\.$/)
      assert.match(last.note, /The user is replying to their own message:\n> lose my reply/)
    }))

  test('/results hides the work; the panel switch does the same', () =>
    withApp({}, async app => {
      await app.send('run a tool')
      await app.waitFor('⚙ 9 steps')
      await app.send('/results')
      await app.waitGone('⚙ 9 steps')
      await app.click(' all ', { area: 'panel' })
      await app.waitFor('⚙ 9 steps')
      await app.click(' results ', { area: 'panel' })
      await app.waitGone('⚙ 9 steps')
    }))
})
