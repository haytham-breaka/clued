// The launchers in bin/: clued (and its /reload loop), ct and clued-classic, each run through
// symlinks, with a fake `node` and `claude` that log what they get. They run under CLUED_TEST_BASH,
// else macOS's own /bin/bash (3.2: an empty array under set -u is an error there), else bash.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = realpathSync(join(import.meta.dirname, '..', '..'))
const BASH = process.env.CLUED_TEST_BASH || (process.platform === 'darwin' ? '/bin/bash' : execFileSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim())

/**
 * A temp dir whose bin/ comes first on PATH, with `bash` (so the scripts' `#!/usr/bin/env bash` is
 * BASH), a fake `node` and `claude`, and links/<name> → ../real/<name> → bin/<name> in the repo.
 * The fake node logs its arguments; the first FAKE_RELOADS runs ask for a /reload (exit 75 with
 * ~/.clued/reload holding s<n>), then it exits FAKE_EXIT (0).
 */
function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'clued-launcher-')))
  const bin = join(dir, 'bin')
  const home = join(dir, 'home')
  for (const d of [bin, home, join(dir, 'links'), join(dir, 'real')]) mkdirSync(d)
  symlinkSync(BASH, join(bin, 'bash'))
  const log = join(dir, 'calls.log')
  const fake = (name: string, extra: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s' ${name} >> '${log}'\nfor a in "$@"; do printf ' [%s]' "$a" >> '${log}'; done\necho >> '${log}'\n${extra}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  fake('node', [
    `n=$(grep -c '^node' '${log}')`,
    'if [ "$n" -le "${FAKE_RELOADS:-0}" ]; then mkdir -p "$HOME/.clued"; printf "s%s" "$n" > "$HOME/.clued/reload"; exit 75; fi',
    'exit "${FAKE_EXIT:-0}"',
  ].join('\n'))
  fake('claude', 'exit 0')
  for (const name of ['clued', 'ct', 'clued-classic']) {
    // A relative link to an absolute one: both kinds are followed.
    symlinkSync(join(REPO, 'bin', name), join(dir, 'real', name))
    symlinkSync(join('..', 'real', name), join(dir, 'links', name))
  }
  const run = (name: string, args: string[] = [], env: Record<string, string> = {}) => {
    const r = spawnSync(join(dir, 'links', name), args, { encoding: 'utf8', cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...env } })
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
    rmSync(log, { force: true })
    return { status: r.status, stderr: r.stderr, calls }
  }
  return { dir, home, run, done: () => rmSync(dir, { recursive: true, force: true }) }
}

const MAIN = `node [--no-warnings] [${REPO}/app/main.ts]`

describe(`launchers (${execFileSync(BASH, ['-c', 'echo "bash $BASH_VERSION"'], { encoding: 'utf8' }).trim()})`, () => {
  test('clued with no flags starts the app from the repo, through symlinks, and passes its exit status on', () => {
    const s = sandbox()
    try {
      let r = s.run('clued')
      assert.equal(r.stderr, '')
      assert.equal(r.status, 0)
      assert.deepEqual(r.calls, [MAIN])
      r = s.run('clued', ['--model', 'opus', ''], { FAKE_EXIT: '3' })
      assert.equal(r.status, 3)
      assert.deepEqual(r.calls, [`${MAIN} [--model] [opus] []`])
      // 75 with no session to reload is just an exit.
      r = s.run('clued', [], { FAKE_EXIT: '75' })
      assert.equal(r.status, 75)
      assert.deepEqual(r.calls, [MAIN])
    } finally {
      s.done()
    }
  })

  test('/reload starts it again on the same session, with the other flags', () => {
    const s = sandbox()
    try {
      // -c alone: nothing else is kept (an empty array, which bash 3.2 under set -u calls unbound).
      let r = s.run('clued', ['-c'], { FAKE_RELOADS: '2' })
      assert.equal(r.stderr, '')
      assert.equal(r.status, 0)
      assert.deepEqual(r.calls, [`${MAIN} [-c]`, `${MAIN} [--resume] [s1]`, `${MAIN} [--resume] [s2]`])
      assert.ok(!existsSync(join(s.home, '.clued', 'reload')))
      // No flags at all.
      r = s.run('clued', [], { FAKE_RELOADS: '1' })
      assert.deepEqual(r.calls, [MAIN, `${MAIN} [--resume] [s1]`])
      // An old --resume and its id go; the other flags stay, a space in one too.
      r = s.run('clued', ['--resume', 'old', '--model', 'opus', '--append-system-prompt', 'a b'], { FAKE_RELOADS: '1' })
      assert.deepEqual(r.calls, [`${MAIN} [--resume] [old] [--model] [opus] [--append-system-prompt] [a b]`, `${MAIN} [--model] [opus] [--append-system-prompt] [a b] [--resume] [s1]`])
    } finally {
      s.done()
    }
  })

  test('ct is clued under its old name', () => {
    const s = sandbox()
    try {
      const r = s.run('ct', ['-c'])
      assert.equal(r.stderr, '')
      assert.equal(r.status, 0)
      assert.deepEqual(r.calls, [`${MAIN} [-c]`])
    } finally {
      s.done()
    }
  })

  test('clued-classic with CLUED_PLAIN runs Claude Code with the repo as its plugin dir', () => {
    const s = sandbox()
    try {
      let r = s.run('clued-classic', [], { CLUED_PLAIN: '1' })
      assert.equal(r.stderr, '')
      assert.equal(r.status, 0)
      assert.deepEqual(r.calls, [`claude [--plugin-dir] [${REPO}]`])
      r = s.run('clued-classic', ['-c', '--model', 'opus'], { CLUED_PLAIN: '1' })
      assert.deepEqual(r.calls, [`claude [--plugin-dir] [${REPO}] [-c] [--model] [opus]`])
    } finally {
      s.done()
    }
  })

  const tmux = spawnSync('tmux', ['-V']).status === 0
  test('bin/tmux.conf picks tmux-256color only where the machine knows it (macOS\'s own terminfo doesn\'t)', { skip: !tmux && 'no tmux' }, () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'clued-tmux-')))
    const t = (...a: string[]) => execFileSync('tmux', ['-S', join(dir, 'sock'), '-f', join(REPO, 'bin', 'tmux.conf'), ...a], { encoding: 'utf8' })
    try {
      t('new-session', '-d', 'sleep 30')
      const known = spawnSync('infocmp', ['tmux-256color']).status === 0
      assert.equal(t('show-options', '-gv', 'default-terminal').trim(), known ? 'tmux-256color' : 'screen-256color')
    } finally {
      try {
        t('kill-server')
      } catch {}
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
