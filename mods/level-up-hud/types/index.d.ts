export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Hud = {
  model: string
  effort: string
  limits: Limit[]
  contextPct: number | null
  costUsd: number
}
export type Progress = { xp: number; day: string; turnsToday: number; toolsToday: number }

declare module 'claude-code' {
  interface PluginState {
    'level-up-hud': { hud: Shaped<Hud>; progress: Shaped<Progress> }
  }
}
