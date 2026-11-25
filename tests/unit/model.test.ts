import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVE_MS,
  activeThreads,
  answerOfBlock,
  briefFor,
  chainOf,
  chains,
  clipName,
  counts,
  describeThread,
  emptyBoard,
  firstLine,
  flatBrief,
  guessStatus,
  isAsking,
  keyOf,
  KEEP_MS,
  lastAnswerIn,
  parseTag,
  prune,
  raiseTopic,
  reactionPrompt,
  reactionSignal,
  reactionText,
  rootOf,
  settleTurn,
  stripTag,
  threadOfMessage,
  threadsOfAnswer,
  threadTree,
  topicsOf,
} from '../../hooks/model.ts'
import type { Board, Thread } from '../../types/index.d.ts'

const NOW = 1_700_000_000_000
const tag = (o: unknown) => `<clued>${JSON.stringify(o)}</clued>`

/** A board with topics raised from these messages, each unsorted (sent to Main). */
function raised(...texts: string[]): Board {
  let b = emptyBoard()
  for (const text of texts) b = raiseTopic(b, { text, key: keyOf(text), replyTo: null }, NOW).board
  return b
}

describe('keys and lines', () => {
  test('keyOf is stable, ignores surrounding space, differs by text', () => {
    assert.equal(keyOf('hello'), keyOf('  hello \n'))
    assert.notEqual(keyOf('hello'), keyOf('hellO'))
    assert.match(keyOf(''), /^[0-9a-z]+$/)
  })
  test('firstLine cuts to the first line and the length', () => {
    assert.equal(firstLine('one\ntwo'), 'one')
    assert.equal(firstLine('abcdefgh', 5), 'abcd…')
    assert.equal(firstLine('', 5), '')
  })
  test('clipName cuts at a word when it can', () => {
    assert.equal(clipName('short'), 'short')
    assert.equal(clipName('a rather long thread name'), 'a rather long…')
    assert.equal(clipName('abcdefghijklmnopqrstuvwxyz'), 'abcdefghijklmno…')
    assert.equal(clipName('  spaced   out  '), 'spaced out')
  })
})

describe('the tag', () => {
  test('stripTag drops whole and half-streamed tags, old and new names', () => {
    assert.equal(stripTag(`Hi ${tag({ topics: [] })}`), 'Hi')
    assert.equal(stripTag('Hi <threadline>{}</threadline> there'), 'Hi\nthere')
    assert.equal(stripTag('Hi <clued>{"topics":['), 'Hi')
  })
  test('parseTag reads topics, statuses, threads and names', () => {
    const t = parseTag(`x ${tag({ topics: [{ id: 'T1', title: ' A title ', status: 'me', thread: '#2', same_as: 'T0', about: 'T0' }, { id: 'T2', status: 'bogus', thread: 'new' }, { id: 3 }, null, { id: 'T4', title: '  ' }], threads: { '#2': 'Some name', '3': 5 } })}`)
    assert.deepEqual(t, {
      topics: [
        { id: 'T1', title: 'A title', status: 'me', same_as: 'T0', about: 'T0', thread: 2 },
        { id: 'T2', title: undefined, status: undefined, same_as: undefined, about: undefined, thread: 'new' },
        { id: 'T4', title: undefined, status: undefined, same_as: undefined, about: undefined, thread: undefined },
      ],
      threads: { '2': 'Some name' },
    })
  })
  test('parseTag: no tag, bad JSON, no topics', () => {
    assert.equal(parseTag('no tag'), null)
    assert.equal(parseTag('<clued>{bad</clued>'), null)
    assert.deepEqual(parseTag('<clued>{}</clued>'), { topics: [], threads: {} })
  })
  test('guessStatus: a question waits on the user', () => {
    assert.equal(guessStatus('Shall I?'), 'me')
    assert.equal(guessStatus('Done.'), 'done')
  })
})

