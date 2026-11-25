# threadline eval

Runs the same conversations through Claude Code two ways and compares cost, context, and how well each message is answered and attributed.

- **A, threadline:** what `app/claude.ts` and `app/main.ts` send. The process is `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompts host --append-system-prompt <APP_GUIDE>`.
  - **Message format.** Each message goes out as two text blocks: the user's text, then the hidden `[threadline]` note.
  - **The note:**
    - It comes from `flatBrief()`, and includes the quoted message when the user replies to a bubble.
    - "It asks N things: T1.1 …" is appended when `questionsOf()` finds several questions.
  - **Status updates.** A quoted reply moves its topic back to "on Claude"; otherwise a plain answer moves the one open question back, as `submit()` does.
  - **Settling.** After every `result`, the board is settled with `settleTurn(…, { flat: true })`, as `finishTurn()` does.
- **B, plain:** the same process, flags, model and messages, without `--append-system-prompt` and without notes. A quoted reply is sent as the quote in `> ` lines above the user's text, so both arms get the same information.

## Frozen app code

`run.ts` never imports `app/` or `hooks/` directly. It imports snapshots from `eval/frozen/`:

- `model.ts` is a copy of `hooks/model.ts`.
- `inbox.ts` is a copy of `app/inbox.ts`.
- `guide.ts` holds `APP_GUIDE`, built from `FLAT_GUIDE`, `REPLY_GUIDE` and the bubble/reaction lines of `app/main.ts`.

`main.ts` itself can't be imported, because importing it starts the TUI.

Take a snapshot with `eval/freeze.sh`, which:

- copies the two files and fixes their import paths;
- checks that `main.ts`'s APP_GUIDE lines still match `guide.ts`;
- refuses if a source changed in the last 60 seconds;
- writes the time and hashes to `frozen/SOURCES.txt`.

Each `results.json` stores `frozen.sha256`, `frozen.sources`, and the full `APP_GUIDE`, `FLAT_GUIDE` and `REPLY_GUIDE` text the runs used. A run process imports the snapshot once at start, so every run of an invocation uses the same version.

## Running

```sh
eval/freeze.sh                                                   # snapshot app code (when it changed)
node --no-warnings eval/run.ts --set hard --reps 5 --concurrency 3 --judge --budget 25
node --no-warnings eval/run.ts --set baseline                    # the 5 easy pilot scenarios
node --no-warnings eval/run.ts --model opus --reps 1             # another model (both arms and the judge)
node --no-warnings eval/run.ts --rescore eval/results/hard [--judge]   # score saved runs again; no new sessions
node --no-warnings eval/run.ts --scenarios burst --reps 5 --concurrency 2 --seed 7 --judge --budget 1.9 --out eval/results/burst   # one scenario, in its own folder
```

| flag | default | meaning |
|---|---|---|
| `--set` | `hard` | `hard` (`scenarios-hard.json` on `fixture-hard/`), `baseline` (`scenarios.json` on `fixture/`), or `all` |
| `--reps` | `1` | runs per scenario per arm. The arm order is shuffled per repeat (seeded by `--seed`). |
| `--concurrency` | `1` | runs at once |
| `--model` | `sonnet` | `claude --model`, for both arms and the judge |
| `--budget` | `3` | hard cap in USD for the invocation, summed from `total_cost_usd` (runs and judge). See below. |
| `--run-cap` | `1` | `--max-budget-usd` for each claude process (lowered near the end of the budget) |
| `--max-turns` | `12` | `--max-turns` for each claude process (applies per turn) |
| `--scenarios`, `--arms` | all, `A,B` | subsets |
| `--judge` | off | one blind-judge call per run |
| `--out` | `eval/results/run-<time>` | where `results.json`, `summary.md` and `raw/<scenario>-<arm>-r<rep>.jsonl` go |
| `--keep-tmp`, `--quiet-ms`, `--timeout-min` | off, `6000`, `12` | keep temp dirs; how long the stream must stay quiet after the last `result`; the limit per run |

**Order and budget.**

- The hard set runs before the baseline. Within a set, scenarios with fewer messages go first, so a run that stops early still has complete scenarios.
- Before starting a run, the runner estimates its cost: 1.15 × the costliest run of that scenario so far, or else 1.5 × the dearest cost per message so far × its message count.
- If spent + in-flight estimates + this estimate would pass `--budget`, the runner waits for in-flight runs. If it would still pass, it stops and records why (`stopped` in `results.json`, and the summary header).

**Isolation.** Each run gets a fresh copy of its fixture in `mktemp -d /tmp/tl-eval-XXXXXX`, and claude runs only there. The runner deletes the copy afterwards, along with the two folders Claude Code makes for it even without session files: `~/.claude/projects/-tmp-tl-eval-*` (auto-memory) and `/tmp/claude-<uid>/-tmp-tl-eval-*` (task output).

## Scenario format

`scenarios*.json` define each conversation:

