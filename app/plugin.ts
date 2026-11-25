// /plugin (or /plugins): Claude Code's plugin manager is an interactive picker, which headless mode
// refuses ("/plugin isn't available in this environment"). clued runs Claude Code's own CLI instead:
// `claude plugin list` for what is installed and the marketplaces, `claude plugin install | enable |
// disable | uninstall | update <name>` for a change, which the running session then takes in
// (reload_plugins, as /reload-plugins does) with no restart. What it shows is a card in the chat.

import { execFile } from 'node:child_process'
import type { Card, Cards, Ctx } from './local.ts'
import { C, cells, clip, pad, wrap } from './text.ts'
import type { Line, Span } from './text.ts'

export const PLUGIN_COMMANDS = ['plugin', 'plugins']

/** What `claude plugin <args>` did. `error`: it couldn't run at all (no claude, a timeout). */
export type Ran = { code: number | null; stdout: string; stderr: string; error?: string }
export type Run = (args: string[], cwd: string, done: (r: Ran) => void) => void

/** Claude Code's own CLI, in the session's folder (a project-scope plugin is that folder's). */
export const runClaude: Run = (args, cwd, done) => {
  execFile('claude', ['plugin', ...args], { cwd, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }, (err: any, stdout, stderr) => {
    const code = err ? (typeof err.code === 'number' ? err.code : null) : 0
    done({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), ...(err && typeof err.code !== 'number' ? { error: err.code === 'ENOENT' ? 'the claude command is not on PATH' : err.killed ? 'it took too long and was stopped' : String(err.message ?? err) } : {}) })
  })
}

export type Reloaded = { ok: true; plugins: number; commands: number; errors: number } | { ok: false; error: string }

export type PluginCtx = Pick<Ctx, 'cwd' | 'after' | 'toast' | 'shown'> & {
  /** The running session takes the change in; undefined when no Claude Code is running. */
  reload?: (done: (r: Reloaded) => void) => void
  /** Claude is at work: the reload waits for its turn to end (Claude Code refuses one mid-turn). */
  isBusy: () => boolean
}

type Installed = { id: string; version?: string; scope?: string; enabled?: boolean }
type Market = { name: string; source?: string; repo?: string; url?: string; path?: string }

const ACTIONS: Record<string, string> = { install: 'install', i: 'install', enable: 'enable', disable: 'disable', uninstall: 'uninstall', remove: 'uninstall', update: 'update' }
const DONE: Record<string, string> = { install: 'Installed', enable: 'Enabled', disable: 'Disabled', uninstall: 'Uninstalled', update: 'Updated' }
const USAGE = 'Usage: /plugin [list] · /plugin install <name>[@marketplace] · /plugin enable | disable | uninstall | update <name>'

const noAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '')
/** What the CLI said when it failed: its last words, else its exit. */
const why = (r: Ran) => r.error ?? (noAnsi(r.stderr || r.stdout).trim().split('\n').filter(Boolean).at(-1)?.replace(/^✘\s*/, '') || `exit ${r.code}`)

/** Waits this long at most for Claude's turn to end before reloading. */
const BUSY_WAIT_MS = 10 * 60_000

export class Plugins {
  private cards: Cards
  private run: Run
  /** How often to look again whether Claude's turn is over (tests make it short). */
  private pollMs: number
  constructor(cards: Cards, run: Run = runClaude, pollMs = 1000) {
    this.cards = cards
    this.run = run
    this.pollMs = pollMs
  }

  /** `/plugin …`: true when it is this command. */
  command(cmd: string, arg: string, ctx: PluginCtx): boolean {
    if (!PLUGIN_COMMANDS.includes(cmd)) return false
    const [sub = 'list', ...rest] = arg.split(/\s+/).filter(Boolean)
    if (sub === 'list') this.list(ctx)
    else if (ACTIONS[sub] && rest.length) this.change(ACTIONS[sub]!, rest, ctx)
    else ctx.toast(USAGE)
    return true
  }

  /** The installed plugins and the marketplaces, on a card: a click enables or disables one. */
  list(ctx: PluginCtx) {
    let installed: Installed[] | undefined
    let markets: Market[] | undefined
    let failed = ''
    const card = this.cards.add({
      title: 'plugin',
      about: 'Claude Code\'s plugins, from claude plugin list',
      after: ctx.after,
      body: w => {
        if (failed) return wrap([{ text: `✘ claude plugin list failed: ${failed}`, style: { fg: C.red } }], w)
        if (!installed) return [[{ text: 'Asking Claude Code…', style: { fg: C.faint, italic: true } }]]
        return listLines(installed, markets ?? [], w, (verb, id) => this.change(verb, [id], ctx))
      },
    })
    ctx.shown(card)
    const redo = () => this.cards.list.includes(card) && this.cards.redo(card.id)
    this.run(['list', '--json'], ctx.cwd, r => {
      try {
        if (r.code !== 0) throw new Error(why(r))
        installed = JSON.parse(r.stdout) as Installed[]
      } catch (err: any) {
        failed = err instanceof SyntaxError ? 'it did not answer in JSON' : String(err?.message ?? err)
      }
      redo()
    })
    // Marketplaces are a nice-to-have: a failure leaves them out.
    this.run(['marketplace', 'list', '--json'], ctx.cwd, r => {
      try {
        markets = r.code === 0 ? (JSON.parse(r.stdout) as Market[]) : []
      } catch {
        markets = []
      }
      redo()
    })
  }

