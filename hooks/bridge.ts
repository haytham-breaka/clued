// The file protocol between the in-Claude mod and the clued window's own
// panel (panel/main.ts). Both sides read this file, so keep it free of `$`.
//
//   $CLUED_DIR/state.json      written by the mod: everything the panel draws
//   $CLUED_DIR/commands.jsonl  appended by the panel: one command per line

import type { Board, Notice, ReplyTo, View } from '../types'

export type Snapshot = {
  board: Board
  view: View
  replyTo: ReplyTo | null
  notices: Notice[]
  isWorking: boolean
  writtenAt: number
}

export type Command =
  | { op: 'thread'; threadId: number }
  | { op: 'results' }
  | { op: 'reply'; threadId: number }
  | { op: 'cancelReply' }
  | { op: 'readNotices' }

export const STATE_FILE = 'state.json'
export const COMMANDS_FILE = 'commands.jsonl'

/** Parses the commands appended since the last read; a torn last line waits for the next read. */
export function parseCommands(text: string): { commands: Command[]; used: number } {
  const end = text.lastIndexOf('\n') + 1
  const commands: Command[] = []
  for (const line of text.slice(0, end).split('\n')) {
    if (!line.trim()) continue
    try {
      const c = JSON.parse(line) as Command
      if (c && typeof c === 'object' && typeof c.op === 'string') commands.push(c)
    } catch {
      // A line that is not JSON is skipped, never retried.
    }
  }
  return { commands, used: new TextEncoder().encode(text.slice(0, end)).length }
}
