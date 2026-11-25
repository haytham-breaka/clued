import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cancelText, clock, cronNext, cronWords, inWords, jobMark, jobName, jobsFromTurns, newJobs, onCall, onExit, onFire, onResult, parseCron, scheduleLine, shownJobs, stateLabel, tick, JOB_KEEP_MS } from '../../app/scheduled.ts'
import type { Job } from '../../app/scheduled.ts'
import { newTurn } from '../../app/session.ts'

/** A local time today (cron reads local time), as ms. */
const at = (h: number, m: number, s = 0, day = 25, month = 10, year = 2026) => new Date(year, month, day, h, m, s).getTime()
const MIN = 60_000

describe('cron in words', () => {
  test('the common shapes', () => {
    assert.equal(cronWords('* * * * *'), 'every minute')
    assert.equal(cronWords('*/5 * * * *'), 'every 5 min')
    assert.equal(cronWords('7 * * * *'), 'hourly at :07')
    assert.equal(cronWords('15 */2 * * *'), 'every 2 h at :15')
    assert.equal(cronWords('0 9 * * *'), 'daily 09:00')
    assert.equal(cronWords('57 8,17 * * *'), 'daily 08:57, 17:57')
    assert.equal(cronWords('0 9 * * 1-5'), 'weekdays 09:00')
    assert.equal(cronWords('30 10 * * 0,6'), 'weekends 10:30')
    assert.equal(cronWords('0 9 * * mon'), 'every Mon 09:00')
    assert.equal(cronWords('0 9 * * 1,3'), 'Mon, Wed 09:00')
    assert.equal(cronWords('0 9 * * 7'), 'every Sun 09:00')
    assert.equal(cronWords('5 4 1 * *'), 'monthly on the 1st 04:05')
    assert.equal(cronWords('5 4 22 * *'), 'monthly on the 22nd 04:05')
    assert.equal(cronWords('5 4 13 * *'), 'monthly on the 13th 04:05')
    assert.equal(cronWords('5 4 3 * *'), 'monthly on the 3rd 04:05')
  })
  test('one-off jobs: the pinned date and time, or "once, next"', () => {
    assert.equal(cronWords('30 14 25 11 *', false), 'once, 25 Nov 14:30')
    assert.equal(cronWords('50 14 * * *', false), 'once, next daily 14:50')
  })
  test('anything else stays cron; a bad one stays as written', () => {
    assert.equal(cronWords('0 9 1-7 * 1'), 'cron 0 9 1-7 * 1')
    assert.equal(cronWords('0 9 * * 1,2,3,4'), 'cron 0 9 * * 1,2,3,4')
    assert.equal(cronWords('not a cron'), 'not a cron')
    assert.equal(cronWords('61 * * * *'), '61 * * * *')
    assert.equal(cronWords('*/0 * * * *'), '*/0 * * * *')
    assert.equal(cronWords('5-3 * * * *'), '5-3 * * * *')
    assert.equal(parseCron('* * * *'), undefined)
    assert.deepEqual([...parseCron('10-20/5 * * jan-mar *')!.mon], [1, 2, 3])
    assert.deepEqual([...parseCron('10-20/5 * * * *')!.min], [10, 15, 20])
    assert.deepEqual([...parseCron('10/20 * * * *')!.min], [10, 30, 50])
  })
})

