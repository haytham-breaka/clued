# clued: spec (v0.1, 2026-11-24)

## Idea
A Claude Code interface with a different UI that still runs on a real Claude Code session. It keeps the status bar, every Claude command, colours and session resume. It adds a side panel for threads and notifications, plus replies and reactions on messages. Claude may react to the user's messages, but only when that adds something.

## Hard constraints
- **No direct API calls.** clued must not call the Claude API or the Agent SDK. Everything runs inside a normal Claude Code session, which owns the harness and the billing. The only extra cost is the `react` tool's short description and any reaction Claude actually makes.
- Works in iTerm2 and starts with one command (`bin/clued`). Every `claude` flag passes through.
- Every built-in and custom slash command keeps working.

## Architecture
A Claude Code mod (function hooks plugin) loaded with `claude --plugin-dir`:

| Feature | Mechanism |
|---|---|
| Side panel | `$.ui.open` pane, drawn by `ui.render` on `Pane`. Docks beside the transcript in the fullscreen layout at 110+ columns, otherwise sits inline. |
| Reactions on messages | `ui.render` on `UserMessage` / `AssistantMessage` keeps the engine's row and adds a reaction line. |
| Claude reacting | Tool `mcp__clued__react`, served by `tool.run`. Guidance goes in through a `prompt.compose` section. |
| Me reacting | `/react` command. |
| Replies / threads | `/reply` quotes the target message and submits it as my own prompt (`$.prompt.submit({ asUser: true })`). |
| Notifications | Task notifications (`prompt.submit` with origin `task-notification`) and Claude's reactions. |
| State | `$.state` atoms (`types/index.d.ts`), kept for the session and across reloads. |

Messages are keyed by a hash of their text, because the render props carry no message id.

## Open questions (waiting on more details)
1. **What is a thread?** Today it's a reply chain on one Claude message. Alternatives: subagents and background tasks, parallel Claude sessions, or git worktrees.
2. **Picking a message to reply or react to.** Today you use an index (`n`). Could be mouse clicks on rows in fullscreen, or keyboard selection.
3. **Should a reply branch the conversation** (fork the session) or stay inline in the main conversation?
4. **Notification sources:** turn finished, permission needed, background task done, PR/CI events?
5. **Look:** theme and colours (`$.theme.set`), and how reactions are drawn.
6. **Persistence across `--resume`:** reactions are in session state; check that they survive a resume.
