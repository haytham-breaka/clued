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

For 3 seconds after Enter a message hasn't gone yet: `◌ sending in 3s · ✎ edit · ✕ delete` under it, and ↑ in an empty box (or Ctrl+Z) puts the last one back in the box, also while it waits in queue or in Claude Code's queue. `/hold <seconds>` changes the time, `/hold 0` sends at once.

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

## Images and diagrams in replies

Claude can show you an image, a chart or a diagram right in its reply. It writes a PNG file and puts `![what it is](/absolute/path.png)` on its own line (the app's guide tells it how; for a chart it renders a PNG, for example with matplotlib if it's installed). The image is drawn in the reply, under its paragraph, as wide as the bubble allows and at most 20 rows high, its shape kept. Under it is `[image: what it is]` with the file's path: a click on either opens it in your image viewer, full size. A ```` ```mermaid ```` block is drawn as a diagram in place of its code, with `⧉ copy` for its source.

What your terminal can draw, and how clued draws there:

- **iTerm2** (macOS) and **WezTerm**: iTerm2's inline images. PNG, JPEG, GIF and WebP.
- **kitty** and **Ghostty**: the kitty graphics protocol.
- **Windows Terminal 1.22 or later** (also from WSL), **foot**, **mlterm**, **xterm -ti vt340** and other terminals that say they draw Sixel: Sixel, at most 256 colours an image.
- **Anything else, and inside tmux or screen** (they don't pass images through): no image. It stays a `[image: what it is]` link that opens the file in your viewer, and nothing else is sent to the terminal.

To choose, set `CLUED_IMAGES` before you start clued: `iterm`, `kitty`, `sixel` or `off` (`auto`, the default, picks from the terminal). clued asks the terminal for its cell size in pixels, to keep an image's shape; if images come out squashed, set it yourself, for example `CLUED_IMAGE_CELL=10x20` (width × height in pixels).

**Diagrams** need the Mermaid CLI, `mmdc`, on your PATH: `npm i -g @mermaid-js/mermaid-cli` (it brings a headless Chrome the first time). Each diagram is drawn once, in a dark theme on a clear background, and kept under `~/.clued/cache/mermaid/` by its source; until it is ready the code shows with `◌ drawing the diagram…` under it. Without `mmdc` the code shows as before, with a line saying how to get diagrams; if `mmdc` fails, the line says why.

The limits:

- Only local files that exist are drawn, up to 10 MB and 40 million pixels. An image link to a URL (`![](https://…)`) is never fetched: it stays a link.
- For kitty and Sixel, a JPEG, GIF, WebP or SVG is turned into a PNG first by a tool already on your machine (`sips` on macOS, ImageMagick, `ffmpeg`, or `rsvg-convert` for SVG), and kept in `~/.clued/cache/images/`; without one it stays a link. iTerm2 draws an SVG only through such a tool too.
- An image scrolled partly out of view is cropped to its rows still in view (a JPEG in iTerm2 shows a placeholder until all of it is). Images show in the chat and a request's view; an agent's view, a reply still being written and the panel show the link.
- Selecting text across an image copies the words around it, not the image.
- You can delete `~/.clued/cache` at any time.

## Permissions

When Claude Code needs permission for a tool, clued asks you in the app, the way `claude` would: with Claude's description of the command and the whole command, wrapped (a very long one has `⧉ copy all`). Your allow and deny rules apply as usual.

## Questions with options

When Claude asks you something with options (its AskUserQuestion tool), the question shows as a `❓ Claude asks` card above the input box: each question with its header and numbered options, with their descriptions. Click an option or press its number, then Enter. When several options are allowed, each click or number ticks one on or off. To answer in your own words, type in the input box and press Enter. When Claude asks several questions at once, they come one after another on the same card. Esc, or the card's ✕, dismisses the question, and Claude is told you didn't answer it.

## Notifications

Each time Claude starts waiting on you (a reply that asks you something, a permission, a question card), you get a notification with a sound, showing the question and the project folder. Each wait notifies once.

- `/notify on` (the default) notifies every time, unless you typed or clicked in this very tab in the last 15 seconds and it still has focus: then you are looking at it already. Focus alone doesn't silence it, because a terminal can't always say whether you are looking (clued starts out counting itself focused, and you can sit in front of a window while reading something else).
- `/notify always` notifies even while you type here, `/notify off` stops them, `/notify test` sends a sample, and `/notify status` says where notifications go and, on Windows, how the last toast went and whether the click handler is set up.

Where it comes from, and what a click does:

- **iTerm2, WezTerm, Ghostty and kitty** post the notification themselves, so a click on it opens the very tab that asked. kitty plays the system's notification sound; iTerm2, WezTerm and Ghostty play what the system's notification settings say for that terminal. clued also rings the terminal's bell, which each terminal plays or shows as it is set to.
- **Windows Terminal (and WSL)** gets a Windows toast with the default notification sound, which stays in the Action Center. A click on it opens the very tab that asked and brings its window to the front, even with several windows and tabs. The tab's title also starts with `✋ 1 ·`, and the tab and taskbar button turn yellow, until you answer.
- **Other terminals on Windows** get the same toast and tab title, but a click doesn't open the tab.
- **macOS** (other terminals): Notification Center, with the Glass sound.
- **Linux**: `notify-send`, which plays no sound itself, so clued also plays the freedesktop `message-new-instant` sound with `canberra-gtk-play`, or with `paplay` when that isn't installed. With neither, there's no sound. The tab title starts with ✋ while Claude waits.

**How a click finds the tab in Windows Terminal.** Windows Terminal gives clued no way to name a tab from outside, so clued sets up a small click handler for your Windows user as it starts, apart from any toast. clued writes `%LOCALAPPDATA%\clued\focus.ps1` itself (from WSL, through `/mnt/c`) and registers a `clued-focus:` link in `HKCU\Software\Classes\clued-focus` with plain `reg.exe add` calls (your user only, no admin rights). The toast opens that link. The handler runs headless (`conhost --headless`, so no window or tab opens), finds the tab by its title through Windows' UI Automation, selects it and brings its window to the front. It runs with `-ExecutionPolicy RemoteSigned`, as Windows runs no script file by default; the file is written on your machine, so that is enough. The title ends with an invisible tag made from the tab's `WT_SESSION`, so two clued tabs on the same folder are told apart. It is set up only once, and again only when clued's handler changes. If it can't be set up, toasts still come, without the click to the tab. `/notify uninstall` removes both and turns notifications off. `/notify on` turns them back on and sets the handler up again. With the profile setting `suppressApplicationTitle`, the tab can't be found by its title, so a click only brings the window to the front.

**Antivirus (Bitdefender, say).** Some antivirus scans the command line of every PowerShell it sees and stops the ones that look like malware: a script decoded from base64 and written to disk, a registry change, `-ExecutionPolicy Bypass`, a hidden window. clued's toasts used to set the click handler up in the same command, and Bitdefender stopped each of them before PowerShell ran (from WSL: `powershell.exe: Invalid argument`), so no notification showed. Now each toast's command is only the toast, small and plain, and the handler is set up apart, without PowerShell. If a toast is still stopped, clued says so once in the app ("Windows notifications were blocked (antivirus?)"), writes each failure to `~/.clued/sent.log` (`notify-failed`), and keeps trying the next ones. `/notify status` shows what happened. If your antivirus keeps blocking them, allow `powershell.exe` (or clued) in it, then `/notify test`.

Windows Terminal Preview 1.26 can post notifications itself (OSC 777, off by default: `compatibility.allowOSC777`). clued doesn't use that yet, so you won't get two notifications for one question.

The notification shows the question's words, so they can appear on a shared screen or a lock screen. `/notify off` if that matters.

## Arabic, Hebrew and other right-to-left text

Most terminals draw each row left to right, in the order they get the characters, so Arabic or Hebrew comes out backwards, and many don't join Arabic letters. clued lays such text out itself:

- Each line of a message, a reply, a table cell or a panel preview is put in reading order (the Unicode Bidirectional Algorithm, line by line after wrapping). Arabic letters are joined, by clued or by the terminal's font (see [Joining Arabic letters](#joining-arabic-letters)).
- A paragraph that starts with an Arabic or Hebrew letter reads right to left and sits on the right of its bubble. English words, numbers, inline code, URLs and paths in it stay left to right. Code blocks stay left to right too; an Arabic string in code reads right to left in its place.
- Selecting and copying, `⧉ copy` and `/copy` give the text as written, not as drawn.
- In the input box an Arabic line sits on the right, with the cursor where the next letter goes. ← and → move one character through the text; in a line that reads right to left, ← goes forward, as in any right-to-left text field.

What each terminal does, and what clued does there:

- **Windows Terminal (and WSL), VS Code, WezTerm, Alacritty, foot, xterm and iTerm2** don't reorder, so clued does it (`app`, the default).
- **GNOME Terminal, Tilix and other VTE terminals** reorder by themselves. clued tells them not to (the BiDi mode escape, `CSI 8 l`) and does it itself. Inside tmux that escape may not reach the terminal: if Arabic looks backwards there, use `terminal`.
- **macOS Terminal, Konsole and mlterm** reorder by themselves and can't be told not to, so clued sends them the text as written (`terminal`). They put each row in order; clued still puts right-to-left paragraphs on the right.
- **kitty** turns each right-to-left word round by itself: set `force_ltr yes` in `kitty.conf`.
- **iTerm2 with its right-to-left support turned on, or WezTerm with `bidi_enabled = true`:** use `terminal`.

To choose, set `CLUED_BIDI` before you start clued, for example `export CLUED_BIDI=terminal` in `~/.zshrc`: `app` (clued reorders), `terminal` (the terminal does) or `off` (text is drawn as it comes, and nothing goes on the right).

### Joining Arabic letters

When clued puts a line in order (`CLUED_BIDI=app`), something still has to join its Arabic letters. A second setting, `CLUED_ARABIC`, says who:

- **`terminal`, the default in Windows Terminal:** clued sends the plain Arabic letters, in display order, and the terminal's font joins them. Windows Terminal does that well, even on text in display order. clued only keeps each mark (harakat, tanween, shadda) right after its letter, and sends a lam with its alef (لا، لأ، لإ، لآ) as the one lam-alef character, since a font can't join those two once they are reversed.
- **`app`, the default everywhere else:** clued draws each letter in its joined form itself (Unicode's Presentation Forms), for terminals that don't join Arabic.

For example `export CLUED_ARABIC=app` in `~/.zshrc`. With `CLUED_BIDI=terminal` or `off`, the terminal gets the text as written and `CLUED_ARABIC` does nothing. Either way, copying gives the text as written.

**The font in Windows Terminal.** The font needs Arabic letters. Use **Cascadia Mono NF** or **Cascadia Code / Cascadia Mono 2111 or later** (from [GitHub](https://github.com/microsoft/cascadia-code/releases)), which have Arabic and join it. The Cascadia Code and Cascadia Mono built into Windows (version 2102) have no Arabic: Windows Terminal borrows each letter from another font, and the letters don't join well. Set the font in Settings → your profile → Appearance → Font face. Cascadia has no glyph for lam-alef (لا), which clued writes as one character, so Windows borrows it from another font, and the borrowed one may not join the letter before it (خلا, ثلا). Name a second font for Windows to borrow from, after a comma: `Cascadia Mono NF, Simplified Arabic Fixed` (or `Courier New`, on every Windows). Cascadia still draws everything it has. In other terminals, with `app`, the font needs the Presentation Forms: DejaVu Sans Mono and most system fonts have them; otherwise the terminal borrows them from another font.

The limits:

- With `app`, letters Unicode has no joined forms for (a few rare ones) show unjoined, and only the lam-alef ligature is drawn.
- With `terminal`, the lam-alef character usually comes from another font than the letters around it.
- A paragraph's direction comes from its first letter: a message that starts with an English word reads left to right, with its Arabic words in order inside it.
- In mixed text the cursor goes through the text in reading order, so it can jump between an Arabic run and an English one.
- Part of a mixed line selected copies the characters in those cells, in reading order.
