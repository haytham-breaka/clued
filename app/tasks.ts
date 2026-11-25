// An agent's tasks: the Agent call's prompt is its first, and each SendMessage to it adds one. A task
// runs while the agent works on it, waits (queued) when it was sent while the agent was still on
// another, and is done or failed when the run that covered it ends. Beside them, the agent's own
// to-do list (TodoWrite, or TaskCreate and TaskUpdate), as its latest steps left it.

import { preview } from './inbox.ts'
import type { Agent, AgentEntry } from './panel.ts'
import type { Turn } from './session.ts'

export type TaskState = 'queued' | 'running' | 'done' | 'failed'

export type AgentTask = {
  title: string
  /** What Claude asked: the Agent call's prompt, or the message it sent. */
  text: string
  /** When Claude sent it. */
  at: number
  /** Your messages (turn keys) open when it was sent. */
  for: string[]
  state: TaskState
  /** The tool call that sent it (Agent or SendMessage). */
  toolId?: string
  /** Where in the agent's log it starts: set once the agent has it. */
  logAt?: number
  /** Its arrival was seen in the agent's own transcript. */
  isSeen?: boolean
}

export type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }

/** A SendMessage's message as text (it can be a structured one, such as a shutdown request). */
export const messageText = (m: unknown): string => (typeof m === 'string' ? m : m == null ? '' : JSON.stringify(m))

/** A SendMessage's task title: its summary, or else the start of its message. */
export function taskTitle(input: Record<string, unknown>): string {
  const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
  return summary || preview(messageText(input.message), 60) || 'a message'
}

/** The first task, from the Agent call. */
export function firstTask(input: Record<string, unknown>, at: number, forKeys: string[], toolId?: string): AgentTask {
  return {
    title: String(input.description || input.subagent_type || 'agent'),
    text: String(input.prompt ?? ''),
    at,
    for: forKeys,
    state: 'running',
    logAt: 0,
    isSeen: true,
    ...(toolId ? { toolId } : {}),
  }
}

/** The agent an agent id, call id or name points at (SendMessage's `to`). */
export function agentFor(agents: Iterable<Agent>, to: string): Agent | undefined {
  if (!to) return undefined
  for (const a of agents) if (a.taskId === to || a.id === to || a.alias === to || a.name === to) return a
  return undefined
}

/**
 * The agent id an Agent call's result names ("agentId: a1b2"), or its structured result. `strict`:
 * a finished agent's own words, where only "agentId:" counts.
 */
export function agentIdOf(text: string | undefined, data?: unknown, strict = false): string | undefined {
  const d = data as { agentId?: unknown } | undefined
  if (d && typeof d.agentId === 'string') return d.agentId
  return text?.match(strict ? /\bagentId:\s*([\w-]+)/ : /agent ?id:?\s*([\w-]+)/i)?.[1]
}

/** The agent runs again, from `at`: a queued task, if none is running, is the one it is on. */
export function resume(a: Agent, at: number) {
  a.state = 'running'
  a.startedAt = at
  delete a.endedAt
  delete a.result
  if (!a.tasks.some(t => t.state === 'running')) {
    const next = a.tasks.find(t => t.state === 'queued')
    if (next) {
      next.state = 'running'
      next.logAt ??= a.log.length
    }
  }
}

/**
 * Claude sent the agent more work. Sent while it runs, the task waits its turn; sent to an agent
 * that had finished, it continues it, and the task runs from now.
 */
export function sendTask(a: Agent, input: Record<string, unknown>, at: number, forKeys: string[], toolId?: string): AgentTask {
  const isBusy = a.state === 'running'
  const task: AgentTask = {
    title: taskTitle(input),
    text: messageText(input.message),
    at,
    for: forKeys,
    state: isBusy ? 'queued' : 'running',
    ...(toolId ? { toolId } : {}),
    ...(isBusy ? {} : { logAt: a.log.length }),
  }
  a.tasks.push(task)
  a.for = [...new Set([...a.for, ...forKeys])]
  if (!isBusy) resume(a, at)
  return task
}

/** A run ended: the tasks it covered (the running ones) are done, or failed with it. */
export function endRun(a: Agent, state: 'done' | 'failed' | 'stopped', at: number) {
  a.state = state
  a.endedAt = at
  for (const t of a.tasks) if (t.state === 'running') t.state = state === 'done' ? 'done' : 'failed'
}

