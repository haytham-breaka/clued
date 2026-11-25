// Scheduled jobs: the prompts Claude set to run later with Claude Code's own tools. CronCreate (a
// cron schedule, recurring or once; CronDelete removes one, CronList lists them), ScheduleWakeup
// (/loop's self-paced wakeups) and RemoteTrigger (cloud routines). Built from the tool calls as they
// stream, and from the session file on resume; the panel lists them, a click opens one.
//
// What the stream shows (Claude Code 2.1, headless): the tool_use and its tool_result, with the
// result's structured form beside it (`tool_use_result`: CronCreate gives id, humanSchedule,
// recurring, durable, nextFireAt, maxAgeMs; ScheduleWakeup gives scheduledFor). A job firing is a
// `command_lifecycle` event (state started; wakeup_source schedule_wakeup for a cron job, loop_wakeup
// for a wakeup) and then a normal turn, with no user message and no job id: the app matches it to
// the job of that kind due nearest that moment. In the session file the firing is a user line with
// isMeta, turnOrigin "scheduled", wakeupSource, and the prompt as its text. A wakeup is a one-shot
// cron job underneath: CronList lists it (with an id) and CronDelete cancels it.

import type { ToolUse } from './claude.ts'
import type { Step, Turn } from './session.ts'

export type JobRun = { at: number; /** The turn the firing started. */ turn?: string }

export type JobState = 'setting up' | 'scheduled' | 'done' | 'deleted' | 'expired' | 'failed' | 'unknown'

export type Job = {
  /** Claude Code's id for it (CronCreate's "72deb24a"); a wakeup or routine without one goes by its call's id. */
  id: string
  /** The tool call that made it. */
  toolId: string
  kind: 'cron' | 'wakeup' | 'remote'
  cron?: string
  recurring: boolean
  /** Kept on disk by Claude Code, so it can outlive this session (undefined: not said). */
  durable?: boolean
  prompt: string
  reason?: string
  delaySeconds?: number
  createdAt: number
  nextAt?: number
  /** Claude Code runs a job a fixed time after each cron match (its own offset): learnt from its first next run. */
  offsetMs?: number
  /** Claude Code's own words for the schedule ("Every minute"). */
  human?: string
  expiresAt?: number
  /** The agent (its Agent call's id) whose own steps made the call; none for Claude itself. */
  by?: string
  /** Your messages (turn keys) it was made for. */
  for: string[]
  state: JobState
  endedAt?: number
  /** Why it ended, in words, when that is known. */
  note?: string
  runs: JobRun[]
  /** Listed by CronList, but not made anywhere in this session's transcript. */
  isOutside?: boolean
}

export const SCHEDULE_TOOLS = new Set(['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger'])

/** Finished jobs stay listed this long (as agents do). */
export const JOB_KEEP_MS = 10 * 60 * 1000

/** Each made job, and the schedule calls still waiting for their results (by tool use id). */
export type Jobs = { list: Job[]; calls: Map<string, ToolUse & { by?: string; for: string[]; at: number }> }

export const newJobs = (): Jobs => ({ list: [], calls: new Map() })

const isActive = (j: Job) => j.state === 'scheduled' || j.state === 'setting up' || j.state === 'unknown'

// ---- Cron ------------------------------------------------------------------------------

type Cron = { min: Set<number>; hour: Set<number>; dom: Set<number>; mon: Set<number>; dow: Set<number>; anyDom: boolean; anyDow: boolean }
const NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

function field(src: string, lo: number, hi: number): Set<number> | undefined {
  const out = new Set<number>()
  const num = (s: string) => (NAMES[s.toLowerCase()] ?? (/^\d+$/.test(s) ? Number(s) : NaN))
  for (const part of src.split(',')) {
    const [range, stepS] = part.split('/')
    const step = stepS == null ? 1 : Number(stepS)
    if (!range || !Number.isInteger(step) || step < 1) return undefined
    let a = lo
    let b = hi
    if (range !== '*') {
      const [x, y] = range.split('-')
      a = num(x!)
      b = y == null ? (stepS == null ? a : hi) : num(y)
    }
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < lo || b > hi + (hi === 6 ? 1 : 0) || a > b) return undefined
    for (let v = a; v <= b; v += step) out.add(hi === 6 && v === 7 ? 0 : v)
  }
  return out
}

export function parseCron(expr: string): Cron | undefined {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) return undefined
  const [min, hour, dom, mon, dow] = [field(f[0]!, 0, 59), field(f[1]!, 0, 23), field(f[2]!, 1, 31), field(f[3]!, 1, 12), field(f[4]!, 0, 6)]
  if (!min || !hour || !dom || !mon || !dow) return undefined
  return { min, hour, dom, mon, dow, anyDom: f[2] === '*', anyDow: f[4] === '*' }
}

