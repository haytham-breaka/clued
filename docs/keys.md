# Keys

Back to the [README](../README.md) · [Using clued](usage.md) · [Commands](commands.md)

| Key | Does |
|---|---|
| Enter / Alt+Enter | send / new line |
| Esc | back to the chat from an agent's, request's, job's, command's or the game's view (also `← back` at the start of its title line); else cancel a reply, dismiss Claude's question, or interrupt Claude |
| Ctrl+C | clear the input or interrupt; twice to quit |
| Alt+↑ / Alt+↓ | go through your recent messages; the chat scrolls to each |
| Alt+→ / Alt+← | from a message to its reply, and back |
| Alt+S | save the message Alt+↑/↓ picked to get back to later, or unsave it |
| Ctrl+F | search your messages |
| Ctrl+G | a game while Claude works (or any time): Comet, in the chat's place. Ctrl+G or Esc closes it |
| Ctrl+Z | take back the message you just sent, while it can still be taken back (back in the box, as ↑ in an empty box) |
| Ctrl+N | next unread reply |
| Ctrl+O | show or hide Claude's steps |
| Shift+Tab | next permission mode (default, accept edits, plan, and bypass or auto when you started in it), shown under the status line |
| ↑ in an empty box | take back your last message to edit, while Claude hasn't read it: in its hold time, in queue, or queued in Claude Code. Its text, images and reply come back in the box. Once Claude has it, ↑ goes to earlier messages |
| ↑ / ↓ | move between rows of a long message; from the top row, earlier messages |
| Ctrl+← / Ctrl+→ | jump words |
| Ctrl+Backspace / Alt+Backspace (⌥⌫) | delete the word before the cursor (Ctrl+W: up to the last space) |
| Ctrl+Delete / Alt+D | delete the word after the cursor |
| Ctrl+V or Alt+V | add the image on the clipboard |
| PgUp / PgDn | scroll |

On a question card, a number picks an option and Enter sends it. Esc dismisses the question, and also closes what a command like `/status` shows.

In `/setup`, ↑↓ (or a number) picks an extra, Enter shows what installing it does, `y` installs it and `n` or Esc doesn't; Esc or `← back` goes back to the chat.

In the game (Ctrl+G), the arrows or WASD steer, Space pauses and plays on (or starts a new run after one ends), and Enter starts a new run too. Every other key goes to the game and does nothing, so nothing reaches the input box; Esc, Ctrl+G or `← back` goes back to the chat. Ctrl+C still interrupts Claude.

On the `/model` card, ↑/↓ (or a number) picks a model, ←/→ changes the effort, and Enter or a click switches. Esc cancels.

## Selecting text

Drag over the chat or the input box to select text; it's copied when you let go. A double-click selects a word, a path or a URL. With text selected, Ctrl+C copies it again and Esc drops it. In the input box, typing or Backspace replaces the selection.

To select across the panel too, hold ⌥ (Option) in iTerm2 or Shift in Windows Terminal: the terminal then selects instead of the app.
