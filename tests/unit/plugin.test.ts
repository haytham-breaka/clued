import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Cards } from '../../app/local.ts'
import { listLines, Plugins, runClaude } from '../../app/plugin.ts'
import type { PluginCtx, Ran } from '../../app/plugin.ts'
import type { Line } from '../../app/text.ts'

const text = (l: Line) => l.map(s => s.text).join('')
const card = (cards: Cards) => cards.list.at(-1)!.body(80).map(text).join('\n')

function setup(answers: Record<string, Ran>) {
  const cards = new Cards(() => {})
  const calls: string[] = []
  const toasts: string[] = []
  const plugins = new Plugins(cards, (args, _cwd, done) => {
    calls.push(args.join(' '))
    done(answers[args.join(' ')] ?? { code: 0, stdout: '', stderr: '' })
  }, 5)
  const ctx: PluginCtx = { cwd: '/tmp', after: '', toast: t => void toasts.push(t), shown: () => {}, isBusy: () => false }
  return { cards, calls, toasts, plugins, ctx }
}

describe('/plugin', () => {
  test('not /plugin: not taken; a list that isn\'t JSON says so; marketplaces that fail are left out', () => {
    const { cards, plugins, ctx } = setup({ 'list --json': { code: 0, stdout: 'not json', stderr: '' }, 'marketplace list --json': { code: 1, stdout: '', stderr: 'no' } })
    assert.ok(!plugins.command('help', '', ctx))
    assert.ok(plugins.command('plugins', '', ctx))
    assert.match(card(cards), /claude plugin list failed: it did not answer in JSON/)
  })

  test('nothing installed; a change with no Claude Code running; a CLI that couldn\'t run', () => {
    const { cards, plugins, ctx, toasts } = setup({ 'list --json': { code: 0, stdout: '[]', stderr: '' }, 'marketplace list --json': { code: 0, stdout: '{', stderr: '' }, 'enable x': { code: null, stdout: '', stderr: '', error: 'the claude command is not on PATH' } })
    plugins.command('plugin', 'list', ctx)
    assert.match(card(cards), /Installed {2}none\nNo plugins installed/)
    plugins.command('plugin', 'install y', ctx)
    assert.match(card(cards), /Claude Code isn't running: it takes the change in when it starts/)
    assert.match(toasts.at(-1)!, /Installed y\. Claude Code takes it in when it starts/)
    plugins.command('plugin', 'enable x', ctx)
    assert.match(card(cards), /✘ It failed: the claude command is not on PATH/)
    assert.match(toasts.at(-1)!, /failed: the claude command is not on PATH/)
    plugins.command('plugin', 'enable', ctx)
    assert.match(toasts.at(-1)!, /^Usage: \/plugin/)
  })

  test('a reload with errors, and the list\'s rows', () => {
    const { cards, plugins, ctx } = setup({})
    plugins.command('plugin', 'update z --scope project', { ...ctx, reload: done => done({ ok: true, plugins: 1, commands: 2, errors: 3 }) })
    assert.match(card(cards), /\$ claude plugin update z --scope project\n✔ Reloaded in this session: 1 plugin, 2 commands, 3 errors\./)
    let acted = ''
    const lines = listLines([{ id: 'b@m', enabled: false }, { id: 'a@m', version: '1', scope: 'user' }], [{ name: 'm', url: 'https://example.com/m.json' }], 70, (v, id) => (acted = `${v} ${id}`))
    assert.match(text(lines[1]!), /^✔ a@m +1 · user +disable$/)
    lines[2]!.at(-1)!.action!()
    assert.equal(acted, 'enable b@m')
    assert.ok(lines.some(l => /m +https:\/\/example\.com\/m\.json/.test(text(l))))
  })

  test('runClaude: the real CLI not there, said plainly', async () => {
    const path = process.env.PATH
    process.env.PATH = '/nonexistent'
    try {
      const r = await new Promise<Ran>(res => runClaude(['list'], '/tmp', res))
      assert.equal(r.error, 'the claude command is not on PATH')
      assert.equal(r.code, null)
    } finally {
      process.env.PATH = path
    }
  })
})
