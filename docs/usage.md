# Using clued

How the screen works and what each part does. For the keys see [keys.md](keys.md), for the slash commands [commands.md](commands.md), and to install it the [README](../README.md#quick-start).

Like `claude`, clued works on the folder you start it in, and sessions are Claude Code's own, kept per folder. `/reload` restarts the app on the same session, for example after a `git pull`.

## The screen

Your messages are on the right and Claude's replies on the left, with Markdown drawn properly. A reply streams into its bubble as Claude writes it, and each part shows which message it answers from its first words. Claude's work between replies folds into one line (`⚙ 8 steps · edited 3 files · ran 4 commands ▸ show`); click it, or press Ctrl+O, to see each step.

Drag the divider to resize the panel, and click `≡` to fold it to icons. Your own status line command runs at the bottom, fed what Claude Code would feed it (the folder is the one Claude is working in now), with the permission mode under it, as in Claude Code.

## The panel

The panel on the left has these sections:

- **Unread / Read:** replies you haven't seen yet, and the ones you have. A reply counts as read after 3 seconds on screen with the window focused.
- **★ Saved:** the messages you saved to get back to later, newest first (shown once there is one). Click one to go to it; ✕ unsaves it.
- **Waiting on you:** Claude's open questions to you. The ✕ on the left, or `✕ dismiss` under the question, drops one you don't want to answer: its message counts as done, and your next message tells Claude not to wait for an answer.
- **Agents:** Claude first, then each agent it started, by name and role (`James (implementer)`, `Jake (explorer)`), running or just finished, with the message it is working on. Claude's own row says how many of your messages its turn is on, and `waiting on you` in yellow while its question or a permission waits for you. Click one to open its live view. Claude is told the names too, so you can write "ask Jake to check the tests". When Claude sends an agent more work, each message is a new task: the agent's row says how many tasks it has and which one it is on, and its view lists them, with the agent's own to-do list below. On the right of a running agent: `last step 12s ago`, or `running Bash 6m` while a tool runs (a long test run is not stuck), or, after 5 minutes with no new step and nothing running, `quiet 6m` in yellow: its view says it may be stuck, with ▶ continue to have Claude check on it. A background agent that a `/reload` or Claude Code's exit cut off shows ■ stopped, with ▶ continue to have Claude resume it.
- **Background:** the shell commands Claude runs in the background (a long test suite, a CI wait, a dev server), shown while there is one. Each row has the command's description, or the command itself, and how long it has been running, or whether it finished as done, failed or stopped, with its exit code when Claude Code gives one. Click one to see the whole command and its output so far, which keeps updating while it runs. `✕ stop` there asks Claude to stop it. One that failed or was stopped (a `/reload` stops them all) has `↻ run again`, in its view and on its row when there is room: it asks Claude, in the chat, to run the same command in the same folder in the background again, or to have the agent that ran it do so. Finished commands stay listed for 10 minutes. On resume they come back from the session file, and any still running then shows as stopped, since it ended with its Claude Code.
- **Not started:** right under Agents and Background, the requests Claude said it still owes work on that nothing is working on right now, one row per request, with how long each has waited. Click one to open it. ▶ start asks Claude to start on it now; while Claude is busy, `+ queue` sends the request to wait its turn instead.
- **Scheduled:** the jobs Claude set to run later, with CronCreate or a `/loop` wakeup, shown while there is one. Each shows ⏰ for recurring or ⏲ for once, what it's for, when it runs next ("every 5 min · next 14:35", "in 3 min"), and whether it's scheduled, has run, or was deleted. Click one to see its whole prompt, its schedule, who set it up and which of your messages it's for, and each run. `✕ cancel` there asks Claude to delete it. Jobs that only live in memory end when Claude Code exits, so `/reload` ends them.
- **Your recent messages:** each with its mark. First the ones in progress, with who is on each (`Claude`, or `Maya · task 2`), then `in queue` (sent while Claude works, waiting for its turn), then `waiting` (Claude still owes work and nothing is on it), then the rest, newest first. Under an answered message, a dim `→` row gives the gist of its answer, room allowing. Click a message to jump to it in the chat, and click its mark to open its chain. Press `?` for what the marks mean and `⌕` to search.

The main marks: ⏳ Claude is on it, ✋ waiting on you, ✓ done, and ⚠ reply lost. `?` in the panel lists them all.

## Sending while Claude works

A message you send while Claude is busy waits in clued (`⏳ in queue`) and goes as a turn of its own when Claude's turn ends, one per turn, so each gets its own answer. A reply to the work in progress (a part of the running turn, its request, or a running agent's view) goes at once, so you can still steer. `/queue off` sends everything at once instead, into the running turn the way Claude Code does it.

