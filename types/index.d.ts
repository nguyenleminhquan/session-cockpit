export type Agent = {
  id: string
  description: string
  model: string
  startedAt: number
  endedAt: number | null
}
export type Turn = { seconds: number; tools: number; files: number }
export type Limit = { kind: string; percent: number }
export type Hud = {
  folder: string
  branch: string | null
  percent: number | null
  usd: number | null
  limits: Limit[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-cockpit': {
      agents: Shaped<Agent[]>
      last: Shaped<Turn | null>
      spawnedCount: number
      hud: Shaped<Hud | null>
      now: number
    }
  }
}
