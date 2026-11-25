# Results

## A reply to a message from before a compaction (2026-11-25)

**Question.** After Claude Code compacts the conversation, a reply to an older message carries only the quoted bubble. Does adding that request's chain to the note (the request's first message, then its last few messages and replies, about 2,000 characters) help Claude use the right earlier detail?

**Set-up** (`--set chain --arms A,B,C --reps 3 --judge`, Sonnet, `scenarios-chain.json` on `fixture-hard/`). Each scenario:

1. a request whose detail is only in the user's first message;
2. two unrelated requests that grow the context: a pasted 60-line log, and an edit;
3. `/compact`;
4. a reply quoting Claude's answer to the first request, asking for something that needs the detail.

There are two scenarios:

- **chain-detail:** a short sentence holds the detail: "staging runs on port 9412, health route /readyz". Then: "Give me the one-line curl health check for staging."
- **chain-paste:** a 20-line `.env` pasted "for reference only (don't write it to disk)" holds the detail: `REDIS_HOST`, `REDIS_PORT`, `REDIS_DB`. Then: "Using that env file, give me the full redis URL for staging."

In both, the quoted answer doesn't contain the detail. The arms:

- **A:** today's note, with the quote;
- **B:** plain Claude Code, with the quote as `> ` lines;
- **C:** A plus the chain.

3 runs per arm per scenario, 18 in all. That is small: read the table as counts, not rates.

| the reply after /compact used the right detail | A | B | C |
|---|---|---|---|
| chain-detail (port 9412 and /readyz) | 3/3 | 3/3 | 3/3 |
| chain-paste (`redis://cache-stg-3.internal:6390/7`) | 3/3 | **0/3** | 3/3 |

The blind judge agrees on every one of these messages. In the 3 B misses, Claude says the compaction lost the values. Twice it gave nothing; once it gave a template with the port and db and asked for the host.

**Where the detail came from.** Each run's compaction summary decides this. Checking each run's summary for the redis host:

- **chain-detail:** every summary kept the short sentence. Claude Code's summary lists the user's messages, so a short detail survives, and the chain adds nothing there. A tie.
- **chain-paste:**
  - **B:** the summary lost the host 3 of 3 times, and B failed 3 of 3.
  - **C:** the summary lost the host 2 of 3 times. Both times the chain note supplied it, and C answered correctly.
  - **A:** the summary happened to keep the whole env file all 3 times, so A's 3/3 says nothing about the note. A, without the chain, was never tested on a lost detail.

  The fair reading: when the summary dropped the detail, the chain recovered it 2/2, and plain Claude Code 0/3. With n this small, whether A's summaries really keep pastes more often than B's is unknown.

**Cost.** Arm C's note on the reply after compaction was 568–622 characters in chain-detail and about 1,385 in chain-paste, against 308–808 for A. Mean cost per run was A $0.126, B $0.113, C $0.123. A and C differ by noise, since the chain is one note on one message. B is cheaper by APP_GUIDE and the notes, as in the earlier runs.

**Limits.**

- The chain clips the request's first message to 500 characters. Here `REDIS_DB` lay at character ~280, so it fit. A detail further into a long paste would be cut.
- The eval builds the chain from the quoted part's topic: its messages and the reply parts naming it. The app uses `requestInfo()`, which also follows links and `about` tags.
- After the run, two decoy lines of the pasted `.env` were reworded so the repo's privacy check passes. The Sentry DSN's host became `ingest.sentry.example`, and the `MAIL_FROM` domain became `shopkit.example` in place of the `.test` domain. Neither is the measured detail. The runs used the original lines, and their copy is with the raw data.
- The filler edit (m3) asked for `with_tax()`, which `fixture-hard/pricing.py` already has. Claude said so, and the judge marked that "incorrect" in 7 runs across all arms. That is the scenario's fault, not the arms', and doesn't touch the measured message.

**Spend:** $2.559 for the 18 runs, of which $0.381 was the judge. There was also $0.013 of Haiku probes and a smoke run. Raw transcripts are outside the repo.

## Can you see what was answered? (2026-11-25)

The first evaluation compared answers. This one asks what clued is for: for each message you sent, can you see whether it was answered, by which reply, and what is still open, without reading the whole chat?