describe('next run', () => {
  test('the next matching minute, strictly after', () => {
    assert.equal(cronNext('* * * * *', at(14, 45, 23)), at(14, 46))
    assert.equal(cronNext('* * * * *', at(14, 46)), at(14, 47))
    assert.equal(cronNext('*/5 * * * *', at(14, 46)), at(14, 50))
    assert.equal(cronNext('0 9 * * *', at(14, 46)), at(9, 0, 0, 26))
    // 25 Nov 2026 is a Wednesday: the next weekday 09:00 is Thursday.
    assert.equal(cronNext('0 9 * * 1-5', at(10, 0)), at(9, 0, 0, 26))
    assert.equal(cronNext('0 9 * * 6', at(10, 0)), at(9, 0, 0, 28))
    assert.equal(cronNext('0 0 1 1 *', at(10, 0)), at(0, 0, 0, 1, 0, 2027))
    // Both day fields set: either matches.
    assert.equal(cronNext('0 9 1 * 4', at(10, 0)), at(9, 0, 0, 26))
    assert.equal(cronNext('0 9 30 * *', at(10, 0)), at(9, 0, 0, 30))
    assert.equal(cronNext('nope', at(10, 0)), undefined)
    assert.equal(cronNext('0 0 31 2 *', at(10, 0)), undefined)
  })
  test('in words, and as a clock', () => {
    assert.equal(inWords(5_000), 'now')
    assert.equal(inWords(40_000), 'in 40 s')
    assert.equal(inWords(3 * MIN), 'in 3 min')
    assert.equal(inWords(125 * MIN), 'in 2 h 5 min')
    assert.equal(inWords(120 * MIN), 'in 2 h')
    assert.equal(inWords(26 * 60 * MIN), 'in 1 day')
    assert.equal(inWords(3 * 24 * 60 * MIN), 'in 3 days')
    assert.equal(clock(at(14, 35), at(9, 0)), '14:35')
    assert.equal(clock(at(9, 5, 0, 27), at(9, 0)), 'Fri 09:05')
    assert.equal(clock(at(9, 5, 0, 12), at(9, 0)), '12 Nov 09:05')
  })
})

const job = (over: Partial<Job>): Job => ({ id: 'j1', toolId: 'tu-1', kind: 'cron', recurring: true, prompt: 'Check the deploy', createdAt: at(14, 0), for: [], state: 'scheduled', runs: [], ...over })

describe('a row in words', () => {
  const now = at(14, 32)
  test('recurring: the schedule and its next run; one-offs and wakeups: how soon', () => {
    assert.equal(scheduleLine(job({ cron: '*/5 * * * *', nextAt: at(14, 35) }), now), 'every 5 min · next 14:35')
    assert.equal(scheduleLine(job({ cron: '0 9 * * *' }), now), 'daily 09:00')
    assert.equal(scheduleLine(job({ human: 'Every day' }), now), 'Every day')
    assert.equal(scheduleLine(job({}), now), 'on a schedule')
    assert.equal(scheduleLine(job({ kind: 'wakeup', recurring: false, nextAt: at(14, 35) }), now), 'in 3 min')
    assert.equal(scheduleLine(job({ kind: 'cron', recurring: false, cron: '0 18 25 11 *', nextAt: at(18, 0) }), now), 'at 18:00')
    // Finished: what it was.
    assert.equal(scheduleLine(job({ kind: 'cron', recurring: false, cron: '0 18 25 11 *', state: 'done' }), now), 'once, 25 Nov 18:00')
    assert.equal(scheduleLine(job({ kind: 'wakeup', recurring: false, delaySeconds: 600, state: 'done' }), now), 'after 10 min')
    assert.equal(scheduleLine(job({ kind: 'wakeup', recurring: false, delaySeconds: 20, state: 'deleted' }), now), 'after 1 min')
    assert.equal(scheduleLine(job({ kind: 'remote', recurring: false, state: 'scheduled' }), now), 'once')
    assert.equal(scheduleLine(job({ cron: '*/5 * * * *', nextAt: at(14, 35), state: 'unknown' }), now), 'every 5 min')
  })
  test('state, name and mark', () => {
    assert.equal(stateLabel(job({})), 'scheduled')
    assert.equal(stateLabel(job({ runs: [{ at: 1 }] })), 'ran once')
    assert.equal(stateLabel(job({ runs: [{ at: 1 }, { at: 2 }, { at: 3 }] })), 'ran 3 times')
    assert.equal(stateLabel(job({ state: 'done', runs: [{ at: 1 }] })), 'ran once')
    assert.equal(stateLabel(job({ state: 'done' })), 'done')
    assert.equal(stateLabel(job({ state: 'deleted' })), 'deleted')
    assert.equal(stateLabel(job({ state: 'expired' })), 'expired')
    assert.equal(stateLabel(job({ state: 'unknown' })), 'may still run')
    assert.equal(jobName(job({ prompt: 'Look at\n the build', reason: 'waiting for CI' })), 'waiting for CI')
    assert.equal(jobName(job({ prompt: 'Look at\n the   build' })), 'Look at the build')
    assert.equal(jobName(job({ prompt: 'x'.repeat(100) }), 10), `${'x'.repeat(9)}…`)
    assert.equal(jobName(job({ prompt: '' })), 'j1')
    assert.equal(jobMark(job({})), '⏰')
    assert.equal(jobMark(job({ recurring: false })), '⏲')
  })
  test('finished jobs leave the list after a while', () => {
    const jobs = newJobs()
    jobs.list.push(job({}), job({ id: 'old', state: 'deleted', endedAt: now - JOB_KEEP_MS - 1 }), job({ id: 'new', state: 'deleted', endedAt: now - 1000 }))
    assert.deepEqual(shownJobs(jobs, now).map(j => j.id), ['j1', 'new'])
  })
})