/** The first minute after `after` that the cron matches (local time), within about four years. */
export function cronNext(expr: string, after: number): number | undefined {
  const c = parseCron(expr)
  if (!c) return undefined
  const d = new Date(after)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const dayOk = () => {
    // As cron does: with both day fields set, either one matching is enough.
    const a = c.dom.has(d.getDate())
    const b = c.dow.has(d.getDay())
    return c.anyDom && c.anyDow ? true : c.anyDom ? b : c.anyDow ? a : a || b
  }
  for (let guard = 0; guard < 200_000; guard++) {
    if (d.getFullYear() - new Date(after).getFullYear() > 4) return undefined
    if (!c.mon.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1)
      d.setHours(0, 0)
      continue
    }
    if (!dayOk()) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0)
      continue
    }
    if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0)
      continue
    }
    if (!c.min.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1)
      continue
    }
    return d.getTime()
  }
  return undefined
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n: number) => String(n).padStart(2, '0')
const hm = (h: number, m: number) => `${two(h)}:${two(m)}`
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b)
const nth = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`

/** A cron schedule in words: "every minute", "every 5 min", "hourly at :07", "daily 09:00", "weekdays 09:00". */
export function cronWords(expr: string, recurring = true): string {
  const f = expr.trim().split(/\s+/)
  const c = parseCron(expr)
  if (!c) return expr
  const [m, h, dom, mon, dow] = f as [string, string, string, string, string]
  const step = (s: string) => s.match(/^\*\/(\d+)$/)?.[1]
  const one = (s: string) => /^\d+$/.test(s)
  const mins = sorted(c.min)
  const hours = sorted(c.hour)
  // Once, at a pinned time ("30 14 25 11 *"): the date and time.
  if (!recurring && one(m) && one(h) && one(dom) && one(mon)) return `once, ${Number(dom)} ${MONTH[Number(mon) - 1]} ${hm(Number(h), Number(m))}`
  const once = recurring ? '' : 'once, next '
  if (dom === '*' && mon === '*' && dow === '*') {
    if (m === '*' && h === '*') return `${once}every minute`
    if (step(m) && h === '*') return `${once}every ${step(m)} min`
    if (one(m) && h === '*') return `${once}hourly at :${two(Number(m))}`
    if (one(m) && step(h)) return `${once}every ${step(h)} h at :${two(Number(m))}`
    if (mins.length === 1 && hours.length <= 4 && one(m)) return `${once}daily ${hours.map(x => hm(x, mins[0]!)).join(', ')}`
  }
  if (dom === '*' && mon === '*' && one(m) && hours.length <= 2 && !h.includes('*')) {
    const at = hours.map(x => hm(x, mins[0]!)).join(', ')
    const days = sorted(c.dow)
    if (days.join() === '1,2,3,4,5') return `${once}weekdays ${at}`
    if (days.join() === '0,6') return `${once}weekends ${at}`
    if (days.length <= 3) return `${once}${days.length === 1 && recurring ? 'every ' : ''}${days.map(d => DAY[d]).join(', ')} ${at}`
  }
  if (one(dom) && mon === '*' && dow === '*' && one(m) && one(h)) return `${once}monthly on the ${nth(Number(dom))} ${hm(Number(h), Number(m))}`
  return `${once}cron ${expr.trim()}`
}

/** A time from now, in words: "in 40 s", "in 3 min", "in 2 h 5 min", "in 3 days"; "now" when it is due. */
export function inWords(ms: number): string {
  if (ms < 15_000) return 'now'
  if (ms < 60_000) return `in ${Math.round(ms / 1000)} s`
  const min = Math.round(ms / 60_000)
  if (min < 60) return `in ${min} min`
  if (min < 24 * 60) return `in ${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`
  const days = Math.round(min / (24 * 60))
  return `in ${days} day${days === 1 ? '' : 's'}`
}

/** "14:35" today, "Mon 14:35" this week, "12 Nov 14:35" later. */
export function clock(at: number, now: number): string {
  const d = new Date(at)
  const t = hm(d.getHours(), d.getMinutes())
  if (d.toDateString() === new Date(now).toDateString()) return t
  if (Math.abs(at - now) < 6 * 24 * 3_600_000) return `${DAY[d.getDay()]} ${t}`
  return `${d.getDate()} ${MONTH[d.getMonth()]} ${t}`
}

/** The schedule in words, as a row says it: "every 5 min · next 14:35", "in 3 min", "daily 09:00". */
export function scheduleLine(j: Job, now: number): string {
  const next = isActive(j) && j.state !== 'unknown' && j.nextAt != null ? j.nextAt : undefined
  if (j.kind === 'wakeup' || !j.recurring) {
    if (next == null) return j.cron && j.kind === 'cron' ? cronWords(j.cron, false) : j.delaySeconds != null ? `after ${Math.round(j.delaySeconds / 60) || 1} min` : 'once'
    return next - now < 3_600_000 ? inWords(next - now) : `at ${clock(next, now)}`
  }
  const words = j.cron ? cronWords(j.cron, true) : (j.human ?? 'on a schedule')
  return next != null ? `${words} · next ${clock(next, now)}` : words
}

/** Where it stands: scheduled, ran N times, deleted, expired. */
export function stateLabel(j: Job): string {
  const ran = j.runs.length === 1 ? 'ran once' : `ran ${j.runs.length} times`
  if (j.state === 'scheduled') return j.runs.length ? ran : 'scheduled'
  if (j.state === 'done') return j.runs.length ? ran : 'done'
  if (j.state === 'unknown') return 'may still run'
  return j.state
}

/** A short name: the reason a wakeup gave, else the prompt's first words. */
export function jobName(j: Job, max = 60): string {
  const text = (j.reason || j.prompt || j.id).replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Recurring (⏰) or once (⏲). */
export const jobMark = (j: Job) => (j.recurring ? '⏰' : '⏲')

/** The jobs a panel shows: the live ones, and finished ones for a while. */
export const shownJobs = (jobs: Jobs, now: number) => jobs.list.filter(j => isActive(j) || now - (j.endedAt ?? now) < JOB_KEEP_MS)

// ---- From the tool calls ------------------------------------------------------------------

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** A scheduling call: remembered until its result comes, which says whether (and as what) it was made. */
export function onCall(jobs: Jobs, tool: ToolUse, at: number, ctx: { by?: string; for: string[] }) {
  if (!SCHEDULE_TOOLS.has(tool.name)) return
  jobs.calls.set(tool.id, { ...tool, ...ctx, at })
  const i = tool.input
  if (tool.name === 'CronCreate') add(jobs, { id: tool.id, toolId: tool.id, kind: 'cron', cron: str(i.cron), recurring: i.recurring !== false, prompt: str(i.prompt), createdAt: at, ...ctx, state: 'setting up', runs: [], ...(i.durable === true ? { durable: true } : {}) })
  else if (tool.name === 'ScheduleWakeup') {
    if (i.noop === true) return
    const delay = num(i.delaySeconds)
    add(jobs, { id: tool.id, toolId: tool.id, kind: 'wakeup', recurring: false, prompt: str(i.prompt), reason: str(i.reason) || undefined, createdAt: at, ...ctx, state: 'setting up', runs: [], ...(delay != null ? { delaySeconds: delay, nextAt: at + delay * 1000 } : {}) })
  } else if (tool.name === 'RemoteTrigger' && /create/i.test(str(i.action))) {
    // A cloud routine: it runs on Anthropic's side, not in this session.
    const body = (i.body ?? i) as Record<string, unknown>
    const cron = str(body.cron_expression ?? body.cron ?? body.schedule)
    add(jobs, { id: tool.id, toolId: tool.id, kind: 'remote', ...(cron ? { cron } : {}), recurring: !!cron, durable: true, prompt: str(body.prompt ?? body.name ?? body.description ?? 'cloud routine'), createdAt: at, ...ctx, state: 'setting up', runs: [] })
  }
}

function add(jobs: Jobs, j: Job) {
  if (j.reason === undefined) delete j.reason
  if (j.by === undefined) delete j.by
  jobs.list.push(j)
}

const end = (j: Job, state: JobState, at: number, note?: string) => {
  j.state = state
  j.endedAt = at
  if (note) j.note = note
}

/** A scheduling call's result: the job made (with its id and next run), deleted, or listed. */
export function onResult(jobs: Jobs, toolId: string, text: string, isError: boolean, data: unknown, at: number) {
  const call = jobs.calls.get(toolId)
  if (!call) return
  jobs.calls.delete(toolId)
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  const job = jobs.list.find(j => j.toolId === toolId)
  if (job && isError) return end(job, 'failed', at, text.split('\n')[0]?.slice(0, 200))
  if (call.name === 'CronCreate' && job) {
    // "Scheduled recurring job 72deb24a (Every minute). Next run: Nov 25 2:46pm. Session-only (…)"
    job.id = str(d.id) || text.match(/\bjob ([0-9a-z-]{4,})\b/i)?.[1] || job.id
    job.human = str(d.humanSchedule) || text.match(/\(([^)]+)\)/)?.[1] || undefined
    if (typeof d.recurring === 'boolean') job.recurring = d.recurring
    job.durable = typeof d.durable === 'boolean' ? d.durable : /session-only/i.test(text) ? false : /durable|persist/i.test(text) ? true : job.durable
    const match = job.cron ? cronNext(job.cron, at - 1000) : undefined
    job.nextAt = num(d.nextFireAt) ?? match
    if (match != null && job.nextAt != null) job.offsetMs = job.nextAt - match
    const maxAge = num(d.maxAgeMs) ?? (/expires after (\d+) days/i.test(text) ? Number(text.match(/expires after (\d+) days/i)![1]) * 86_400_000 : undefined)
    if (job.recurring && maxAge != null) job.expiresAt = job.createdAt + maxAge
    job.state = 'scheduled'
    if (!job.human) delete job.human
  } else if (call.name === 'ScheduleWakeup' && job) {
    // "Next wakeup scheduled for 14:50:00 (in 112s)."
    const inS = Number(text.match(/\(in (\d+)s\)/)?.[1])
    job.nextAt = num(d.scheduledFor) ?? (Number.isFinite(inS) ? at + inS * 1000 : job.nextAt)
    job.state = 'scheduled'
    // A new wakeup replaces the loop's earlier one still waiting.
    for (const o of jobs.list) if (o !== job && o.kind === 'wakeup' && o.state === 'scheduled' && o.prompt === job.prompt) end(o, 'deleted', at, 'replaced by a newer wakeup')
  } else if (call.name === 'RemoteTrigger' && job) {
    job.id = str(d.id ?? (d.trigger as any)?.id) || text.match(/\b(trig_[\w-]+)/)?.[1] || job.id
    job.state = 'scheduled'
  } else if (call.name === 'CronDelete') {
    // "Cancelled job 72deb24a." A wakeup is a one-shot cron job underneath: deleting it ends the loop's wakeup.
    const id = str(call.input.id)
    const hit = jobs.list.find(j => j.id === id && isActive(j)) ?? (d.endedLoopWakeup === true ? jobs.list.findLast(j => j.kind === 'wakeup' && isActive(j)) : undefined)
    if (hit) end(hit, 'deleted', at)
  } else if (call.name === 'CronList') {
    // "72deb24a — Every minute (recurring) [session-only], next run Nov 25 2:48pm: <prompt>", or "No scheduled jobs."
    const listed = Array.isArray(d.jobs) ? (d.jobs as Record<string, unknown>[]) : [...text.matchAll(/^([0-9a-z-]{6,}) — [^\n]*?: (.*)$/gim)].map((m): Record<string, unknown> => ({ id: m[1], prompt: m[2] }))
    if (!Array.isArray(d.jobs) && !listed.length && !/no scheduled jobs/i.test(text)) return
    const seen = new Set<Job>()
    for (const x of listed) {
      const id = str(x.id)
      const next = num(x.nextFireAt)
      // A wakeup shows up as a one-shot cron job with its prompt: it gets that job's id.
      const known = jobs.list.find(j => j.id === id) ?? jobs.list.find(j => j.kind === 'wakeup' && isActive(j) && j.id === j.toolId && j.prompt.trim() === str(x.prompt).trim())
      if (known) {
        seen.add(known)
        known.id = id
        if (x.cron && known.kind === 'wakeup') known.cron = str(x.cron)
        if (next != null) known.nextAt = next
        if (known.state === 'unknown') known.state = 'scheduled'
      } else if (id && x.cron) {
        const j: Job = { id, toolId: `list:${id}`, kind: 'cron', cron: str(x.cron), recurring: x.recurring === true, prompt: str(x.prompt), createdAt: at, for: [], state: 'scheduled', runs: [], isOutside: true, ...(next != null ? { nextAt: next } : {}), ...(typeof x.durable === 'boolean' ? { durable: x.durable } : {}), ...(x.humanSchedule ? { human: str(x.humanSchedule) } : {}) }
        add(jobs, j)
        seen.add(j)
      }
    }
    // What Claude Code no longer lists is gone: a one-shot that ran is done; anything else ended.
    for (const j of jobs.list)
      if (j.kind !== 'remote' && isActive(j) && j.state !== 'setting up' && !seen.has(j)) end(j, !j.recurring && j.runs.length ? 'done' : 'expired', at, !j.recurring && j.runs.length ? undefined : 'no longer listed by CronList')
  }
}

/**
 * A job fired (Claude Code started a scheduled turn). The stream does not say which, only its kind
 * (`source`: schedule_wakeup for a CronCreate job, loop_wakeup for a ScheduleWakeup): the one of that
 * kind due nearest `at`, or the one whose prompt is `prompt` when that is known (from the session
 * file). Counts the run and works out the next one.
 */
export function onFire(jobs: Jobs, at: number, opts: { turn?: string; prompt?: string; source?: string } = {}): Job | undefined {
  const { turn, prompt, source } = opts
  let pool = jobs.list.filter(j => (j.state === 'scheduled' || j.state === 'unknown') && j.kind !== 'remote')
  const narrow = (keep: (j: Job) => boolean) => {
    if (pool.some(keep)) pool = pool.filter(keep)
  }
  if (source === 'loop_wakeup') narrow(j => j.kind === 'wakeup')
  else if (source === 'schedule_wakeup') narrow(j => j.kind === 'cron')
  if (prompt != null) narrow(j => j.prompt.trim() === prompt.trim())
  const due = (j: Job) => Math.abs((j.nextAt ?? j.createdAt) - at)
  const job = [...pool].sort((a, b) => due(a) - due(b))[0]
  if (!job) return undefined
  job.runs.push({ at, ...(turn ? { turn } : {}) })
  if (job.kind === 'wakeup' || !job.recurring) end(job, 'done', at)
  else if (job.cron) {
    const off = job.offsetMs ?? 0
    let next = cronNext(job.cron, Math.max(at, job.nextAt ?? at) - off)
    while (next != null && next + off <= at) next = cronNext(job.cron, next)
    if (next != null) job.nextAt = next + off
    // Its last run: Claude Code deletes a recurring job when it expires.
    if (job.expiresAt != null && at >= job.expiresAt) end(job, 'expired', at, 'auto-expired after 30 days')
  }
  return job
}

/** Recurring jobs past their expiry, and a next run that has gone by while Claude Code was busy. */
export function tick(jobs: Jobs, now: number) {
  for (const j of jobs.list) {
    if (j.state !== 'scheduled') continue
    if (j.expiresAt != null && now > j.expiresAt + 5 * 60_000) end(j, 'expired', now, 'auto-expired after 30 days')
  }
}

/** Claude Code stopped: the jobs it kept only in memory went with it. */
export function onExit(jobs: Jobs, now: number) {
  for (const j of jobs.list) if (isActive(j) && j.kind !== 'remote' && j.durable !== true) end(j, 'expired', now, 'ended with its Claude Code session')
}

/**
 * The jobs a session file shows, from its turns (loadHistory): the calls in order with their results,
 * and the turns jobs started. What is still scheduled at the end belongs to a Claude Code that has
 * stopped: session-only jobs ended with it; others may still run (the transcript can't say).
 */
export function jobsFromTurns(turns: Turn[], now: number): Jobs {
  const jobs = newJobs()
  let lastAsk: string | undefined
  for (const t of turns) {
    if (!t.followUp && !t.reaction && !t.fired) lastAsk = t.key
    if (t.fired) {
      const j = onFire(jobs, t.at, { turn: t.key, ...t.fired })
      if (j) {
        t.fired.job = j.toolId
        if (j.for.length) t.followUp = j.for
      }
    }
    t.steps.forEach((s: Step, i) => {
      const at = t.at + i
      onCall(jobs, s.tool, at, { for: lastAsk && !t.fired ? [lastAsk] : t.followUp ?? [] })
      if (s.result != null) onResult(jobs, s.tool.id, s.result, !!s.isError, s.data, at)
    })
  }
  for (const j of jobs.list) {
    if (!isActive(j)) continue
    if (j.kind === 'remote') continue
    if (j.durable === false || j.kind === 'wakeup') end(j, 'expired', now, 'ended with its Claude Code session')
    else j.state = 'unknown'
  }
  return jobs
}

/** What the app tells Claude when you cancel a job from its view. */
export function cancelText(j: Job): string {
  const what = `“${jobName(j, 80)}”`
  if (j.kind === 'wakeup') return `Please cancel the scheduled wakeup ${what}${j.id !== j.toolId ? ` (job ${j.id})` : ''}: it is a one-shot job in CronList, so delete it with CronDelete, and don't schedule that loop again.`
  if (j.kind === 'remote') return `Please cancel the cloud routine ${j.id} (${what}) with RemoteTrigger.`
  return `Please cancel the scheduled job ${j.id} (${what}): delete it with CronDelete.`
}
