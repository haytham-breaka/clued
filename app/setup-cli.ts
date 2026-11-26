// `clued setup`: the optional extras from the shell, the same ones as /setup in the app, each
// installed only after a y. `clued setup --check` only prints their statuses.

import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { MARK, plan, statuses, systemIo } from './setup.ts'
import type { SetupIo, Status } from './setup.ts'

const line = (s: Status) => `${MARK[s.state]} ${s.name}: ${s.text}`

/** Reads answers from stdin one line at a time (a terminal, or a pipe in the tests). */
function asker(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
  const rl = createInterface({ input, terminal: false })
  const queue: string[] = []
  const waiting: ((s: string | undefined) => void)[] = []
  let closed = false
  rl.on('line', l => (waiting.length ? waiting.shift()!(l) : queue.push(l)))
  rl.on('close', () => {
    closed = true
    for (const w of waiting.splice(0)) w(undefined)
  })
  return {
    ask(q: string): Promise<boolean> {
      output.write(`${q} [y/N] `)
      return new Promise(done => {
        const take = (a: string | undefined) => {
          if (a === undefined) output.write('\n')
          done(/^\s*y(es)?\s*$/i.test(a ?? ''))
        }
        if (queue.length) take(queue.shift())
        else if (closed) take(undefined)
        else waiting.push(take)
      })
    },
    close: () => rl.close(),
  }
}

export async function main(args: string[], io: SetupIo = systemIo(), input: NodeJS.ReadableStream = process.stdin, out: NodeJS.WritableStream = process.stdout): Promise<number> {
  const say = (s = '') => void out.write(`${s}\n`)
  if (args.some(a => a !== '--check')) {
    say('usage: clued setup [--check]')
    return 2
  }
  const rows = await statuses(io)
  say('clued: the optional extras\n')
  for (const s of rows) say(line(s))
  if (args.includes('--check')) return 0
  const todo = rows.filter(s => s.state === 'missing')
  if (!todo.length) {
    say('\nNothing to install.')
    return 0
  }
  const a = asker(input, out)
  let failed = false
  try {
    for (const s of todo) {
      const p = await plan(io, s.id)
      say('')
      if ('error' in p) {
        say(`${s.name}: ${p.error}.`)
        continue
      }
      say(p.title)
      for (const step of p.steps) say(`  • ${step}`)
      if (p.warn) say(`  ⚠ ${p.warn}`)
      if (!(await a.ask(p.replaces ? `Replace “${p.replaces}”?` : 'Install?'))) {
        say('  Skipped.')
        continue
      }
      const r = await p.run(l => say(`  ${l}`))
      say(`${r.ok ? '✓' : '✗'} ${r.text}`)
      if (!r.ok) failed = true
    }
  } finally {
    a.close()
  }
  return failed ? 1 : 0
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
