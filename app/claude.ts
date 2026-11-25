// A real Claude Code session, run headless: we write user messages as stream-json on its
// stdin and read its events from stdout. Claude Code runs the harness (tools, permissions,
// hooks, plugins, MCP, sessions); this app only draws.

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export type ToolUse = { id: string; name: string; input: Record<string, unknown> }

export type ClaudeEvent =
  | { kind: 'init'; sessionId: string; model: string; cwd: string; commands: string[]; permissionMode: string }
  | { kind: 'text-delta'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: ToolUse }
  | { kind: 'tool-result'; id: string; text: string; isError: boolean }
  | { kind: 'status'; text: string }
  | { kind: 'result'; text: string; isError: boolean; usage: Usage; costUsd: number; durationMs: number; sessionId: string; contextWindow?: number }
  | { kind: 'rate'; info: Record<string, unknown> }
  | { kind: 'usage'; usage: Usage }
  | { kind: 'permission'; requestId: string; tool: string; input: Record<string, unknown> }
  | { kind: 'exit'; code: number | null; stderr: string }
  /** A subagent's own step: the Agent call it runs under, and the tool it used. */
  | { kind: 'agent-step'; parent: string; tool: ToolUse }
  /** A subagent's words, and its tools' results. */
  | { kind: 'agent-text'; parent: string; text: string }
  | { kind: 'agent-tool-result'; parent: string; id: string; text: string; isError: boolean }
  /** Background task news from Claude Code: started, progress, or finished (status). */
  | { kind: 'task'; phase: 'started' | 'progress' | 'done'; taskId: string; toolUseId?: string; status?: string; text?: string; lastTool?: string }

export type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

export type Options = { args: string[]; cwd: string; appendSystemPrompt: string }

export class Claude {
  private proc: ChildProcessWithoutNullStreams
  private buf = ''
  private stderr = ''
  private onEvent: (e: ClaudeEvent) => void
  constructor(opts: Options, onEvent: (e: ClaudeEvent) => void) {
    this.onEvent = onEvent
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompts', 'host',
      // Without these, Claude Code refuses a tool that needs a yes instead of asking the app (seen in
      // default permission mode): the prompts come over stdio, after the SDK's initialize request.
      '--permission-prompt-tool', 'stdio',
      '--append-system-prompt', opts.appendSystemPrompt,
      ...opts.args,
    ]
    this.proc = spawn('claude', args, { cwd: opts.cwd, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT ?? 'sdk-ts' } })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => this.read(chunk))
    this.proc.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000)
    })
    this.proc.on('exit', code => this.onEvent({ kind: 'exit', code, stderr: this.stderr }))
    // As the Agent SDK does: tells Claude Code a host is here to answer permission prompts.
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'initialize', hooks: null } })
  }

  private write(obj: unknown) {
    if (!this.proc.stdin.writable) return
    this.proc.stdin.write(JSON.stringify(obj) + '\n')
  }

  /** A user message; `hidden` goes along as a second text block Claude reads and the app never shows. */
  send(text: string, hidden?: string, images: { media: string; data: string }[] = []) {
    const blocks = [
      ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.media, data: i.data } })),
      { type: 'text', text },
      ...(hidden ? [{ type: 'text', text: hidden }] : []),
    ]
    const content = blocks.length > 1 ? blocks : text
    this.write({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' })
  }

  interrupt() {
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })
  }

  answerPermission(requestId: string, allow: boolean, input: Record<string, unknown>) {
    this.write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user denied this.' },
      },
    })
  }

  close() {
    this.proc.stdin.end()
    setTimeout(() => this.proc.kill('SIGTERM'), 1500).unref()
  }

  private read(chunk: string) {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (!line.trim()) continue
      let e: any
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      this.dispatch(e)
    }
  }

  private dispatch(e: any) {
    const emit = this.onEvent
    switch (e.type) {
      case 'system':
        if (e.subtype === 'init')
          emit({
            kind: 'init',
            sessionId: e.session_id,
            model: e.model,
            cwd: e.cwd,
            commands: (e.slash_commands ?? []).map(String),
            permissionMode: e.permissionMode ?? '',
          })
        else if (e.subtype === 'status' && typeof e.status === 'string') emit({ kind: 'status', text: e.status })
        else if (e.subtype === 'compact_boundary') emit({ kind: 'status', text: 'compacted' })
        else if (e.subtype === 'task_started' || e.subtype === 'task_progress' || e.subtype === 'task_notification')
          emit({
            kind: 'task',
            phase: e.subtype === 'task_started' ? 'started' : e.subtype === 'task_progress' ? 'progress' : 'done',
            taskId: String(e.task_id ?? ''),
            ...(e.tool_use_id ? { toolUseId: String(e.tool_use_id) } : {}),
            ...(e.status ? { status: String(e.status) } : {}),
            ...(e.summary || e.description ? { text: String(e.summary ?? e.description) } : {}),
            ...(e.last_tool_name ? { lastTool: String(e.last_tool_name) } : {}),
          })
        return
      case 'stream_event': {
        if (e.parent_tool_use_id) return // a subagent's stream
        const ev = e.event
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') emit({ kind: 'text-delta', text: ev.delta.text })
        return
      }
      case 'assistant': {
        if (e.parent_tool_use_id) {
          for (const b of e.message?.content ?? []) {
            if (b.type === 'tool_use') emit({ kind: 'agent-step', parent: String(e.parent_tool_use_id), tool: { id: b.id, name: b.name, input: b.input ?? {} } })
            else if (b.type === 'text' && b.text) emit({ kind: 'agent-text', parent: String(e.parent_tool_use_id), text: b.text })
          }
          return
        }
        if (e.message?.usage) emit({ kind: 'usage', usage: e.message.usage })
        for (const b of e.message?.content ?? []) {
          if (b.type === 'text' && b.text) emit({ kind: 'text', text: b.text })
          else if (b.type === 'tool_use') emit({ kind: 'tool', tool: { id: b.id, name: b.name, input: b.input ?? {} } })
        }
        return
      }
      case 'user': {
        const content = e.message?.content
        if (!Array.isArray(content)) return
        for (const b of content) {
          if (b.type !== 'tool_result') continue
          const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') : ''
          if (e.parent_tool_use_id) emit({ kind: 'agent-tool-result', parent: String(e.parent_tool_use_id), id: b.tool_use_id, text, isError: !!b.is_error })
          else emit({ kind: 'tool-result', id: b.tool_use_id, text, isError: !!b.is_error })
        }
        return
      }
      case 'result':
        emit({
          kind: 'result',
          text: typeof e.result === 'string' ? e.result : '',
          isError: !!e.is_error,
          usage: e.usage ?? {},
          costUsd: e.total_cost_usd ?? 0,
          durationMs: e.duration_ms ?? 0,
          sessionId: e.session_id,
          // The context size Claude Code uses for the main model (its biggest; agents may run smaller ones).
          ...(() => {
            const sizes = Object.values(e.modelUsage ?? {}).map((u: any) => Number(u?.contextWindow) || 0).filter(n => n > 0)
            return sizes.length ? { contextWindow: Math.max(...sizes) } : {}
          })(),
        })
        return
      case 'rate_limit_event':
        emit({ kind: 'rate', info: e.rate_limit_info ?? {} })
        return
      case 'control_request':
        if (e.request?.subtype === 'can_use_tool')
          emit({ kind: 'permission', requestId: e.request_id, tool: e.request.tool_name, input: e.request.input ?? {} })
        else this.write({ type: 'control_response', response: { subtype: 'success', request_id: e.request_id, response: {} } })
        return
    }
  }
}
