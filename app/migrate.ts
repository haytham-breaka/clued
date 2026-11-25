// The app was called threadline and kept its state in ~/.threadline. On the first start
// as clued, that folder moves to ~/.clued, and a link is left at the old path so a
// launcher started before the rename still finds its reload file.
// Imported first by main.ts, so it runs before anything reads ~/.clued.

import { existsSync, lstatSync, renameSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'

const old = `${homedir()}/.threadline`
const now = `${homedir()}/.clued`
try {
  if (!existsSync(now) && existsSync(old) && !lstatSync(old).isSymbolicLink()) {
    renameSync(old, now)
    symlinkSync(now, old)
  }
} catch (e) {
  console.error(`clued: could not move ${old} to ${now}: ${(e as Error).message}`)
}
