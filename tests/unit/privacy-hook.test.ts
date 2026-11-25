// The privacy hook (scripts/check-private.sh) blocks what it reports: run on a throwaway repo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Built at run time, so this file itself has nothing for the hook to find.
const at = '@'
const someEmail = `someone${at}corp.io`
const homePath = `/ho${'me'}/alice/notes.txt`

function check(files: Record<string, string | Buffer>): { code: number; err: string } {
  const dir = mkdtempSync(join(tmpdir(), 'clued-hook-'))
  try {
    const env = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
    const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' })
    git('init', '-q')
    mkdirSync(join(dir, 'scripts'))
    copyFileSync('scripts/check-private.sh', join(dir, 'scripts/check-private.sh'))
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
    git('add', '.')
    const r = spawnSync('bash', ['scripts/check-private.sh'], { cwd: dir, env, encoding: 'utf8' })
    return { code: r.status ?? -1, err: r.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('clean files and the safe addresses pass', () => {
  const r = check({ 'a.md': `Co-Authored-By: x <noreply${at}anthropic.com>\nby 1+me${at}users.noreply.github.com, see dev${at}example.com\n` })
  assert.equal(r.code, 0, r.err)
})

test('an email is blocked, not only reported', () => {
  const r = check({ 'a.md': `mail ${someEmail}\n` })
  assert.equal(r.code, 1)
  assert.match(r.err, /a\.md contains the email someone/)
})

test('a file that never belongs is blocked', () => {
  const r = check({ 'run.log': 'hello\n' })
  assert.equal(r.code, 1)
  assert.match(r.err, /run\.log should not be committed/)
})

test('a home-folder path is blocked', () => {
  assert.equal(check({ 'a.md': `see ${homePath}\n` }).code, 1)
})

test('binary files are skipped (an image whose bytes look like an email)', () => {
  const gif = Buffer.concat([Buffer.from('GIF89a\0\0\x01'), Buffer.from(`gifski${at}encoder.rs`), Buffer.from([0, 255, 0])])
  const r = check({ 'demo.gif': gif })
  assert.equal(r.code, 0, r.err)
})
