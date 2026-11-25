# Commands

Back to the [README](../README.md) · [Using clued](usage.md) · [Keys](keys.md)

## Starting clued

```bash
cd ~/code/my-project
clued                  # new session in this folder
clued -c               # continue this folder's last session
clued --resume         # pick a session
clued --resume <id>    # open that session
clued --model opus     # any other flag goes to claude
```

Like `claude`, it works on the folder you start it in, and sessions are Claude Code's own, kept per folder.

## Slash commands

| Command | Does |
|---|---|
| `/help` | every command, clued's and Claude Code's |
| `/status` | version, session, account, model, permission mode and MCP servers |
| `/plan [description]` | plan mode, then your message |
| `/diff` | the uncommitted changes, drawn like Claude's edits |
| `/copy [N]` | Claude's last reply, or the Nth back |
| `/export [file]` | the chat as Markdown, to a file or the clipboard |
| `/branch [name]` | a new session with the conversation so far, to try another way (`/resume` shows both and goes back) |
| `/add-dir <path>` | let Claude work in another folder too, kept for this session |
| `/plugin [list \| install \| enable \| disable \| uninstall \| update <name>]` | Claude Code's plugins through its own CLI, and the session reloads them |
| `/clear` | new session |
| `/btw <question>` | a quick side question: it sees the conversation but stays out of it, answered aside even while Claude works |
| `/resume` | pick a session |
| `/model <name>` | switch model |
| `/notify on\|always\|off\|test\|uninstall` | notifications, with a sound, when Claude waits on you (uninstall: remove the Windows click handler) |
| `/hold <seconds>` | time to take a message back |
| `/queue on\|off` | hold messages while Claude works |
| `/results` | hide Claude's steps and keep its results |
| `/work folded\|edits\|all` | how much of Claude's work to show |
| `/panel` | fold the panel |
| `/reload` | restart on this session |
| `/exit` | quit |

Every other slash command goes to Claude Code as usual.

## Commands headless Claude Code refuses

clued runs Claude Code headless, and headless Claude Code refuses its own /help, /status, /plan, /diff, /copy, /export, /branch, /add-dir and /plugin ("isn't available in this environment"). So clued runs those itself: what they show is a card in the chat, closed with ✕ or Esc.

Other Claude Code commands that only work in its own interactive screen, and that clued hasn't rebuilt, are still refused. For those, run `claude` in the same folder; `claude --resume` opens the same session.
