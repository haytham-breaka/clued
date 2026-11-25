# clued

A different interface on top of a real Claude Code session. It is a Claude Code mod, not a separate client: it makes no API calls of its own. Claude Code still runs the harness, slash commands, the status line, `--resume`/`-c`, permissions and colours. clued adds:

- **Topics and threads.** Each message you send becomes a topic, marked ⏳ waiting on Claude, ✋ waiting on you, or ✓ done. Claude ends each reply with a small tag that names topics and sets their status, and the mod hides the tag from view. A thread holds 3 topics; a 4th forks a child thread, drawn under its parent.
- **Main** shows every message. A message you send to Main is sorted by Claude into a thread active in the last 3 days, or into a new one. Threads are kept per project across sessions for 30 days.
- **Side panel** shows the thread tree with ⏳/✋/✓ counts, topics in progress and notifications. Press a thread to view only it.
- `/thread 2` shows only thread 2 and sends new messages there. `/thread main` shows everything again.
- **Click to reply:** hover over any message and click `↩ reply`; your next message replies to it, in its thread, with that message quoted to Claude. Claude's messages also get 👍 👎 ❓ 👀 on hover (a second click takes a reaction back). A band above the prompt shows what you're replying to, with `✕ cancel`. Clicks and hover need Claude Code's fullscreen layout and mouse reporting in iTerm2.
- `/reply 2 text` replies in thread 2 from the keyboard. `/reply 2` makes your next message the reply. Claude also gets the thread's name, its topics and its last message.
- `/results` hides Claude's actions (tool calls and the narration between them) and keeps the results. Run it again to show them.
- **Reply markers:** "↳ you replied in #2 …" above your replies, and "↳ Claude in #2 …" plus topic statuses above Claude's answers.
- **Your reactions talk to Claude only when they mean something.**
  - 👍 on a message that asked you something is a go-ahead, and Claude proceeds.
  - 👎 makes Claude ask what to change; ❓ makes it explain again, more simply.
  - Anything else (👍 on finished work, 🎉, 👀) starts no turn. Claude reads it with your next message and mentions it only if it matters.
  - Use `/react 👍 [n]` from the keyboard, or the hover bar.
- **Claude's reactions are rare**, with one meaning each: 👀 seen (a message you sent while it was busy), 👍 noted, ✅ done with nothing to add, 🎉 good news. It never reacts to a question or request, and the tool refuses other emoji, a second reaction on one message, or more than one reaction in your last 4 messages (👀 on a message sent mid-turn is exempt).

## The app (`clued`)

`clued` is a chat app of its own, drawn entirely by clued, on top of a real Claude Code session that runs headless underneath (`claude -p --input-format stream-json --output-format stream-json`). Claude Code still runs the harness: tools, permissions, plugins, MCP, hooks, the session file and `--resume`. The app makes no API calls of its own.

- Your messages in bubbles on the right; Claude's answers on the left, with Markdown drawn properly.
- Every reply of Claude's quotes the message it answers (`↩ "…"`, click to go there). When it answers several messages at once, each gets its own bubble (Claude marks the parts with `<<reply T4>>` lines, which the app hides).
- **Unread:** a reply you haven't seen has a magenta border and `● new`; it counts as read after 3 seconds on screen with the window focused. Ctrl+N, or `● N unread · next ▸`, goes through unread replies oldest first.
- Claude's work between them folds into one line (`⚙ 8 steps · edited 3 files · ran 4 commands ▸ show`); click it, or Ctrl+O, to see each step. The `work` setting (panel, or `/work folded|edits|all`, kept per chat) shows file edits as diffs, or every step with its command and output. Click a step to open just that one.
- `↩ reply` and 👍 👎 ❓ 👀 under every message (on hover); a reply bar on the input with ✕; quotes link both ways.
- The panel on the left: **Unread** (a ✓ on each marks it read), **Waiting on you** (Claude's open questions), **Working** (Claude while it works; a click opens its live view), **Agents** (each agent Claude started, running or just finished, with the message it is on; a click opens its own view), **Your recent messages** (⏳ Claude on it, ✋ waiting on you, ✓ done; latest activity on top, ↩ replied or ↻ status changed at that time, and they hold still while the pointer is on the panel). A click on one of your messages jumps to it (its ⏳/✓ mark opens its whole chain); Alt+↑/↓ goes up and down the list, Alt+→ goes to the reply, Ctrl+F (or ⌕) searches them. Drag the divider to resize it, click `☰` to fold it to icons. The app has no threads: each message is a topic, which is all the inbox needs.
- Your own status line command runs at the bottom, fed what Claude Code would feed it.
- Keys: Enter sends, Alt+Enter new line, Esc cancels a reply or interrupts Claude, Ctrl+C clears or interrupts (twice to quit), PgUp/PgDn scroll, ↑/↓ move between the rows of a long message (from the top row, ↑ goes to your earlier messages), Ctrl+←/→ or Alt+←/→ jump words, Ctrl+V or Alt+V adds the image on the clipboard (dropping or pasting an image file's path adds that image), `/` opens the command menu.
- `/clear` new session, `/resume` pick one, `/model <name>` switch model, `/results` hide steps, `/work` how much work to show, `/panel` fold the panel, `/exit`. Other slash commands go to Claude Code.
- iTerm2: hold ⌥ (Option) while dragging to select text, since the app takes the mouse.

`clued-classic` is the earlier layout: Claude Code's own screen in tmux, with the threads panel beside it and the mod in `hooks/`.

## Run

```sh
ln -s "$PWD/bin/clued" ~/.local/bin/clued   # once, from the repo: any folder on your PATH works

clued              # new session in this folder
clued -c           # continue this folder's last session
clued --resume     # pick a session
clued --model opus # any other flag goes to claude
```

Like `claude`, it works on the folder you start it in: sessions are Claude Code's own, per folder. The app keeps its own small state (read marks, links, panel width, pasted images) in `~/.clued/`.

### The classic layout

`bin/clued-classic` opens Claude Code's own screen in tmux, with the threads panel on the left and the real Claude Code on the right, with its status line, commands, colours and resume unchanged. Every flag passes through to `claude`.

- Click `☰ Threads` (top left) to fold the panel to a narrow strip with ⏳/✋ counts, and click `☰` to open it again.
- Click a thread to show only it; new messages go there. Click `↩` on a thread to reply in it. Click `all activity` / `results only` to hide Claude's actions.
- After a click, the keyboard goes back to Claude Code.

The window is tmux (its own server, `-L clued`, with every bar hidden; `bin/tmux.conf`). The two sides talk through files in `~/.clued/run/<id>/`: the mod in Claude Code writes `state.json`, and the panel (`panel/main.ts`, plain Node, no dependencies) appends clicks to `commands.jsonl`. `CLUED_PLAIN=1 clued-classic` runs Claude Code alone, with the mod's own panel on the right.

## Develop

```sh
claude plugin validate .   # what the engine would load or refuse
claude plugin test .       # tests/*.test.tsx
```

Before your first commit, turn on the privacy check: `git config core.hooksPath .githooks`. It stops a commit or push that holds an email address, a home-folder path, a token or key, a log or a raw eval transcript (`scripts/check-private.sh`, or `--all` for every tracked file).

The engine reloads the mod when you save `hooks/register.tsx` during a `clued-classic` session. The API types are written to `.claude-plugin/types/` the first time the mod loads.

Spec and open questions: [docs/SPEC.md](docs/SPEC.md).
