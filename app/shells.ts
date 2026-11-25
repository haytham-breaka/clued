// Background shell commands: a Bash call with run_in_background (or one Claude Code moved to the
// background when it ran past its timeout). Claude Code runs it apart from the turn and writes its
// output to a file; the panel lists each under Background, and a click opens its command and output.
//
// What the stream shows (Claude Code 2.1, headless): the Bash tool_use (input: command, description,
// run_in_background), a `task_started` system event (task_type local_bash, is_backgrounded, the call's
// tool_use_id), then the call's result: "Command running in background with ID: b6txj58po. Output is
// being written to: /tmp/…/tasks/b6txj58po.output. …", with tool_use_result.backgroundTaskId. When it
// ends, `task_updated` (patch.status) and `task_notification` (status completed, failed or killed;
// output_file; summary: 'Background command "…" completed (exit code 0)', '… failed with exit code 1',
// '… was stopped'). KillShell (shell_id) and TaskStop (task_id) stop one. In the session file the end
// is a <task-notification> user message with the same fields, which loadHistory keeps as AgentEnds.

import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs'
import type { ToolUse } from './claude.ts'
import type { Turn } from './session.ts'

export type ShellState = 'running' | 'done' | 'failed' | 'stopped'

export type Shell = {
  /** The Bash call's tool use id (`task:<id>` for one known only from Claude Code's task event). */
  id: string
  /** Claude Code's id for it ("b6txj58po"), which KillShell, TaskStop and its output file go by. */
  taskId?: string
  command: string
  description: string
  outputFile?: string
  state: ShellState
  /** Its exit code, when Claude Code's summary gives one. */
  exitCode?: number
  startedAt: number
  endedAt?: number
  /** Your messages (turn keys) it was started for. */
  for: string[]
  /** The agent (its Agent call's id) whose own step started it; none for Claude itself. */
  by?: string
  /** How it ended, in Claude Code's words, or why the app can't know more. */
  note?: string
  /** Still running when the Claude Code that ran it stopped: it went with it. */
  isCut?: boolean
}

/** Each background command, and the shell calls still waiting for their results (by tool use id). */
export type Shells = { list: Shell[]; calls: Map<string, ToolUse & { by?: string; for: string[]; at: number }> }

export const newShells = (): Shells => ({ list: [], calls: new Map() })

/** Finished commands stay listed this long (as agents do); one an exit cut off, an hour. */
export const SHELL_KEEP_MS = 10 * 60 * 1000
export const SHELL_CUT_KEEP_MS = 60 * 60 * 1000

/** The commands a panel shows: the running ones, and finished ones for a while. */
export const shownShells = (sh: Shells, now: number) =>
  sh.list.filter(s => s.state === 'running' || now - (s.endedAt ?? now) < (s.isCut ? SHELL_CUT_KEEP_MS : SHELL_KEEP_MS))

const SHELL_TOOLS = new Set(['Bash', 'KillShell', 'TaskStop'])
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))

/** What a row calls it: its description, else its command's first line. */
export function shellName(s: Shell, max = 60): string {
  const name = s.description.trim() || s.command.trim().split('\n')[0]!.trim() || s.taskId || 'background command'
  return name.length > max ? `${name.slice(0, max - 1)}…` : name
}

/** "running", "done", "failed (exit 2)", "stopped". */
export function shellState(s: Shell): string {
  return s.exitCode != null && s.exitCode !== 0 ? `${s.state} (exit ${s.exitCode})` : s.state
}

/** Claude Code's status for a task, as the app's state. */
const stateOf = (status: string | undefined): ShellState | undefined =>
  status === 'completed' ? 'done' : status === 'failed' ? 'failed' : status === 'killed' || status === 'stopped' ? 'stopped' : undefined

const exitOf = (summary: string | undefined) => {
  const m = summary?.match(/exit code (\d+)/i)
  return m ? Number(m[1]) : undefined
}