- `messages[]`:
  - `send`: when the message goes out:
    - `start`;
    - `idle`: the last event was a `result` and the stream has been quiet for 1.5 s;
    - `afterTool`: Claude's next main-thread tool call after the previous message, or idle;
    - `after`: `delayMs` after the previous message.

    Messages go to stdin as the app writes them, and Claude Code folds a message sent mid-turn into the running turn.
  - `quote`: `{ who: 'claude'|'me', of: <message id> }`, a reply to an earlier bubble.
    - For `claude`, A quotes the reply part (bubble) that answered `of`, as `replyTo()` does: the part text and its topic ids. B quotes the paragraphs of its answer to `of` that contain `of`'s facts, or else the whole answer.
    - For `me`, both arms quote the user's own message. The quote is clipped to 600 chars, as `flatBrief()` clips it.
  - `expect[]`: `{ name, re, about? }`. `re` is a fact the reply must contain (a JS regex, case-insensitive). `about` is a regex of words naming the fact's subject; it falls back to the message's `about`.
- `checks[]`: the project after the run. Each check is a `file` + `re` (multiline; `absent` inverts it), a `cmd`, or `py` code run with `python3 -c` in the project. `msg` ties a check to the message it judges, for example "the late correction was applied to the right item" or "the quoted port, not the tax rate, was changed".

## Metrics

**Per run** (`totals` and `metrics` in `results.json`):

- **cost**: the last `total_cost_usd` of the process, which is cumulative in stream-json mode. `usage`, `num_turns` and `duration_ms` on each `result` are per turn.
- **API calls, input tokens (fresh, cache read, cache write), output tokens**: from `stream_event` `message_start` and `message_delta`, per model request, summed. `resultUsage` holds the same sums taken from the `result` events.
- **cache ratio** = cache_read / all input.
- **context per call** = input + cache_read + cache_creation; `lastContext` is the final main-thread call. **contextWindow** comes from `modelUsage`.
- **turn time** = the summed `duration_ms`. **wall time** includes the harness's waits.

**Per message** (`score.messages`):

- **addressedFinal**: every expected fact is in a final answer after the message. **addressedAny**: the facts are anywhere in Claude's text, narration included.
- **attributed**: the arm-neutral attribution rubric. Marks, tags and topic ids are removed first. Each fact must be in a final answer, and either:
  - that turn answered only this message, or
  - the fact sits in a paragraph or bullet that also names the fact's subject (`about`).

  This catches a fact that only appears in a reply about something else, or a batch answer that never says which question a number belongs to.
- **checksOk**: the message's own project checks passed. This is where references are really tested: "change that port" must change `server.toml`, "that fee" must change `SHIPPING_FEE`, "Halve that" quoting the nails bubble must change the nails row and nothing else.
- **midTurn**: the message was sent while a turn was running.
- **Arm A only:**
  - **attribution**, from the reply parts as `splitAnswer()`/`assignParts()` build them:
    - `own`: a part only for this message;
    - `grouped`: a marked `<<reply T1,T2>>` part;
    - `shared`: only unmarked text, which replies to every message since the last answer;
    - `other`: only in another message's part;
    - `missing`.
  - **named**: a mark names this message.
  - **inTag**: a tag lists it. Per run there is also `tags` (answers carrying a tag), `badMarks` (marks naming unknown ids) and `badTagIds` (tag entries with made-up ids such as `T1-discount`).
  - **reacted**: the turn answering this message was only a tag reaction (`"react":"✅"`) with no text, which APP_GUIDE allows for small finished requests. `addressedFinal` stays false, because the facts were never stated. The summary also reports "answered or reacted".
- **Blind judge** (`--judge`): one `claude -p` call per run with no tools and its own system prompt.
  - **What it sees:** both arms rendered the same way. User messages appear as B sends them (quotes as `> ` lines). Every main-thread assistant text block appears in order, with `<<reply>>` marks, `<threadline>` tags and topic ids removed. A reaction-only reply appears as "assistant reacted to the user's last message with ✅ (no text)", which is what the user sees.
  - **Re-judging:** `transcriptSha` records what it judged. `--rescore --judge` re-judges only runs whose transcript has changed since. Pass the real `--budget`: rescore checks it against the stored spend.
  - **No blocking:** the judge runs asynchronously, so it doesn't stall the timers of concurrent runs. An earlier synchronous version delayed 5 of 60 timed sends by 4-7.5 s.
  - **What it scores, per message:** `answered` (0-2), `correct` (including whether a reference resolved to the right message), `clear` (0-2), `misattributed`; per run, `corrections_followed`. It gets the expected facts.

**Summary** (`summary.md`), per set:

- Mean ± sd per run for each arm.
- A − B as the mean over scenarios of (mean A − mean B), with a two-sided stratified permutation p-value: arm labels shuffled within each scenario, 5,000 shuffles.
- A per-scenario table and A's overhead. `failures` in `results.json` lists every message that missed a fact, an attribution, a check or the judge, with the reply text.

