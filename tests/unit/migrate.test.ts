import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// migrate.ts runs when it loads, against HOME: each run is a fresh process under the test's HOME.
// (A process each, not a fresh import each: coverage of `migrate.ts?run=N` imports doesn't add up.)
const MIGRATE = fileURLToPath(new URL('../../app/migrate.ts', import.meta.url))
let home = ''
const run = () => spawnSync(process.execPath, ['--no-warnings', MIGRATE], { encoding: 'utf8', env: { ...process.env, HOME: home } })
const fresh = () => (home = mkdtempSync(join(tmpdir(), 'clued-migrate-')))
afterEach(() => rmSync(home, { recursive: true, force: true }))

test('moves ~/.threadline to ~/.clued and leaves a link behind', () => {
  fresh()
  mkdirSync(join(home, '.threadline'))
  writeFileSync(join(home, '.threadline', 'panel.json'), '{"width":30}')
  run()
  assert.equal(readFileSync(join(home, '.clued', 'panel.json'), 'utf8'), '{"width":30}')
  assert.ok(lstatSync(join(home, '.threadline')).isSymbolicLink())
  assert.equal(readlinkSync(join(home, '.threadline')), join(home, '.clued'))
})

test('leaves things alone when ~/.clued exists, or the old path is already a link, or nothing is there', () => {
  fresh()
  mkdirSync(join(home, '.clued'))
  mkdirSync(join(home, '.threadline'))
  run()
  assert.ok(!lstatSync(join(home, '.threadline')).isSymbolicLink())
  rmSync(join(home, '.clued'), { recursive: true })
  rmSync(join(home, '.threadline'), { recursive: true })
  symlinkSync('/tmp', join(home, '.threadline'))
  run()
  assert.ok(!existsSync(join(home, '.clued')))
  rmSync(join(home, '.threadline'))
  run()
  assert.ok(!existsSync(join(home, '.clued')))
})

test('says so, and goes on, when the move fails', { skip: process.getuid?.() === 0 && 'root can write anywhere' }, () => {
  fresh()
  mkdirSync(join(home, '.threadline'))
  // HOME read-only: the rename into it fails.
  chmodSync(home, 0o555)
  let stderr = ''
  try {
    stderr = run().stderr
  } finally {
    chmodSync(home, 0o755)
  }
  assert.match(stderr, /^clued: could not move .*\.threadline to .*\.clued: /)
  assert.ok(!existsSync(join(home, '.clued')))
})
