# How clued works

Back to the [README](../README.md) · [Using clued](usage.md)

clued starts `claude -p --input-format stream-json --output-format stream-json` and talks to it over stdin and stdout. It makes no API calls of its own: the model, tools, permissions, billing and the session itself are all Claude Code's. clued draws the screen and keeps track of the conversation.

## What clued adds to the conversation

- **The guide:** a short instruction, appended to Claude Code's system prompt with `--append-system-prompt`, asks Claude to end each reply with one hidden tag line. The tag says which of your messages the reply is about and what their status is now: on Claude, on you, or done. The guide also covers reply parts, reactions, keeping long waits in the background and how to show an image or a diagram. Today it is about 4,800 characters.
- **The note:** each message you send carries a short hidden note with its id (`T12`), the messages still open, and the questions it asks when there are several. A message that goes into Claude's running turn says so, and asks for its own reply part; a reply to an old message brings its request's chain (below).
- **Splitting:** when a reply answers several messages, Claude marks each part with `<<reply T12>>` lines. The app hides these and draws one bubble per part.

These cost tokens. In the [evaluation](../eval/RESULTS.md#as-overhead), the guide (3,423 characters then) and the first note added about 1,100 tokens to the first call, each note about 34 tokens, and each tag about 48 output tokens: about 9% more per session. The guide has grown since, and its cost hasn't been measured again.

## Asking again for missing replies

Claude's tag can settle a message whose reply part never came: in one test, Sonnet drafted answers in its thinking and never wrote them out. When the turn ends, clued asks Claude at once, in one message, for each reply that never arrived. One still missing after that is marked `⚠ reply lost`, with `↻ ask again`. In the evaluation's burst of 8 messages, this took clued from about half of the messages answered fully to 98%, at the cost of an extra turn ([Closing the gap](../eval/RESULTS.md#closing-the-gap-2026-11-25-later)).

## Chains after a compaction

When you reply to a message from before a compaction, or more than 30 messages back, the note carries its request's chain: the first message (clipped to 500 characters), then the last few messages and replies, trimmed to about 2,000 characters in all. In a small test (18 runs; [details](../eval/RESULTS.md#a-reply-to-a-message-from-before-a-compaction-2026-11-25)), when the compaction summary had dropped the detail asked about, the chain brought it back 2 times of 2, and plain Claude Code got it 0 times of 3.

## History

The chat comes from Claude Code's own session file (under `~/.claude/projects/`), so `--resume` and `-c` work the same way they do in `claude`. Replies Claude wrote mid-turn are also kept by clued, since the session file can miss them.

## What clued keeps in `~/.clued/`

- `sessions/<session id>.json`, one per session: which reply answers which message, reactions, read marks, saved messages (with their words), replies Claude wrote mid-turn, messages still in queue when the app closed, the folders `/add-dir` added, and which images each message was sent with.
- `panel.json`: the panel's width and whether it's folded, and the `/notify`, `/hold` and `/queue` settings.
- `sent.log`: every message you send, with its hidden note and the time, one line each, plus edits, deletions and answers to Claude's questions. It's there to debug timing problems; the app never reads it back. When the app starts, and every hour after, it drops the entries older than 7 days and keeps the file to its newest 5 MB.
- `images/`: images you pasted from the clipboard, saved as PNG files. One a message was sent with stays as long as that session's file names it, so a click on its `[image N]` still opens it. One that no session's file names (pasted and never sent, or its message deleted while held) is deleted once it is 30 days old. An image you attach by its path stays where it is, and clued never deletes it.
- `cache/`: Mermaid diagrams drawn by `mmdc` (`cache/mermaid/`) and images turned into PNG to draw them (`cache/images/`), each named by what it was made from. Safe to delete at any time.
- `reload`: the session id, for a moment during `/reload`.

Apart from that trimming (and `reload`, gone once the app is back), clued never deletes any of these itself. To change the limits, set these before you start clued (0 turns a limit off):

- `CLUED_LOG_DAYS`: how many days of `sent.log` to keep (7).
- `CLUED_LOG_MB`: the most `sent.log` may hold, in MB (5).
- `CLUED_IMAGE_DAYS`: how old an unsent pasted image gets before it is deleted (30).

To remove everything clued keeps, delete `~/.clued`; your sessions stay in Claude Code.

## Processes

- `bin/clued` is a bash loop around `node app/main.ts`. `/reload` exits with code 75, and the loop starts the app again on the same session.
- `/btw` runs a second Claude Code, forked from the session with `--fork-session` and `--no-session-persistence`, so the side question never enters the session itself.
- `/plugin` runs Claude Code's own `claude plugin` CLI, then the session reloads its plugins.
- Notifications (`app/notify.ts`) use the terminal's own notification sequence where it has one, a Windows toast from WSL, `osascript` on macOS or `notify-send` and a sound on Linux. In Windows Terminal a click runs a per-user `clued-focus:` handler that selects the tab through UI Automation (see [usage](usage.md#notifications)).

## The classic layout

The older layout, Claude Code's own screen in tmux with a threads panel beside it, is still in the repo as `bin/clued-classic`: see [classic.md](classic.md).
