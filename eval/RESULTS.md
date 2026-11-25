# Results

## Can you see what was answered? (2026-11-25)

The first evaluation compared answers. This one asks what clued is for: for each message you sent, can you see whether it was answered, by which reply, and what is still open, without reading the whole chat?

**Short answer.**
- **Answered or not: yes, and plain Claude Code can't show it on one screen.** From one screen, a reader tells this right for 992 of 995 messages with clued, and 856 of 995 without it. Without clued, the reader couldn't tell for 135 messages, because they had scrolled off. Reading the whole chat closes the gap: 278 of 279.
- **Which reply: the panel's link is always right, but the answer isn't easier to find.** The panel links every answered message to a reply that answers it (648 of 648). From one screen, though, a reader finds the answer itself equally often in both arms: 82% and 83% (p = 0.95).
- **What is still open: no clear win.** clued scores higher only if Claude's offers ("I can change that if you like") count as waiting on you. Leave offers out and the two arms tie (−1 pt, p = 0.49). The panel also makes two mistakes of its own; see below.
- **An unanswered message that looked answered:** 0 of 141 on clued's panel, and 4 of 135 for a reader of plain Claude Code. That gap isn't significant (p = 0.22).

### Method

**Data.** It re-uses the 130 recorded runs of the bigger run below (`results/hard/results.json` and `raw/*.jsonl`). No session was run again.

**Moments.** Each run is looked at just before each message after the first, and at the end. Those are the moments you add a message, or come back to the chat. At each moment, every message sent so far is one item, a pair. That gives 995 pairs per arm, 280 of them at the end.

**Ground truth, per message.** It records three things:
- the Claude block that answers it;
- the block where Claude asks you something about it, if any;
- your message that answers that question, if any.

From these, each pair gets one state:
- **done**: answered, and nothing asked of you;
- **waiting**: Claude asked you something you haven't answered;
- **working**: not answered yet.

The truth comes from one careful judge call per run, Sonnet, on all 130 runs, so both arms get the same kind of truth. The judge reads the whole transcript, arm-blind: marks, tags and topic ids removed, and every block numbered. It also gets the scenario's expected facts. It is told:
- to give a question to the message whose reply first raised it, not to later replies that only repeat it;
- to ignore courtesies like "anything else?".

The rule-based answer (the first reply block that states the expected facts, and names their subject or answers only that message) agrees with the judge on 541 of 560 messages. 10 of the other 19 are `open-question` m1, which the rules can't settle.

**Arm A, clued.** The recorded stream goes through the app's own code. The scored screens were drawn at `main` 344e029. They are byte-identical at 4e14ac3: every prompt was found in the cache when re-run there. The code it goes through:
- `app/claude.ts`'s parser (its `dispatch`, with no process);
- `submit()`, `onEvent()` and `finishTurn()` as `app/main.ts` does them, ported line for line, because importing `main.ts` starts the TUI;
- `hooks/model.ts` `raiseTopic`/`settleTurn`, and `app/inbox.ts` `assignParts()` and `inbox()`.

This gives each message's mark (⏳ ▶ ✋ ✓ ○ ⚠ ✕, and the spinner) and the reply it links to. Then `app/panel.ts` `panelLines()` and `app/chat.ts` `chatLines()` draw the screen. The replay checks that every message gets the topic id the run gave it.

The state logic is the same as the eval's frozen copy; only the guide text has changed since. The recordings have no text deltas, so the fix for replies that only streamed (#2) can't show here.

**Arm B, plain.** The same stream is drawn as Claude Code's terminal draws it:
- your prompts as `>` lines;
- Claude's text as `⏺` lines;
- one line per tool call, with the first line of its result.

**Readers.**
- **A panel:** the panel's own state and link, scored directly, with no model.
- **A glance and B glance:** a small model (Haiku), told it is a busy developer who doesn't scroll. It sees one screen, 120 × 40:
  - clued: the panel (38 columns) beside the end of the chat;
  - plain: the end of the chat.

  It also gets the list of messages you sent and a one-line legend of the screen. For each message it gives a state (done, waiting, working or unknown) and the answer it sees, in at most 12 words.
- **A full read and B full read:** the same reader, at the end only, given the whole chat (clued: the whole panel, then the whole chat).

**Why the glancer reads clued's screen too.** The headline comparison is A glance against B glance. It holds the reader constant, so the difference comes from the screen and not from comparing code with a model. The panel scored directly (zero reading cost) is shown as well.

**Scores per pair.**
- **answered or not:** the reader's state has the right side of answered (done or waiting) against not answered (working).
- **still open:** waiting or working, against done.
- **answer found:** of the messages already answered, the share where the reader's answer contains the expected facts. For the panel, the share it links to a reply that states them. Markdown and underscores are ignored, because previews drop them.
- **can't tell:** a state of unknown, which counts as wrong.

**Statistics.** Per-run rates. A − B is the mean over scenarios of (mean A − mean B). p is the same two-sided permutation test as below, with labels shuffled within each scenario (5,000 shuffles).

### Results (995 pairs per arm; 280 at the end)

