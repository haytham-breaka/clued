# The classic layout

Before the app, clued was a Claude Code mod (a function-hooks plugin in `hooks/`) drawn inside Claude Code's own screen, with a threads panel beside it in tmux. It still works, and it still has threads, which the app dropped. It is kept for reference; new work goes into the app.

It is a Claude Code mod, not a separate client: it makes no API calls of its own. Claude Code still runs the harness, slash commands, the status line, `--resume`/`-c`, permissions and colours. clued adds:

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

## Run it

`bin/clued-classic` opens Claude Code's own screen in tmux, with the threads panel on the left and the real Claude Code on the right, with its status line, commands, colours and resume unchanged. Every flag passes through to `claude`.

- Click `☰ Threads` (top left) to fold the panel to a narrow strip with ⏳/✋ counts, and click `☰` to open it again.
- Click a thread to show only it; new messages go there. Click `↩` on a thread to reply in it. Click `all activity` / `results only` to hide Claude's actions.
- After a click, the keyboard goes back to Claude Code.

The window is tmux (its own server, `-L clued`, with every bar hidden; `bin/tmux.conf`). The two sides talk through files in `~/.clued/run/<id>/`: the mod in Claude Code writes `state.json`, and the panel (`panel/main.ts`, plain Node, no dependencies) appends clicks to `commands.jsonl`. `CLUED_PLAIN=1 clued-classic` runs Claude Code alone, with the mod's own panel on the right.

## Develop the mod

```sh
claude plugin validate .   # what the engine would load or refuse
claude plugin test .       # tests/*.test.tsx
```

Before your first commit, turn on the privacy check: `git config core.hooksPath .githooks`. It stops a commit or push that holds an email address, a home-folder path, a token or key, a log or a raw eval transcript (`scripts/check-private.sh`, or `--all` for every tracked file).

The engine reloads the mod when you save `hooks/register.tsx` during a `clued-classic` session. The API types are written to `.claude-plugin/types/` the first time the mod loads.

Spec and open questions: [docs/SPEC.md](SPEC.md).