**Short answer.**
- **Answered or not: yes, and plain Claude Code can't show it on one screen.** From one screen, a reader tells this right for 992 of 995 messages with clued, and 856 of 995 without it. Without clued, the reader couldn't tell for 135 messages, because they had scrolled off. Reading the whole chat closes the gap: 278 of 279.
- **Which reply: the panel's link is always right, but the answer isn't easier to find.** The panel links every answered message to a reply that answers it (648 of 648). From one screen, though, a reader finds the answer itself equally often in both arms: 82% and 83% (p = 0.95).
- **What is still open: no clear win.** clued scores higher only if Claude's offers ("I can change that if you like") count as waiting on you. Leave offers out and the two arms tie (−1 pt, p = 0.49). The panel also makes two mistakes of its own; see below.
- **An unanswered message that looked answered:** 0 of 141 on clued's panel, and 4 of 135 for a reader of plain Claude Code. That gap isn't significant (p = 0.22).

**Since then (panel fix).** The panel showed ✋ on follow-ups that Claude's tag merged into a topic whose question was still open, though the follow-up itself was settled. A merged follow-up now waits on you only if its own latest reply asks something. Re-scored with the saved truth and no model calls (`--truth-from`): the panel's still-open accuracy went from 92.8% to 93.4%, and the false ✋ marks from 27 to 21, with nothing newly wrong. The other error, ✓ where Claude asked something but its tag said done, stays at 45. A rule that marked any reply ending on a question as waiting fixed 7 of those but broke 16 others: replies to one message often end by asking again about another, so it was dropped.

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

