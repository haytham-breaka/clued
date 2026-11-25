// What clued keeps in ~/.clued only for a while. sent.log, a log for debugging that nothing in the app
// reads back, keeps its last 7 days and at most 5 MB. A pasted image goes once it is 30 days old and
// no session's kept state names it any more: an image a message was sent with stays, so a click on
// its [image N] still opens it.
//
// CLUED_LOG_DAYS, CLUED_LOG_MB and CLUED_IMAGE_DAYS change these limits; 0 turns a limit off.

import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

export const DAY_MS = 86_400_000
const MB = 1024 * 1024

export type Limits = { logMs: number; logBytes: number; imageMs: number }

/** A limit from the environment: a number from 0 up (0 is no limit: Infinity), else `fallback`. */
export function envLimit(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return n === 0 ? Infinity : n
}

/** The limits: 7 days and 5 MB of sent.log, unsent pasted images for 30 days. */
export const limits = (env: Record<string, string | undefined> = process.env): Limits => ({
  logMs: envLimit(env.CLUED_LOG_DAYS, 7) * DAY_MS,
  logBytes: envLimit(env.CLUED_LOG_MB, 5) * MB,
  imageMs: envLimit(env.CLUED_IMAGE_DAYS, 30) * DAY_MS,
})

/**
 * A log's lines (`<ISO time> <what> <json>`) within `maxMs` of `now` and, newest first, at most
 * `maxBytes` in all. A line with no time at its start can't be dated, so it goes. A last line cut
 * short (the app stopped mid-write) stays when it is recent, with its newline, so the next entry
 * starts a line of its own. `cut`: the text starts mid-line (the tail of a bigger file), so its
 * first line goes.
 */
export function trimLog(text: string, now: number, maxMs: number, maxBytes: number, cut = false): string {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (cut) lines.shift()
  const kept = lines.filter(l => {
    const at = Date.parse(l.slice(0, l.indexOf(' ')))
    return !Number.isNaN(at) && now - at <= maxMs
  })
  let bytes = 0
  let from = kept.length
  while (from > 0) {
    const size = Buffer.byteLength(kept[from - 1]!) + 1
    if (bytes + size > maxBytes) break
    bytes += size
    from--
  }
  return kept.slice(from).map(l => `${l}\n`).join('')
}

/**
 * Trims a log file (trimLog) in place, when anything goes: a new file renamed over the old one, so a
 * reader never sees half of it. Only the last `logBytes` of a bigger file are read. Lines another
 * clued appended meanwhile are carried over. Says whether it rewrote the file.
 */
export function trimLogFile(path: string, lim: Pick<Limits, 'logMs' | 'logBytes'>, now = Date.now()): boolean {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return false
  }
  const tmp = `${path}.${process.pid}.tmp`
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - lim.logBytes)
    const text = readAt(fd, start, size)
    const out = trimLog(text, now, lim.logMs, lim.logBytes, start > 0)
    if (start === 0 && out === text) return false
    const grown = fstatSync(fd).size
    writeFileSync(tmp, out + (grown > size ? readAt(fd, size, grown) : ''), { mode: 0o600 })
    renameSync(tmp, path)
    return true
  } catch {
    try {
      unlinkSync(tmp)
    } catch {}
    return false
  } finally {
    closeSync(fd)
  }
}

function readAt(fd: number, from: number, to: number): string {
  const buf = Buffer.alloc(to - from)
  let got = 0
  while (got < buf.length) {
    const n = readSync(fd, buf, got, buf.length - got, from + got)
    if (!n) break
    got += n
  }
  return buf.subarray(0, got).toString('utf8')
}

/** The image files a session's kept state names: those its messages were sent with, and those of messages still held. */
export function keptImages(kept: unknown): string[] {
  const k = (kept ?? {}) as { images?: Record<string, unknown>; held?: unknown }
  const out: string[] = []
  for (const paths of Object.values(k.images ?? {})) if (Array.isArray(paths)) out.push(...paths.filter(p => typeof p === 'string'))
  if (Array.isArray(k.held)) {
    for (const h of k.held as { from?: { images?: unknown } }[]) {
      const imgs = h?.from?.images
      if (Array.isArray(imgs)) for (const i of imgs as { path?: unknown }[]) if (typeof i?.path === 'string') out.push(i.path)
    }
  }
  return out
}

/** A file the app saved from the clipboard: its name is the time, in ms, and .png. */
const PASTED = /^\d+\.png$/

/**
 * Deletes the pasted images in `dir` older than `maxMs` that no kept session in `sessions` names,
 * nor `inUse` (the ones in this app's box, or held). When a session's file can't be read, it can't
 * tell which images are still wanted, so it deletes none. Returns the names it deleted.
 */
export function cleanImages(dir: string, sessions: string, maxMs: number, now = Date.now(), inUse: Iterable<string> = []): string[] {
  if (!Number.isFinite(maxMs)) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const old = names.filter(n => {
    if (!PASTED.test(n)) return false
    try {
      const st = statSync(`${dir}/${n}`)
      return st.isFile() && now - st.mtimeMs > maxMs
    } catch {
      return false
    }
  })
  if (!old.length) return []
  const named = new Set([...inUse].map(p => basename(p)))
  let files: string[] = []
  try {
    files = readdirSync(sessions).filter(f => f.endsWith('.json'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return []
  }
  for (const f of files) {
    try {
      for (const p of keptImages(JSON.parse(readFileSync(`${sessions}/${f}`, 'utf8')))) named.add(basename(p))
    } catch {
      return []
    }
  }
  const gone: string[] = []
  for (const n of old) {
    if (named.has(n)) continue
    try {
      unlinkSync(`${dir}/${n}`)
      gone.push(n)
    } catch {}
  }
  return gone
}
