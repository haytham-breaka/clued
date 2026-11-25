import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Line } from '../../app/text.ts'
import type { Turn } from '../../app/session.ts'

// session.ts reads HOME when it loads: a temp one first.
const home = mkdtempSync(join(tmpdir(), 'clued-local-'))
process.env.HOME = home
after(() => rmSync(home, { recursive: true, force: true }))
const L = await import('../../app/local.ts')
const { newTurn } = await import('../../app/session.ts')

const text = (l: Line) => l.map(s => s.text).join('')
const turn = (mine: string, answer: string, extra: Partial<Turn> = {}): Turn => ({ ...newTurn(mine, Date.UTC(2026, 10, 25, 10, 5)), answer, isDone: true, ...extra })

describe('local commands', () => {
  test('facts: the initialize answer, then init and changed commands', () => {
    const f: import('../../app/local.ts').Facts = { commands: [] }
    L.takeFacts(f, { kind: 'init', sessionId: 's', model: 'm', cwd: '/tmp', commands: ['compact'], permissionMode: 'default' })
    assert.deepEqual(f.commands, [{ name: 'compact' }])
    L.takeFacts(f, { kind: 'hello', info: { commands: [{ name: 'cost', description: 'Cost' }], account: { email: 'a@example.com' }, claude_code_version: '2.0', output_style: 'Concise', models: [] } })
    assert.equal(f.version, '2.0')
    assert.equal(f.commands[0]!.description, 'Cost')
    L.takeFacts(f, { kind: 'init', sessionId: 's', model: 'm', cwd: '/tmp', commands: ['x'], permissionMode: 'default', version: '2.1', mcpServers: [], apiKeySource: 'ANTHROPIC_API_KEY', outputStyle: 'Learning' })
    assert.equal(f.commands[0]!.name, 'cost', 'init keeps the described commands')
    assert.equal(f.version, '2.1')
    L.takeFacts(f, { kind: 'commands', commands: [{ name: 'new' }] })
    assert.deepEqual(f.commands, [{ name: 'new' }])
    const rows = Object.fromEntries(L.statusRows({ cliVersion: '1', sessionId: '', cwd: '/tmp/w', here: '/tmp/w/sub', model: 'm', permissionMode: 'plan', contextUsed: 12_000, contextSize: 200_000, costUsd: 0.5, extra: [['More', 'yes']] }, f))
    assert.match(rows.Account!, /a@example\.com · API key \(ANTHROPIC_API_KEY\)/)
    assert.equal(rows.Session, 'new: no messages yet')
    assert.match(rows.Folder!, /Claude is in \/tmp\/w\/sub/)
    assert.match(rows['Permission mode']!, /^plan/)
    assert.equal(rows['Output style'], 'Learning')
    assert.equal(rows.Context, '12k of 200k tokens (6%)')
    assert.match(rows.Cost!, /\$0\.5000/)
    assert.equal(rows.More, 'yes')
    assert.equal(rows['MCP servers'], 'none')
    // Nothing known yet.
    const none = Object.fromEntries(L.statusRows({ cliVersion: '1', sessionId: 's', cwd: '/tmp', model: '', permissionMode: 'odd', contextUsed: 0, contextSize: 999, costUsd: 0 }, { commands: [], account: { apiProvider: 'bedrock' }, mcpServers: [{ name: 'x', status: 'failed' }, { name: 'y', status: 'pending' }] }))
    assert.equal(none['Claude Code'], 'not started yet')
    assert.equal(none.Account, 'bedrock')
    assert.equal(none.Model, 'not known yet')
    assert.equal(none['Permission mode'], 'odd')
    assert.equal(none.Context, '999 tokens')
    assert.equal(none['MCP servers'], '✘ x (failed)\n… y (pending)')
    const lines = L.statusLines(Object.entries(none) as [string, string][], 40).map(text)
    assert.ok(lines.some(l => /^ +… y \(pending\)/.test(l)))
  })

  test('/help without Claude Code\'s commands says when they come', () => {
    const lines = L.helpLines(['help', 'unknown'], { commands: [] }, 60).map(text)
    assert.ok(lines.some(l => l.startsWith('/unknown')))
    assert.ok(lines.some(l => /show here once it has started/.test(l)))
  })

  test('replies, the export and its file name', () => {
    const turns = [
      turn('Fix the login page, please!', 'Done.'),
      { ...turn('👍', ''), reaction: '👍' },
      turn('', '', { parts: [{ to: ['T1'], text: 'An agent came back.' }, { to: ['T2'], text: 'And another.' }], followUp: ['k'] }),
      turn('', 'The job ran.', { fired: { prompt: 'check' } }),
      turn('break it', '', { error: 'Claude Code stopped.' }),
    ]
    assert.deepEqual(L.replies(turns), ['Done.', 'An agent came back.\n\nAnd another.', 'The job ran.'])
    const md = L.exportMarkdown(turns, { sessionId: '', cwd: '/tmp/w', now: Date.UTC(2026, 10, 25, 12) })
    assert.match(md, /^# Fix the login page, please!\n/)
    assert.doesNotMatch(md, /session|👍|<clued>/)
    assert.match(md, /## Claude · on its own · .*\n\nAn agent came back\.\n\nAnd another\./)
    assert.match(md, /## Claude · a scheduled job/)
    assert.match(md, /_Claude Code stopped\._/)
    assert.equal(L.exportMarkdown([], { sessionId: 'x', cwd: '/tmp', now: 0 }).split('\n')[0], '# A chat with Claude')
    assert.match(L.exportName(turns, Date.UTC(2026, 10, 25, 12)), /^2026-11-2\d-fix-the-login-page-please\.md$/)
    assert.match(L.exportName([turn('/compact', '')], 0), /-chat\.md$/)
    const dir = mkdtempSync(join(tmpdir(), 'clued-export-'))
    try {
      mkdirSync(join(dir, 'sub'))
      assert.equal(L.exportPath(dir, 'out.txt', turns, 0), join(dir, 'out.txt'))
      assert.equal(L.exportPath(dir, 'sub', turns, 0), join(dir, 'sub', L.exportName(turns, 0)))
      assert.equal(L.exportPath(dir, '/tmp/abs/x', turns, 0), '/tmp/abs/x.md')
      assert.equal(L.exportPath(dir, '~/notes.md', turns, 0), join(home, 'notes.md'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('parseDiff: files, hunks, renames, deletions, binaries, and lines that look like headers', () => {
    const files = L.parseDiff([
      'diff --git a/a.txt b/a.txt',
      'index 1..2 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,3 +1,3 @@ heading',
      ' keep',
      '--- removed dashes',
      '+++ added pluses',
      '\\ No newline at end of file',
      '@@ -10,1 +10,1 @@',
      '-x',
      '+y',
      'diff --git a/old.txt b/new.txt',
      'similarity index 90%',
      'rename from old.txt',
      'rename to new.txt',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-one',
      '-two',
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
      'diff --git a/new.txt b/new.txt',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+hello',
    ].join('\n'))
    assert.deepEqual(files.map(f => [f.path, f.note, f.added, f.removed, f.hunks.length]), [
      ['a.txt', undefined, 2, 2, 2],
      ['new.txt', 'renamed from old.txt', 0, 0, 0],
      ['gone.txt', 'deleted', 0, 2, 1],
      ['img.png', 'binary', 0, 0, 0],
      ['new.txt', 'new', 1, 0, 1],
    ])
    assert.deepEqual(files[0]!.hunks[0], { before: 'keep\n-- removed dashes', after: 'keep\n++ added pluses', at: 1 })
    assert.equal(files[0]!.hunks[1]!.at, 10)
    // Drawn: each file's head, hunks parted, a deleted file's lines all removed.
    const lines = L.diffLines(files, 60, new Set(), () => {}).map(text)
    assert.ok(lines.some(l => l.includes('gone.txt  (deleted)')))
    assert.ok(lines.some(l => / 1 - one/.test(l)))
    assert.ok(lines.some(l => l.includes('⋯')), 'hunks parted')
    // A long file is cut, and shown whole once asked.
    const long = L.parseDiff(['diff --git a/l b/l', '@@ -1 +1,300 @@', ...Array.from({ length: 300 }, (_, i) => `+line ${i}`)].join('\n'))
    let asked = ''
    const cut = L.diffLines(long, 60, new Set(), p => (asked = p))
    const more = cut.at(-1)!
    assert.match(text(more), /… \d+ more lines, show all/)
    more[0]!.action!()
    assert.equal(asked, 'l')
    assert.ok(L.diffLines(long, 60, new Set(['l']), () => {}).length > cut.length)
  })

  test('gitDiff: no repository, no commit yet, a long new file, a failing git', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clued-git-'))
    try {
      assert.deepEqual(L.gitDiff(dir), { kind: 'not-repo' })
      execFileSync('git', ['-C', dir, 'init', '-q'])
      assert.deepEqual(L.gitDiff(dir), { kind: 'clean' })
      writeFileSync(join(dir, 'big.txt'), Array.from({ length: 250 }, (_, i) => `l${i}`).join('\n') + '\n')
      writeFileSync(join(dir, 'bin.dat'), 'a\0b')
      execFileSync('git', ['-C', dir, 'add', 'big.txt'])
      const d = L.gitDiff(dir)
      assert.equal(d.kind, 'diff')
      if (d.kind !== 'diff') return
      // Staged in a repository with no commit: against the empty tree. The binary is untracked.
      assert.deepEqual(d.files.map(f => [f.path, f.note ?? '', f.added]), [['big.txt', 'new', 250], ['bin.dat', 'new, binary', 0]])
      execFileSync('git', ['-C', dir, 'reset', '-q'])
      const u = L.gitDiff(dir)
      const big = u.kind === 'diff' ? u.files.find(f => f.path === 'big.txt')! : undefined
      assert.equal(big?.note, 'new, untracked')
      const lines = L.diffLines([big!], 60, new Set(['big.txt']), () => {}).map(text)
      assert.match(lines.at(-1)!, /… 50 more lines in the file/)
      // git itself failing (a broken repository).
      rmSync(join(dir, '.git', 'HEAD'))
      writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      writeFileSync(join(dir, '.git', 'index'), 'not an index')
      assert.equal(L.gitDiff(dir).kind, 'failed')
      // No git at all.
      const path = process.env.PATH
      process.env.PATH = '/nonexistent'
      try {
        assert.deepEqual(L.gitDiff(dir), { kind: 'no-git' })
      } finally {
        process.env.PATH = path
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('/add-dir folders and /branch titles in the picker', () => {
    const local = new L.Local(() => {})
    local.fresh.push('/tmp/a')
    assert.deepEqual(local.dirArgs(undefined, { board: {} as any, reactions: {}, links: {} }), ['--add-dir', '/tmp/a'])
    const kept = { board: {} as any, reactions: {}, links: {}, addDirs: ['/tmp/b'] }
    assert.ok(local.settle(kept))
    assert.deepEqual(kept.addDirs, ['/tmp/b', '/tmp/a'])
    assert.ok(!local.settle(kept))
    local.fresh.push('/tmp/c')
    // Another session opened: the new one's folders are dropped.
    assert.deepEqual(local.dirArgs('s2', kept), ['--add-dir', '/tmp/b', '--add-dir', '/tmp/a'])
    assert.deepEqual(local.fresh, [])
    mkdirSync(join(home, '.clued', 'sessions'), { recursive: true })
    writeFileSync(join(home, '.clued', 'sessions', 'b1.json'), JSON.stringify({ forkOf: { id: 'original-id', at: 1 } }))
    writeFileSync(join(home, '.clued', 'sessions', 'b2.json'), JSON.stringify({ forkOf: { id: 'original-id', at: 2, name: 'other way' } }))
    const sessions = [{ id: 'b2', mtime: 3, title: 'T' }, { id: 'b1', mtime: 2, title: 'T' }, { id: 'original-id', mtime: 1, title: 'T' }, { id: 'x', mtime: 0, title: 'U' }]
    const titles = local.titles(sessions, '/tmp/w')
    assert.deepEqual(titles, ['⑂ other way · T  (a branch of original)', '⑂ T  (a branch of original)', 'T  (⑂ 2 branches; original)', 'U'])
    assert.equal(local.titles(sessions, '/tmp/w'), titles, 'worked out once for the list')
  })

  test('cards: one per command, laid out once per width, Esc closes the latest', () => {
    let draws = 0
    const cards = new L.Cards(() => draws++)
    let calls = 0
    const a = cards.add({ title: 'help', about: 'a', after: '', body: () => (calls++, [[{ text: 'body' }]]), actions: [{ label: 'go', run: () => {} }] })
    cards.lines(a, 60)
    cards.lines(a, 60)
    assert.equal(calls, 1)
    cards.redo(a.id)
    cards.lines(a, 60)
    assert.equal(calls, 2)
    cards.add({ title: 'help', about: 'b', after: '', body: () => [] })
    assert.equal(cards.list.length, 1)
    const laid = cards.into({ lines: [[{ text: 'x' }]], anchors: {}, owners: [''] }, [], 60)
    assert.equal(laid.anchors[`card:${cards.list[0]!.id}`], 1)
    assert.ok(cards.dismissLast())
    assert.ok(!cards.dismissLast())
    assert.ok(draws >= 4)
    assert.match(L.cluedVersion(), /^\d+\.\d+/)
  })
})
