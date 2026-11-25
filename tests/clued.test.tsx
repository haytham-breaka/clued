import { expect, test } from 'claude-code/testing'

import { keyOf as keyOfText } from '../hooks/model'

// The test runner has timers; the mod's lib (no DOM, no Node) does not declare them.
declare const setTimeout: (fn: (value?: unknown) => void, ms: number) => unknown

const composer = { kind: 'composer' } as const

function engine(on: any, seen: { context: string[]; texts?: string[] }) {
  // Each hook here stands in for the engine beneath the mod.
  on('command.register', () => ({ value: {} }))
  on('tool.register', () => ({ value: {} }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.root', () => ({ value: '/p' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('ui.close', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: unknown, e: { text: string; context?: string[] }) => {
    seen.context.push(...(e.context ?? []))
    seen.texts?.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props?.text ?? 'engine'}</Text>
  })
}

const start = ($: any) => $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
const say = ($: any, text: string) => $.prompt.submit({ text, origin: composer })
const answer = ($: any, text: string) => $.turn.complete({ answer: text, durationMs: 1, isAborted: false, turnId: crypto.randomUUID() })
const tag = (topics: object[], threads: object = {}) => `\n<clued>${JSON.stringify({ topics, threads })}</clued>`

const PANE = {
  plugin: 'clued',
  component: 'Pane',
  requestId: 'threads',
  surface: 'terminal',
  props: { title: 'Threads', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as any

test('Claude sorts topics into a thread; a 4th topic forks a child under it', async ($, on) => {
  const seen = { context: [] as string[] }
  engine(on, seen)
  await start($)

  await say($, 'fix the login redirect')
  expect(seen.context.at(-1)).toContain('sent to Main')
  await answer($, 'Fixed it.' + tag([{ id: 'T1', title: 'Login redirect', status: 'done', thread: 'new' }], { '1': 'Auth' }))

  await say($, 'also the token refresh')
  expect(seen.context.at(-1)).toContain('#1 "Auth"')
  await answer($, 'Done.' + tag([{ id: 'T2', title: 'Token refresh', status: 'claude', thread: 1 }]))
  await say($, 'and logout')
  await answer($, 'Should logout clear all devices?' + tag([{ id: 'T3', title: 'Logout', status: 'me', thread: 1 }]))
  await say($, 'what about 2FA')
  await answer($, 'Noted.' + tag([{ id: 'T4', title: '2FA', status: 'claude', thread: 1 }], { '2': 'Auth hardening' }))

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /#1 Auth/ }))?.text).toContain('⏳1 ✋1 ✓1')
  expect((await ui.find({ type: 'Text', text: /#2 Auth hardening/ }))?.text).toContain('└')
  expect((await ui.find({ type: 'Text', text: /waiting on you/ }))?.text).toContain('Logout')
  await ui.unmount()
})

test('"waiting on you" needs a question in the reply', async ($, on) => {
  engine(on, { context: [] })
  await start($)
  await say($, 'deploy it')
  await answer($, 'Deployed.' + tag([{ id: 'T1', title: 'Deploy', status: 'me', thread: 'new' }]))
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /Deploy$/ }))?.text).toContain('✓')
  await ui.unmount()
})

test('a reply carries its thread, and the tag never shows', async ($, on) => {
  const seen = { context: [] as string[] }
  engine(on, seen)
  await start($)
  await say($, 'set up CI')
  await answer($, 'CI runs on push now.' + tag([{ id: 'T1', title: 'CI setup', status: 'done', thread: 'new' }], { '1': 'Build' }))
  await say($, 'rename the repo')
  await answer($, 'Renamed.' + tag([{ id: 'T2', title: 'Repo rename', status: 'done', thread: 'new' }], { '2': 'Repo' }))

  await $.command.run({ command: 'reply', args: '1', origin: composer } as any)
  await say($, 'make it run on PRs too')
  const brief = seen.context.at(-1) ?? ''
  expect(brief).toContain('a reply in thread #1 "Build"')
  expect(brief).toContain('> CI runs on push now.')

  const row = await $.ui.mount({
    plugin: 'clued', component: 'AssistantMessage', surface: 'terminal',
    props: { text: 'Renamed.' + tag([{ id: 'T2', status: 'done' }]), isFirstOfReply: true },
  } as any)
  expect(await row.find({ type: 'Text', text: /clued>/ })).toBeUndefined()
  expect((await row.find({ type: 'Text', text: /↳ #2/ }))?.text).toContain('#2 Repo')
  await row.unmount()

  const mine = await $.ui.mount({
    plugin: 'clued', component: 'UserMessage', surface: 'terminal',
    props: { text: 'make it run on PRs too', origin: composer, isExpanded: true },
  } as any)
  expect((await mine.find({ type: 'Text', text: /↳ in/ }))?.text).toContain('#1 Build')
  await mine.unmount()
})

test("results only hides Claude's actions", async ($, on) => {
  engine(on, { context: [] })
  await start($)
  await $.command.run({ command: 'results', args: '', origin: composer } as any)
  const tool = await $.ui.mount({ plugin: 'clued', component: 'ToolUse', surface: 'terminal', props: { text: 'Edit(src/a.ts)' } } as any)
  expect(await tool.find({ type: 'Text', text: /Edit/ })).toBeUndefined()
  await tool.unmount()
})

test("Claude's reaction shows under my latest message", async ($, on) => {
  engine(on, { context: [] })
  await start($)
  await say($, 'Thanks, that fixed it!')
  const ran = await $.tool.run({ tool: 'mcp__clued__react', tool_use_id: 't1', emoji: '🎉' } as any)
  expect((ran as any).result).toBe('Reacted 🎉.')
  const again = await $.tool.run({ tool: 'mcp__clued__react', tool_use_id: 't2', emoji: '👍' } as any)
  expect((again as any).deny).toBe('You already reacted to this message.')
  const ui = await $.ui.mount({
    plugin: 'clued', component: 'UserMessage', surface: 'terminal',
    props: { text: 'Thanks, that fixed it!', origin: composer, isExpanded: true },
  } as any)
  expect((await ui.find({ type: 'Text', text: /🎉/ }))?.text).toContain('Claude')
  await ui.unmount()
})

test('clicking ↩ on a message replies to it, in its thread, quoted to Claude', async ($, on) => {
  const seen = { context: [] as string[] }
  engine(on, seen)
  await start($)
  await say($, 'set up CI')
  await answer($, 'CI runs on push now. Want it on PRs too?' + tag([{ id: 'T1', title: 'CI setup', status: 'me', thread: 'new' }], { '1': 'Build' }))

  const row = await $.ui.mount({
    plugin: 'clued', component: 'AssistantMessage', surface: 'terminal',
    props: { text: 'CI runs on push now. Want it on PRs too?', isFirstOfReply: true },
  } as any)
  await row.press({ key: `reply-claude-${keyOfText('CI runs on push now. Want it on PRs too?')}` })
  await row.press({ key: `react-0-${keyOfText('CI runs on push now. Want it on PRs too?')}` })
  await row.unmount()

  const band = await $.ui.mount({ plugin: 'clued', component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey: false, isCollapsed: false, isWorking: false } } as any)
  expect((await band.find({ type: 'Text', text: /^Claude$/ }))?.text).toBe('Claude')
  expect((await band.find({ type: 'Text', text: /^#\d/ }))?.text).toBe('#1')
  await band.unmount()

  await say($, 'yes please')
  const brief = seen.context.at(-1) ?? ''
  expect(brief).toContain('a reply in thread #1 "Build"')
  expect(brief).toContain('replying to your message:\n> CI runs on push now.')

  const again = await $.ui.mount({
    plugin: 'clued', component: 'AssistantMessage', surface: 'terminal',
    props: { text: 'CI runs on push now. Want it on PRs too?', isFirstOfReply: true },
  } as any)
  expect((await again.find({ type: 'Text', text: /👍/ }))?.text).toContain('you')
  await again.unmount()
})

test('a reply links to the message it answered, and that message links back', async ($, on) => {
  const seen = { context: [] as string[] }
  engine(on, seen)
  await start($)
  await say($, 'set up CI')
  await answer($, 'CI runs on push now. Want it on PRs too?' + tag([{ id: 'T1', title: 'CI', status: 'me', thread: 'new' }], { new: 'Build' }))
  const original = 'CI runs on push now. Want it on PRs too?'
  const row = await $.ui.mount(claudeRow(original))
  await row.press({ key: `reply-claude-${keyOfText(original)}` })
  await row.unmount()
  await say($, 'yes please')

  // The reply's bubble quotes what it answered, as a link (↩ Claude: “…”).
  const mine = await $.ui.mount({ plugin: 'clued', component: 'UserMessage', surface: 'terminal', props: { text: 'yes please', origin: composer } } as any)
  expect((await mine.find({ type: 'Text', text: /↩ Claude/ }))?.text).toContain('CI runs on push now')
  await mine.unmount()
  // The answered message links to its reply (↪ your reply).
  const back = await $.ui.mount(claudeRow(original))
  expect((await back.find({ type: 'Text', text: /your reply/ }))?.text).toContain('↪')
  await back.unmount()
})

const claudeRow = (text: string) =>
  ({ plugin: 'clued', component: 'AssistantMessage', surface: 'terminal', props: { text, isFirstOfReply: true } }) as any

test('👍 on a question is a go-ahead; 👍 on finished work is only heard', async ($, on) => {
  const seen = { context: [] as string[], texts: [] as string[] }
  engine(on, seen)
  await start($)
  await say($, 'migrate the db')
  const asked = 'The migration drops a column. Should I proceed?'
  await answer($, asked + tag([{ id: 'T1', title: 'DB migration', status: 'me', thread: 'new' }], { '1': 'Data' }))

  const row = await $.ui.mount(claudeRow(asked))
  await row.press({ key: `react-0-${keyOfText(asked)}` })
  await row.unmount()
  await new Promise(r => setTimeout(r, 20))
  const sent = seen.texts.find(t => t.includes('[clued reaction]'))
  expect(sent).toContain('go ahead')
  expect(sent).toContain('T1')

  await answer($, 'Migrated, all green.' + tag([{ id: 'T1', status: 'done' }]))
  const done = await $.ui.mount(claudeRow('Migrated, all green.'))
  const before = seen.texts.length
  await done.press({ key: `react-0-${keyOfText('Migrated, all green.')}` })
  await done.unmount()
  await new Promise(r => setTimeout(r, 20))
  expect(seen.texts.length).toBe(before)

  await say($, 'next: add an index')
  expect(seen.context.at(-1)).toContain('the user reacted: 👍 on your message “Migrated, all green.”')
})

test("Claude's reactions are rare: its four emoji, one per message, one in four messages", async ($, on) => {
  engine(on, { context: [] })
  await start($)
  const react = (emoji: string, id: string) => $.tool.run({ tool: 'mcp__clued__react', tool_use_id: id, emoji } as any) as any

  await say($, 'fyi the staging db is back')
  expect((await react('❤️', 'a')).deny).toContain('Use one of')
  expect((await react('👍', 'b')).result).toBe('Reacted 👍.')
  await say($, 'ok')
  expect((await react('👍', 'c')).deny).toContain('reacted recently')
})

test('the panel closes from its ✕ and reopens from ☰ Threads above the prompt', async ($, on) => {
  engine(on, { context: [] })
  await start($)
  const band = { plugin: 'clued', component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey: false, isCollapsed: false, isWorking: false } } as any

  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'close-pane' })
  await pane.unmount()

  const closed = await $.ui.mount(band)
  expect((await closed.find({ type: 'Text', text: /☰ Threads/ }))?.text).toBe('☰ Threads')
  await closed.press({ key: 'open-pane' })
  await closed.unmount()

  const reopened = await $.ui.mount(band)
  expect(await reopened.find({ type: 'Text', text: /☰ Threads/ })).toBeUndefined()
  await reopened.unmount()
})

test('the board is kept by project root, and a copy split off under a working folder is joined back', async ($, on0) => {
  const on = on0 as any
  const older = { topics: [], threads: [], answers: [], nextTopic: 2, turnTopics: [], replies: {} }
  const further = {
    topics: [{ id: 'T3', title: 'Panel on the left', threadId: 1, status: 'me', messageKeys: ['k'], updatedAt: Date.now() }],
    threads: [{ id: 1, name: 'Own window', topicIds: ['T3'], createdAt: Date.now(), updatedAt: Date.now() }],
    answers: [], nextTopic: 4, turnTopics: [], replies: {},
  }
  const saved: Record<string, unknown> = {}
  on('command.register', () => ({ value: {} }))
  on('tool.register', () => ({ value: {} }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.after', () => ({ value: undefined }))
  on('session.root', () => ({ value: '/root' }))
  on('store.get', (_: unknown, e: any) => ({ value: e.key === 'board:/root' ? older : e.key === 'board:/root/sub' ? further : undefined }))
  on('store.set', (_: unknown, e: any) => {
    saved[e.key] = e.value
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/root/sub', surface: 'terminal', isInteractive: true } as any)

  expect((saved['board:/root'] as any)?.nextTopic).toBe(4)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /#1 Own window/ }))?.text).toContain('✋1')
  await ui.unmount()
})