/** The SendMessage that sent a task failed: the task failed, and an agent it alone was running for ends again. */
export function sendFailed(a: Agent, toolId: string, at: number) {
  const t = a.tasks.find(x => x.toolId === toolId)
  if (!t || t.state === 'done' || t.state === 'failed') return
  t.state = 'failed'
  if (a.state === 'running' && !a.tasks.some(x => x.state === 'running')) endRun(a, 'done', at)
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * The agent's transcript shows a new message to it (a SendMessage arriving): the task it is starts
 * here in the log, and the agent is on it. Matched by its text, else the first not seen yet. Seen
 * only after the run ended (the transcript is read a moment behind), the run covered it: it ended
 * with it.
 */
export function taskArrived(a: Agent, text: string): AgentTask | undefined {
  const t = norm(text)
  const open = a.tasks.slice(1).filter(x => !x.isSeen)
  const task = open.find(x => { const s = norm(x.text); return !!s && (s === t || t.includes(s)) }) ?? open.find(x => x.state === 'queued') ?? open[0]
  if (!task) return undefined
  task.isSeen = true
  task.logAt = a.log.length
  if (task.state === 'queued') task.state = a.state === 'running' ? 'running' : a.state === 'done' ? 'done' : 'failed'
  return task
}

/** The task the agent is on (the newest running one), else the last it had. */
export function currentTask(a: Agent): number {
  const running = a.tasks.findLastIndex(t => t.state === 'running')
  if (running >= 0) return running
  const had = a.tasks.findLastIndex(t => t.state !== 'queued')
  return had >= 0 ? had : 0
}

/** The messages an agent works on now: those of its running tasks (else all it was given). */
export function workingFor(a: Agent): string[] {
  const keys = a.tasks.filter(t => t.state === 'running').flatMap(t => t.for)
  return keys.length ? [...new Set(keys)] : a.for
}

// ---- The agent's own to-do list -------------------------------------------------------

const STATUS = new Set(['pending', 'in_progress', 'completed'])
const statusOf = (s: unknown): Todo['status'] => (STATUS.has(String(s)) ? (String(s) as Todo['status']) : 'pending')

/**
 * The agent's latest to-do list, from its steps: a TodoWrite gives the whole list; TaskCreate adds
 * one (numbered as Claude Code numbers them, or as its result says) and TaskUpdate changes one.
 */
export function todosOf(log: AgentEntry[]): Todo[] {
  let list: (Todo & { id: string })[] = []
  let made = 0
  for (const e of log) {
    if (!('step' in e)) continue
    const { tool, result } = e.step
    const i = tool.input
    if (tool.name === 'TodoWrite' && Array.isArray(i.todos)) {
      list = (i.todos as Record<string, unknown>[]).map((t, n) => ({
        id: String(n + 1),
        content: String(t?.content ?? ''),
        status: statusOf(t?.status),
        ...(t?.activeForm ? { activeForm: String(t.activeForm) } : {}),
      }))
      made = list.length
    } else if (tool.name === 'TaskCreate') {
      made++
      const id = result?.match(/#(\d+)/)?.[1] ?? String(made)
      list.push({ id, content: String(i.subject ?? i.description ?? ''), status: 'pending', ...(i.activeForm ? { activeForm: String(i.activeForm) } : {}) })
    } else if (tool.name === 'TaskUpdate') {
      const t = list.find(x => x.id === String(i.taskId ?? ''))
      if (!t) continue
      if (i.status === 'deleted') list = list.filter(x => x !== t)
      else {
        if (i.status != null) t.status = statusOf(i.status)
        if (typeof i.subject === 'string') t.content = i.subject
        if (typeof i.activeForm === 'string') t.activeForm = i.activeForm
      }
    }
  }
  return list.map(({ id: _, ...t }) => t)
}

// ---- History ------------------------------------------------------------------------

/**
 * The agents a session file shows, from its turns (loadHistory): each Agent call, the SendMessage
 * calls to it as its later tasks, and the ends of its runs (the Agent call's result, or a task
 * notification). The Claude Code that ran them has stopped: one still running at the end is done,
 * and so is every task it was sent.
 */
export function agentsFromTurns(turns: Turn[]): Agent[] {
  const agents = new Map<string, Agent>()
  let last = 0
  // A run that ended covered the messages sent to it before: Claude Code gives them to a running
  // agent at its next step.
  const ended = (a: Agent, state: 'done' | 'failed' | 'stopped', at: number) => {
    endRun(a, state, at)
    for (const t of a.tasks) if (t.state === 'queued') t.state = state === 'done' ? 'done' : 'failed'
  }
  for (const t of turns) {
    const forKeys = t.followUp ?? [t.key]
    const ends = t.agentEnds ?? []
    const endsAt = (n: number) => {
      for (const e of ends) {
        if (e.after !== n) continue
        const a = [...agents.values()].find(x => (e.taskId && x.taskId === e.taskId) || (e.toolUseId && x.id === e.toolUseId))
        if (!a || a.state !== 'running') continue
        ended(a, e.status === 'failed' ? 'failed' : e.status === 'killed' || e.status === 'stopped' ? 'stopped' : 'done', e.at)
        if (e.summary) a.result = e.summary
      }
    }
    t.steps.forEach((s, n) => {
      endsAt(n)
      const at = s.at ?? t.at
      last = Math.max(last, at)
      const i = s.tool.input
      if (s.tool.name === 'Agent' || s.tool.name === 'Task') {
        const a: Agent = {
          id: s.tool.id,
          name: String(i.description || i.subagent_type || 'agent'),
          type: String(i.subagent_type ?? ''),
          isBackground: i.run_in_background === true,
          for: forKeys,
          startedAt: at,
          state: 'running',
          steps: 0,
          last: '',
          prompt: String(i.prompt ?? ''),
          log: [],
          tasks: [firstTask(i, at, forKeys, s.tool.id)],
          isPast: true,
          ...(typeof i.name === 'string' && i.name ? { alias: i.name } : {}),
        }
        const id = agentIdOf(s.result, s.data, !(a.isBackground && !s.isError))
        if (id) a.taskId = id
        if (s.result != null && !(a.isBackground && !s.isError)) {
          endRun(a, s.isError ? 'failed' : 'done', at)
          a.result = s.result
        }
        agents.set(a.id, a)
      } else if (s.tool.name === 'SendMessage') {
        const a = agentFor(agents.values(), String(i.to ?? ''))
        if (!a) return
        sendTask(a, i, at, forKeys, s.tool.id)
        if (s.isError) sendFailed(a, s.tool.id, at)
      }
    })
    endsAt(t.steps.length)
    last = Math.max(last, t.at + (t.durationMs ?? 0))
  }
  for (const a of agents.values()) if (a.state === 'running') ended(a, 'done', last)
  return [...agents.values()]
}
