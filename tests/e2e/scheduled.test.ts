// Scheduled jobs: Claude's CronCreate and ScheduleWakeup calls listed under Scheduled in the panel,
// a click opens a job's view (what it is for, its schedule, who set it up, its runs), Esc goes back,
// a firing shows as Claude's own turn, ✕ cancel asks Claude to delete it, and jobs come back on resume.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rowOf, withApp, writeSession } from './harness.ts'

/** A saved panel width (prefs), wide enough for job rows in full. */
const widePanel = ({ home }: { home: string }) => {
  mkdirSync(join(home, '.clued'), { recursive: true })
  writeFileSync(join(home, '.clued', 'panel.json'), JSON.stringify({ width: 56 }))
}

describe('scheduled jobs', () => {
  test('the section lists the jobs; a click opens one, Esc goes back; a firing counts as a run; ✕ cancel asks Claude', () =>
    withApp({ setup: widePanel, height: 44, width: 150 }, async app => {
      let s = await app.screen()
      assert.ok(!s.includes('Scheduled'), 'no section without a job')
      await app.send('please schedule jobs')
      s = await app.waitFor('Scheduled them.')
      s = await app.waitFor(/Scheduled +3 active/)
      // Each job: its mark, a short name (the reason, for a wakeup), when it runs, and how it stands.
      assert.match(rowOf(s, 'Check the deploy'), /⏰ Check the deploy and tell me if it is gr.* scheduled│/)
      assert.match(s, /every 5 min · next \d\d:\d\d/)
      assert.match(rowOf(s, 'waiting for CI'), /⏲ waiting for CI to finish +scheduled/)
      assert.match(s, /in 10 min/)
      assert.match(rowOf(s, 'Remind the user'), /⏲ Remind the user to tag the release\./)
      assert.match(s, /in 3 h · by James \(planner\)|at (?:\w{3} )?\d\d:\d\d · by James \(planner\)/)

      // The view: what it is for, the schedule in words and as cron, who set it up and runs it.
      await app.click('Check the deploy', { area: 'panel' })
      s = await app.waitFor('What it is for')
      assert.match(s, /⏰ Scheduled · Check the deploy/)
      assert.match(s, /⏰ Recurring job +a1b2c3d4 +· +scheduled/)
      assert.match(s, /✕ cancel/)
      assert.match(s, /✻ sent to Claude when it fires/)
      assert.match(s, /cron +\*\/5 \* \* \* \* +\(every 5 min; Claude Code says “Every 5 minutes”\)/)
      assert.match(s, /lasts +session-only: it ends when this Claude Code session exits/)
      assert.match(s, /auto-expires/)
      assert.match(s, /set up by +✻ Claude \(lead\)/)
      assert.match(s, /runs it +✻ Claude \(lead\), the main session: when it fires, its/)
      assert.match(s, /made for +↳ “please schedule jobs”/)
      assert.match(s, /Not run yet\./)
      app.keys('Escape')
      s = await app.waitGone('What it is for')
      assert.match(s, /Scheduled them\./)

      // The agent's reminder: set up by the agent, by name; a click on it opens that agent.
      await app.click('Remind the user', { area: 'panel' })
      s = await app.waitFor('⏲ One-off job')
      assert.match(s, /set up by +◇ James \(planner\) · Plan the release/)
      assert.match(s, /cron +\d+ \d+ \d+ \d+ \* +\(once, \d+ \w+ \d\d:\d\d/)
      await app.click('◇ James (planner)', { area: 'chat' })
      await app.waitFor('Plan the release.')
      await app.click('← back to chat', { area: 'chat' })

      // The wakeup: its reason and prompt.
      await app.click('waiting for CI', { area: 'panel' })
      s = await app.waitFor('⏲ Wakeup (/loop)')
      assert.match(s, /reason +waiting for CI to finish/)
      assert.match(s, /Look at the build again\./)
      assert.match(s, /delay +600 s asked/)
      app.keys('Escape')

      // The cron fires: Claude's own turn, marked with the job, and a run in its view.
      app.release('fire')
      await app.waitFor('⏰ scheduled job ran: “Check the deploy and tell me if it is green.”')
      // Its answer, once its turn has ended (a frame before, it can still show its caret).
      await app.waitFor(/│ The deploy is green\. +│/)
      s = await app.waitFor(/⏰ Check the deploy and tell me if it is gr.* ran once│/)
      await app.click('⏰ scheduled job ran', { area: 'chat' })
      s = await app.waitFor('Runs (1)')
      assert.match(s, /· \d\d:\d\d +↗ its turn/)
      await app.click('↗ its turn', { area: 'chat' })
      s = await app.waitGone('Runs (1)')
      assert.match(s, /The deploy is green\./)

      // ✕ cancel sends Claude a message asking it to delete the job; Claude's CronDelete marks it deleted.
      await app.click('Check the deploy', { area: 'panel' })
      await app.waitFor('What it is for')
      await app.click('✕ cancel', { area: 'chat' })
      await app.waitLog(e => e.type === 'user' && JSON.stringify(e).includes('Please cancel the scheduled job a1b2c3d4'))
      const sent = app.sent().at(-1)!
      assert.match(sent.text, /^Please cancel the scheduled job a1b2c3d4 \(“Check the deploy and tell me if it is green\.”\): delete it with CronDelete\.$/)
      assert.match(sent.note, /from inside the view of your scheduled job a1b2c3d4/)
      s = await app.waitFor('Deleted job a1b2c3d4.')
      assert.match(s, /your messages about this job/)
      s = await app.waitFor(/⏰ Recurring job +a1b2c3d4 +· +deleted/)
      assert.ok(!/✕ cancel/.test(s), 'no cancel on a deleted job')
      assert.match(rowOf(s, 'Check the deploy and tell'), /deleted/)
      assert.match(s, /Scheduled +2 active/)
    }))

  test('on resume, jobs come back from the session file: runs matched, session-only ones ended with it', async () => {
    const t0 = Date.parse('2026-11-25T10:45:23.000Z')
    const iso = (ms: number) => new Date(t0 + ms).toISOString()
    const setup = (a: { home: string; work: string }) => {
      widePanel(a)
      writeSession(a.home, a.work, 'old-1', [
        { type: 'user', timestamp: iso(0), message: { role: 'user', content: 'ping me every minute' } },
        { type: 'assistant', timestamp: iso(2000), message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'CronCreate', input: { cron: '* * * * *', recurring: true, prompt: 'Reply with exactly PING-CRON.' } }] } },
        { type: 'user', timestamp: iso(2100), message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'Scheduled recurring job 72deb24a (Every minute). Next run: Nov 25 2:46pm. Session-only (not written to disk, dies when Claude exits). Auto-expires after 30 days. Use CronDelete to cancel sooner.' }] },
          toolUseResult: { id: '72deb24a', humanSchedule: 'Every minute', recurring: true, durable: false, nextFireAt: t0 + 50_000, maxAgeMs: 2_592_000_000 } },
        { type: 'assistant', timestamp: iso(3000), message: { content: [{ type: 'text', text: 'Scheduled it.' }] } },
        // Two firings, as Claude Code writes them.
        { type: 'user', isMeta: true, turnOrigin: 'scheduled', wakeupSource: 'schedule_wakeup', timestamp: iso(50_800), message: { role: 'user', content: 'Reply with exactly PING-CRON.' } },
        { type: 'assistant', timestamp: iso(52_000), message: { content: [{ type: 'text', text: 'PING-CRON' }] } },
        { type: 'user', isMeta: true, turnOrigin: 'scheduled', wakeupSource: 'schedule_wakeup', timestamp: iso(110_700), message: { role: 'user', content: 'Reply with exactly PING-CRON.' } },
        { type: 'assistant', timestamp: iso(112_000), message: { content: [{ type: 'text', text: 'PING-CRON again' }] } },
      ])
    }
    await withApp({ setup, args: ['--resume', 'old-1'], height: 44, width: 150 }, async app => {
      let s = await app.waitFor('PING-CRON again')
      assert.match(s, /⏰ scheduled job ran: “Reply with exactly PING-CRON\.”/)
      s = await app.waitFor(/Scheduled +none active/)
      assert.match(rowOf(s, 'Reply with exactly PING-CRON.'), /expired/)
      await app.click('Reply with exactly PING-CRON.', { area: 'panel' })
      s = await app.waitFor('Runs (2)')
      assert.match(s, /⏰ Recurring job +72deb24a +· +expired/)
      assert.match(s, /Expired: ended with its Claude Code session\./)
      assert.match(s, /made for +↳ “ping me every minute”/)
      assert.ok(!s.includes('✕ cancel'))
    })
  })
})