describe('raising and settling topics', () => {
  test('raiseTopic files a provisional topic waiting on Claude', () => {
    const { board, topicId, threadId } = raiseTopic(emptyBoard(), { text: 'Fix the bug', key: 'k1', replyTo: null }, NOW)
    assert.equal(topicId, 'T1')
    assert.equal(threadId, 0)
    assert.deepEqual(board.topics[0], { id: 'T1', title: 'Fix the bug', threadId: 0, status: 'claude', messageKeys: ['k1'], isProvisional: true, updatedAt: NOW })
    assert.equal(board.nextTopic, 2)
    assert.deepEqual(board.turnTopics, ['T1'])
  })

  test('flat settling sets titles and statuses, and never makes threads', () => {
    const b = raised('one', 'two')
    const { board, nowWaiting } = settleTurn(b, `Which?\n${tag({ topics: [{ id: 'T1', title: 'First', status: 'me' }] })}`, NOW + 1, { flat: true })
    assert.equal(board.threads.length, 0)
    assert.equal(board.topics[0]!.title, 'First')
    assert.equal(board.topics[0]!.status, 'me')
    // Left out of the tag: the guess from the answer (it asks, so me).
    assert.equal(board.topics[1]!.status, 'me')
    assert.equal(board.topics[1]!.isProvisional, undefined)
    assert.deepEqual(nowWaiting.map(t => t.id), ['T1', 'T2'])
    assert.deepEqual(board.turnTopics, [])
    assert.equal(board.answers.at(-1)!.text, 'Which?')
  })

  test('the tag\'s "me" is trusted, with or without a question mark', () => {
    // Claude often says a topic still waits on you in a reply about something else.
    const { board } = settleTurn(raised('x'), `All set.\n${tag({ topics: [{ id: 'T1', status: 'me' }] })}`, NOW, { flat: true })
    assert.equal(board.topics[0]!.status, 'me')
    assert.deepEqual(board.topics[0]!.askedBy, [keyOf('x')])
    // Left out of the tag, the guess still reads the text.
    assert.equal(settleTurn(raised('y'), 'All set.', NOW, { flat: true }).board.topics[0]!.status, 'done')
  })

  test('a follow-up\'s "done" does not settle the question of the topic it continues', () => {
    const asked = settleTurn(raised('Add a discount function'), `Done. Should I fix member_price?\n${tag({ topics: [{ id: 'T1', status: 'me' }] })}`, NOW, { flat: true }).board
    const b = raiseTopic(asked, { text: 'Round it to cents.', key: 'k2', replyTo: null }, NOW + 1).board
    const after = (entries: unknown[]) => settleTurn(b, `Rounded.\n${tag({ topics: entries })}`, NOW + 2, { flat: true }).board.topics
    const merged = after([{ id: 'T2', status: 'done', same_as: 'T1' }])
    assert.deepEqual(merged.map(t => [t.id, t.status]), [['T1', 'me']])
    // Still the first message's question: the follow-up isn't asked anything.
    assert.deepEqual(merged[0]!.askedBy, [keyOf('Add a discount function')])
    // The topic's own entry decides, in either order.
    assert.equal(after([{ id: 'T2', status: 'done', same_as: 'T1' }, { id: 'T1', status: 'done' }])[0]!.status, 'done')
    assert.equal(after([{ id: 'T1', status: 'done' }, { id: 'T2', status: 'done', same_as: 'T1' }])[0]!.status, 'done')
    assert.equal(after([{ id: 'T1', status: 'me' }, { id: 'T2', status: 'done', same_as: 'T1' }])[0]!.status, 'me')
    // The old question settled and the follow-up's reply asks a new one: it is the follow-up's.
    const fresh = after([{ id: 'T1', status: 'done' }, { id: 'T2', status: 'me', same_as: 'T1' }])[0]!
    assert.equal(fresh.status, 'me')
    assert.deepEqual(fresh.askedBy, ['k2'])
    // Once nothing waits on you, askedBy goes.
    assert.equal(after([{ id: 'T2', status: 'done', same_as: 'T1' }, { id: 'T1', status: 'done' }])[0]!.askedBy, undefined)
  })

  test('a question under a made-up id waits on the topic it grew from', () => {
    // "T1-discount": the id's start names the topic.
    const a = settleTurn(raised('Add a fee', 'What port?'), `Added. Should I fix the discount?\n${tag({ topics: [{ id: 'T1', status: 'done' }, { id: 'T2', status: 'done' }, { id: 'T1-discount', status: 'me' }] })}`, NOW, { flat: true }).board
    assert.deepEqual(a.topics.map(t => [t.id, t.status]), [['T1', 'me'], ['T2', 'done']])
    // A new id: the reply mark above the question names it.
    const text = `<<reply T1>>\nOne.\n\n<<reply T2>>\nTwo. Should I fix the test?\n${tag({ topics: [{ id: 'T1', status: 'done' }, { id: 'T2', status: 'done' }, { id: 'T3', status: 'me' }] })}`
    assert.deepEqual(settleTurn(raised('one', 'two'), text, NOW, { flat: true }).board.topics.map(t => t.status), ['done', 'me'])
    // No mark: the turn's only topic; with several and no mark, nobody (it can't tell).
    assert.equal(settleTurn(raised('one'), `Should I?\n${tag({ topics: [{ id: 'T1', status: 'done' }, { id: 'T9', status: 'me' }] })}`, NOW, { flat: true }).board.topics[0]!.status, 'me')
    assert.deepEqual(settleTurn(raised('one', 'two'), `Should I?\n${tag({ topics: [{ id: 'T1', status: 'done' }, { id: 'T2', status: 'done' }, { id: 'T9', status: 'me' }] })}`, NOW, { flat: true }).board.topics.map(t => t.status), ['done', 'done'])
    // No question at all: nothing to attach.
    assert.equal(settleTurn(raised('one', 'two'), `Done.\n${tag({ topics: [{ id: 'T1', status: 'done' }, { id: 'T2', status: 'done' }, { id: 'T9', status: 'me' }] })}`, NOW, { flat: true }).board.topics[0]!.status, 'done')
  })

  test('a plain message guessed to answer a question: the tag confirms it, or the question is open again', () => {
    const asked = settleTurn(raised('Add a reorder check'), `Which threshold?\n${tag({ topics: [{ id: 'T1', status: 'me' }] })}`, NOW, { flat: true }).board
    // As app/main.ts submit() does for a plain message while one question is open.
    const guessed = { ...asked, topics: asked.topics.map(t => ({ ...t, status: 'claude' as const, answerGuessed: true as const })) }
    const b = raiseTopic(guessed, { text: 'What host?', key: 'k2', replyTo: null }, NOW + 1).board
    const settle = (entries: unknown[], opts = {}) => settleTurn(b, `It binds to 127.0.0.1.\n${tag({ topics: entries })}`, NOW + 2, { flat: true, ...opts }).board.topics
    // The tag leaves T1 out: the message was about something else.
    const open = settle([{ id: 'T2', status: 'done' }])
    assert.deepEqual(open.map(t => [t.id, t.status]), [['T1', 'me'], ['T2', 'done']])
    assert.equal(open[0]!.answerGuessed, undefined)
    assert.deepEqual(open[0]!.askedBy, [keyOf('Add a reorder check')])
    // The tag lists it, or links the message to it: the guess stands.
    assert.equal(settle([{ id: 'T1', status: 'done' }, { id: 'T2', status: 'done' }])[0]!.status, 'done')
    assert.equal(settle([{ id: 'T2', status: 'claude', about: 'T1' }])[0]!.status, 'claude')
    // A follow-up folded in with same_as only continues the subject: the question stays open.
    assert.equal(settle([{ id: 'T2', status: 'done', same_as: 'T1' }])[0]!.status, 'me')
    // A reply written mid-turn leaves the guess for the turn's last tag.
    const mid = settle([{ id: 'T2', status: 'done' }], { partial: true })
    assert.equal(mid[0]!.status, 'claude')
    assert.equal(mid[0]!.answerGuessed, true)
  })

  test('same_as folds a provisional topic into the earlier one', () => {
    let b = settleTurn(raised('first'), `ok ${tag({ topics: [{ id: 'T1', status: 'done' }] })}`, NOW, { flat: true }).board
    b = raiseTopic(b, { text: 'more on that', key: 'k2', replyTo: null }, NOW).board
    const { board } = settleTurn(b, `ok ${tag({ topics: [{ id: 'T2', same_as: 'T1', status: 'claude' }] })}`, NOW + 5, { flat: true })
    assert.deepEqual(board.topics.map(t => t.id), ['T1'])
    assert.deepEqual(board.topics[0]!.messageKeys, [keyOf('first'), 'k2'])
    assert.equal(board.topics[0]!.status, 'claude')
  })

  test('threads: unsorted topics go to a new thread, then the recent one, then forks', () => {
    let b = raised('a')
    b = settleTurn(b, `ok ${tag({ topics: [{ id: 'T1', status: 'done', thread: 'new' }], threads: { '1': 'Alpha' } })}`, NOW).board
    assert.equal(b.threads.length, 1)
    assert.equal(b.threads[0]!.name, 'Alpha')
    assert.equal(b.threads[0]!.isUnnamed, undefined)
    // Two more: they join the most recent thread, which is then full.
    for (const text of ['b', 'c']) {
      b = raiseTopic(b, { text, key: keyOf(text), replyTo: null }, NOW).board
      b = settleTurn(b, 'ok', NOW + 1).board
    }
    assert.deepEqual(b.threads[0]!.topicIds, ['T1', 'T2', 'T3'])
    // A reply into the full thread forks a child.
    const r = raiseTopic(b, { text: 'd', key: 'kd', replyTo: 1 }, NOW + 2)
    assert.equal(r.threadId, 2)
    assert.equal(r.board.threads[1]!.parentId, 1)
    assert.equal(r.board.threads[1]!.name, 'Alpha 2')
    assert.equal(r.board.replies.kd, 2)
    // A reply to a thread that is gone stays unsorted.
    assert.equal(raiseTopic(b, { text: 'e', key: 'ke', replyTo: 99 }, NOW).threadId, 0)
    // Claude's pick of an existing thread is honoured.
    const s = settleTurn(raiseTopic(r.board, { text: 'f', key: 'kf', replyTo: null }, NOW + 3).board, `ok ${tag({ topics: [{ id: 'T5', thread: 2 }] })}`, NOW + 3)
    assert.equal(s.board.topics.find(t => t.id === 'T5')!.threadId, 2)
  })

  test('a merge that empties a thread drops it', () => {
    let b = raised('a')
    b = settleTurn(b, `ok ${tag({ topics: [{ id: 'T1', thread: 'new' }] })}`, NOW).board
    b = raiseTopic(b, { text: 'b', key: 'kb', replyTo: null }, NOW).board
    b = settleTurn(b, `ok ${tag({ topics: [{ id: 'T2', thread: 'new' }] })}`, NOW).board
    assert.equal(b.threads.length, 2)
    // T2 provisional again is not possible; make a provisional T3 in thread 2 and merge it into T1.
    b = raiseTopic({ ...b, threads: b.threads.map(t => (t.id === 2 ? { ...t, topicIds: [] } : t)) }, { text: 'c', key: 'kc', replyTo: 2 }, NOW).board
    const { board } = settleTurn(b, `ok ${tag({ topics: [{ id: 'T3', same_as: 'T1' }] })}`, NOW)
    assert.ok(!board.threads.some(t => t.id === 2))
  })
})

