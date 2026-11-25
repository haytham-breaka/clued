# clued

**Never lose track of what you asked Claude.** clued is a chat app for the terminal that runs on top of a real Claude Code session. Every message you send is tracked until it's answered, every reply says which of your messages it answers, and a side panel shows what Claude is working on and what is waiting on you. Send five things while Claude is busy, and you can still see, for each one, whether it was answered and where.

[![Tests](https://github.com/haytham-breaka/clued/actions/workflows/test.yml/badge.svg)](https://github.com/haytham-breaka/clued/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node ≥ 22.18](https://img.shields.io/badge/node-%E2%89%A5%2022.18-brightgreen.svg)](#install)
[![Version 0.1.0](https://img.shields.io/badge/version-0.1.0-informational.svg)](.claude-plugin/plugin.json)
[![Runs on Claude Code](https://img.shields.io/badge/runs%20on-Claude%20Code-d97757.svg)](https://claude.com/claude-code)

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
- **You can type while Claude works.** Messages sent mid-task are delivered to the running turn, the way Claude Code does it, and each one is still tracked on its own.
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
- **Waiting on you:** Claude's open questions to you. The ✕ on the left, or `✕ dismiss` under the question, drops one you don't want to answer: its message counts as done, and your next message tells Claude not to wait for an answer.
- **Agents:** Claude first, then each agent it started, by name and role (`James (implementer)`, `Jake (explorer)`), running or just finished, with the message it is working on. Click one to open its live view. Claude is told the names too, so you can write "ask Jake to check the tests".
- **Scheduled:** the jobs Claude set to run later, with CronCreate or a `/loop` wakeup, shown while there is one. Each shows ⏰ for recurring or ⏲ for once, what it's for, when it runs next ("every 5 min · next 14:35", "in 3 min"), and whether it's scheduled, has run, or was deleted. Click one to see its whole prompt, its schedule, who set it up and which of your messages it's for, and each run. `✕ cancel` there asks Claude to delete it. Jobs that only live in memory end when Claude Code exits, so `/reload` ends them.
- **Your recent messages:** each with its mark, latest activity first. Press `?` for what the marks mean and `⌕` to search.

Drag the divider to resize the panel, and click `☰` to fold it to icons. Your own status line command runs at the bottom, fed what Claude Code would feed it (the folder is the one Claude is working in now), with the permission mode under it, as in Claude Code.

### Keys

| Key | Does |
|---|---|
| Enter / Alt+Enter | send / new line |
| Esc | cancel a reply, dismiss Claude's question, or interrupt Claude |
| Ctrl+C | clear the input or interrupt; twice to quit |
| Alt+↑ / Alt+↓ | go through your recent messages; the chat scrolls to each |
| Alt+→ / Alt+← | from a message to its reply, and back |
| Ctrl+F | search your messages |
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

`/clear` new session · `/resume` pick one · `/model <name>` switch model · `/notify on|always|off|test` notifications · `/results` hide Claude's steps and keep its results · `/work folded|edits|all` how much of Claude's work to show · `/panel` fold the panel · `/reload` restart on this session · `/exit`. Every other slash command goes to Claude Code as usual.

## Features

### Replies that say what they answer

When one reply answers several messages, it splits into one bubble per message, each quoting what it answers. When a message asks several things, each question can be answered on its own: the quote reads `↩ 2 questions`. If you send a follow-up without clicking reply, it's linked to the earlier message automatically, shown as `↩ about: …`.

### Reply to anything, react to anything

Hover over a message for `↩ reply`, `copy` and 👍 👎 ❓ 👀. A reply quotes the message to Claude. A 👍 on a question is a go-ahead, so Claude proceeds. 👎 asks Claude what to change, and ❓ asks it to explain again, more simply. Other reactions start no turn.

Claude reacts too, only where it means something: 👀 seen (for a message sent while it was busy), 👍 noted, ✅ done with nothing to add, 🎉 good news.

### Chains

The `⛓` button on a message opens everything connected to it: the replies, your follow-ups, the corrections, and the replies to those.

### Live views of Claude and its agents

Click Claude or any agent under **Agents** for its own view: each step as it happens, with commands, output and diffs. Press Esc to go back to the chat.

### Messages that never got an answer

Sometimes a reply never arrives, for example when it was written between tool calls and Claude Code didn't keep it. Such a message is marked `⚠ reply lost` instead of looking answered, and `↻ ask again` sends it again.

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
- **The note:** each message you send carries a one-line hidden note with its id (`T12`), the messages still open, and the questions it asks when there are several.
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

- **What clued adds:** you can see, for each message, whether it was answered and where.
- **What it doesn't add:** Claude's answers aren't better.
- **What it costs:** about 1,100 tokens of instructions per session, plus a short tag on each reply.

The full method and results are in [eval/RESULTS.md](eval/RESULTS.md), and the runner is in [eval/](eval/). In the eval files, clued appears under its earlier name, threadline.

## Contributing

clued takes contributions through **issues only**: bug reports, ideas and questions are all welcome. Pull requests from outside the project aren't accepted. [CONTRIBUTING.md](CONTRIBUTING.md) explains why, what makes a useful bug report, and how to run it from a clone.

## Licence

MIT. See [LICENSE](LICENSE). clued has no dependencies beyond Node and Claude Code.
