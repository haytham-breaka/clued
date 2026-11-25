# Results

## The bigger run (2026-11-25)

**Setup.**
- 8 hard scenarios (`scenarios-hard.json`, `fixture-hard/`) and the 5 pilot scenarios as a baseline.
- 5 repeats per scenario per arm, 130 runs, every one judged blind.
- `--model sonnet` (`claude-sonnet-5-5`, 1M context window); Claude Code 2.1.331.
- Arm order shuffled per repeat (seed 7), concurrency 3.

**Data.**
- `results/hard/results.json` holds every run, score, judge verdict and failure, the frozen guide text and its hashes.
- `results/hard/summary.md` holds the tables; `results/hard/raw/*.jsonl` the streams; `results/hard.log` the console log.

**App code.**
- Frozen by `freeze.sh` at 03:30:00 (`frozen/SOURCES.txt`): `hooks/model.ts` from 23:17, `app/inbox.ts` from 03:28:50, `app/main.ts` from 03:28:07.
- APP_GUIDE is 3,423 chars. That includes your new REPLY_GUIDE lines on `"about"` links and on updating topics that are still "on Claude". It was 2,870 in the pilot.
- Every run used this snapshot.

**Spend: $9.94 of the $25 cap.** Nothing was stopped by the budget.

| item | $ |
|---|---|
| 130 sessions | 8.4861 |
| 130 judge calls | 1.1025 |
| re-judging 10 runs after fixing how reaction-only replies are rendered | 0.0679 |
| a judge test | 0.0064 |
| a 4-run validation of the new scenarios, before the final freeze, results discarded | 0.2811 |

With the pilot ($0.71), everything so far totals $10.65.

### Hard set: per arm (40 runs each; mean ± sd per run)

The A − B column is the mean over scenarios of (mean A − mean B). p is a two-sided permutation test that shuffles the arm labels within each scenario (5,000 shuffles; the smallest possible p is 0.0002).

| metric | A threadline | B plain | A − B | p |
|---|---|---|---|---|
| cost per run | $0.0800 ± 0.0236 | $0.0732 ± 0.0193 | +$0.0068 (+9%) | <0.001 |
| input tokens (all) | 228,779 ± 121,843 | 229,905 ± 120,404 | −1,127 | 0.78 |
| output tokens | 1,630 ± 710 | 1,457 ± 493 | +173 (+12%) | <0.001 |
| cache ratio | 94% ± 2% | 95% ± 2% | −1 pt | <0.001 |
| API calls per run | 10.2 ± 5.1 | 10.8 ± 5.5 | −0.7 | <0.001 |
| context at the last call | 23,820 ± 1,356 | 22,484 ± 1,056 | +1,336 | <0.001 |
| turn time (Σ `duration_ms`) | 18.6 s ± 9.5 | 20.8 s ± 20.3 | −2.2 s | 0.86 |
| messages answered in a final answer (regex) | 98% ± 6% | 99% ± 4% | −1 pt | 0.32 |
| … counting a reaction-only reply as answered | 100% | 99% ± 4% | +1 pt | 0.44 |
| attributed (plain-text rubric) | 98% ± 6% | 99% ± 4% | −1 pt | 0.28 |
| mid-turn messages answered in the final answer | 56/56 | 56/58 | | 0.45 |
| project checks passed (right item changed, others untouched) | 100% | 99% ± 3% | | 1.0 |
| judge: answered fully / correct | 100% / 100% | 100% / 100% | | 1.0 |
| judge: clear which reply answers it | 99% ± 4% | 100% | −1 pt | 0.22 |
| judge: misattributed messages | 0 | 0 | | |
| judge: corrections followed | 100% | 100% | | |

**Per scenario, cost per run (mean ± sd over 5 runs):**

| scenario | A | B | A vs B | output A vs B |
|---|---|---|---|---|
| numbered (4 numbered questions, then "the third one") | 0.0497 ± 0.0015 | 0.0461 ± 0.0009 | +8% | −3% |
| continuation (follow-ups that never name the request) | 0.0775 ± 0.0023 | 0.0673 ± 0.0022 | +15% | +26% |
| open-question (bare "8." answers an old question) | 0.0809 ± 0.0033 | 0.0809 ± 0.0033 | 0% | −8% |
| late-correction ("that fee should be 5.49", 4 turns later) | 0.0834 ± 0.0012 | 0.0746 ± 0.0011 | +12% | +19% |
| midturn-edits (2 edits + a correction + a question mid-task) | 0.0681 ± 0.0056 | 0.0664 ± 0.0035 | +3% | −6% |
| quotes (replies quoting earlier bubbles or messages) | 0.0793 ± 0.0021 | 0.0738 ± 0.0034 | +7% | +12% |
| midturn-flood (5 questions during a test-fixing task) | 0.0673 ± 0.0022 | 0.0609 ± 0.0081 | +10% | +5% |
| interleaved (12 messages on 4 subjects, "the CSV one") | 0.1339 ± 0.0137 | 0.1155 ± 0.0016 | +16% | +33% |

