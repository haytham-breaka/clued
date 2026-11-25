import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyBoard, keyOf } from '../../hooks/model.ts'
import { answerGist, assignParts, lostRepliesAsked, hasMarks, inbox, lostRepliesPrompt, matches, partId, preview, questionOf, questionsOf, REPLY_GUIDE, splitAnswer, STALE_MS, stripMarks, topicOfKey } from '../../app/inbox.ts'
import type { Turn } from '../../app/session.ts'
import type { Board, Topic } from '../../types/index.d.ts'

const NOW = 1_700_000_000_000

function turn(text: string, extra: Partial<Turn> = {}): Turn {
  return { key: keyOf(text), text, at: NOW, steps: [], live: '', pending: '', isDone: true, isOpen: false, ...extra }
}
const topic = (id: string, keys: string[], status: Topic['status'], extra: Partial<Topic> = {}): Topic => ({ id, title: id, threadId: 0, status, messageKeys: keys, updatedAt: NOW, ...extra })
const boardOf = (...topics: Topic[]): Board => ({ ...emptyBoard(), topics })

describe('reply marks', () => {
  test('hasMarks and stripMarks', () => {
    assert.equal(hasMarks('<<reply T1>>\nhi'), true)
    assert.equal(hasMarks('say <<reply T1>> inline'), false)
    assert.equal(stripMarks('<<reply T1>>\nhi\n\n\n\n<<reply T2,T3>>\nthere'), 'hi\n\nthere')
    assert.match(REPLY_GUIDE, /<<reply T43>>/)
  })
  test('splitAnswer splits at marks; text before the first mark goes to the fallback', () => {
    const parts = splitAnswer('Intro\n<<reply t1>>\nOne\n<<reply T2, T3>>\nTwo\n<<reply nonsense>>\nThree\n<clued>{}</clued>', ['T9'])
    assert.deepEqual(parts, [
      { to: ['T9'], text: 'Intro' },
      { to: ['T1'], text: 'One' },
      { to: ['T2', 'T3'], text: 'Two' },
      { to: ['T9'], text: 'Three' },
    ])
  })
  test('a numbered question names its message and remembers which', () => {
    assert.deepEqual(splitAnswer('<<reply T90.2>>\nThe second one.', []), [{ to: ['T90'], text: 'The second one.', subs: ['T90.2'] }])
    assert.deepEqual(splitAnswer('', ['T1']), [])
  })
})

describe('asking again for replies that never arrived', () => {
  test('one message names them all, and how to write each', () => {
    assert.equal(lostRepliesPrompt(['T3']), 'Your reply to T3 never reached the app: it shows no answer to it. Write it again now as reply text, in a part starting with <<reply T3>>.')
    assert.match(lostRepliesPrompt(['T2', 'T5']), /^Your replies to T2, T5 never reached the app: it shows no answer to them\. Write each of them again now as reply text, each in its own part/)
    // Read back from the session file: the ids it asked for, and nothing for other text.
    assert.deepEqual(lostRepliesAsked(lostRepliesPrompt(['T2', 'T5'])), ['T2', 'T5'])
    assert.deepEqual(lostRepliesAsked(lostRepliesPrompt(['T3'])), ['T3'])
    assert.equal(lostRepliesAsked('Your reply to this message (T3) never reached the app: it shows no answer.'), undefined)
  })
})

describe('the gist of an answer', () => {
  test('its first sentence, without the words that restate your message, cut to fit', () => {
    assert.equal(answerGist('What port does server.toml use?', 'The port in server.toml is 8137. It is set on line 3.', 30), '8137.')
    assert.equal(answerGist('Who is the maintainer?', 'Done: the maintainer named in the README is **Dana Reyes**.', 40), 'named in the README is Dana Reyes.')
    // Nothing restated: the sentence as it is; too long: cut.
    assert.equal(answerGist('Set nails to 100.', 'I set nails to 100 in stock.csv, up from 120.', 20), 'I set nails to 100…')
    // A request: the thing it changed stays, as a label.
    assert.equal(answerGist('Set workers in server.toml to 8.', 'Done: workers in server.toml is now 6, per your correction.', 32), 'workers: now 6, per your correc…')
    assert.equal(answerGist('Set the tax rate in pricing.py to 0.2.', 'The tax rate in pricing.py is now 0.2.', 40), 'tax rate: now 0.2.')
    // Everything restated: the last word stays.
    assert.equal(answerGist('workers is 8?', 'workers is 8.', 20), '8.')
  })
})