## Visibility: can you see what was answered?

`visibility.ts` re-scores saved runs for a different question: for each message, can you see whether it was answered, by which reply, and what is still open? It runs no sessions. The method and results are in RESULTS.md, under "Can you see what was answered?".

```sh
node --no-warnings eval/visibility.ts --dry                                  # replay and the rules only; no model calls
node --no-warnings eval/visibility.ts --truth-judge --glance --full --budget 3
node --no-warnings eval/visibility.ts --run interleaved-A-r1 --screens --dry  # one run: transcript, marks, screens
node --no-warnings eval/visibility.ts --in eval/results/burst --out eval/results/burst/visibility --truth-judge --glance --full --budget 1.55
```

- **Arm A** replays the recorded stream through the app's own code (`app/claude.ts`, `app/inbox.ts`, `hooks/model.ts`, and `submit`/`onEvent`/`finishTurn` ported from `app/main.ts`). `panelLines()` and `chatLines()` then draw one 120 × 40 screen. **Arm B** draws the same stream as Claude Code's terminal.
- **The deterministic half** (replay, screens, rules, scores) is in `visibility-core.ts`, and `tests/unit/visibility.test.ts` tests it. The model calls, the cache and the summary are in `visibility.ts`.
- **Model calls** (`claude -p`, as the judge above makes them):
  - `--truth-judge`: one Sonnet call per run, for the ground truth;
  - `--glance`: one Haiku call per moment and arm;
  - `--full`: one Haiku call per run, reading the whole chat at the end.

  They run 2 at a time.
- **Budget, ledger and cache.** Every call is logged in `results/visibility/raw/ledger.jsonl`. A call that could pass `--budget` (spent so far plus 1.5 × the dearest call of its kind) is not made. Answers are cached by prompt in `results/visibility/raw/cache/`, so re-scoring costs nothing.
- **Re-reading only what changed.**
  - `--truth-from <results.json>` takes the ground truth from an earlier run (no truth calls).
  - `--readers-from <results.json>` takes readers whose screens didn't change (by default `B glance,B full read`, set with `--readers`) from an earlier run: its `misses` list every pair they got wrong, so every other pair was right. It reproduces the saved scores exactly.
  - `--arms A` makes model calls for arm A only; `--only <file>` glances only the frames listed (lines `<scenario>-<arm>-r<rep> <label>`), such as the ones a change redrew.
- **Inputs and outputs.** `--in` (default `results/hard`) and `--raw` say where the saved runs are; `--out` (default `results/visibility`) is where `results.json` and `summary.md` go. These hold ids, states and scores only, with no transcript text.

## Caveats

- **The interactive CLI isn't scripted.** B is the same headless `claude -p` stream-json process, standing in for normal Claude Code. The TUI may queue mid-turn messages a little differently.
- **A clean configuration, the same for both arms.** For safety and reproducibility, the runs use:
  - `--setting-sources project,local` in an empty temp dir: no user settings, plugins, hooks or `bypassPermissions`;
  - `--strict-mcp-config` with no servers;
  - `WebFetch` and `WebSearch` disallowed;
  - `CLAUDE*` environment variables dropped, with `CLAUDE_CODE_ENTRYPOINT=sdk-ts` set;
  - `--no-session-persistence`.

  Your real sessions carry a larger system prompt in both arms.
- **Permissions.**
  - **What it takes.** With only `--permission-prompts host`, Claude Code 2.1.331 refused Edit (`permission_denied`) without asking the host. The harness adds `--permission-prompt-tool stdio` and sends an SDK-style `initialize`.
  - **Policy, the same for both arms:** allow file tools inside the project, and Bash unless the command looks like network use. This is a regex, not a sandbox.
- **What A gets that the eval leaves out:** reactions the app has heard, the request and agent views, follow-up turns after background agents, the "write that reply again" retry, and the app's reaction to a tag's `"about"` links. The board logic used here is the frozen `model.ts`.
- **What the rubric can tell.**
  - **Regex hits.** A regex hit means a fact is mentioned, not that the answer is right; checks and the judge cover correctness.
  - **The attribution rubric** is a proxy: a paragraph naming the subject is taken as "the reader can tell". Messages sent while idle are trivially attributed, since their turn answers only them.
  - **The judge** is blind to marks and tags but not to style; A's replies tend to be terser and say "Done:". It is the same model family as the subject.
- **Shuffled order, concurrency 3.** Runs share the machine and the API with each other. Arm order is shuffled per repeat, so this shouldn't bias one arm.
- **Old pilot results.** The 2026-11-25 pilot (`results/pilot`) ran before `freeze.sh` existed, with an older APP_GUIDE (2,870 chars, against 3,423 after your 03:2x REPLY_GUIDE edits). Its numbers aren't comparable with later runs. `--rescore` works on it.