describe('reading the board', () => {
  const th = (id: number, extra: Partial<Thread> = {}): Thread => ({ id, name: `t${id}`, topicIds: [], createdAt: NOW + id, updatedAt: NOW + id, ...extra })
  const board: Board = {
    ...emptyBoard(),
    threads: [th(1, { topicIds: ['T1'] }), th(2, { parentId: 1, topicIds: ['T2'] }), th(3, { parentId: 2 }), th(4, { parentId: 99, updatedAt: NOW + 100 })],
    topics: [
      { id: 'T1', title: 'one', threadId: 1, status: 'done', messageKeys: ['k1'], updatedAt: NOW },
      { id: 'T2', title: 'two', threadId: 2, status: 'me', messageKeys: ['k2'], updatedAt: NOW },
    ],
    answers: [{ key: keyOf('Answer one'), text: 'Answer one', topicIds: ['T1'] }, { key: 'x', text: 'Answer two is long', topicIds: ['T2'] }],
  }
  test('roots, chains and the tree', () => {
    assert.equal(rootOf(board, 3)!.id, 1)
    assert.equal(rootOf(board, 4)!.id, 4)
    assert.equal(rootOf(board, 42), undefined)
    assert.deepEqual(chainOf(board, 3).map(t => t.id), [1, 2, 3])
    assert.deepEqual(chainOf(board, 42), [])
    assert.deepEqual(chains(board).map(c => c.root.id), [4, 1])
    assert.deepEqual(threadTree(board).map(x => [x.thread.id, x.depth]), [[4, 0], [1, 0], [2, 1], [3, 2]])
  })
  test('topics, counts, answers and messages', () => {
    assert.equal(topicsOf(board, 0).length, 2)
    assert.deepEqual(topicsOf(board, 2).map(t => t.id), ['T2'])
    assert.deepEqual(counts(board.topics), { claude: 0, me: 1, done: 1 })
    assert.equal(lastAnswerIn(board, 2)!.text, 'Answer two is long')
    assert.equal(threadOfMessage(board, 'k2'), 2)
    assert.equal(answerOfBlock(board, 'Answer one')!.text, 'Answer one')
    assert.equal(answerOfBlock(board, 'Answer two')!.text, 'Answer two is long')
    assert.equal(answerOfBlock(board, '<clued>{}</clued>'), undefined)
    assert.deepEqual(threadsOfAnswer(board, board.answers[1]!).map(t => t.id), [2])
    assert.equal(describeThread(board.threads[0]!), '#1 t1')
    assert.equal(isAsking(board, board.answers[1], 'no question'), true)
    assert.equal(isAsking(board, board.answers[0], 'Go on?'), true)
    assert.equal(isAsking(board, undefined, 'Fine.'), false)
    assert.deepEqual(activeThreads(board, NOW + ACTIVE_MS + 50).map(t => t.id), [4])
  })
  test('prune drops idle threads with their topics, answers and replies', () => {
    const p = prune({ ...board, replies: { k1: 1, k4: 4 }, turnTopics: ['T1', 'T9'] }, NOW + 100 + KEEP_MS - 1)
    assert.deepEqual(p.threads.map(t => t.id), [4])
    assert.equal(p.threads[0]!.parentId, undefined)
    assert.deepEqual(p.topics, [])
    assert.deepEqual(p.answers, [])
    assert.deepEqual(p.replies, { k4: 4 })
    assert.deepEqual(p.turnTopics, [])
  })
})

