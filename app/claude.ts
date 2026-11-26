// A real Claude Code session, run headless: we write user messages as stream-json on its
// stdin and read its events from stdout. Claude Code runs the harness (tools, permissions,
// hooks, plugins, MCP, sessions); this app only draws.

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export type ToolUse = { id: string; name: string; input: Record<string, unknown> }

export type ClaudeEvent =
  | { kind: 'init'; sessionId: string; model: string; cwd: string; commands: string[]; permissionMode: string; version?: string; mcpServers?: McpServer[]; apiKeySource?: string; outputStyle?: string }
  /** Claude Code's answer to the initialize request: its commands with their descriptions, the account, its version… */
  | { kind: 'hello'; info: Hello }
  /** Claude Code's commands changed (plugins or skills reloaded). */
  | { kind: 'commands'; commands: CommandInfo[] }
  | { kind: 'text-delta'; text: string }
  /** Claude Code took one of your messages into the conversation (its echo, with the uuid sent). */
  | { kind: 'received'; uuid: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: ToolUse }
  /** `data`: the result's structured form, when Claude Code sends one (tool_use_result: CronCreate's id and next run). */
  | { kind: 'tool-result'; id: string; text: string; isError: boolean; data?: unknown }
  | { kind: 'status'; text: string }
  | { kind: 'mode'; mode: string }
  | { kind: 'result'; text: string; isError: boolean; usage: Usage; costUsd: number; durationMs: number; sessionId: string; contextWindow?: number }
  | { kind: 'rate'; info: Record<string, unknown> }
  | { kind: 'usage'; usage: Usage }
  | { kind: 'output-tokens'; tokens: number }
  | { kind: 'permission'; requestId: string; tool: string; input: Record<string, unknown> }
  /** Claude asks the user multiple-choice questions (its AskUserQuestion tool): answered with answerAsk. */
  | { kind: 'ask'; requestId: string; input: Record<string, unknown> }
  | { kind: 'exit'; code: number | null; stderr: string }
  /** A subagent's own step: the Agent call it runs under, and the tool it used. */
  | { kind: 'agent-step'; parent: string; tool: ToolUse }
  /** A subagent's words, and its tools' results. */
  | { kind: 'agent-text'; parent: string; text: string }
  | { kind: 'agent-tool-result'; parent: string; id: string; text: string; isError: boolean; data?: unknown }
  /** A scheduled job fired (CronCreate, ScheduleWakeup): Claude Code starts a turn of its own, with no message of yours. */
  | { kind: 'fired'; source: string }
  /**
   * Background task news from Claude Code: started, progress, a change (updated: its status, or that it
   * went to the background), or finished (status). `type`: local_agent, local_bash (a background shell
   * command)…; `outputFile`: where a shell command's output goes.
   */
  | { kind: 'task'; phase: 'started' | 'progress' | 'updated' | 'done'; taskId: string; toolUseId?: string; status?: string; text?: string; lastTool?: string; type?: string; isBackgrounded?: boolean; outputFile?: string; parentTaskId?: string }
  /** Every background task Claude Code runs now (background_tasks_changed, sent on each change): their ids. */
  | { kind: 'live-tasks'; ids: string[] }

export type McpServer = { name: string; status: string }
export type CommandInfo = { name: string; description?: string; argumentHint?: string }
/** What Claude Code tells the host as it starts (the parts the app uses). */
export type Hello = {
  commands?: CommandInfo[]
  account?: { email?: string; subscriptionType?: string; apiProvider?: string; organization?: string; tokenSource?: string; apiKeySource?: string }
  claude_code_version?: string
  output_style?: string
  models?: { value: string; resolvedModel?: string; displayName?: string; description?: string; supportsEffort?: boolean; supportedEffortLevels?: string[] }[]
}

/** A control request's answer: Claude Code's response, or why there is none (`code`: Claude Code's error_code). */
export type Answer = { ok: true; response: any } | { ok: false; error: string; code?: string }

export type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

export type Options = { args: string[]; cwd: string; appendSystemPrompt: string }

export class Claude {
  private proc: ChildProcessWithoutNullStreams
  private buf = ''
  private stderr = ''
  private onEvent: (e: ClaudeEvent) => void
  /** The app's own control requests waiting for Claude Code's answer, by request id. */
  private answers = new Map<string, (response: any) => void>()
  constructor(opts: Options, onEvent: (e: ClaudeEvent) => void) {
    this.onEvent = onEvent
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      // Each message you send comes back once Claude Code takes it in: at once when idle, at
      // Claude's next step when sent mid-turn. The app's "received" mark.
      '--replay-user-messages',
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
    // Its answer holds Claude Code's commands with their descriptions, the account and the version (/help, /status).
    const hello = randomUUID()
    this.answers.set(hello, r => {
      this.answers.delete(hello)
      if (r?.subtype === 'success' && r.response) this.onEvent({ kind: 'hello', info: r.response })
    })
    this.write({ type: 'control_request', request_id: hello, request: { subtype: 'initialize', hooks: null } })
  }