describe('questions', () => {
  test('questionsOf lists them only when there are several', () => {
    assert.deepEqual(questionsOf('What is it? And why is it here? ok?'), ['What is it?', 'And why is it here?'])
    assert.deepEqual(questionsOf('Just one question here?'), [])
  })
  test('questionOf: the last sentence, when it asks', () => {
    assert.equal(questionOf('Done.\n- **Shall I** go on?'), 'Shall I go on?')
    assert.equal(questionOf('Is it? No, it is done.'), undefined)
    assert.equal(questionOf('```\nwhat?\n```'), undefined)
  })
  test('preview makes one plain line', () => {
    assert.equal(preview('# Title\n- **bold** and `code` [link](https://example.com)\n```\ncode\n```\n<clued>{}</clued>'), 'Title bold and code link')
    assert.equal(preview('x'.repeat(100), 10), 'xxxxxxxxx…')
  })
  test('matches needs every word, any case', () => {
    assert.equal(matches('Fix the Login bug', 'login fix'), true)
    assert.equal(matches('Fix the Login bug', 'logout'), false)
    assert.equal(matches('anything', '  '), true)
  })
})

describe('assignParts', () => {
  test('unmarked text answers every message since the last answer', () => {
    const a = turn('first', { topicId: 'T1' })
    const b = turn('second', { topicId: 'T2', answer: 'Both done.' })
    const c = turn('third', { topicId: 'T3', answer: '<<reply T3>>\nThird.' })
    assignParts([a, b, c], emptyBoard())
    assert.deepEqual(b.parts, [{ to: ['T1', 'T2'], text: 'Both done.', id: `${b.key}:0` }])
    assert.deepEqual(c.parts?.map(p => p.to), [['T3']])
    assert.equal(a.parts, undefined)
  })
  test('early replies come first, the same words twice get their own ids, follow-ups answer their messages', () => {
    const a = turn('yes', { topicId: 'T1', early: ['<<reply T1>>\nEarly.'], answer: '<<reply T1>>\nFinal.' })
    const b = turn('yes', { topicId: 'T2', answer: 'Again.' })
    const f = turn('', { key: 'follow-1', followUp: [b.key], answer: 'Agent done.' })
    const r = turn('[clued reaction] 👍', { reaction: '👍' })
    assignParts([a, b, f, r], emptyBoard())
    assert.deepEqual(a.parts?.map(p => [p.id, p.text]), [[`${a.key}:0`, 'Early.'], [`${a.key}:1`, 'Final.']])
    assert.equal(b.parts?.[0]!.id, `${b.key}~1:0`)
    assert.deepEqual(f.parts?.[0]!.to, ['T2'])
    assert.equal(partId(b, 0), `${b.key}~1:0`)
    assert.equal(partId(r, 3), `${r.key}:3`)
  })
  test('a message without its own id uses the topic holding it', () => {
    const a = turn('old message', { answer: 'Answer.' })
    const board = boardOf(topic('T7', [a.key], 'done'))
    assignParts([a], board)
    assert.deepEqual(a.parts?.[0]!.to, ['T7'])
    assert.equal(topicOfKey(board, a.key), 'T7')
    assert.equal(topicOfKey(board, 'nope'), undefined)
  })
})

