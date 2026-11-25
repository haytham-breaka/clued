# Contributing to clued

The [README](README.md) covers what clued does and how to use it. This file covers how to help.

## Issues, not pull requests

clued takes contributions through **issues only**. Bug reports, ideas, questions and "this confused me" are all welcome, and they are the most useful thing you can send.

Pull requests from outside the project are not accepted, and GitHub only lets collaborators open them. clued is a single-maintainer project with strong opinions about how it should feel to use, so a change is cheaper to talk through in an issue than to review as code. If you've already found the fix, put it in the issue: a few lines or a diff pasted there is welcome, and you'll be credited when it lands.

You're free to fork it. The [MIT licence](LICENSE) allows that, and you can change your copy however you like.

## A useful bug report

- **What you did and what happened:** the message you sent, what you expected, what you saw. A screenshot of the terminal helps a lot.
- **Where:** your OS, your terminal (iTerm2, Windows Terminal with WSL, …), `node --version`, `claude --version`, and the clued commit (`git -C <clone> rev-parse --short HEAD`).
- **Whether it's clued or Claude Code:** does the same thing happen in plain `claude`? If it does, it belongs to [Claude Code's issues](https://github.com/anthropics/claude-code/issues).

**Check what you paste.** Session files and logs can hold your file paths, your email address, project code and anything you or Claude typed. Paste the few lines that matter, not whole files, and remove anything private. `~/.clued/sent.log` records what the app sent and when, which is often the quickest way to show a timing problem.

## Running it from a clone

```bash
git clone https://github.com/haytham-breaka/clued.git
cd clued
bin/clued            # the app, on this folder
```

There's no build step and there are no dependencies to run it (`npm ci` only installs the test tools). Every file under `app/` is TypeScript that Node runs directly, so an edit shows up on the next start, or after `/reload` inside the app.

```
bin/clued          launcher: starts the app and restarts it on /reload
app/
  main.ts          state, input, keys, the turn loop and the guide given to Claude
  claude.ts        the headless Claude Code process: stream-json in and out, permission prompts
  ask.ts           Claude's multiple-choice questions (AskUserQuestion): the card and the answer
  chat.ts          drawing the chat: bubbles, quotes, steps, live views
  panel.ts         drawing the panel: unread, waiting on you, working, agents, recent messages
  inbox.ts         which reply answers which message, message states, questions in a message
  session.ts       history from Claude Code's session file, and what the app keeps per session
  markdown.ts      Markdown to terminal text
  diff.ts, text.ts diffs and text width
  migrate.ts       moves the old ~/.threadline folder to ~/.clued
hooks/model.ts     the tag and topic model shared with the classic mod
eval/              the comparison with plain Claude Code (see eval/README.md)
docs/classic.md    the older tmux layout and its Claude Code mod
```

### Checks

```bash
npm ci && npm test && npm run coverage
```

`npm ci` installs the dev-only test tools: c8 for coverage, and TypeScript with Node's types. `npm test` runs the unit tests (`tests/unit/`) and the end-to-end tests (`tests/e2e/`). The end-to-end tests drive the real app in tmux, so tmux must be installed. They run it against a fake `claude` that plays scripted scenarios, with HOME set to a temporary folder, and fake notification and clipboard tools, so they need no Claude Code, no network, and never touch your own `~/.clued` or `~/.claude`. `npm run coverage` runs the same tests and fails below 80% of lines, branches or functions covered in `app/` and `hooks/model.ts`. `npm run typecheck` type-checks the app and the tests. The same checks run on every pull request and every push to `main`.

If a step times out on a slow machine, `E2E_WAIT_MS=30000 npm test` gives each wait in the end-to-end tests longer (the default is 15000).

```bash
claude plugin test .     # the classic mod's tests, which also cover the shared tag model
```

### The privacy check

If you keep your own fork, turn on the check before your first commit: `git config core.hooksPath .githooks`. It stops a commit or push that contains an email address, a home-folder path, a token or key, a log, or a raw eval transcript. To check every tracked file, run `scripts/check-private.sh --all`.