Under each message, `✓ sent` means Claude Code has it, and `✓✓` means Claude has actually taken it in (a message sent into the running turn says `⏸ queued: Claude reads it at its next step` until then).

Messages still in queue when the app closes are held again when you open the session.

## Taking a message back

For 3 seconds after Enter a message hasn't gone yet: `◌ sending in 3s · ✎ edit · ✕ delete` under it, and Ctrl+Z puts the last one back in the box. `/hold <seconds>` changes the time, `/hold 0` sends at once.

A message that is `✓ sent` but not `✓✓` can still be deleted: Claude Code drops it from its queue when it can, and otherwise Claude is told to ignore it.

## Replies that say what they answer

When one reply answers several messages, it splits into one bubble per message, each quoting what it answers. Click a quote to jump to it. When a message asks several things, each question can be answered on its own: the quote reads `↩ 2 questions`. If you send a follow-up without clicking reply, it's linked to the earlier message automatically, shown as `↩ about: …`.

## Reply to anything, react to anything

Hover over a message for `↩ reply`, `copy` and 👍 👎 ❓ 👀. A reply quotes the message to Claude. A 👍 on a question is a go-ahead, so Claude proceeds. 👎 asks Claude what to change, and ❓ asks it to explain again, more simply. Other reactions start no turn.

`☆ save` under any message, yours or one part of Claude's reply, keeps it in the panel's **★ Saved** list to get back to later; the bubble then shows `★ saved`, and a click on it again unsaves it. The list is kept with the session, so it's still there after `--resume` or `/resume`.

Claude reacts too, only where it means something: 👀 seen (for a message sent while it was busy), 👍 noted, ✅ done with nothing to add, 🎉 good news.

## Chains

The `⛓ chain` link under a message (as soon as it has a reply), or a click on its mark in the panel, opens everything connected to it: the replies, your follow-ups, the corrections, and the replies to those. Chains come from the session file and what clued keeps in `~/.clued/`, not from Claude's context, so they stay whole when Claude Code compacts the conversation. When you reply to a message from before a compaction, or more than 30 messages back, its request's chain goes to Claude with it: the first message and the last few messages and replies, trimmed to about 2,000 characters, so Claude has the context it no longer holds word for word.

## Live views of Claude and its agents

Click Claude or any agent under **Agents** for its own view: each step as it happens, with commands, output and diffs. That includes agents running in the background, whose steps Claude Code does not stream: the app reads them from the transcript Claude Code keeps for each agent. Press Esc to go back to the chat.

## Messages that never got an answer

Sometimes a reply never arrives: Claude's tag settles a message, but no reply part for it came. When the turn ends, the app asks Claude at once, in one message, to write each missing reply again; the chat shows `↻ asked Claude again for 2 replies that never arrived`. A message whose reply is still missing after that is marked `⚠ reply lost` instead of looking answered, and `↻ ask again` sends it again.

## Images

Ctrl+V adds the image on the clipboard. This works with the Windows clipboard from WSL, with macOS, and with Wayland or X11. Pasting or dropping an image file's path attaches that image. Once sent, a click on `[image N]` in your message (in the chat, the panel or a request's view) opens that image in your image viewer: Windows' own from WSL, `open` on macOS, `xdg-open` on Linux.

## Permissions

When Claude Code needs permission for a tool, clued asks you in the app, the way `claude` would: with Claude's description of the command and the whole command, wrapped (a very long one has `⧉ copy all`). Your allow and deny rules apply as usual.

## Questions with options

When Claude asks you something with options (its AskUserQuestion tool), the question shows as a `❓ Claude asks` card above the input box: each question with its header and numbered options, with their descriptions. Click an option or press its number, then Enter. When several options are allowed, each click or number ticks one on or off. To answer in your own words, type in the input box and press Enter. When Claude asks several questions at once, they come one after another on the same card. Esc, or the card's ✕, dismisses the question, and Claude is told you didn't answer it.

## Notifications

When Claude asks you something, or needs a permission, you get a notification with the question and the project folder, while the clued window is in the background. `/notify always` notifies even when it's in front, `/notify off` stops them, `/notify test` sends a sample.

- **iTerm2, WezTerm, Ghostty and kitty** post the notification themselves, so a click on it opens the very tab that asked.
- **Windows Terminal (and WSL)** gets a Windows toast. Windows has no way to open a given tab from a notification, so the tab marks itself instead: its title starts with `✋ 1 ·` and the tab and taskbar button turn yellow until you answer.
- **Elsewhere** it's Notification Center on macOS and `notify-send` on Linux, and the tab title starts with ✋ while Claude waits.

The notification shows the question's words, so they can appear on a shared screen or a lock screen. `/notify off` if that matters.