describe('inbox', () => {
  const live = (extra: Partial<Parameters<typeof inbox>[3] & object> = {}) => ({ isWorking: false, busy: new Set<string>(), now: NOW, ...extra })

  test('unread parts, and questions waiting on you', () => {
    const a = turn('which one', { topicId: 'T1', answer: 'A or B. Which do you want?', durationMs: 2000 })
    const board = boardOf(topic('T1', [a.key], 'me'))
    assignParts([a], board)
    const box = inbox([a], board, new Set(), live())
    assert.equal(box.unread.length, 1)
    assert.equal(box.unread[0]!.preview, 'A or B. Which do you want?')
    assert.deepEqual(box.waiting.map(w => w.question), ['Which do you want?'])
    assert.equal(box.messages[0]!.state, 'me')
    assert.equal(box.messages[0]!.event, 'replied')
    assert.equal(box.messages[0]!.updatedAt, NOW + 2000)
    assert.equal(inbox([a], board, new Set([a.parts![0]!.id!])).unread.length, 0)
  })

  test('a waiting topic whose part asks nothing shows the preview', () => {
    const a = turn('do it', { topicId: 'T1', answer: 'Check the result.' })
    const board = boardOf(topic('T1', [a.key], 'me'))
    assignParts([a], board)
    assert.equal(inbox([a], board, new Set()).waiting[0]!.question, 'Check the result.')
  })

  test('every message state', () => {
    const working = turn('working on it', { topicId: 'T1', isDone: false })
    const st = (t: Turn[], b: Board, l = live()) => {
      assignParts(t, b)
      return inbox(t, b, new Set(), l).messages.find(m => m.turn === t[0])!
    }
    assert.equal(st([working], boardOf(topic('T1', [working.key], 'claude', { isProvisional: true }))).state, 'claude')
    const owes = turn('owes', { topicId: 'T1', answer: 'On it.' })
    assert.equal(st([owes], boardOf(topic('T1', [owes.key], 'claude'))).state, 'progress')
    const done = turn('finished', { topicId: 'T1', answer: 'Done.' })
    assert.equal(st([done], boardOf(topic('T1', [done.key], 'done'))).state, 'done')
    const failed = turn('broke', { topicId: 'T1', error: 'boom' })
    assert.equal(st([failed], boardOf(topic('T1', [failed.key], 'claude', { isProvisional: true }))).state, 'failed')
    const none = turn('silence', { topicId: 'T1' })
    assert.equal(st([none], boardOf(topic('T1', [none.key], 'claude', { isProvisional: true }))).state, 'none')
    const lost = turn('lost one', { topicId: 'T1' })
    assert.equal(st([lost], boardOf(topic('T1', [lost.key], 'done'))).state, 'lost')
    const reacted = turn('thanks', { topicId: 'T1' })
    assert.equal(st([reacted], boardOf(topic('T1', [reacted.key], 'done')), live({ reacted: new Set([reacted.key]) })).state, 'done')
    const agent = turn('agent on it', { topicId: 'T1' })
    assert.equal(st([agent], boardOf(topic('T1', [agent.key], 'claude', { isProvisional: true })), live({ busy: new Set([agent.key]) })).state, 'progress')
  })

  test('in progress with nothing working on it for a while is stale', () => {
    const owes = turn('owes', { topicId: 'T1', answer: 'On it.' })
    const board = boardOf(topic('T1', [owes.key], 'claude'))
    assignParts([owes], board)
    assert.equal(inbox([owes], board, new Set(), live({ now: NOW + STALE_MS + 1 })).messages[0]!.stale, true)
    assert.equal(inbox([owes], board, new Set(), live({ now: NOW + STALE_MS + 1, isWorking: true })).messages[0]!.stale, undefined)
  })

  test('active: Claude\'s turn is on it now, or an agent is; then it is never stale', () => {
    const msg = (m: ReturnType<typeof inbox>) => m.messages[0]!
    // Not answered yet, while Claude works: active; once nothing runs, not.
    const working = turn('working', { topicId: 'T1', isDone: false })
    const wBoard = boardOf(topic('T1', [working.key], 'claude', { isProvisional: true }))
    assert.equal(msg(inbox([working], wBoard, new Set(), live({ isWorking: true }))).active, true)
    assert.equal(msg(inbox([working], wBoard, new Set(), live())).active, undefined)
    // Answered, still owed: active while an agent is on it, however long ago it last moved.
    const owes = turn('owes', { topicId: 'T1', answer: 'On it.' })
    const board = boardOf(topic('T1', [owes.key], 'claude'))
    assignParts([owes], board)
    const busy = msg(inbox([owes], board, new Set(), live({ busy: new Set([owes.key]), now: NOW + STALE_MS + 1 })))
    assert.equal(busy.state, 'progress')
    assert.equal(busy.active, true)
    assert.equal(busy.stale, undefined)
    // Claude working on something else is not working on it: neither active nor stale.
    const other = msg(inbox([owes], board, new Set(), live({ isWorking: true, now: NOW + STALE_MS + 1 })))
    assert.equal(other.active, undefined)
    assert.equal(other.stale, undefined)
    // Nothing on it, for a while: stale (waiting for Claude), not active.
    const idle = msg(inbox([owes], board, new Set(), live({ now: NOW + STALE_MS + 1 })))
    assert.equal(idle.active, undefined)
    assert.equal(idle.stale, true)
    // Done is never active, even while Claude works.
    const done = turn('finished', { topicId: 'T2', answer: 'Done.' })
    const dBoard = boardOf(topic('T2', [done.key], 'done'))
    assignParts([done], dBoard)
    assert.equal(msg(inbox([done], dBoard, new Set(), live({ isWorking: true }))).active, undefined)
  })

  test('history from before the app: the next answer is the reply', () => {
    const a = turn('old question')
    const b = turn('old follow', { answer: 'Old answer.' })
    assignParts([a, b], emptyBoard())
    const box = inbox([a, b], emptyBoard(), new Set())
    assert.ok(box.messages.every(m => m.state === 'done' && m.replyId === b.parts![0]!.id))
  })

  test('reactions, follow-ups and commands are not listed; newest first, ties keep the later on top', () => {
    const a = turn('one', { topicId: 'T1' })
    const b = turn('two', { topicId: 'T2' })
    const r = turn('[clued reaction] 👍', { reaction: '👍' })
    const c = turn('/cost')
    const f = turn('', { key: 'follow-x', followUp: [a.key] })
    const box = inbox([a, b, r, c, f], emptyBoard(), new Set())
    assert.deepEqual(box.messages.map(m => m.turn.text), ['two', 'one'])
  })

  test('in progress first, then in queue (in the order sent), then the rest newest first', () => {
    const old = turn('old done', { topicId: 'T1', answer: 'Done.' })
    const agent = turn('agent on it', { topicId: 'T2', answer: 'Started.', at: NOW + 1 })
    const cur = turn('working on', { topicId: 'T3', at: NOW + 2, isDone: false })
    const q1 = turn('queued one', { topicId: 'T4', at: NOW + 3, queued: true, isDone: false })
    const q2 = turn('queued two', { topicId: 'T5', at: NOW + 4, queued: true, isDone: false })
    // Newest activity of all, but done: it goes after.
    const board = boardOf(topic('T1', [old.key], 'done', { updatedAt: NOW + 60_000 }), topic('T2', [agent.key], 'claude'))
    assignParts([old, agent, cur, q1, q2], board)
    const box = inbox([old, agent, cur, q1, q2], board, new Set(), live({ isWorking: true, busy: new Set([agent.key]) }))
    assert.deepEqual(box.messages.map(m => [m.turn.text, m.active ? 'in progress' : m.queued ? 'in queue' : m.state]), [
      ['working on', 'in progress'],
      ['agent on it', 'in progress'],
      ['queued one', 'in queue'],
      ['queued two', 'in queue'],
      ['old done', 'done'],
    ])
    // Once Claude stops working, nothing is in queue.
    assert.ok(!inbox([old, agent, cur, q1, q2], board, new Set(), live()).messages.some(m => m.queued))
  })

  test('while Claude works, only messages not answered yet are in progress, not old ones answered without naming them', () => {
    const thanked = turn('thanks', { topicId: 'T1' })
    const lost = turn('lost one', { topicId: 'T2', at: NOW + 1 })
    const later = turn('later', { topicId: 'T3', at: NOW + 2, answer: '<<reply T3>>\nLater.' })
    const now = turn('new one', { topicId: 'T4', at: NOW + 3, isDone: false })
    const board = boardOf(topic('T1', [thanked.key], 'done'), topic('T2', [lost.key], 'done'), topic('T3', [later.key], 'done'), topic('T4', [now.key], 'claude', { isProvisional: true }))
    const all = [thanked, lost, later, now]
    assignParts(all, board)
    const box = inbox(all, board, new Set(), live({ isWorking: true, reacted: new Set([thanked.key]) }))
    assert.deepEqual(box.messages.filter(m => m.active).map(m => m.turn.text), ['new one'])
    assert.deepEqual(Object.fromEntries(box.messages.map(m => [m.turn.text, m.state])), { thanks: 'done', 'lost one': 'lost', later: 'done', 'new one': 'claude' })
  })

  test('an agent working for a follow-up merged into a request works on the request too: in progress, not "not started"', () => {
    const ask = turn('add a demo video', { topicId: 'T1', answer: '<<reply T1>>\nWill do.' })
    const go = turn('start it now', { topicId: 'T2', at: NOW + 1, answer: '<<reply T2>>\nStarted.' })
    const other = turn('something else', { topicId: 'T3', at: NOW + 2, answer: '<<reply T3>>\nLater.' })
    const board = boardOf(topic('T1', [ask.key, go.key], 'claude'), topic('T3', [other.key], 'claude'))
    assignParts([ask, go, other], board)
    const box = inbox([ask, go, other], board, new Set(), live({ busy: new Set([go.key]) }))
    const by = Object.fromEntries(box.messages.map(m => [m.turn.text, m.active ? 'active' : m.state]))
    assert.deepEqual(by, { 'add a demo video': 'active', 'start it now': 'active', 'something else': 'progress' })
  })

  test('a status change long after the reply is a status event', () => {
    const a = turn('later', { topicId: 'T1', answer: 'Reply.' })
    const board = boardOf(topic('T1', [a.key], 'done', { updatedAt: NOW + 60_000 }))
    assignParts([a], board)
    assert.equal(inbox([a], board, new Set()).messages[0]!.event, 'status')
    const quiet = turn('quiet', { topicId: 'T1' })
    assert.equal(inbox([quiet], boardOf(topic('T1', [quiet.key], 'claude', { isProvisional: true })), new Set()).messages[0]!.event, 'sent')
  })

  test('a merged message is answered by a part naming the topic it merged into', () => {
    const a = turn('first', { topicId: 'T1', answer: 'First reply.' })
    const b = turn('more', { topicId: 'T2', answer: '<<reply T1>>\nCovers both.' })
    const board = boardOf(topic('T1', [a.key, b.key], 'done'))
    assignParts([a, b], board)
    const box = inbox([a, b], board, new Set())
    assert.equal(box.messages.find(m => m.turn === b)!.replyId, b.parts![0]!.id)
  })
})