const end = (s: Shell, state: ShellState, at: number, note?: string) => {
  if (s.state !== 'running') return
  s.state = state
  s.endedAt = at
  if (note) s.note = note
}

const find = (sh: Shells, ref: { taskId?: string; toolUseId?: string }) =>
  sh.list.find(s => (ref.toolUseId && s.id === ref.toolUseId) || (ref.taskId && s.taskId === ref.taskId))

function add(sh: Shells, call: ToolUse & { by?: string; for: string[]; at: number }): Shell {
  const i = call.input
  const s: Shell = { id: call.id, command: str(i.command), description: str(i.description), state: 'running', startedAt: call.at, for: call.for, ...(call.by ? { by: call.by } : {}) }
  sh.list.push(s)
  return s
}

/** A Bash call (a background one is listed at once), or one that stops a command: remembered until its result. */
export function onShellCall(sh: Shells, tool: ToolUse, at: number, ctx: { by?: string; for: string[] }) {
  if (!SHELL_TOOLS.has(tool.name)) return
  const call = { ...tool, ...ctx, at }
  sh.calls.set(tool.id, call)
  if (tool.name === 'Bash' && tool.input.run_in_background === true && !sh.list.some(s => s.id === tool.id)) add(sh, call)
}

/**
 * A shell call's result: a background command's id and output file (or a foreground one moved to the
 * background past its timeout), or a command stopped. A background call that failed never ran.
 */
export function onShellResult(sh: Shells, toolId: string, text: string, isError: boolean, data: unknown, at: number) {
  const call = sh.calls.get(toolId)
  if (!call) return
  sh.calls.delete(toolId)
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  if (call.name === 'Bash') {
    let s = sh.list.find(x => x.id === toolId)
    if (isError) {
      if (s && !s.taskId) sh.list = sh.list.filter(x => x !== s)
      return
    }
    const id = str(d.backgroundTaskId) || text.match(/running in background with ID: ([\w-]+)/i)?.[1] || text.match(/moved to the background \(ID: ([\w-]+)\)/i)?.[1]
    if (!id) return
    if (!s) {
      s = add(sh, call)
      s.note = 'moved to the background when it ran past its timeout'
    }
    s.taskId = id
    const file = text.match(/Output is being written to: (\S+?)\.?(?=\s|$)/)?.[1]
    if (file) s.outputFile = file
    return
  }
  // KillShell { shell_id }, TaskStop { task_id } (or the older shell_id).
  if (isError) return
  const id = str(call.input.task_id ?? call.input.shell_id)
  const s = sh.list.find(x => x.taskId === id)
  if (s) end(s, 'stopped', at, `stopped by ${call.by ? 'its agent' : 'Claude'} (${call.name})`)
}

/** Claude Code's task event, as main.ts gets it from claude.ts. */
export type TaskNews = { phase: 'started' | 'progress' | 'updated' | 'done'; taskId: string; toolUseId?: string; status?: string; text?: string; type?: string; isBackgrounded?: boolean; outputFile?: string }

/**
 * Claude Code's news about a task, when it is a background command (true: it was one): its id from
 * the start, its end (state, exit code, Claude Code's summary). A background command it starts that
 * no call here shows (an agent's, whose steps aren't streamed) is listed from the event alone.
 */
export function onShellTask(sh: Shells, e: TaskNews, at: number, ctx: { for: string[] }): boolean {
  let s = find(sh, e)
  if (!s && e.type === 'local_bash' && e.isBackgrounded === true) {
    const call = e.toolUseId ? sh.calls.get(e.toolUseId) : undefined
    s = add(sh, call ?? { id: e.toolUseId || `task:${e.taskId}`, name: 'Bash', input: { description: e.text ?? '' }, for: ctx.for, at })
  }
  // (A foreground command Claude Code moves to the background is listed from its call's result.)
  if (!s) return false
  if (e.taskId) s.taskId = e.taskId
  if (e.outputFile) s.outputFile = e.outputFile
  const state = stateOf(e.status)
  if ((e.phase === 'done' || e.phase === 'updated') && state) {
    const code = exitOf(e.text)
    if (code != null && s.state === 'running') s.exitCode = code
    end(s, state, at, e.phase === 'done' ? e.text : undefined)
  }
  // Its summary comes with the notification, which can follow the update that ended it.
  if (e.phase === 'done' && e.text && !s.note) {
    s.note = e.text
    s.exitCode ??= exitOf(e.text)
  }
  return true
}