**Later the same day,** the panel, the chat and the app changed to close the gap: see [Closing the gap](#closing-the-gap-2026-11-25-later). The tables below are the state before that.

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

### A burst of messages before the first reply (2026-11-25)

You send many messages and requests before Claude has replied once. Which screen lets you keep track of them?

**Short answer.**
- **Answered or not: clued is a little better, but not clearly.** From one screen, a reader tells it right for 273 of 275 messages with clued, and 259 of 275 without (+5 pt, p = 0.13). The panel itself is right for all 275 (+6 pt against the plain glance, p = 0.048). The plain gap isn't messages scrolling off. While Claude is still on the burst, the plain screen shows only your prompts, and the reader said "can't tell" for 14 of them, not "not answered yet". At the end, both readers get all 50 right.
- **Which reply: plain Claude Code wins.** From one screen, a reader finds the answer itself for 86% of answered messages with clued, and 99% without (−13 pt, p = 0.008). At the end it's 74% against 100% (p = 0.008). The panel links every message to a reply that answers it (111 of 111), but you have to click to see it.
- **What is still open: no clear difference.** 97% with clued against 91% (+7 pt, p = 0.12). Leave out offers ("I can fix that if you like") and it's +4 pt (p = 0.27).
- **An unanswered message that looked answered:** 0 of 140 for clued, on the panel and at a glance, and 2 of 138 for plain (p = 0.44).

These are 5 runs per arm of one scenario. Only the "which reply" result is beyond noise, and it goes against clued.

**The scenario (`burst` in `scenarios-hard.json`, on `fixture-hard/`).** 8 messages, 0.9 s apart:
1. "What's the tax rate in pricing.py?"
2. "Set workers in server.toml to 8."
3. "How many customers are in customers.json?"
4. "Add a FREE_SHIPPING_OVER constant to pricing.py, but ask me which amount first." (a decision for you)
5. "Who is the maintainer named in the README?"
6. "In stock.csv, set nails to 100."
7. "Sorry, workers should be 6, not 8." (corrects message 2)
8. "For the third thing I sent you: how many of them are from Germany?" (refers to message 3)

Then, after Claude's reply, "50." (your decision) and "And what would 100 cost with that tax rate?".

**What happened.** In all 10 runs, the 7 later messages arrived while Claude was working, and Claude answered the whole burst in one reply: at 13.4 s on average for clued and 16.6 s for plain. The last message went out at 6.3 s. Both arms got everything right: 100% project checks, the judge found every message answered and correct, every correction followed (workers 6, never 8), and "the third thing" read as the customers question every time. clued cost $0.075 a run and plain $0.073 (p = 0.64).

**How each arm laid out the reply.**
- **clued** split the reply into 6 bubbles: tax, workers (messages 2 and 7 together), customers (3 and 8 together), the free-shipping question, maintainer and nails. On one screen, the chat shows the last bubbles, and the panel's Unread list shows each bubble as a cut preview ("The maintainer named in the REA…", "customers.json has 7 customers,…"). So the panel says ✓ for the maintainer and the Germany count, but the answer itself isn't on the screen.
- **plain** wrote one bulleted list, about 10 lines, that stays on the screen until the follow-ups.

**Per arm (275 message-moments each; 50 at the end):**

| measure | A panel (no model) | A glance | B glance | A − B, glance | p |
|---|---|---|---|---|---|
| answered or not | 275/275 | 273/275 | 259/275 | +5 pt | 0.13 |
| … at the end | 50/50 | 49/50 | 50/50 | −2 pt | 1.0 |
| can't tell | 0 | 1 | 14 | | |
| answer found | 111/111 | 96/111 | 110/111 | −13 pt | 0.008 |
| … at the end | 42/42 | 31/42 | 42/42 | −27 pt | 0.008 |
| still open (offers count as waiting) | 272/275 | 268/275 | 250/275 | +7 pt | 0.12 |
| still open, offers left out | 272/275 | 268/275 | 248/265 | +4 pt | 0.27 |
| not answered, but looked answered | 0/140 | 0/140 | 2/138 | −0.4 per run | 0.44 |
| open, but looked done | 3/154 | 3/154 | 11/154 | −1.6 per run | 0.25 |

The full read at the end: answered or not 50/50 in both arms, answer found 41/42 (clued) and 42/42 (plain), still open 50/50 and 47/50 (p = 0.17).

**What was waiting on you.** Two things. One was the free-shipping amount (message 4). The other was a bug Claude found on its own: `member_price` adds the discount instead of subtracting it. The truth counts that bug as a question on the tax message in 3 clued runs and 3 plain runs.
- **The amount.** clued asked in a bubble with a question mark, and the panel showed ✋ until you answered "50.". In plain, Claude called the AskUserQuestion tool in 4 of 5 runs. The headless harness can't answer it, so the tool returned "The user did not answer the questions" at once. Claude then asked again in its reply (2 runs) or wrote "Tell me the amount and I'll add it" (2 runs).
- **The bug, in clued.** Claude asked "Should I fix it?" in the tax bubble, and the panel showed ✋ on the tax message. It then wrongly turned to ✓ in 3 of 9 open moments, for two reasons:
  - In r4, the reply to "50." listed the tax topic as still waiting on you, but had no question mark. `settleTurn()` marks a topic waiting only when the reply asks something, so it marked it done.
  - In r1, the tag put "what would 100 cost" into the tax topic (`same_as`) with status done, and that closed the bug question too.
- **The bug, in plain.** Claude offered the fix ("I can if you like"). From one screen, the reader took it as done in all 11 open moments, and in all 3 when reading the whole chat.

**What this cannot show.**
- **5 runs per arm, one scenario.** A difference of one or two messages moves the rates by several points.
- **clued ran on the bigger run's frozen APP_GUIDE.** Today's guide tells Claude to write each answer as soon as it's ready, even mid-turn, and to ask with AskUserQuestion. Neither was tested here. The screens, though, were drawn by today's app code.
- **AskUserQuestion in plain Claude Code** opens a dialog that waits for you. Here it returned at once, unanswered, so the plain arm's question handling isn't what you would see in the terminal.
- The other caveats of this section apply: the reader is a model, the plain screen is drawn by this script, and clicks aren't modelled.

**Spend: $1.09 of the $2.50 cap.**

| item | calls | $ |
|---|---|---|
| 10 sessions | 10 | 0.7410 |
| blind judge, one per run | 10 | 0.1251 |
| ground truth, Sonnet, one per run | 10 | 0.1260 |
| one-screen glance, Haiku | 100 | 0.0791 |
| full read, Haiku, at the end | 10 | 0.0160 |

At most 2 Claude processes ran at once.

**Files.**
- `results/burst/summary.md` holds the session tables.
- `results/burst/visibility/` holds the visibility results and tables (ids, states, counts and scores only).
- Not committed, and no longer kept: `results/burst/results.json` (Claude's reply text), the streams in `results/burst/raw/`, and the prompts, answers and ledger in `results/burst/visibility/raw/`. They were deleted by mistake when the worktree was cleaned up, so these 10 runs can't be re-scored without running the sessions again (about $1.10).

### Closing the gap (2026-11-25, later)

The goal: clued at least ties plain Claude Code on every measure, and is clearly ahead on answered-or-not and on finding the answer, with the same readers and scoring.

**Short answer.**
- **Answered or not: clearly ahead on both sets.**
  - Hard set: 993 of 995 messages read right from one screen, against 856 of 995 (+4 pt per run, p < 0.001).
  - Burst set: 272 of 275 against 235 of 275 (+13.5 pt, p = 0.018).
- **Finding the answer: ahead on the hard set, tied on the burst set, behind on the hard set's full read.**
  - Hard set, from one screen: 90.8% against 82.7%, up from 81.7%. The per-run test gives +1.4 pt (p = 0.17) over all moments and +3.8 pt (p = 0.021) at the end. It weighs each run equally, and plain's misses sit in the long runs.
  - Burst set, from one screen: 98.4% against 98.2%, up from 77.3%. That is a tie (p = 0.84), but no longer −18 pt.
  - Full read: 93.9% against 97.9% (−5 pt, p = 0.021). This one doesn't win; see the caveats.
- **What is still open: ahead when offers count, tied without them.** But clued shows a finished message as waiting on you more often than plain does: 23 of 659 against 2 of 694 on the hard set, and 12 of 135 against 0 of 124 on the burst set.
- **What did most of it.** Two things, for two different failures:
  - On the burst set, the app now asks Claude again, at once, for replies its tag settled but that never arrived. Without that, clued's sessions answered only about half of the burst.
  - On the hard set, the panel's fixes: it trusts Claude's "waiting on you", and a follow-up can no longer close another message's question.

**What changed in the app, one PR each, in this order.**
1. **#21, panel.** The panel trusts the tag's "me" (waiting on you), even without a question mark. A `same_as` follow-up marked done no longer closes the question of the topic it merged into. A made-up id such as `T1-discount` maps to its real topic. A message the app guessed was your answer goes back to waiting if Claude's next tag ignores it. ✋ shows only on the message whose reply asked.
2. **#25, chat.** In a reply of several parts, a short part (one or two lines, answering one message) has no box. It is one `↩ “Which port…”` line with the answer under it, so a burst of answers fits on one screen. *Undone later (#37): the owner found the boxless parts read as random text, so every part has its bubble again. The scores above were measured with it.*
3. **#29, panel.** Under each answered message in Your recent messages, a dim `→` row gives the answer's gist, room allowing. For a question, the words that restate it go (`→ 8137.`). For a request, the thing it changed stays as a label (`→ workers: now 6, per your correction.`).
4. **#30, app.** Replies Claude's tag settled but never wrote are asked for again at once, in one message. See "Why the burst set was losing" below.
5. **#31, app.** A reply part shows, and answers its message, as soon as its text block is complete. Before, it waited for Claude's next tool call. While one of your messages waited in queue, the chat hid the part too.

Idea 4, a guide line about Claude's ✓ on a question, wasn't needed: the panel fixes solved that case in code.

**Why the burst set was losing.** The burst set was run again with today's APP_GUIDE, 5 sessions per arm (`results/burst2/`). Sonnet with interleaved thinking often drafted the answer parts for the burst in its thinking blocks and never wrote them as text. The tag still marked those messages done, so the panel showed ⚠ reply lost. The judge found only 50% ± 28% of clued's messages answered fully, against 100% for plain (p = 0.045).

A guide line asking for every part as reply text didn't help: 56% ± 13% (`summary-guide-try.md`), so it was dropped. Asking again in the app (#30) brought it to 98% ± 4% (`summary-retry.md`). That costs a turn: $0.090 a session for clued against $0.071 for plain.

**Hard set (995 message-moments per arm, 280 at the end; same sessions, same saved truth).** "Before" is arm A as scored in the tables above. "After" is the app after #31.

| measure | A glance before | A glance after | B glance | A − B after | p | (before: A − B, p) |
|---|---|---|---|---|---|---|
| answered or not | 992/995 | 993/995 | 856/995 | +4.3 pt | <0.001 | +4.2 pt, <0.001 |
| … at the end | 279/280 | 279/280 | 240/280 | +7.2 pt | <0.001 | +7.2 pt, <0.001 |
| answer found | 81.7% | 90.8% | 82.7% | +1.4 pt | 0.17 | +0.1 pt, 0.95 |
| … at the end | 86.1% | 89.1% | 83.8% | +3.8 pt | 0.021 | +2.6 pt, 0.15 |
| still open (offers count as waiting) | 929/995 | 959/995 | 765/995 | +8.0 pt | <0.001 | +7.2 pt, <0.001 |
| still open, offers left out | 93.6% | 96.7% | 86.3% | −0.2 pt | 0.88 | −0.9 pt, 0.49 |
| open, but looked done | 31/336 | 11/336 | 93/301 | −1.26 per run | <0.001 | −0.95, <0.001 |
| done, but looked open | 33/659 | 23/659 | 2/694 | +0.32 per run | <0.001 | +0.48, <0.001 |
| not answered, but looked answered | 0/141 | 0/141 | 4/135 | −0.06 per run | 0.22 | same |
| full read at the end: answer found | 96.1% | 93.9% | 97.9% | −5.0 pt | 0.021 | −1.2 pt, 0.27 |

The panel itself, with no model:
- Still open: 92.8% before, 98.9% after.
- Open, but looked done: 45 before, 3 after. The 3 left are offers.
- Done, but looked open: 27 before, 8 after.
- Answer found: 99.8% before and after.

**Burst set (275 message-moments per arm, 50 at the end; 5 runs per arm).**
- "Before" is the old app (`3ff1327`) on the sessions with today's guide.
- "Display only" is the app after #31 on the same sessions.
- "After" is the app after #31 on new clued sessions, run with #30's asking again.
- Plain's sessions and readers are the same in every column.

| measure | A glance before | display only | after | B glance | A − B after | p | (before: A − B, p) |
|---|---|---|---|---|---|---|---|
| answered or not | 213/275 | 212/275 | 272/275 | 235/275 | +13.5 pt | 0.018 | −8.0 pt, 0.28 |
| … at the end | 25/50 | 25/50 | 49/50 | 50/50 | −2 pt | 1.0 | −50 pt, 0.047 |
| can't tell | 62 | 63 | 0 | 40 | | | |
| answer found | 77.3% (of 44) | 90.9% | 98.4% (of 127) | 98.2% (of 114) | +0.2 pt | 0.84 | −18.2 pt, 0.16 |
| … at the end | 70.0% | 85.0% | 95.2% | 97.7% | −2.5 pt | 1.0 | −23.1 pt, 0.16 |
| still open | 206/275 | 202/275 | 257/275 | 229/275 | +10.2 pt | 0.018 | −8.4 pt, 0.26 |
| done, but looked open | 6/54 | 8/54 | 12/135 | 0/124 | +2.4 per run | 0.047 | +1.2, 0.16 |
| open, but looked done | 1/221 | 2/221 | 6/140 | 6/151 | 0 | 1.0 | −1.0, 0.44 |
| full read at the end: answered or not | 43/50 | 31/50 | 49/50 | 50/50 | −2 pt | 1.0 | −14 pt, 0.45 |
| full read at the end: answer found | 95% | 95% | 97.6% | 100% | −2.2 pt | 1.0 | −10 pt, 1.0 |

The display changes alone moved "answer found" from 77% to 91% on the same sessions. Answered-or-not only moved once the replies themselves arrived (#30).

Of the misses left after #29's first version:
- 4 were moments between a finished part and Claude's next step, fixed by #31.
- 8 were the gist for a request cut off before its value, fixed by the label.

**Caveats.**
- **The panel rules were tuned on the hard set's misses,** so the hard set's panel gains are in-sample. The burst set was the check, but #29's label and #31 were written after looking at the burst set's misses too.
- **The arms were not run side by side.** clued's "after" sessions ran later than plain's, with the same model, guide and fixture.
- **Plain Claude Code has no counterpart to asking again,** and needs none: its replies are its text. The extra turn is in clued's cost.
- **Not every reader was run again.**
  - Plain's glance verdicts on the hard set are the earlier run's, read back from its saved misses (`--readers-from`), since plain's screens didn't change. That reproduces its scores exactly.
  - Plain's full read on the hard set was sampled again for this comparison and scored 97.9% again (`visibility-after/b-full-again/`).
  - clued's hard-set "before" verdicts were read with the old legend, which had no line for the `→` row.
- **The full read got worse for clued: 96.1% to 93.9%, 9 misses to 14.** Every new miss is the reader paraphrasing without the fact ("Anna Weber and Lukas Brandt are from Germany" for "how many?"), not a missing answer. On one fresh sample, this can't be told apart from noise. clued's whole chat is longer than plain's: 566 words against 334 at the end of a burst run.
- **5 runs per arm on the burst set.** One message moves a rate by 2-4 points, and the smallest p a 5-against-5 test can give is 0.008.

**Spend: $3.12 of the $4 cap.**

| item | $ |
|---|---|
| burst sessions with today's guide, both arms, and the blind judge | 0.9207 |
| the guide-line try, 5 clued sessions | 0.5605 |
| sessions with asking again, 5 clued sessions | 0.5138 |
| burst set: truth, glances and full reads | 0.5803 |
| hard set: clued glances and full reads, plain's full read again | 0.5454 |

About $0.07 of the hard set's glances was a first pass stopped part-way. At most 2 Claude processes ran at once.

**Files.**
- `results/burst2/summary.md`, `summary-guide-try.md` and `summary-retry.md` hold the session tables.
- `results/burst2/visibility-{before,display,after}/` and `results/visibility-after/` hold the visibility results: ids, states, counts and scores only.
- The sessions' `results.json`, the streams and the model prompts and answers stay outside the repo.

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