describe('a follow-up merged into a topic that waits on you', () => {
  test('waits too only when its own latest reply asks something', () => {
    const first = turn('Add a reorder check; ask me the threshold first.', { topicId: 'T1', answer: 'Which threshold?', parts: [{ to: ['T1'], text: 'Which threshold should it use?' }] })
    const follow = (text: string) => turn('Meanwhile, which host does the server bind to?', { topicId: 'T2', answer: text, parts: [{ to: ['T2'], text }] })
    // Claude's tag merged T2 into T1, whose question is still open.
    const board = boardOf(topic('T1', [first.key, keyOf('Meanwhile, which host does the server bind to?')], 'me'))
    const state = (ts: Turn[]) => Object.fromEntries(inbox(ts, board, new Set()).messages.map(m => [m.turn.text.slice(0, 5), m.state]))
    assert.deepEqual(state([first, follow('It binds to 127.0.0.1.')]), { 'Add a': 'me', Meanw: 'done' })
    // Its own reply asks something: it waits on you as well.
    assert.deepEqual(state([first, follow('There are two hosts. Which one do you mean?')]), { 'Add a': 'me', Meanw: 'me' })
  })

  test('askedBy names the messages whose reply asked, whatever the replies say', () => {
    const first = turn('Add a discount function.', { topicId: 'T1', answer: 'Done. Should I fix member_price?', parts: [{ to: ['T1'], text: 'Done. Should I fix member_price?' }] })
    // The follow-up's reply asks the same question again: it is still the first message's question.
    const follow = turn('Reject negative percentages too.', { topicId: 'T2', answer: 'Done. Should I fix member_price?', parts: [{ to: ['T2'], text: 'Done. Should I fix member_price?' }] })
    const state = (askedBy: string[]) => Object.fromEntries(inbox([first, follow], boardOf(topic('T1', [first.key, follow.key], 'me', { askedBy })), new Set()).messages.map(m => [m.turn.text.slice(0, 5), m.state]))
    assert.deepEqual(state([first.key]), { 'Add a': 'me', Rejec: 'done' })
    // A question the follow-up's reply raised is the follow-up's, not the first message's.
    assert.deepEqual(state([follow.key]), { 'Add a': 'done', Rejec: 'me' })
  })
})