| measure | A panel (no model) | A glance | B glance | A − B, glance | p |
|---|---|---|---|---|---|
| answered or not | 994/995 | 992/995 | 856/995 | +4 pt | <0.001 |
| … at the end | 279/280 | 279/280 | 240/280 | +7 pt | <0.001 |
| can't tell | 0 | 2 | 135 | | |
| not answered, but looked answered | 0/141 | 0/141 | 4/135 | −0.06 per run | 0.22 |
| answer found | 100% | 82% | 83% | +0 pt | 0.95 |
| still open (offers count as waiting) | 923/995 | 929/995 | 765/995 | +7 pt | <0.001 |
| still open, offers left out | 93% | 94% | 86% | −1 pt | 0.49 |
| open, but looked done | 45/336 | 31/336 | 93/301 | −0.95 per run | <0.001 |
| done, but looked open | 27/659 | 33/659 | 2/694 | +0.48 per run | <0.001 |

**The full read, at the end (280 pairs per arm):**

| measure | A full read | B full read | A − B | p |
|---|---|---|---|---|
| answered or not | 279/280 | 278/279 | 0 | 1.0 |
| still open | 256/280 | 243/279 | +2 pt | 0.36 |
| answer found | 96% | 98% | −1 pt | 0.27 |
| open, but looked done | 8/45 | 33/41 | −0.38 per run | <0.001 |

**Reading cost.** One clued screen holds 168 words on average, and a plain one 133. The whole chat at the end is 302 words in clued and 233 in plain. A plain reader who can't tell from one screen has to read about 1.75 screens of text to get the answered-or-not right.

### Where the arms differ

- **`interleaved` (12 messages): answered or not, 100% against 71%.** The first messages scroll off a plain screen, so the reader can't tell. clued's panel lists all 12 with their marks. The answer itself, though, is found less often on clued's screen (66% against 70%). The panel says "✓", but older answers sit in the chat above, and in the Unread list only as cut previews ("The tax rate in pricing.py is 1…"). The answer is one click away, not on the screen.
- **`quotes` and `open-question`: answered or not, 99-100% against 89%.** The cause is the same: the early messages have scrolled off.
- **Mid-turn messages (`midturn-edits`, `midturn-flood`, `busy-burst`).** Both arms nearly always show these as not answered yet (clued ⏳ or the spinner; plain, a chat ending in tool calls). The plain reader called a mid-turn message done 4 times; clued's panel never did.
- **`continuation`, `late-correction` and `correction`: what is still open.** Both arms do poorly here (67-92% for clued, 50-80% for plain), for different reasons:
  - **Plain: offers are missed.** Claude in plain Claude Code rarely asks with a question mark. Of its 166 waiting pairs, 151 are offers like "I can make that change if you like". The reader saw only 37 of those 151 as open on one screen, and 8 of 41 even reading the whole chat.
  - **clued: Claude asks with a question mark.** APP_GUIDE tells Claude to end with a question, so 192 of A's 195 waiting pairs are direct questions, and readers see them.
  - **clued: one question marked on several messages.** In `continuation`, `interleaved`, `late-correction` and `quotes`, Claude's tag puts a follow-up in the same topic as an earlier message (`same_as`) whose question is open. The panel then shows ✋ on the follow-up too ("And round the result to 2 decimals." ✋). That accounts for most of the 27 "done, but looked open".
  - **clued: a question under ✓.** Claude asked something in the text but marked the topic "done" in its tag, or gave the question a made-up id (`T1-discount`, see below). The panel shows ✓, and the question is missing from Waiting on you. That is 45 of 336 open pairs: `late-correction` m1, `interleaved` m3 and m7, `open-question` m1, `continuation` m1 and `correction` m1.
- **One lost reply (`midturn-flood` A r2, m5).** "Who is the maintainer?" shows ⚠ reply lost, though the answer was written: it went under the next message's bubble (the attribution gap described below). It is the only message where clued's panel gets answered-or-not wrong.
- **No difference:** `busy-burst`, `follow-up`, `numbered`, `tool-task` and `two-questions`. Every reader scored 100% on each of these.

### What this cannot show

- **The reader is a model, not a person.** It reads every character of a screen. A person glancing may read less, and may trust a ✓ more.
- **The plain screen is drawn by this script, not by Claude Code.** It leaves out the diffs Claude Code shows for edits, so plain chats here are shorter than real ones. That helps arm B: more of the chat fits on one screen.
- **Clicks are not modelled.** In clued, a click on a message jumps to its reply. That is what the "A panel" row measures, not the glance.
- **The truth is a judgement.** "Waiting on you" depends on whether an offer counts, which is why both readings are shown. The judge is Sonnet, the same family as the subject.
- **These are short sessions (1-12 messages),** on Sonnet, with the APP_GUIDE of the run. They are not today's guide, and not Opus.

### Spend: $2.08 of the $3 cap

| item | calls | $ |
|---|---|---|
| ground truth, Sonnet, one per run | 130 | 1.1606 |
| one-screen glance, Haiku, one per moment and arm | 840 | 0.7242 |
| full read, Haiku, at the end | 195 | 0.1917 |
| a cost test | 1 | 0.0003 |

280 of the glances and 65 of the full reads were wasted. They were arm A's first pass, and `main` changed the panel (a spinner and "in progress") before the write-up. Arm A was read again on the current panel, and only that second pass is scored.

The first pass ran up to 6 model calls at a time, which overloaded the machine. Everything after it ran at most 2 at a time.

**Files.**
- `visibility/results.json` holds ids, states, counts and scores only: the truth per message (block ids), the panel's mark per moment, every miss by reader, and the per-run scores.
- `visibility/summary.md` holds all the tables.
- Prompts, model answers and the spend ledger stay in `visibility/raw/`, which is never committed.
- `eval/visibility.ts` re-scores everything from that cache at no cost.

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
