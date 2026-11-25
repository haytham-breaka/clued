// /plugin: headless Claude Code refuses its plugin picker, so clued runs Claude Code's own CLI
// (`claude plugin …`, the fake's keeps its plugins in a temp file) and the session reloads them.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rowOf, withApp } from './harness.ts'

const cli = (app: { read: (rel: string) => string }) => app.read('plugin.log').split('\n').filter(Boolean).map(l => JSON.parse(l).args.join(' '))
const reloads = (app: { claudeLog: () => any[] }) => app.claudeLog().filter(e => e.request?.subtype === 'reload_plugins').length
const plugins = (dir: string) => JSON.parse(readFileSync(join(dir, 'plugins.json'), 'utf8')) as { id: string; enabled: boolean }[]

describe('/plugin', () => {
  test('lists the plugins and marketplaces; a click enables one, and the session reloads its plugins', () =>
    withApp({}, async app => {
      await app.send('/plugin')
      let s = await app.waitFor('Marketplaces')
      assert.match(rowOf(s, 'figma@fake-market'), /✔ figma@fake-market +2\.2\.0 · user +disable/)
      assert.match(rowOf(s, 'old-tool@local'), /○ old-tool@local +0\.1\.0 · project +enable/)
      assert.match(rowOf(s, 'example/fake-market'), /fake-market +example\/fake-market/)
      assert.deepEqual(cli(app).sort(), ['list --json', 'marketplace list --json'])
      assert.equal(JSON.parse(app.read('plugin.log').split('\n')[0]!).cwd, app.work)
      // Enable the disabled one: the CLI, then the session reloads.
      await app.click('enable', { area: 'chat' })
      s = await app.waitFor('✔ Reloaded in this session: 2 plugins, 5 commands.')
      assert.match(s, /\$ claude plugin enable old-tool@local/)
      assert.match(s, /✔ Successfully enabled plugin: old-tool@local \(scope: project\)/)
      await app.waitFor('Enabled old-tool@local, and this session has reloaded its plugins.')
      assert.equal(plugins(app.dir).find(p => p.id === 'old-tool@local')!.enabled, true)
      assert.equal(reloads(app), 1)
      // Its command is in /help now, from the reload's answer.
      await app.send('/help')
      await app.waitFor('╭ help')
      app.keys('PageDown', 'PageDown', 'PageDown')
      assert.match(rowOf(await app.waitFor('/old-tool'), '/old-tool'), /From the old-tool@local plugin/)
      // Install, then uninstall; /plugins is the same command.
      await app.send('/plugins install new-thing')
      s = await app.waitFor('✔ Reloaded in this session: 3 plugins')
      assert.match(s, /✔ Successfully installed plugin: new-thing \(scope: user\)/)
      assert.doesNotMatch(s, /\x1b|\[32m/)
      await app.send('/plugin uninstall new-thing')
      await app.waitFor('Uninstalled new-thing, and this session')
      await app.click('≡ list plugins', { area: 'chat' })
      s = await app.waitFor('Marketplaces')
      assert.doesNotMatch(s, /new-thing@/)
      assert.deepEqual(app.sent(), [], 'nothing went to Claude')
      // In the slash menu, and the usage when it is typed wrong.
      await app.send('/plugin frobnicate')
      await app.waitFor('Usage: /plugin [list]')
      app.type('/plu')
      await app.waitFor(/│ {2}\/plugin$/m)
    }))

  test('a failing CLI says why and reloads nothing; mid-turn, the reload waits for the turn to end', () =>
    withApp({}, async app => {
      await app.send('/plugin install fail-me')
      let s = await app.waitFor('Nothing changed in this session.')
      assert.match(s, /✘ Failed to install plugin "fail-me": Plugin "fail-me" not found in any\s/)
      assert.match(s, /✘ It failed \(exit 1\)/)
      await app.waitFor('claude plugin install fail-me failed: Failed to install plugin')
      await app.send('/plugin enable nothing-here')
      await app.waitFor('Failed to enable plugin "nothing-here"')
      assert.equal(reloads(app), 0)
      // Claude at work: Claude Code refuses a reload mid-turn, so it waits.
      await app.send('hold on')
      await app.waitFor('Starting the slow work.')
      await app.send('/plugin disable figma')
      s = await app.waitFor('The session reloads its plugins once Claude\'s turn is over.')
      assert.equal(plugins(app.dir).find(p => p.id === 'figma@fake-market')!.enabled, false)
      await new Promise(r => setTimeout(r, 1500))
      assert.equal(reloads(app), 0)
      app.release('slow')
      await app.waitFor('The slow work is done.')
      await app.waitFor('✔ Reloaded in this session: 0 plugins')
      assert.equal(reloads(app), 1)
    }))

  test('a list that fails, and a reload Claude Code refuses', () =>
    withApp({ env: { FAKE_PLUGIN_BROKEN: '1', FAKE_RELOAD_BUSY: '1' } }, async app => {
      await app.send('/plugin')
      await app.waitFor('✘ claude plugin list failed: Failed to read the plugin settings: boom')
      await app.send('/plugin enable old-tool')
      await app.waitFor('✘ The session couldn\'t reload its plugins: Cannot reload')
      await app.waitFor('Enabled old-tool, but the session couldn')
    }))
})
