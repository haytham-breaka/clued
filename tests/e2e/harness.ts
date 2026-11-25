// Drives the real app in a private tmux server, with a fake `claude` (fake-claude.ts) first on PATH
// and HOME in a temp dir, so nothing touches your own ~/.claude, ~/.clued, clipboard or notifications.
// When NODE_V8_COVERAGE is set (c8 sets it), the app writes its coverage there as it exits.

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cells } from '../../app/text.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FAKE = join(REPO, 'tests', 'e2e', 'fake-claude.ts')
/** CI machines are slower: the default wait for the screen. */
export const WAIT_MS = Number(process.env.E2E_WAIT_MS ?? 15_000)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export type LaunchOpts = {
  args?: string[]
  width?: number
  height?: number
  /** Runs before the app starts: write session files, settings, images. */
  setup?: (app: { dir: string; home: string; work: string }) => void
  env?: Record<string, string>
}

export type App = Awaited<ReturnType<typeof launch>>
type Find = { nth?: number; area?: 'chat' | 'panel'; dx?: number }


export async function launch(opts: LaunchOpts = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'clued-e2e-')))
  const bin = join(dir, 'bin')
  const home = join(dir, 'home')
  const work = join(dir, 'work')
  for (const d of [bin, home, work]) mkdirSync(d, { recursive: true })
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  // The fake Claude Code; its own process writes no coverage.
  script('claude', `unset NODE_V8_COVERAGE\nexec node --no-warnings ${q(FAKE)} "$@"`)
  // Windows toasts and clipboard (WSL), Linux notifications and clipboard: logged, never real.
  for (const name of ['powershell.exe', 'notify-send', 'osascript'])
    script(name, `printf '%s\\n' "$0 $*" >> ${q(join(dir, 'notify.log'))}\ncase "$*" in *GetImage*) [ -f ${q(join(dir, 'clip.png'))} ] && echo 'C:\\fake\\clip.png' ;; esac\nexit 0`)
  script('wslpath', `[ "$1" = -u ] && shift; case "$1" in 'C:\\fake\\clip.png') echo ${q(join(dir, 'clip.png'))} ;; *) echo "$1" ;; esac`)
  script('wl-paste', `[ -f ${q(join(dir, 'clip.png'))} ] && cat ${q(join(dir, 'clip.png'))} || exit 1`)
  script('xclip', `exit 1`)
  opts.setup?.({ dir, home, work })

  const W = opts.width ?? 120
  const H = opts.height ?? 34
  const cov = process.env.NODE_V8_COVERAGE
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    CLUED_CLIPBOARD: 'osc52',
    // Messages go at once (no hold to edit or delete them first) unless a test sets it: '' is the app's default.
    CLUED_HOLD_MS: '0',
    // And a message sent while Claude works goes at once too (Claude Code folds it in), unless a test sets it.
    CLUED_QUEUE: '0',
    // A toast stays up (it goes after 3.5 s in the app): its row going moves the chat down a row, and
    // a click on its way, at a place looked up a moment before, would land a row off.
    CLUED_TOAST_MS: '600000',
    FAKE_DIR: dir,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    ...(cov ? { NODE_V8_COVERAGE: cov } : {}),
    ...opts.env,
  }
  const envArgs = Object.entries(env).map(([k, v]) => `${k}=${q(v)}`).join(' ')
  const args = (opts.args ?? []).map(q).join(' ')
  const cmd = `cd ${q(work)} && exec env -u TERM_PROGRAM -u KITTY_WINDOW_ID -u WT_SESSION ${envArgs} node --no-warnings ${q(join(REPO, 'app', 'main.ts'))} ${args}`
  const tmuxEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'xterm-256color', SHELL: '/bin/sh' }
  const tmux = (...a: string[]) => execFileSync('tmux', ['-u', '-S', join(dir, 'tmux.sock'), '-f', '/dev/null', ...a], { encoding: 'utf8', env: tmuxEnv })
  // remain-on-exit keeps the pane (and its exit status) once the app quits; set-clipboard on puts
  // what the app copies (OSC 52) in a tmux buffer, for clipboard().
  tmux('start-server', ';', 'set-option', '-g', 'remain-on-exit', 'on', ';', 'set-option', '-g', 'set-clipboard', 'on', ';', 'new-session', '-d', '-x', String(W), '-y', String(H), cmd)
  const pid = Number(tmux('display-message', '-p', '#{pane_pid}').trim())
  // Everything the app writes, raw: what it prints as it quits doesn't stay on tmux's screen.
  tmux('pipe-pane', '-O', `cat > ${q(join(dir, 'output.log'))}`)

  const screen = () => tmux('capture-pane', '-p').replace(/\s+$/gm, '')
  /**
   * The screen, and whether it is a whole frame. The app writes each frame at once, top row to bottom
   * row with the cursor hidden, then shows the cursor in the input box (none while a permission prompt
   * or the session picker is up: it stays on the last row). But tmux takes a big frame in in pieces,
   * so a capture can catch one half drawn (this frame's rows above, the last one's below), its cursor
   * hidden on a row above the last. Both come from one tmux command: tmux takes in nothing between.
   */
  const capture = () => {
    const o = tmux('display-message', '-p', '#{cursor_flag} #{cursor_y} #{pane_height}', ';', 'capture-pane', '-p')
    const nl = o.indexOf('\n')
    const [shown, y, h] = o.slice(0, nl).split(' ').map(Number)
    return { isWhole: shown === 1 || y === h! - 1, screen: o.slice(nl + 1).replace(/\s+$/gm, '') }
  }
  const lines = () => screen().split('\n')

  let lastClick = { row: 0, col: 0, at: 0 }
  const app = {
    dir,
    home,
    work,
    pid,
    screen,
    lines,
    /** Types text as keys, literally. */
    type(text: string) {
      tmux('send-keys', '-l', text)
    },
    /** tmux key names: Enter, Escape, C-o, M-Up… */
    keys(...k: string[]) {
      tmux('send-keys', ...k)
    },
    /** Raw bytes to the app (escape sequences: mouse, focus, paste). */
    raw(s: string) {
      tmux('send-keys', '-l', s)
    },
    async send(text: string) {
      app.type(text)
      await sleep(30)
      app.keys('Enter')
    },
    /** Waits until the screen shows `what`; returns the screen. */
    async waitFor(what: string | RegExp | ((s: string) => boolean), ms = WAIT_MS): Promise<string> {
      const test = typeof what === 'function' ? what : typeof what === 'string' ? (s: string) => s.includes(what) : (s: string) => what.test(s)
      const until = Date.now() + ms
      let s = ''
      while (Date.now() < until) {
        const c = capture()
        s = c.screen
        // Only a whole frame counts.
        if (c.isWhole && test(s)) return s
        await sleep(50)
      }
      throw new Error(`Timed out waiting for ${String(what)}. Screen:\n${s}`)
    },
    /**
     * Waits until the screen shows `what` and Claude's turn is over (○ idle, atop the panel). A reply's
     * words show while Claude writes them ("Claude is typing…"); its quote, its actions on hover and
     * the footer of the message it answers come once the turn ends, and can move what is on screen.
     */
    async waitIdle(what: string, ms = WAIT_MS) {
      return app.waitFor(s => s.includes(what) && s.includes('○ idle'), ms)
    },
    /** Waits until the screen no longer shows `what`. */
    async waitGone(what: string | RegExp, ms = WAIT_MS) {
      return app.waitFor(s => (typeof what === 'string' ? !s.includes(what) : !what.test(s)), ms)
    },
    /** Waits for a line in the fake Claude's log that passes `test`. */
    async waitLog(test: (e: any) => boolean, ms = WAIT_MS) {
      const until = Date.now() + ms
      while (Date.now() < until) {
        const hit = app.claudeLog().find(test)
        if (hit) return hit
        await sleep(50)
      }
      throw new Error(`Timed out waiting for a claude.log line.\n${readIf(join(dir, 'claude.log'))}`)
    },
    /** Every line the fake Claude got (and its start line with args). */
    claudeLog(): any[] {
      return readIf(join(dir, 'claude.log')).split('\n').filter(Boolean).map(l => JSON.parse(l))
    },
    /** The user messages the app sent Claude: their visible text and hidden note. */
    sent(): { text: string; note: string; images: number }[] {
      return app.claudeLog().filter(e => e.type === 'user').map(e => {
        const c = e.message.content
        const blocks: any[] = Array.isArray(c) ? c : [{ type: 'text', text: c }]
        const texts = blocks.filter(b => b.type === 'text').map(b => b.text)
        return { text: texts[0] ?? '', note: texts[1] ?? '', images: blocks.filter(b => b.type === 'image').length }
      })
    },
    /** What the app wrote to the terminal so far, escape sequences and all. */
    output: () => readIf(join(dir, 'output.log')),
    /** The window title the app set (OSC 2). */
    title: () => tmux('display-message', '-p', '#{pane_title}').trim(),
    /** The text the app last copied (through OSC 52), '' when none. */
    clipboard(): string {
      try {
        return tmux('show-buffer')
      } catch {
        return ''
      }
    },
    /** Waits until the app has copied `text`. */
    async waitClipboard(text: string, ms = WAIT_MS) {
      const until = Date.now() + ms
      while (Date.now() < until) {
        if (app.clipboard() === text) return
        await sleep(50)
      }
      throw new Error(`Clipboard is ${JSON.stringify(app.clipboard())}, not ${JSON.stringify(text)}`)
    },
    /** Lets a waiting scenario go on (fake-claude.ts: release-<name>). */
    release(name: string) {
      writeFileSync(join(dir, `release-${name}`), '')
    },
    read: (rel: string) => readIf(join(dir, rel)),
    /** The column of the panel's divider (0 when there is no panel). */
    divider(): number {
      const first = lines()[0] ?? ''
      const i = first.indexOf('│')
      return i < 0 ? 0 : cells(first.slice(0, i)) + 1
    },
    /**
     * Where `text` is on screen: 1-based row and column, in cells. `nth` picks a later match (0 = first),
     * `area` only looks left of the panel's divider (panel) or right of it (chat).
     */
    find(text: string, opts: Find = {}): { row: number; col: number } | undefined {
      let n = 0
      const ls = lines()
      const div = opts.area ? app.divider() : 0
      for (let r = 0; r < ls.length; r++) {
        let from = 0
        for (let i = ls[r]!.indexOf(text, from); i >= 0; i = ls[r]!.indexOf(text, from)) {
          from = i + text.length
          const col = cells(ls[r]!.slice(0, i)) + 1
          if ((opts.area === 'chat' && col <= div) || (opts.area === 'panel' && col >= div)) continue
          if (n++ === (opts.nth ?? 0)) return { row: r + 1, col }
        }
      }
      return undefined
    },
    /**
     * Waits for the screen to hold still (two equal captures in a row, the second a whole frame), at
     * most `ms`: a toast or a redraw still on its way can move the layout under a position about to be
     * clicked. A spinner never holds still, hence the limit.
     */
    async settle(ms = 400) {
      const until = Date.now() + ms
      let last = screen()
      while (Date.now() < until) {
        await sleep(40)
        const now = capture()
        if (now.screen === last && now.isWhole) return
        last = now.screen
      }
    },
    /** Where `text` is, once the screen holds still (or a given position); throws when it isn't there. */
    async at(at: string | { row: number; col: number }, opts: Find = {}) {
      if (typeof at === 'string') await app.settle()
      const p = typeof at === 'string' ? app.find(at, opts) : at
      if (!p) throw new Error(`Not on screen: ${String(at)} ${JSON.stringify(opts)}\n${screen()}`)
      return { row: p.row, col: p.col + (opts.dx ?? 0) }
    },
    /** Clicks (press and release) on the first cell of `text` (plus `dx`), or at a row and column. */
    async click(at: string | { row: number; col: number }, opts: Find = {}) {
      const p = await app.at(at, opts)
      // Two clicks on one spot within 400 ms are a double-click to the app (it selects a word).
      const wait = lastClick.row === p.row && Math.abs(lastClick.col - p.col) <= 1 ? lastClick.at + 450 - Date.now() : 0
      if (wait > 0) await sleep(wait)
      lastClick = { ...p, at: Date.now() }
      app.raw(`\x1b[<0;${p.col};${p.row}M\x1b[<0;${p.col};${p.row}m`)
      await sleep(80)
      return p
    },
    /** Moves the pointer over a cell (no button). */
    async hover(at: string | { row: number; col: number }, opts: Find = {}) {
      const p = await app.at(at, opts)
      app.raw(`\x1b[<35;${p.col};${p.row}M`)
      await sleep(80)
      return p
    },
    /** Presses at one place, drags to another and lets go. */
    async drag(from: { row: number; col: number }, to: { row: number; col: number }) {
      app.raw(`\x1b[<0;${from.col};${from.row}M`)
      app.raw(`\x1b[<32;${to.col};${to.row}M`)
      await sleep(40)
      app.raw(`\x1b[<0;${to.col};${to.row}m`)
      await sleep(80)
    },
    /** Pages the chat up until `text` is on screen. */
    async scrollTo(text: string, pages = 12) {
      for (let i = 0; i < pages && !screen().includes(text); i++) {
        app.keys('PageUp')
        await sleep(80)
      }
      return app.waitFor(text, 2000)
    },
    wheel(row: number, col: number, up: boolean) {
      app.raw(`\x1b[<${up ? 64 : 65};${col};${row}M`)
    },
    /** Whether the app has exited, and its exit status. */
    exitStatus(): number | undefined {
      const [dead, status] = tmux('display-message', '-p', '#{pane_dead} #{pane_dead_status}').trim().split(' ')
      // The pane can read as dead a moment before its status is filled in.
      if (dead === '1' && status) return Number(status)
      // tmux 3.2 sometimes leaves the exited app unreaped for a long while. A zombie's exit status is
      // in /proc: the 52nd field of its stat, as waitpid reports it.
      try {
        const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')
        if (f[0] === 'Z') return Number(f[49]) >> 8
      } catch {}
      return undefined
    },
    async waitExit(ms = WAIT_MS): Promise<number> {
      const until = Date.now() + ms
      while (Date.now() < until) {
        const s = app.exitStatus()
        if (s != null) return s
        await sleep(50)
      }
      throw new Error('The app did not exit.')
    },
    /** Quits the app (so it writes its coverage), stops tmux and removes the temp dir. */
    async stop() {
      try {
        if (app.exitStatus() == null) {
          try {
            process.kill(pid, 'SIGTERM')
          } catch {}
          await app.waitExit(10_000).catch(() => {
            try {
              process.kill(pid, 'SIGKILL')
            } catch {}
          })
        }
      } finally {
        try {
          tmux('kill-server')
        } catch {}
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
  return app
}

function readIf(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** A Claude Code session file for the fake HOME, so -c and --resume have history. */
export function writeSession(home: string, cwd: string, id: string, lines: unknown[]) {
  const d = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, `${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

/**
 * Runs `fn` against a started app (Claude's init seen) and always stops it after. With `unfocused`,
 * the window reports focus lost first, so replies stay unread while the test looks at them.
 */
export async function withApp(opts: LaunchOpts & { unfocused?: boolean; ready?: string | false }, fn: (app: App) => Promise<void>) {
  const app = await launch(opts)
  try {
    if (opts.ready !== false) await app.waitFor(opts.ready ?? 'Fake 1.0')
    if (opts.unfocused) app.raw('\x1b[O')
    await fn(app)
  } finally {
    await app.stop()
  }
}

/** The screen's row holding `text`, as a string (for checking what sits on the same line). */
export const rowOf = (screen: string, text: string) => screen.split('\n').find(l => l.includes(text)) ?? ''
/** How many rows of the chat (right of the panel) show `text`. */
export const chatRowsWith = (screen: string, text: string) => {
  const edge = screen.split('\n')[0]!.indexOf('│') // the panel's edge, on its first row
  return screen.split('\n').filter(l => [...l].slice(edge + 1).join('').includes(text)).length
}