describe('jobs from the calls, in the shapes Claude Code streams', () => {
  const t0 = at(14, 45, 27)
  test('CronCreate: id, next run, offset and expiry from its result; a firing is a run; CronDelete ends it', () => {
    const jobs = newJobs()
    onCall(jobs, { id: 'tu-1', name: 'CronCreate', input: { cron: '* * * * *', recurring: true, prompt: 'Reply with exactly PING-CRON.' } }, t0, { for: ['k1'] })
    assert.equal(jobs.list[0]!.state, 'setting up')
    onResult(jobs, 'tu-1', 'Scheduled recurring job 72deb24a (Every minute). Next run: Nov 25 2:46pm. Session-only (not written to disk, dies when Claude exits). Auto-expires after 30 days. Use CronDelete to cancel sooner.', false,
      { id: '72deb24a', humanSchedule: 'Every minute', recurring: true, durable: false, nextFireAt: at(14, 46, 13), maxAgeMs: 2_592_000_000 }, t0)
    const j = jobs.list[0]!
    assert.equal(j.id, '72deb24a')
    assert.equal(j.state, 'scheduled')
    assert.equal(j.human, 'Every minute')
    assert.equal(j.durable, false)
    assert.equal(j.nextAt, at(14, 46, 13))
    assert.equal(j.offsetMs, 13_000)
    assert.equal(j.expiresAt, t0 + 2_592_000_000)
    assert.deepEqual(j.for, ['k1'])
    // It fires at 14:46:13: one run, next at 14:47:13.
    assert.equal(onFire(jobs, at(14, 46, 14), { turn: 'fired-1', source: 'schedule_wakeup' }), j)
    assert.deepEqual(j.runs, [{ at: at(14, 46, 14), turn: 'fired-1' }])
    assert.equal(j.nextAt, at(14, 47, 13))
    onFire(jobs, at(14, 47, 13))
    assert.equal(j.nextAt, at(14, 48, 13))
    assert.equal(stateLabel(j), 'ran 2 times')
    // A result for a call it never saw does nothing.
    onResult(jobs, 'nope', '', false, undefined, t0)
    onCall(jobs, { id: 'tu-2', name: 'CronDelete', input: { id: '72deb24a' } }, at(14, 49), { for: [] })
    onResult(jobs, 'tu-2', 'Cancelled job 72deb24a.', false, { id: '72deb24a' }, at(14, 49))
    assert.equal(j.state, 'deleted')
    assert.equal(j.endedAt, at(14, 49))
    // Other tools are not schedule calls.
    onCall(jobs, { id: 'tu-3', name: 'Bash', input: {} }, t0, { for: [] })
    assert.equal(jobs.calls.size, 0)
  })

  test('without the structured result, the text says it', () => {
    const jobs = newJobs()
    onCall(jobs, { id: 'tu-1', name: 'CronCreate', input: { cron: '*/5 * * * *', prompt: 'p', durable: true } }, t0, { for: [], by: 'agent-1' })
    onResult(jobs, 'tu-1', 'Scheduled recurring job ab12cd34 (Every 5 minutes). Next run: soon. Auto-expires after 7 days.', false, undefined, t0)
    const j = jobs.list[0]!
    assert.equal(j.id, 'ab12cd34')
    assert.equal(j.human, 'Every 5 minutes')
    assert.equal(j.durable, true)
    assert.equal(j.by, 'agent-1')
    assert.equal(j.nextAt, at(14, 50))
    assert.equal(j.offsetMs, 0)
    assert.equal(j.expiresAt, t0 + 7 * 86_400_000)
  })

  test('a failed call fails the job', () => {
    const jobs = newJobs()
    onCall(jobs, { id: 'tu-1', name: 'CronCreate', input: { cron: 'bad', prompt: 'p' } }, t0, { for: [] })
    onResult(jobs, 'tu-1', 'Invalid cron expression\nmore', true, undefined, t0)
    assert.equal(jobs.list[0]!.state, 'failed')
    assert.equal(jobs.list[0]!.note, 'Invalid cron expression')
  })

  test('a one-off cron runs once, then it is done', () => {
    const jobs = newJobs()
    onCall(jobs, { id: 'tu-1', name: 'CronCreate', input: { cron: '30 15 25 11 *', recurring: false, prompt: 'Tag the release' } }, t0, { for: [] })
    onResult(jobs, 'tu-1', 'Scheduled one-shot job e5f6a7b8.', false, { id: 'e5f6a7b8', recurring: false, durable: false, nextFireAt: at(15, 30) }, t0)
    assert.equal(jobs.list[0]!.expiresAt, undefined)
    onFire(jobs, at(15, 30, 2), { source: 'schedule_wakeup' })
    assert.equal(jobs.list[0]!.state, 'done')
    assert.equal(stateLabel(jobs.list[0]!), 'ran once')
  })

  test('a recurring job past its 30 days expires: on its last run, or on a tick', () => {
    const jobs = newJobs()
    jobs.list.push(job({ cron: '* * * * *', nextAt: at(14, 1), expiresAt: at(14, 0) }), job({ id: 'j2', toolId: 'tu-2', cron: '0 9 * * *', expiresAt: at(14, 0) }))
    onFire(jobs, at(14, 1), { prompt: 'Check the deploy' })
    assert.equal(jobs.list[0]!.state, 'expired')
    tick(jobs, at(14, 2))
    assert.equal(jobs.list[1]!.state, 'scheduled')
    tick(jobs, at(14, 10))
    assert.equal(jobs.list[1]!.state, 'expired')
  })

  test('ScheduleWakeup: next run from scheduledFor; it fires as a loop_wakeup; a newer one replaces it', () => {
    const jobs = newJobs()
    onCall(jobs, { id: 'w1', name: 'ScheduleWakeup', input: { delaySeconds: 60, prompt: 'Look again.', reason: 'probe wakeup', noop: false } }, at(14, 48, 8), { for: ['k1'] })
    assert.equal(jobs.list[0]!.nextAt, at(14, 49, 8))
    onResult(jobs, 'w1', 'Next wakeup scheduled for 14:50:00 (in 112s). If you owe the user a status update…', false, { scheduledFor: at(14, 50), clampedDelaySeconds: 60, wasClamped: false }, at(14, 48, 8))
    const w = jobs.list[0]!
    assert.equal(w.nextAt, at(14, 50))
    assert.equal(w.reason, 'probe wakeup')
    assert.equal(w.recurring, false)
    // A cron due at the same moment: the source says which one fired.
    jobs.list.push(job({ id: 'c1', toolId: 'c1', cron: '* * * * *', nextAt: at(14, 50, 13) }))
    assert.equal(onFire(jobs, at(14, 50, 13), { source: 'loop_wakeup' }), w)
    assert.equal(w.state, 'done')
    // A noop wakeup makes nothing; a new one replaces the waiting one with the same prompt.
    onCall(jobs, { id: 'w2', name: 'ScheduleWakeup', input: { noop: true } }, at(14, 51), { for: [] })
    onCall(jobs, { id: 'w3', name: 'ScheduleWakeup', input: { delaySeconds: 300, prompt: 'Again.' } }, at(14, 51), { for: [] })
    onResult(jobs, 'w3', 'Next wakeup scheduled for 14:56:00 (in 300s).', false, undefined, at(14, 51))
    onCall(jobs, { id: 'w4', name: 'ScheduleWakeup', input: { delaySeconds: 300, prompt: 'Again.' } }, at(14, 52), { for: [] })
    onResult(jobs, 'w4', 'Next wakeup scheduled for 14:57:00 (in 300s).', false, undefined, at(14, 52))
    assert.equal(jobs.list.find(j => j.toolId === 'w3')!.state, 'deleted')
    assert.equal(jobs.list.find(j => j.toolId === 'w4')!.nextAt, at(14, 57))
  })

  test('CronList: a wakeup shows as a one-shot job and gets its id; what it no longer lists is gone; others came from outside', () => {
    const jobs = newJobs()
    onCall(jobs, { id: 'w1', name: 'ScheduleWakeup', input: { delaySeconds: 60, prompt: 'Reply with exactly PING-WAKE.', reason: 'probe' } }, t0, { for: [] })
    onResult(jobs, 'w1', 'Next wakeup scheduled for 14:50:00 (in 112s).', false, { scheduledFor: at(14, 50) }, t0)
    jobs.list.push(job({ id: 'gone', toolId: 'g' }), job({ id: 'ranonce', toolId: 'r', recurring: false, runs: [{ at: 1 }] }))
    onCall(jobs, { id: 'l1', name: 'CronList', input: {} }, t0, { for: [] })
    onResult(jobs, 'l1', 'e1f2aa79 — Every day at 2:50 PM (one-shot) [session-only], next run Nov 25 2:50pm: Reply with exactly PING-WAKE.\n9z9z9z9z — Every hour [durable]: Back up', false, {
      jobs: [
        { id: 'e1f2aa79', cron: '50 14 * * *', humanSchedule: 'Every day at 2:50 PM', prompt: 'Reply with exactly PING-WAKE.', durable: false, nextFireAt: at(14, 50) },
        { id: '9z9z9z9z', cron: '7 * * * *', humanSchedule: 'Every hour', prompt: 'Back up', recurring: true, durable: true, nextFireAt: at(15, 7) },
      ],
    }, t0)
    const w = jobs.list.find(j => j.toolId === 'w1')!
    assert.equal(w.id, 'e1f2aa79')
    assert.equal(w.cron, '50 14 * * *')
    assert.equal(jobs.list.find(j => j.id === 'gone')!.state, 'expired')
    assert.equal(jobs.list.find(j => j.id === 'gone')!.note, 'no longer listed by CronList')
    assert.equal(jobs.list.find(j => j.id === 'ranonce')!.state, 'done')
    const outside = jobs.list.find(j => j.id === '9z9z9z9z')!
    assert.equal(outside.isOutside, true)
    assert.equal(outside.durable, true)
    assert.equal(outside.human, 'Every hour')
    assert.equal(outside.nextAt, at(15, 7))
    assert.match(cancelText(w), /^Please cancel the scheduled wakeup “probe” \(job e1f2aa79\): it is a one-shot job in CronList, so delete it with CronDelete/)
    // CronDelete on it ends the loop's wakeup.
    onCall(jobs, { id: 'd1', name: 'CronDelete', input: { id: 'e1f2aa79' } }, t0, { for: [] })
    onResult(jobs, 'd1', 'Cancelled job e1f2aa79.', false, { id: 'e1f2aa79', endedLoopWakeup: true }, t0)
    assert.equal(w.state, 'deleted')
    // "No scheduled jobs." ends the rest; a list it can't read changes nothing.
    onCall(jobs, { id: 'l2', name: 'CronList', input: {} }, t0, { for: [] })
    onResult(jobs, 'l2', 'something else', false, undefined, t0)
    assert.equal(outside.state, 'scheduled')
    onCall(jobs, { id: 'l3', name: 'CronList', input: {} }, t0, { for: [] })
    onResult(jobs, 'l3', 'No scheduled jobs.', false, undefined, t0)
    assert.equal(outside.state, 'expired')
  })

  test('CronList as text only: ids and prompts from its lines', () => {
    const jobs = newJobs()
    jobs.list.push(job({ id: '72deb24a', state: 'unknown' }))
    onCall(jobs, { id: 'l1', name: 'CronList', input: {} }, t0, { for: [] })
    onResult(jobs, 'l1', '72deb24a — Every minute (recurring) [session-only], next run Nov 25 2:48pm: Check the deploy', false, undefined, t0)
    assert.equal(jobs.list[0]!.state, 'scheduled')
  })

  test('a wakeup deleted without a known id: the latest live wakeup ends', () => {
    const jobs = newJobs()
    onCall(jobs, { id: 'w1', name: 'ScheduleWakeup', input: { delaySeconds: 60, prompt: 'p' } }, t0, { for: [] })
    onResult(jobs, 'w1', 'Next wakeup scheduled', false, undefined, t0)
    onCall(jobs, { id: 'd1', name: 'CronDelete', input: { id: 'abc' } }, t0, { for: [] })
    onResult(jobs, 'd1', 'Cancelled job abc.', false, { id: 'abc', endedLoopWakeup: true }, t0)
    assert.equal(jobs.list[0]!.state, 'deleted')
  })

  test('RemoteTrigger create: a cloud routine', () => {
    const jobs = newJobs()
    onCall(jobs, { id: 'r1', name: 'RemoteTrigger', input: { action: 'create', body: { name: 'Nightly triage', cron_expression: '0 3 * * *' } } }, t0, { for: [] })
    onCall(jobs, { id: 'r2', name: 'RemoteTrigger', input: { action: 'list' } }, t0, { for: [] })
    onResult(jobs, 'r1', 'Created trigger trig_01AbC', false, undefined, t0)
    onResult(jobs, 'r2', '[]', false, undefined, t0)
    const r = jobs.list[0]!
    assert.equal(jobs.list.length, 1)
    assert.equal(r.kind, 'remote')
    assert.equal(r.id, 'trig_01AbC')
    assert.equal(r.recurring, true)
    assert.equal(r.prompt, 'Nightly triage')
    assert.match(cancelText(r), /cloud routine trig_01AbC/)
    // It runs in the cloud: Claude Code exiting doesn't end it, and firings here aren't its runs.
    onExit(jobs, t0)
    assert.equal(r.state, 'scheduled')
    assert.equal(onFire(jobs, t0), undefined)
  })

  test('Claude Code exiting ends the jobs it kept in memory', () => {
    const jobs = newJobs()
    jobs.list.push(job({ durable: false }), job({ id: 'd', toolId: 'd', durable: true }))
    onExit(jobs, at(15, 0))
    assert.equal(jobs.list[0]!.state, 'expired')
    assert.equal(jobs.list[0]!.note, 'ended with its Claude Code session')
    assert.equal(jobs.list[1]!.state, 'scheduled')
    assert.equal(cancelText(jobs.list[1]!), 'Please cancel the scheduled job d (“Check the deploy”): delete it with CronDelete.')
  })
})