describe('notes for Claude', () => {
  test('flatBrief names the topic, the quotes and what is still open', () => {
    const b = raised('first thing', 'second')
    assert.equal(flatBrief(b, 'T2'), '[clued] This message is topic T2.\nStill open: T1 "first thing" (on Claude).')
    const one = flatBrief(emptyBoard(), 'T1', [{ who: 'claude', text: 'x'.repeat(700) }])
    assert.match(one, /replying to your message:\n> x+…$/)
    const two = flatBrief(emptyBoard(), 'T1', [{ who: 'me', text: 'a', topics: ['T3'] }, { who: 'claude', text: 'b' }])
    assert.match(two, /answering 2 of these messages at once/)
    assert.match(two, /\(your reply to T3\)\n> a/)
  })
  test('briefFor: in a thread, quoting, and in Main with active threads', () => {
    let b = raised('a')
    b = settleTurn(b, `Answer A ${tag({ topics: [{ id: 'T1', thread: 'new' }] })}`, NOW).board
    b = raiseTopic(b, { text: 'b', key: 'kb', replyTo: null }, NOW).board
    b = settleTurn(b, `Answer B ${tag({ topics: [{ id: 'T2', thread: 'new' }] })}`, NOW).board
    const r = raiseTopic(b, { text: 'reply', key: 'kr', replyTo: 1 }, NOW)
    const inThread = briefFor(r.board, r.topicId, r.threadId, 1, NOW)
    assert.match(inThread, /a reply in thread #1/)
    assert.match(inThread, /Your last message in that thread:\n> Answer A/)
    assert.match(inThread, /Name these threads in your tag: #1, #2\./)
    assert.match(briefFor(r.board, r.topicId, r.threadId, 1, NOW, { who: 'me', text: 'q' }), /replying to their own message:\n> q/)
    const m = raiseTopic(b, { text: 'short', key: 'ks', replyTo: null }, NOW)
    const main = briefFor(m.board, m.topicId, 0, null, NOW, { who: 'claude', text: 'q' })
    assert.match(main, /sent to Main/)
    assert.match(main, /Likely thread: #2/)
    assert.match(main, /Threads active in the last 3 days:\n {2}#1 "a": T1 "a" \(done\)\n {2}#2 "b"/)
    assert.match(briefFor(raised('x'), 'T1', 0, null, NOW), /No threads are active/)
  })
})

describe('reactions', () => {
  test('signals', () => {
    assert.equal(reactionSignal('👍', true), 'go')
    assert.equal(reactionSignal('👍', false), 'fyi')
    assert.equal(reactionSignal('👎', false), 'stop')
    assert.equal(reactionSignal('❓', false), 'explain')
    assert.equal(reactionSignal('🎉', true), 'fyi')
  })
  test('reactionText reads both prefixes', () => {
    assert.equal(reactionText('[clued reaction] 👍 on x'), ' 👍 on x')
    assert.equal(reactionText('[threadline reaction]👎'), '👎')
    assert.equal(reactionText('plain'), undefined)
  })
  test('reactionPrompt says what the user wants', () => {
    assert.equal(reactionPrompt('go', '👍', 'Shall I?', ['T1', 'T2']), '[clued reaction] 👍 on your message “Shall I?”. The user is saying yes: go ahead as you proposed. Topics: T1, T2.')
    assert.match(reactionPrompt('stop', '👎', 'x', []), /disagrees.*briefly what to change\.$/)
    assert.match(reactionPrompt('explain', '❓', 'x', []), /Explain it again/)
  })
})