Every scenario's quality numbers are in `summary.md`. All of them are 87-100%, with the failures listed below.

### Baseline set (the 5 pilot scenarios; 25 runs per arm)

| metric | A | B |
|---|---|---|
| cost per run | $0.0494 ± 0.0075 | $0.0449 ± 0.0078 (A +10%, p < 0.001) |
| output tokens | 700 ± 331 | 684 ± 334 (p = 0.49) |
| quality, every measure | 100% | 100% |

### A's overhead

- **APP_GUIDE plus the first note: +1,088 tokens on the first call.** It was identical across scenarios (1,087-1,090; 1,176 for `numbered`, whose note lists four questions). That is about 3.15 chars a token. The pilot's smaller guide cost +925.
- **Notes** average 107 chars, about 34 tokens; the largest is 302 chars (a quoted bubble). Every later call reads them all again. After 12 messages, A's context is about 1,340 tokens larger than B's.
- **Tags** average 148 chars per final answer, about 48 output tokens. That is most of A's +12% output, and with long multi-topic tags in `interleaved` it reaches +33%.
- **Cost: +$0.005 to +$0.007 per short session (+9-10%).** Most of it is the guide written to cache once per session, plus the extra output. A makes slightly fewer API calls (−0.7 per run), so its total input tokens come out equal to B's.

### Where each arm failed

The hard set had 230 messages per arm.

**A (threadline):**

1. **Reaction-only replies: 6 messages.** "Change it to 8443." got only `"react":"✅"`, with no text, in 4 of 5 `quotes` runs. "Change that port to 9000." (`interleaved` r4) and "that fee should be 5.49" (`late-correction` r4) did too. The edits were right every time (checks pass), and APP_GUIDE allows this: "✅ … the reaction is the whole reply". But the user never sees the new value confirmed. Shown a ✅ as the whole answer, the blind judge rated "clear" 1/2 in 3 of these cases. This is the one A-specific behaviour that is clearly beyond noise (p = 0.01). Whether it's desirable is a product decision.
2. **A bubble attributed to the next message: 5 real cases, plus 3 caused by the harness.** In every `interleaved` run, "Add 20 to that lowest item's quantity." (m10) arrived 0.6-1.2 s before Claude's answer to "List their names." (m9) was complete. Claude Code ran m10 as its own turn, but the m9 answer was unmarked. Under the frozen `assignParts()` rule ("unmarked text replies to every message since the previous answer"), the app would show the German-names bubble as replying to both m9 and m10. That is a real attribution gap in the app when a user types while a reply is finishing; B has no structure to get wrong. The other 3 "shared" cases (m1/m2 in `interleaved` r1-r3) came from late sends by the harness (see below).
3. **Made-up topic ids in tags: 6 entries, in 2 `late-correction` runs** (`"id":"T1-discount"`). Claude opened its own topic for a side issue it raised (the `member_price` bug). The frozen `settleTurn` ignores unknown ids, so that side question is never tracked.
4. **One fact landed in another message's part:** `midturn-flood` r2, the maintainer answer.

**B (plain):**