/** Claude Code stopped: the commands it was running went with it. */
export function onShellsExit(sh: Shells, now: number, why = 'stopped when Claude Code exited') {
  for (const s of sh.list)
    if (s.state === 'running') {
      end(s, 'stopped', now, why)
      s.isCut = true
    }
}

/**
 * The background commands a session file shows, from its turns (loadHistory): the Bash calls with
 * their results, the stops, and the task notifications that ended them (kept as the turn's agentEnds).
 * One still running at the end went with the Claude Code that ran it.
 */
export function shellsFromTurns(turns: Turn[]): Shells {
  const sh = newShells()
  let last = 0
  for (const t of turns) {
    const forKeys = t.followUp ?? [t.key]
    const endsAt = (n: number) => {
      for (const e of t.agentEnds ?? []) if (e.after === n) onShellTask(sh, { phase: 'done', taskId: e.taskId, ...(e.toolUseId ? { toolUseId: e.toolUseId } : {}), status: e.status, ...(e.summary ? { text: e.summary } : {}) }, e.at, { for: forKeys })
    }
    t.steps.forEach((s, n) => {
      endsAt(n)
      const at = s.at ?? t.at
      last = Math.max(last, at)
      onShellCall(sh, s.tool, at, { for: forKeys })
      if (s.result != null) onShellResult(sh, s.tool.id, s.result, !!s.isError, s.data, at)
    })
    endsAt(t.steps.length)
    for (const e of t.agentEnds ?? []) last = Math.max(last, e.at)
    last = Math.max(last, t.at + (t.durationMs ?? 0))
  }
  onShellsExit(sh, last)
  return sh
}

/** What the app asks Claude when you stop a command from its view. */
export const stopText = (s: Shell) =>
  `Please stop the background command “${shellName(s, 80)}”${s.taskId ? ` (task ${s.taskId})` : ''} with TaskStop.`

// ---- Its output ------------------------------------------------------------------------

/** The output a view shows: the file's last this many bytes. */
const TAIL_BYTES = 64 * 1024

export type Output = { text: string; size: number; isTail: boolean } | { missing: true }

let cache: { path: string; size: number; mtime: number; out: Output } | undefined

/**
 * A command's output so far, from its file: the last TAIL_BYTES of it (isTail when there is more),
 * each line as a terminal last showed it (a progress bar's \r rewrites keep only the last). Read
 * again only when the file changed.
 */
export function readOutput(path: string): Output {
  let st
  try {
    st = statSync(path)
  } catch {
    return { missing: true }
  }
  if (cache && cache.path === path && cache.size === st.size && cache.mtime === st.mtimeMs) return cache.out
  let raw = ''
  let size = st.size
  try {
    const fd = openSync(path, 'r')
    try {
      size = fstatSync(fd).size
      const from = Math.max(0, size - TAIL_BYTES)
      const buf = Buffer.alloc(size - from)
      const n = readSync(fd, buf, 0, buf.length, from)
      raw = buf.subarray(0, n).toString('utf8')
      // Cut mid-line at the start: that line is partial.
      if (from > 0) raw = raw.slice(raw.indexOf('\n') + 1)
    } finally {
      closeSync(fd)
    }
  } catch {
    return { missing: true }
  }
  const text = raw.split('\n').map(l => l.replace(/\r+$/, '').split('\r').at(-1)!).join('\n')
  const out: Output = { text, size, isTail: size > TAIL_BYTES }
  cache = { path, size: st.size, mtime: st.mtimeMs, out }
  return out
}