describe('jobs from a session file', () => {
  test('calls and their results replay in order; fired turns become runs; what was live ends with that session', () => {
    const ask = newTurn('ping me every minute', at(14, 45))
    ask.steps.push({
      tool: { id: 'tu-1', name: 'CronCreate', input: { cron: '* * * * *', recurring: true, prompt: 'PING' } },
      result: 'Scheduled recurring job 72deb24a (Every minute). Session-only (not written to disk, dies when Claude exits).',
      data: { id: '72deb24a', recurring: true, durable: false, nextFireAt: at(14, 46, 13) },
    }, {
      tool: { id: 'tu-2', name: 'CronCreate', input: { cron: '0 9 * * *', prompt: 'Morning report' } },
      result: 'Scheduled recurring job 0a0a0a0a (Every day at 9:00 AM).',
    })
    const fired = newTurn('', at(14, 46, 14))
    fired.key = 'fired-1'
    fired.fired = { prompt: 'PING', source: 'schedule_wakeup' }
    fired.followUp = ['x']
    // A wakeup set up inside a fired turn is for that turn's messages.
    fired.steps.push({ tool: { id: 'w1', name: 'ScheduleWakeup', input: { delaySeconds: 60, prompt: 'Again', reason: 'loop' } }, result: 'Next wakeup scheduled for 14:48:00 (in 100s).' })
    const lost = newTurn('', at(14, 47))
    lost.key = 'fired-2'
    lost.fired = { prompt: 'something unknown' }
    const now = at(16, 0)
    const jobs = jobsFromTurns([ask, fired, lost], now)
    const [cron, daily, wake] = jobs.list
    assert.deepEqual(cron!.runs.map(r => r.turn), ['fired-1', 'fired-2'])
    assert.equal(fired.fired.job, 'tu-1')
    assert.deepEqual(fired.followUp, [ask.key])
    assert.deepEqual(cron!.for, [ask.key])
    assert.equal(cron!.state, 'expired')
    assert.equal(cron!.endedAt, now)
    assert.equal(daily!.state, 'unknown')
    assert.equal(stateLabel(daily!), 'may still run')
    assert.equal(wake!.state, 'expired')
    assert.deepEqual(wake!.for, [ask.key])
  })
})