1. **Mid-turn answers only in narration: 2 of 58 mid-turn messages.** In `midturn-flood` r2 and r3, the port question was answered between tool calls ("`server.toml` uses port **8137** … Now fixing the two failures.") and then left out of the final summary, which answered the other four questions. A CLI reader sees it, but anything that shows or consumes only the final text (the `result`, the app's bubbles, an SDK caller) loses it. A never did this (56/56). Its guide tells it to put every part in the final message.
2. **An ambiguous quoted request read as a question: 1 of 5.** "Halve that." quoting "Nails … 120" got "Half of the 120 nails is 60. I haven't changed `stock.csv`…" (`quotes` r1), so the check failed. A edited the file in 5 of 5 runs.
3. **A 137 s turn:** a Bash heredoc hung until the tool timed out (`midturn-flood` r4). That is noise, not arm-related. It is why B's turn-time sd is so large.

**Both:** no misattributions found by the judge. All corrections were followed: "workers 6, not 8", "that fee 5.49", and "8." for the open question. All references resolved correctly: "the second thing I asked", "the CSV one", "their names", "the third one", "it should reject negatives". The project checks confirm it.

### Is the difference beyond noise?

- **Cost, output tokens and context: yes.** A costs about 9-10% more per session and writes about 12% more output, with p < 0.001, in 7 of 8 hard scenarios and in the baseline. The fixed overhead is deterministic.
- **Answering, attribution and correctness: no.** Both arms score 98-100% on every measure, no quality metric differs significantly, and the judge found no misattribution in either arm. The two arms fail in different ways, each only a few times in 230 messages:
  - A answers small edits with a bare ✅ (6), and can file a bubble under the next message (5).
  - B can leave a mid-turn answer only in narration (2), and can treat an imperative as a question (1).
  - With 5 repeats, these counts are too small to rank the arms. Each is a concrete behaviour worth fixing or keeping on purpose.
- **Time: no difference** (p = 0.86).

What this cannot show:

- Sessions much longer than 12 messages, or Opus.
- Your real configuration (plugins, hooks).
- The interactive TUI.
- Whether the app's bubbles help a person find answers faster. The blind judge deliberately removes that structure, so it measures only whether the text itself is clear.

### Harness problems found during the run, and fixes

1. **The synchronous judge stalled the event loop.** `judge()` used `spawnSync`, which blocked the event loop for the other concurrent runs. 5 of 60 timed sends went out 4-7.5 s late, and three m1/m2 pairs in `interleaved` were misread as a race. Fixed: the judge is asynchronous now, and was tested. The affected runs are flagged above and not counted as A failures in the text. They still appear as "shared" in `summary.md`.
2. **Reaction-only replies.** The scorer and the judge originally treated them as no answer. Now `reacted` is scored, the judge's transcript shows "assistant reacted … with ✅", and the 10 affected runs were re-judged ($0.07).
3. **Bullets under a lead line.** The plain-text attribution rubric missed facts in bullets under a lead line ("**Test fixes**" then bullets). Now a bullet carries its lead. The test-fix message's subject cue also gained `pricing|inventory|member_price|low_stock`. These are scoring-only changes, applied with `--rescore` and costing nothing.
4. **Leftover `/tmp/claude-<uid>/-tmp-tl-eval-*` folders.** Claude Code makes one per project dir for task output; there were 147, all removed. The runner now deletes these along with `~/.claude/projects/-tmp-tl-eval-*`.
5. **Lines with dotted names.** `questionsOf()` misreads "pricing.py?" ("toml use?", "csv list?"), so the `numbered` scenario avoids dotted names. This is an app limitation: with dotted file names, a real user's numbered note would be wrong.
6. **The code was edited during the run.** `app/inbox.ts` changed while the run was being set up. `freeze.sh` waits for 60 s of quiet and records the hashes.

### Recommendation

- **Product questions this run raised:**
  - Should a ✅ be allowed to replace a confirmation of a changed value?
  - Should unmarked text written while a new message arrives be filed under only the messages sent before the turn began?
  - Should the tag allow ids that aren't topics?
- **Harder separation would need:**
  - longer sessions of 30-50 messages, where context pressure starts to matter;
  - real parallel work (background agents);
  - user-side measures (time to find an answer) rather than text judgements.

  At the costs measured here, about $0.01 per message per run on Sonnet, 6 long scenarios × 2 arms × 5 repeats × 40 messages comes to about $25-30.
- **Opus:** do one `--model opus --reps 1` pass first (about 25 runs) to measure the price per run.

## Pilot (earlier the same day; superseded)

- **Setup:** 5 easy scenarios × 2 arms × 1 run, at $0.525, plus $0.19 of smoke tests (`results/pilot`). It used the older APP_GUIDE (2,870 chars), before `freeze.sh`.
- **Result:** both arms scored 100%. A cost +11% ($0.2462 vs $0.2211) with a +923-925 token first-call overhead.
- **Pilot finding:** permission prompts need `--permission-prompt-tool stdio` and `initialize` in Claude Code 2.1.331. `app/claude.ts` passed neither at the time. You said you're fixing this.
