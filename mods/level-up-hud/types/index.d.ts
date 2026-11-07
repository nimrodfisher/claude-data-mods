export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Hud = {
  model: string
  effort: string
  limits: Limit[]
  contextPct: number | null
  costUsd: number
}
export type Progress = { xp: number; day: string; turnsToday: number; toolsToday: number }

/** One whole-file read: the tokens of its biggest result and how often it was read. */
export type FileRead = { path: string; tokens: number; count: number; isRanged: boolean }
/** One long Bash result. */
export type LongOutput = { command: string; tokens: number }
/** One MCP server whose tool schemas sit in the context window. */
export type McpServer = { name: string; tokens: number; tools: string[] }

/** What the waste detector has seen this session. */
export type Waste = {
  reads: FileRead[]
  outputs: LongOutput[]
  servers: McpServer[]
  usedTools: string[]
}

/** The pane's own view state: which tip is open, and what was dismissed. */
export type TipsView = {
  open: string | null
  showAll: boolean
  dismissed: string[]
  shown: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'level-up-hud': {
      hud: Shaped<Hud>
      progress: Shaped<Progress>
      waste: Shaped<Waste>
      tips: Shaped<TipsView>
    }
  }
}