  /** Runs `claude plugin <verb> <args>`, shows what it said, then has the session reload its plugins. */
  change(verb: string, args: string[], ctx: PluginCtx) {
    const shown = `claude plugin ${[verb, ...args].join(' ')}`
    let ran: Ran | undefined
    let reload: 'waiting' | 'reloading' | 'none' | Reloaded | undefined
    const card: Card = this.cards.add({
      title: 'plugin',
      about: shown,
      after: ctx.after,
      body: w => changeLines(shown, ran, reload, w),
      actions: [{ label: '≡ list plugins', run: () => this.list(ctx) }],
    })
    ctx.shown(card)
    const redo = () => this.cards.list.includes(card) && this.cards.redo(card.id)
    this.run([verb, ...args], ctx.cwd, r => {
      ran = r
      if (r.code !== 0) {
        ctx.toast(`${shown} failed: ${why(r)}`)
        return redo()
      }
      if (!ctx.reload) {
        reload = 'none'
        ctx.toast(`${DONE[verb]} ${args[0]}. Claude Code takes it in when it starts.`)
        return redo()
      }
      const go = () => {
        reload = 'reloading'
        redo()
        ctx.reload!(res => {
          reload = res
          ctx.toast(res.ok ? `${DONE[verb]} ${args[0]}, and this session has reloaded its plugins.` : `${DONE[verb]} ${args[0]}, but the session couldn't reload its plugins (${res.error}): type /reload-plugins.`)
          redo()
        })
      }
      // Claude Code refuses to reload mid-turn: it waits for the turn to end.
      if (!ctx.isBusy()) return go()
      reload = 'waiting'
      redo()
      const until = Date.now() + BUSY_WAIT_MS
      const wait = () => (!ctx.isBusy() || Date.now() > until ? go() : void setTimeout(wait, this.pollMs).unref())
      setTimeout(wait, this.pollMs).unref()
    })
  }
}

/** The card's list: each plugin, enabled or not, with a click to change that; then the marketplaces. */
export function listLines(installed: Installed[], markets: Market[], width: number, act: (verb: string, id: string) => void): Line[] {
  const out: Line[] = [[{ text: 'Installed', style: { bold: true, fg: C.cyan } }, { text: `  ${installed.length || 'none'}`, style: { fg: C.faint } }]]
  if (!installed.length) out.push([{ text: 'No plugins installed. /plugin install <name>[@marketplace] installs one.', style: { fg: C.faint, italic: true } }])
  const col = Math.min(Math.max(0, ...installed.map(p => cells(p.id))) + 2, Math.floor(width / 2))
  for (const p of [...installed].sort((a, b) => a.id.localeCompare(b.id))) {
    const on = p.enabled !== false
    const id = clip(p.id, col - 1)
    const about = [p.version, p.scope].filter(Boolean).join(' · ')
    const toggle: Span = { text: on ? 'disable' : 'enable', style: { fg: C.gray, underline: true }, action: () => act(on ? 'disable' : 'enable', p.id) }
    out.push([
      { text: on ? '✔ ' : '○ ', style: { fg: on ? C.green : C.faint } },
      { text: id, style: on ? { fg: C.white } : { fg: C.gray } },
      pad(col - cells(id)),
      { text: clip(about, Math.max(4, width - col - 14)), style: { fg: C.faint } },
      pad(2),
      toggle,
    ])
  }
  if (markets.length) {
    out.push([], [{ text: 'Marketplaces', style: { bold: true, fg: C.cyan } }])
    const mcol = Math.min(Math.max(...markets.map(m => cells(m.name))) + 2, Math.floor(width / 2))
    for (const m of markets) {
      const from = m.repo ?? m.url ?? m.path ?? m.source ?? ''
      out.push([pad(2), { text: clip(m.name, mcol - 1), style: { fg: C.white } }, pad(mcol - cells(clip(m.name, mcol - 1))), { text: clip(from, Math.max(4, width - mcol - 2)), style: { fg: C.faint } }])
    }
  }
  out.push([], ...wrap([{ text: USAGE.replace(/^Usage: /, ''), style: { fg: C.faint } }], width))
  return out
}

function changeLines(shown: string, ran: Ran | undefined, reload: 'waiting' | 'reloading' | 'none' | Reloaded | undefined, width: number): Line[] {
  const out: Line[] = [[{ text: `$ ${shown}`, style: { fg: C.gray } }]]
  if (!ran) return [...out, [{ text: 'Running…', style: { fg: C.faint, italic: true } }]]
  const said = noAnsi(`${ran.stdout}\n${ran.stderr}`).trim()
  for (const l of said.split('\n').filter(Boolean)) out.push(...wrap([{ text: l, style: { fg: l.startsWith('✘') ? C.red : C.white } }], width))
  if (ran.code !== 0) {
    out.push(...wrap([{ text: `✘ It failed${ran.error ? `: ${ran.error}` : ` (exit ${ran.code})`}. Nothing changed in this session.`, style: { fg: C.red } }], width))
    return out
  }
  const r =
    reload === 'waiting' ? { text: '… The session reloads its plugins once Claude\'s turn is over.', style: { fg: C.yellow } }
    : reload === 'reloading' ? { text: '… Reloading the session\'s plugins.', style: { fg: C.faint, italic: true } }
    : reload === 'none' ? { text: 'Claude Code isn\'t running: it takes the change in when it starts.', style: { fg: C.gray } }
    : reload?.ok ? { text: `✔ Reloaded in this session: ${reload.plugins} plugin${reload.plugins === 1 ? '' : 's'}, ${reload.commands} commands${reload.errors ? `, ${reload.errors} errors` : ''}.`, style: { fg: reload.errors ? C.yellow : C.green } }
    : reload ? { text: `✘ The session couldn't reload its plugins: ${reload.error}. /reload-plugins tries again.`, style: { fg: C.red } }
    : undefined
  if (r) out.push(...wrap([r], width))
  return out
}