  /** `done`: once it is written to Claude Code (never when Claude Code is gone). */
  private write(obj: unknown, done?: () => void) {
    if (!this.proc.stdin.writable) return
    this.proc.stdin.write(JSON.stringify(obj) + '\n', err => {
      if (!err) done?.()
    })
  }

  /** A user message; `hidden` goes along as a second text block Claude reads and the app never shows. */
  send(text: string, hidden?: string, images: { media: string; data: string }[] = [], uuid?: string, sent?: () => void) {
    const blocks = [
      ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.media, data: i.data } })),
      { type: 'text', text },
      ...(hidden ? [{ type: 'text', text: hidden }] : []),
    ]
    const content = blocks.length > 1 ? blocks : text
    this.write({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '', ...(uuid ? { uuid } : {}) }, sent)
  }

  /** default, acceptEdits, plan, bypassPermissions…: Claude Code answers with a status event. */
  setMode(mode: string) {
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'set_permission_mode', mode } })
  }

  /**
   * Takes back a message Claude Code has queued and not taken in yet (sent with `uuid`), with its
   * cancel_async_message control request. `done(true)`: Claude Code dropped it, so Claude never sees
   * it. `done(false)`: it was taken in already, or this Claude Code can't (an error, or no answer in 3 s).
   */
  cancelQueued(uuid: string, done: (cancelled: boolean) => void) {
    const id = randomUUID()
    let isOver = false
    const end = (cancelled: boolean) => {
      if (isOver) return
      isOver = true
      this.answers.delete(id)
      done(cancelled)
    }
    this.answers.set(id, r => end(r?.subtype === 'success' && r.response?.cancelled === true))
    setTimeout(() => end(false), 3000).unref()
    if (!this.proc.stdin.writable) return end(false)
    this.write({ type: 'control_request', request_id: id, request: { subtype: 'cancel_async_message', message_uuid: uuid } })
  }

  /**
   * Claude Code reloads its plugins, skills, agents and hooks (the reload_plugins control request, as
   * /reload-plugins does). `done`: its answer, or the error (busy, gone, or no answer in 30 s).
   */
  reloadPlugins(done: (r: { ok: true; plugins: number; commands: number; errors: number } | { ok: false; error: string }) => void) {
    const id = randomUUID()
    let isOver = false
    const end = (r: Parameters<typeof done>[0]) => {
      if (isOver) return
      isOver = true
      this.answers.delete(id)
      done(r)
    }
    this.answers.set(id, r => {
      // Its commands now: a plugin's own come with it (/help lists them).
      if (r?.subtype === 'success' && Array.isArray(r.response?.commands)) this.onEvent({ kind: 'commands', commands: r.response.commands })
      end(r?.subtype === 'success'
        ? { ok: true, plugins: r.response?.plugins?.length ?? 0, commands: r.response?.commands?.length ?? 0, errors: Number(r.response?.error_count ?? 0) }
        : { ok: false, error: String(r?.error ?? 'Claude Code refused') })
    })
    setTimeout(() => end({ ok: false, error: 'no answer from Claude Code' }), 30_000).unref()
    if (!this.proc.stdin.writable) return end({ ok: false, error: 'Claude Code is not running' })
    this.write({ type: 'control_request', request_id: id, request: { subtype: 'reload_plugins' } })
  }

  /**
   * Switches the model on the running Claude Code (set_model, as the Agent SDK's setModel): the
   * conversation goes on, the next request on the new model. Its answer holds the model id it runs.
   */
  setModel(model: string, done: (r: Answer) => void) {
    this.control({ subtype: 'set_model', model }, 10_000, done)
  }

  /** The effort level from now on (low…max), as a flag setting: it lasts as long as this Claude Code. */
  setEffort(level: string, done: (r: Answer) => void) {
    this.control({ subtype: 'apply_flag_settings', settings: { effortLevel: level } }, 10_000, done)
  }

  /** Claude Code's settings: `applied` holds the model and effort it runs with now. */
  settings(done: (r: Answer) => void) {
    this.control({ subtype: 'get_settings' }, 10_000, done)
  }

  /** A control request of the app's own; `done` once, with the answer or the error (gone, or no answer in `ms`). */
  private control(request: Record<string, unknown>, ms: number, done: (r: Answer) => void) {
    const id = randomUUID()
    let isOver = false
    const end = (r: Answer) => {
      if (isOver) return
      isOver = true
      this.answers.delete(id)
      done(r)
    }
    this.answers.set(id, r => end(r?.subtype === 'success' ? { ok: true, response: r.response ?? {} } : { ok: false, error: String(r?.error ?? 'Claude Code refused'), ...(r?.error_code ? { code: String(r.error_code) } : {}) }))
    setTimeout(() => end({ ok: false, error: 'no answer from Claude Code' }), ms).unref()
    if (!this.proc.stdin.writable) return end({ ok: false, error: 'Claude Code is not running' })
    this.write({ type: 'control_request', request_id: id, request })
  }

  interrupt() {
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })
  }

  answerPermission(requestId: string, allow: boolean, input: Record<string, unknown>) {
    this.respond(requestId, allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user denied this.' })
  }

  /**
   * Answers AskUserQuestion: the tool runs with `input` (the questions plus their `answers`), or, with
   * `dismissed`, it is refused with that message for Claude.
   */
  answerAsk(requestId: string, input: Record<string, unknown>, dismissed?: string) {
    this.respond(requestId, dismissed ? { behavior: 'deny', message: dismissed } : { behavior: 'allow', updatedInput: input })
  }

  private respond(requestId: string, response: Record<string, unknown>) {
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
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
            ...(e.claude_code_version ? { version: String(e.claude_code_version) } : {}),
            ...(Array.isArray(e.mcp_servers) ? { mcpServers: e.mcp_servers.map((m: any) => ({ name: String(m?.name ?? ''), status: String(m?.status ?? '') })) } : {}),
            ...(e.apiKeySource ? { apiKeySource: String(e.apiKeySource) } : {}),
            ...(e.output_style ? { outputStyle: String(e.output_style) } : {}),
          })
        else if (e.subtype === 'commands_changed' && Array.isArray(e.commands)) emit({ kind: 'commands', commands: e.commands })
        else if (e.subtype === 'status') {
          if (typeof e.status === 'string') emit({ kind: 'status', text: e.status })
          // The permission mode changed: Shift+Tab here, or Claude entering or leaving plan mode.
          if (typeof e.permissionMode === 'string') emit({ kind: 'mode', mode: e.permissionMode })
        }
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
            ...(e.task_type ? { type: String(e.task_type) } : {}),
            ...(typeof e.is_backgrounded === 'boolean' ? { isBackgrounded: e.is_backgrounded } : {}),
            ...(e.output_file ? { outputFile: String(e.output_file) } : {}),
            // An agent's own task (its background command): the agent's id.
            ...(e.parent_task_id ? { parentTaskId: String(e.parent_task_id) } : {}),
          })
        else if (e.subtype === 'background_tasks_changed' && Array.isArray(e.tasks))
          emit({ kind: 'live-tasks', ids: e.tasks.map((x: any) => String(x?.task_id ?? '')).filter(Boolean) })
        else if (e.subtype === 'task_updated' && e.patch && typeof e.patch === 'object')
          emit({
            kind: 'task',
            phase: 'updated',
            taskId: String(e.task_id ?? ''),
            ...(e.patch.status ? { status: String(e.patch.status) } : {}),
            ...(typeof e.patch.is_backgrounded === 'boolean' ? { isBackgrounded: e.patch.is_backgrounded } : {}),
          })
        return
      case 'stream_event': {
        if (e.parent_tool_use_id) return // a subagent's stream
        const ev = e.event
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') emit({ kind: 'text-delta', text: ev.delta.text })
        // The reply's real output count comes at its end (the assistant event carries the count from its start).
        if (ev?.type === 'message_delta' && typeof ev.usage?.output_tokens === 'number') emit({ kind: 'output-tokens', tokens: ev.usage.output_tokens })
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
        if (e.isReplay) {
          if (e.uuid) emit({ kind: 'received', uuid: String(e.uuid) })
          return
        }
        const content = e.message?.content
        if (!Array.isArray(content)) return
        for (const b of content) {
          if (b.type !== 'tool_result') continue
          const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') : ''
          // The structured result covers the event's one tool result (Claude Code sends one per event).
          const data = content.length === 1 && e.tool_use_result != null ? { data: e.tool_use_result } : {}
          if (e.parent_tool_use_id) emit({ kind: 'agent-tool-result', parent: String(e.parent_tool_use_id), id: b.tool_use_id, text, isError: !!b.is_error, ...data })
          else emit({ kind: 'tool-result', id: b.tool_use_id, text, isError: !!b.is_error, ...data })
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
      case 'command_lifecycle':
        // A turn Claude Code starts by itself: a scheduled job's prompt (it names no job, and the prompt isn't streamed).
        if (e.state === 'started' && e.wakeup_source) emit({ kind: 'fired', source: String(e.wakeup_source) })
        return
      case 'rate_limit_event':
        emit({ kind: 'rate', info: e.rate_limit_info ?? {} })
        return
      case 'control_response':
        this.answers.get(String(e.response?.request_id ?? ''))?.(e.response)
        return
      case 'control_request':
        if (e.request?.subtype === 'can_use_tool' && e.request.tool_name === 'AskUserQuestion')
          emit({ kind: 'ask', requestId: e.request_id, input: e.request.input ?? {} })
        else if (e.request?.subtype === 'can_use_tool')
          emit({ kind: 'permission', requestId: e.request_id, tool: e.request.tool_name, input: e.request.input ?? {} })
        else this.respond(e.request_id, {})
        return
    }
  }
}
