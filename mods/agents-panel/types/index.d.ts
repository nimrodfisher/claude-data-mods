export type AgentState = 'running' | 'needs_input' | 'done' | 'error'

export type AgentEventKind = 'prompt' | 'tool' | 'notify' | 'subagent' | 'stop' | 'error'
export type AgentEvent = { at: string; kind: AgentEventKind; text: string }

/** What one session writes to `~/.claude/agents-status/<session_id>.json`. */
export type AgentStatus = {
  session_id: string
  title: string
  prompt: string
  cwd: string
  repo: string
  branch: string
  surface: string
  status: AgentState
  started_at: string
  last_event_at: string
  /** When the current turn began: "18m elapsed" while running, "22m run" once done. */
  turn_started_at: string | null
  stopped_at: string | null
  ended_at: string | null
  waiting_since: string | null
  waiting_on: string | null
  /** The request a needs-input row shows in full: "Claude wants to run" + "npm run migrate". */
  request: { label: string; text: string } | null
  error: string | null
  last_activity: string
  tool_calls: number
  subagents: { started: number; done: number }
  files: string[]
  files_changed: number
  model: string
  effort: string | null
  tokens: { input: number; output: number; cache_read: number; cache_write: number; total: number }
  context_pct: number | null
  events: AgentEvent[]
}

/** What the pane draws from: every session's status, read from the folder. */
export type Snapshot = { now: number; selfId: string; agents: AgentStatus[] }

export type Filter = 'all' | 'needs' | 'running' | 'done'
export type PanelView = { filter: Filter; selected: string | null }

declare module 'claude-code' {
  interface PluginState {
    'agents-panel': {
      snap: Shaped<Snapshot>
      view: Shaped<PanelView>
    }
  }
}
