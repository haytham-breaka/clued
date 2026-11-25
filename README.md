# clued

**Never lose track of what you asked Claude.** clued is a chat app for the terminal that runs on top of a real Claude Code session. Every message you send is tracked until it's answered, every reply says which of your messages it answers, and a side panel shows what Claude is working on and what is waiting on you. Send five things while Claude is busy, and you can still see, for each one, whether it was answered and where.

[![Tests](https://github.com/haytham-breaka/clued/actions/workflows/test.yml/badge.svg)](https://github.com/haytham-breaka/clued/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node ≥ 22.18](https://img.shields.io/badge/node-%E2%89%A5%2022.18-brightgreen.svg)](#install)
[![Version 0.1.0](https://img.shields.io/badge/version-0.1.0-informational.svg)](.claude-plugin/plugin.json)
[![Runs on Claude Code](https://img.shields.io/badge/runs%20on-Claude%20Code-d97757.svg)](https://claude.com/claude-code)

<p align="center"><img src="docs/demo.gif" width="600" alt="clued in a real session: a message sent while Claude works waits in queue, then gets its own answer; Claude asks with a card you click; the Overview lists unread replies and jumps to them; a request's chain; ☆ save a reply and come back to it from ★ Saved; a background agent's live steps"></p>

**[▶ Watch with sound](docs/demo.mp4)** (82 s, narrated)

clued makes no API calls of its own. Claude Code runs underneath, headless, with your own login: its tools, permissions, plugins, MCP servers, hooks, slash commands, status line and sessions are all still Claude Code's. clued draws the screen and keeps track of the conversation.

## Contents

- [Why clued](#why-clued)
- [Install](#install)
- [Usage](#usage)
- [Features](#features)
- [How it works](#how-it-works)
- [Does it help? The evaluation](#does-it-help-the-evaluation)
- [Contributing](#contributing)
- [Licence](#licence)

## Why clued

- **Nothing you ask gets lost.** In a plain terminal session, a question you typed while Claude was busy can be answered in the middle of a tool run, or not at all. clued gives every message a mark: ⏳ Claude is on it, ✋ waiting on you, ✓ done. A message whose reply never arrived says so, with a button to ask again.
- **Every reply says what it answers.** A reply quotes the message, or each of the several messages, it answers. Click a quote to jump to it. From any message you can open its whole chain: the follow-ups, the corrections and every reply that touched it.
- **You can type while Claude works.** A message you send while Claude is busy waits in clued (`⏳ in queue`) and goes as a turn of its own when Claude's turn ends, one per turn, so each gets its own answer. A reply to the work in progress (a part of the running turn, its request, or a running agent's view) goes at once, so you can still steer. `/queue off` sends everything at once instead, into the running turn the way Claude Code does it. Under each message, `✓ sent` means Claude Code has it, and `✓✓` means Claude has actually taken it in (a message sent into the running turn says `⏸ queued: Claude reads it at its next step` until then).
- **A few seconds to take a message back.** For 3 seconds after Enter a message hasn't gone yet: `◌ sending in 3s · ✎ edit · ✕ delete` under it, and Ctrl+Z puts the last one back in the box. `/hold <seconds>` changes the time, `/hold 0` sends at once. A message that is `✓ sent` but not `✓✓` can still be deleted: Claude Code drops it from its queue when it can, and otherwise Claude is told to ignore it.
- **It's still Claude Code.** No second client, no API key, no separate bill. Your `CLAUDE.md`, settings, permissions and plugins apply as they always do, and every session can also be opened in `claude` itself.
- **The overhead is measured.** About 9% more cost per session, for the instructions and the small tag on each reply. The numbers are [below](#does-it-help-the-evaluation).

## Install

Requires:
- [Claude Code](https://claude.com/claude-code), installed and logged in. `claude` must be on your PATH.
- **Node 22.18 or later.** clued runs its TypeScript directly, with no build step and no dependencies.
  The `package.json` lists only the tools for its tests (c8 and TypeScript, as dev dependencies); running clued needs none of them.
- macOS, Linux or Windows through WSL. The launcher is a bash script. It's tested in iTerm2 and in Windows Terminal with WSL.

```bash
git clone https://github.com/haytham-breaka/clued.git ~/src/clued
ln -s ~/src/clued/bin/clued ~/.local/bin/clued   # or any folder on your PATH
```

There is nothing to `npm install`. To update, run `git pull`.

## Usage

```bash
cd ~/code/my-project
clued                  # new session in this folder
clued -c               # continue this folder's last session
clued --resume         # pick a session
clued --model opus     # any other flag goes to claude
```

Like `claude`, it works on the folder you start it in, and sessions are Claude Code's own, kept per folder. `/reload` restarts the app on the same session, for example after a `git pull`.

### The screen

Your messages are on the right and Claude's replies on the left, with Markdown drawn properly. A reply streams into its bubble as Claude writes it, and each part shows which message it answers from its first words. Claude's work between replies folds into one line (`⚙ 8 steps · edited 3 files · ran 4 commands ▸ show`); click it, or press Ctrl+O, to see each step.

The panel on the left has these sections:
- **Unread / Read:** replies you haven't seen yet, and the ones you have. A reply counts as read after 3 seconds on screen with the window focused.
- **★ Saved:** the messages you saved to get back to later, newest first (shown once there is one). Click one to go to it; ✕ unsaves it.
- **Waiting on you:** Claude's open questions to you. The ✕ on the left, or `✕ dismiss` under the question, drops one you don't want to answer: its message counts as done, and your next message tells Claude not to wait for an answer.
- **Agents:** Claude first, then each agent it started, by name and role (`James (implementer)`, `Jake (explorer)`), running or just finished, with the message it is working on. Claude's own row says how many of your messages its turn is on, and `waiting on you` in yellow while its question or a permission waits for you. Click one to open its live view. Claude is told the names too, so you can write "ask Jake to check the tests". When Claude sends an agent more work, each message is a new task: the agent's row says how many tasks it has and which one it is on, and its view lists them, with the agent's own to-do list below. On the right of a running agent: `last step 12s ago`, or `running Bash 6m` while a tool runs (a long test run is not stuck), or, after 5 minutes with no new step and nothing running, `quiet 6m` in yellow: its view says it may be stuck, with ▶ continue to have Claude check on it. A background agent that a `/reload` or Claude Code's exit cut off shows ■ stopped, with ▶ continue to have Claude resume it.
- **Not started:** right under Agents, the requests Claude said it still owes work on that nothing is working on right now, one row per request, with how long each has waited. Click one to open it. ▶ start asks Claude to start on it now; while Claude is busy, `+ queue` sends the request to wait its turn instead.
- **Scheduled:** the jobs Claude set to run later, with CronCreate or a `/loop` wakeup, shown while there is one. Each shows ⏰ for recurring or ⏲ for once, what it's for, when it runs next ("every 5 min · next 14:35", "in 3 min"), and whether it's scheduled, has run, or was deleted. Click one to see its whole prompt, its schedule, who set it up and which of your messages it's for, and each run. `✕ cancel` there asks Claude to delete it. Jobs that only live in memory end when Claude Code exits, so `/reload` ends them.
- **Your recent messages:** each with its mark. First the ones in progress, with who is on each (`Claude`, or `Maya · task 2`), then `in queue` (sent while Claude works, waiting for its turn), then `waiting` (Claude still owes work and nothing is on it), then the rest, newest first. Under an answered message, a dim `→` row gives the gist of its answer, room allowing. Press `?` for what the marks mean and `⌕` to search.

Drag the divider to resize the panel, and click `≡` to fold it to icons. Your own status line command runs at the bottom, fed what Claude Code would feed it (the folder is the one Claude is working in now), with the permission mode under it, as in Claude Code.

### Keys

| Key | Does |
|---|---|
| Enter / Alt+Enter | send / new line |
| Esc | cancel a reply, dismiss Claude's question, or interrupt Claude |
| Ctrl+C | clear the input or interrupt; twice to quit |
| Alt+↑ / Alt+↓ | go through your recent messages; the chat scrolls to each |
| Alt+→ / Alt+← | from a message to its reply, and back |
| Alt+S | save the message Alt+↑/↓ picked to get back to later, or unsave it |
| Ctrl+F | search your messages |
| Ctrl+Z | take back the message you just sent, while it waits to go (back in the box) |
| Ctrl+N | next unread reply |
| Ctrl+O | show or hide Claude's steps |
| Shift+Tab | next permission mode (default, accept edits, plan, and bypass or auto when you started in it), shown under the status line |
| ↑ / ↓ | move between rows of a long message; from the top row, earlier messages |
| Ctrl+← / Ctrl+→ | jump words |
| Ctrl+Backspace / Alt+Backspace (⌥⌫) | delete the word before the cursor (Ctrl+W: up to the last space) |
| Ctrl+Delete / Alt+D | delete the word after the cursor |
| Ctrl+V or Alt+V | add the image on the clipboard |
| PgUp / PgDn | scroll |

**Selecting text:** drag over the chat or the input box to select text; it's copied when you let go. A double-click selects a word, a path or a URL. With text selected, Ctrl+C copies it again and Esc drops it. In the input box, typing or Backspace replaces the selection. To select across the panel too, hold ⌥ (Option) in iTerm2 or Shift in Windows Terminal: the terminal then selects instead of the app.

### Commands

`/help` every command, clued's and Claude Code's · `/status` version, session, account, model, permission mode and MCP servers · `/plan [description]` plan mode, then your message · `/diff` the uncommitted changes, drawn like Claude's edits · `/copy [N]` Claude's last reply, or the Nth back · `/export [file]` the chat as Markdown, to a file or the clipboard · `/branch [name]` a new session with the conversation so far, to try another way (`/resume` shows both and goes back) · `/add-dir <path>` let Claude work in another folder too, kept for this session · `/clear` new session · `/btw <question>` a quick side question: it sees the conversation but stays out of it, answered aside even while Claude works · `/resume` pick one · `/model <name>` switch model · `/notify on|always|off|test` notifications · `/hold <seconds>` time to take a message back · `/queue on|off` hold messages while Claude works · `/results` hide Claude's steps and keep its results · `/work folded|edits|all` how much of Claude's work to show · `/panel` fold the panel · `/reload` restart on this session · `/exit`. Every other slash command goes to Claude Code as usual. Headless Claude Code refuses its own /help, /status, /plan, /diff, /copy, /export, /branch and /add-dir ("isn't available in this environment"), so clued runs those itself: what they show is a card in the chat, closed with ✕ or Esc.

## Features

### Replies that say what they answer

When one reply answers several messages, it splits into one bubble per message, each quoting what it answers. When a message asks several things, each question can be answered on its own: the quote reads `↩ 2 questions`. If you send a follow-up without clicking reply, it's linked to the earlier message automatically, shown as `↩ about: …`.

### Reply to anything, react to anything

Hover over a message for `↩ reply`, `copy` and 👍 👎 ❓ 👀. A reply quotes the message to Claude. A 👍 on a question is a go-ahead, so Claude proceeds. 👎 asks Claude what to change, and ❓ asks it to explain again, more simply. Other reactions start no turn.

`☆ save` under any message, yours or one part of Claude's reply, keeps it in the panel's **★ Saved** list to get back to later; the bubble then shows `★ saved`, and a click on it again unsaves it. The list is kept with the session, so it's still there after `--resume` or `/resume`.

Claude reacts too, only where it means something: 👀 seen (for a message sent while it was busy), 👍 noted, ✅ done with nothing to add, 🎉 good news.

### Chains

The `⛓ chain` link under a message (as soon as it has a reply), or a click on its mark in the panel, opens everything connected to it: the replies, your follow-ups, the corrections, and the replies to those. Chains come from the session file and what clued keeps in `~/.clued/`, not from Claude's context, so they stay whole when Claude Code compacts the conversation. When you reply to a message from before a compaction, or more than 30 messages back, its request's chain goes to Claude with it: the first message and the last few messages and replies, trimmed to about 2,000 characters, so Claude has the context it no longer holds word for word.

### Live views of Claude and its agents

Click Claude or any agent under **Agents** for its own view: each step as it happens, with commands, output and diffs. That includes agents running in the background, whose steps Claude Code does not stream: the app reads them from the transcript Claude Code keeps for each agent. Press Esc to go back to the chat.

### Messages that never got an answer

Sometimes a reply never arrives: Claude's tag settles a message, but no reply part for it came. When the turn ends, the app asks Claude at once, in one message, to write each missing reply again; the chat shows `↻ asked Claude again for 2 replies that never arrived`. A message whose reply is still missing after that is marked `⚠ reply lost` instead of looking answered, and `↻ ask again` sends it again.

### Images

Ctrl+V adds the image on the clipboard. This works with the Windows clipboard from WSL, with macOS, and with Wayland or X11. Pasting or dropping an image file's path attaches that image.

### Permissions

When Claude Code needs permission for a tool, clued asks you in the app, the way `claude` would: with Claude's description of the command and the whole command, wrapped (a very long one has `⧉ copy all`). Your allow and deny rules apply as usual.

### Questions with options

When Claude asks you something with options (its AskUserQuestion tool), the question shows as a `❓ Claude asks` card above the input box: each question with its header and numbered options, with their descriptions. Click an option or press its number, then Enter. When several options are allowed, each click or number ticks one on or off. To answer in your own words, type in the input box and press Enter. When Claude asks several questions at once, they come one after another on the same card. Esc, or the card's ✕, dismisses the question, and Claude is told you didn't answer it.

### Notifications

When Claude asks you something, or needs a permission, you get a notification with the question and the project folder, while the clued window is in the background. `/notify always` notifies even when it's in front, `/notify off` stops them, `/notify test` sends a sample.

- **iTerm2, WezTerm, Ghostty and kitty** post the notification themselves, so a click on it opens the very tab that asked.
- **Windows Terminal (and WSL)** gets a Windows toast. Windows has no way to open a given tab from a notification, so the tab marks itself instead: its title starts with `✋ 1 ·` and the tab and taskbar button turn yellow until you answer.
- **Elsewhere** it's Notification Center on macOS and `notify-send` on Linux, and the tab title starts with ✋ while Claude waits.

## How it works

clued starts `claude -p --input-format stream-json --output-format stream-json` and talks to it over stdin and stdout:

- **The guide:** a short instruction, appended to Claude Code's system prompt, asks Claude to end each reply with one hidden tag line. The tag says which of your messages the reply is about and what their status is now: on Claude, on you, or done.
- **The note:** each message you send carries a short hidden note with its id (`T12`), the messages still open, and the questions it asks when there are several. A message that goes into Claude's running turn says so, and asks for its own reply part; a reply to an old message brings its request's chain.
- **Splitting:** when a reply answers several messages, Claude marks each part with `<<reply T12>>` lines. The app hides these and draws one bubble per part.
- **History:** comes from Claude Code's own session file, so `--resume` and `-c` work the same way they do in `claude`.
- **What clued keeps:** read marks, links, panel width, a send log and pasted images, in `~/.clued/`.

Everything else, the model, tools, permissions, billing and the session itself, is Claude Code's.

The older layout, Claude Code's own screen in tmux with a threads panel beside it, is still in the repo as `bin/clued-classic`: see [docs/classic.md](docs/classic.md).

## Does it help? The evaluation

clued and plain Claude Code were given the same 13 scripted conversations, with Sonnet and 5 runs each, 130 runs in all. The conversations included many messages sent mid-task, corrections, numbered questions, and references like "the second thing I asked". A blind judge scored every reply.

| per session | clued | plain Claude Code |
|---|---|---|
| Cost | $0.080 | $0.073 (clued +9%) |
| Messages sent mid-task that were answered | 56 of 56 | 56 of 58 |
| Project checks passed | 100% | 99% |
| Judge: correct, and answers given to the wrong message | 100%, none | 100%, none |
| From one screen, messages you can tell are answered or not | 99.8% | 86% |
| From one screen, answers you can find | 91% | 83% |
| [After 8 messages sent before the first reply](eval/RESULTS.md#closing-the-gap-2026-11-25-later) (5 runs), answered or not / answers found on one screen | 99% / 98% | 86% / 98% |

- **What clued adds:** you can see, for each message, whether it was answered and where.
- **What it doesn't add:** Claude's answers aren't better.
- **What it costs:** about 1,100 tokens of instructions per session, plus a short tag on each reply.

A follow-up on the same runs found that one glance at clued shows whether each message was answered, even after older ones scroll off, but at first found neither the answer itself nor what is still open any better ([details](eval/RESULTS.md#can-you-see-what-was-answered-2026-11-25)). After the fixes in [Closing the gap](eval/RESULTS.md#closing-the-gap-2026-11-25-later), clued is clearly ahead on answered or not in both sets. It is ahead on finding the answer from one screen on the hard set (91% against 83%; significant at the end, p = 0.02, not over all moments, p = 0.17) and tied on the burst set. Two measures still go against it:
- Reading the whole chat, the answer is found less often: 94% against 98%.
- clued shows more finished messages as waiting on you.

The full method and results are in [eval/RESULTS.md](eval/RESULTS.md), and the runner is in [eval/](eval/). In the eval files, clued appears under its earlier name, threadline.

## Contributing

clued takes contributions through **issues only**: bug reports, ideas and questions are all welcome. Pull requests from outside the project aren't accepted. [CONTRIBUTING.md](CONTRIBUTING.md) explains why, what makes a useful bug report, and how to run it from a clone.

## Licence

MIT. See [LICENSE](LICENSE). clued has no dependencies beyond Node and Claude Code.
