import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { AgentEventKind, AgentState, AgentStatus, Filter, PanelView, Snapshot } from '../types'

type Engine = EngineInterface

const PANE = 'agents-panel'
const TITLE = 'Agents'
const POLL_MS = 2000
const STALE_MS = 10 * 60_000 // running with no event for this long reads as stale
const ENDED_KEEP_MS = 60 * 60_000 // a closed session stays under Done this long
const READ_WINDOW_MS = 24 * 3_600_000 // files untouched for longer are not read
const MAX_EVENTS = 20
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const AGENT_TOOLS = new Set(['Agent', 'Task'])

const snap = atom({ plugin: 'agents-panel', key: 'snap' } as const, { now: 0, selfId: '', agents: [] }, { shape: 'snap-1' })
const view = atom({ plugin: 'agents-panel', key: 'view' } as const, { filter: 'all', selected: null }, { shape: 'view-1' })

// ── small helpers ────────────────────────────────────────────
const slash = (p: string) => p.replace(/\\/g, '/')
const baseName = (p: string) => slash(p).replace(/\/$/, '').split('/').pop() || p
const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`
}
const relTo = (cwd: string, p: string) => {
  const root = slash(cwd).replace(/\/$/, '') + '/'
  const s = slash(p)
  return s.startsWith(root) ? s.slice(root.length) : s
}
const tildePath = (p: string, home: string) => (home && slash(p).startsWith(slash(home)) ? `~${slash(p).slice(slash(home).length)}` : p)
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN)

export const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

export const fmtAgo = (d: number) => {
  const s = Math.max(0, Math.round(d / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

const hhmm = (t: number) => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const prettyModel = (m: string) => {
  if (!m) return '—'
  return m
    .replace(/^claude-/, '')
    .replace(/\[.*\]$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .replace(/^\w/, c => c.toUpperCase())
}

const SURFACE_LABEL: Record<string, string> = { terminal: 'Terminal', desktop: 'Desktop', vscode: 'VS Code', mobile: 'Mobile' }

/** `<Tool> <main arg>`: `Edit src/a.ts`, `Bash npm test`. */
export function activityOf(tool: string, input: unknown, cwd: string): string {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const path = str('file_path') || str('notebook_path') || str('path')
  const arg = path
    ? relTo(cwd, path)
    : str('command') || str('pattern') || str('url') || str('query') || str('description') || str('prompt') || str('skill')
  const name = tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' ') : tool
  return clip(arg ? `${name} ${arg}` : name, 90)
}

// ── the status file ──────────────────────────────────────────
let dirCache = ''
let homeCache = ''
async function statusDir($: Engine) {
  if (dirCache) return dirCache
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
  homeCache = home
  dirCache = `${slash(config).replace(/\/$/, '')}/agents-status`
  return dirCache
}

export function blank(id: string, cwd: string, at: string): AgentStatus {
  return {
    session_id: id,
    title: '',
    prompt: '',
    cwd,
    repo: baseName(cwd),
    branch: '',
    surface: '',
    status: 'done',
    started_at: at,
    last_event_at: at,
    turn_started_at: null,
    stopped_at: null,
    ended_at: null,
    waiting_since: null,
    waiting_on: null,
    request: null,
    error: null,
    last_activity: 'Started',
    tool_calls: 0,
    subagents: { started: 0, done: 0 },
    files: [],
    files_changed: 0,
    model: '',
    effort: null,
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 },
    context_pct: null,
    events: [],
  }
}

/** Fills what an older or partial file lacks, so the pane never trips on it. */
export function normalize(raw: unknown): AgentStatus | null {
  const r = raw as Partial<AgentStatus> | null
  if (!r || typeof r.session_id !== 'string') return null
  const b = blank(r.session_id, r.cwd ?? '', r.started_at ?? new Date(0).toISOString())
  return {
    ...b,
    ...r,
    subagents: { ...b.subagents, ...(r.subagents ?? {}) },
    tokens: { ...b.tokens, ...(r.tokens ?? {}) },
    files: Array.isArray(r.files) ? r.files : [],
    events: Array.isArray(r.events) ? r.events : [],
  }
}

// One record per session, this process's own. Writes go one after another.
let rec: AgentStatus | null = null
let writing: Promise<void> = Promise.resolve()

type Base = { session_id: string; cwd: string; effort?: { level: string } }

async function gitInfo($: Engine, cwd: string) {
  let repo = baseName(cwd)
  let branch = ''
  try {
    const r = await $.session.repo()
    if (r) repo = baseName(r.root)
  } catch {}
  try {
    const g = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 2000 })
    if (g.exitCode === 0) branch = g.stdout.trim()
  } catch {}
  return { repo, branch }
}

async function load($: Engine, e: Base, at: string): Promise<AgentStatus> {
  const dir = await statusDir($)
  try {
    const found = normalize(JSON.parse(await $.fs.read(`${dir}/${e.session_id}.json`)))
    if (found && found.session_id === e.session_id) return found
  } catch {}
  const r = blank(e.session_id, e.cwd, at)
  try {
    const surfaces = await $.session.surfaces()
    const pick = ['vscode', 'desktop', 'mobile', 'terminal'].find(s => surfaces.includes(s as never))
    r.surface = pick ?? ''
  } catch {}
  try {
    r.model = await $.session.model()
  } catch {}
  Object.assign(r, await gitInfo($, e.cwd))
  return r
}

function addEvent(r: AgentStatus, at: string, kind: AgentEventKind, text: string) {
  r.events = [...r.events, { at, kind, text: clip(text, 140) }].slice(-MAX_EVENTS)
}

function wait(r: AgentStatus, at: string, on: string, request: AgentStatus['request']) {
  if (r.status !== 'needs_input') r.waiting_since = at
  r.status = 'needs_input'
  r.waiting_on = on
  r.request = request
}

function resume(r: AgentStatus) {
  r.status = 'running'
  r.waiting_on = null
  r.waiting_since = null
  r.request = null
}

/** Applies `fn` to this session's record and writes it. Never throws, never blocks Claude for long. */
async function touch($: Engine, e: Base, fn: (r: AgentStatus, at: string) => void | Promise<void>) {
  try {
    const at = new Date(await $.clock.now()).toISOString()
    if (!rec || rec.session_id !== e.session_id) rec = await load($, e, at)
    const r = rec
    await fn(r, at)
    r.last_event_at = at
    if (e.effort?.level) r.effort = e.effort.level
    const dir = await statusDir($)
    const text = JSON.stringify(r)
    writing = writing.then(() => $.fs.write(`${dir}/${r.session_id}.json`, text)).catch(() => {})
    await writing
  } catch {}
}

/** This session's id and directory, for hooks whose input carries neither. */
async function selfBase($: Engine): Promise<Base | null> {
  try {
    return { session_id: await $.session.id(), cwd: rec?.cwd || (await $.session.cwd()) }
  } catch {
    return null
  }
}

async function contextPct($: Engine) {
  try {
    const p = (await $.session.usage()).context.percent
    return typeof p === 'number' ? Math.round(p) : null
  } catch {
    return null
  }
}

// ── what the pane shows ──────────────────────────────────────
export type Shown = { r: AgentStatus; state: AgentState; isStale: boolean }

export function shownOf(r: AgentStatus, now: number): Shown | null {
  if (!r.prompt && !r.title && r.tool_calls === 0) return null // opened, nothing asked yet
  if (r.ended_at && now - ms(r.ended_at) > ENDED_KEEP_MS) return null
  if (r.ended_at && r.status !== 'error') return { r, state: 'done', isStale: false }
  if (r.status === 'running' && now - ms(r.last_event_at) > STALE_MS) return { r, state: 'error', isStale: true }
  return { r, state: r.status, isStale: false }
}

export function sections(agents: AgentStatus[], now: number) {
  const shown = agents.map(a => shownOf(a, now)).filter((s): s is Shown => s !== null)
  const needs = shown
    .filter(s => s.state === 'needs_input')
    .sort((a, b) => ms(a.r.waiting_since ?? a.r.last_event_at) - ms(b.r.waiting_since ?? b.r.last_event_at))
  const running = shown.filter(s => s.state === 'running').sort((a, b) => ms(b.r.last_event_at) - ms(a.r.last_event_at))
  const done = shown
    .filter(s => s.state === 'done' || s.state === 'error')
    .sort((a, b) => ms(b.r.stopped_at ?? b.r.last_event_at) - ms(a.r.stopped_at ?? a.r.last_event_at))
  return { needs, running, done, all: shown }
}

export function timeLabel(s: Shown, now: number) {
  const r = s.r
  if (s.state === 'needs_input') return `waiting ${fmtAgo(now - ms(r.waiting_since ?? r.last_event_at))}`
  if (s.state === 'running') return `${fmtAgo(now - ms(r.last_event_at))} ago`
  const t = ms(r.stopped_at ?? r.last_event_at)
  return `${hhmm(t)} · ${fmtAgo(now - t)} ago`
}

export function activityLabel(s: Shown, now: number) {
  const r = s.r
  if (s.state === 'needs_input') return r.waiting_on ?? 'Waiting for you'
  if (s.state === 'running') return r.last_activity
  if (s.isStale) return `No activity for ${fmtAgo(now - ms(r.last_event_at))} · stale`
  if (s.state === 'error') return `Stopped: ${r.error ?? 'error'}`
  const run = r.turn_started_at && r.stopped_at ? ` · ${fmtAgo(ms(r.stopped_at) - ms(r.turn_started_at))} run` : ''
  const files = r.files_changed > 0 ? ` · ${r.files_changed} file${r.files_changed === 1 ? '' : 's'} changed` : ''
  return `${r.ended_at ? 'Closed' : 'Finished'}${files}${run}`
}

const startOfDay = (now: number) => {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// ── icons: shape and color, never color alone ────────────────
const HEX: Record<AgentState, string> = { needs_input: '#B45309', running: '#1D4ED8', done: '#15803D', error: '#B91C1C' }
const TONE: Record<AgentState, string> = { needs_input: 'warning', running: 'suggestion', done: 'success', error: 'error' }
const GLYPH: Record<AgentState, string> = { needs_input: '!', running: '◐', done: '✓', error: '✕' }
const ALT: Record<AgentState, string> = { needs_input: 'Needs input', running: 'Running', done: 'Completed', error: 'Stopped with error' }
const PATHS: Record<AgentState, string> = {
  needs_input: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><path d="M12 16.5v.5"/>',
  running: '<path d="M21 12a9 9 0 1 1-9-9"/>',
  done: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
}
const iconSvg = (s: AgentState) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${HEX[s]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PATHS[s]}</svg>`
const HAIRLINE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="380" height="1" viewBox="0 0 380 1" preserveAspectRatio="none"><rect width="380" height="1" fill="#E5E2D8"/></svg>'
const EVENT_TONE: Record<AgentEventKind, string> = {
  prompt: 'suggestion',
  tool: 'inactive',
  notify: 'warning',
  subagent: 'success',
  stop: 'success',
  error: 'error',
}

// ── reader: every session's file, every 2 seconds ──
const cache = new Map<string, { mtime: number; rec: AgentStatus }>()
let badge: string | undefined

async function poll($: Engine) {
  try {
    const dir = await statusDir($)
    const now = await $.clock.now()
    const selfId = await $.session.id()
    let entries: Awaited<ReturnType<Engine['fs']['list']>> = []
    try {
      entries = await $.fs.list(dir)
    } catch {}
    const seen = new Set<string>()
    for (const f of entries) {
      if (f.kind !== 'file' || !f.name.endsWith('.json') || now - f.mtimeMs > READ_WINDOW_MS) continue
      const id = f.name.slice(0, -5)
      seen.add(id)
      if (cache.get(id)?.mtime === f.mtimeMs) continue
      try {
        const r = normalize(JSON.parse(await $.fs.read(`${dir}/${f.name}`)))
        if (r) cache.set(id, { mtime: f.mtimeMs, rec: r })
      } catch {} // caught mid-write: the last good read stands
    }
    for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id)
    const cleared = ((await $.store.get('cleared')) ?? {}) as Record<string, string>
    const agents = [...cache.values()]
      .map(c => c.rec)
      .filter(r => {
        const at = cleared[r.session_id]
        return !(at && at >= r.last_event_at)
      })
    await update($, snap, () => ({ now, selfId, agents }))

    const waiting = sections(agents, now).needs.filter(s => s.r.session_id !== selfId).length
    const next = waiting > 0 ? `${waiting} agent${waiting === 1 ? ' needs' : 's need'} you` : undefined
    if (next !== badge) {
      badge = next
      $.ui.status(next)
    }
  } catch {}
}

async function clearFinished($: Engine) {
  const { agents, now } = await read($, snap)
  const done = sections(agents, now).done.map(s => s.r)
  if (done.length === 0) return
  const dir = await statusDir($)
  try {
    await $.process.run(['rm', '-f', ...done.map(r => `${dir}/${r.session_id}.json`)], { timeoutMs: 3000 })
  } catch {}
  // Also hidden by id, for where rm is missing; a session that acts again shows again.
  const cleared = ((await $.store.get('cleared')) ?? {}) as Record<string, string>
  for (const r of done) cleared[r.session_id] = r.last_event_at
  const cutoff = new Date(now - 7 * READ_WINDOW_MS).toISOString()
  for (const [id, at] of Object.entries(cleared)) if (at < cutoff) delete cleared[id]
  await $.store.set('cleared', cleared)
  await poll($)
}

// ── the module ───────────────────────────────────────────────
export const register: Register = on => {
  // ── writer: this session's status file, from native events only ──
  // (Classic hook events can be skipped by an organization's security plugin.)
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && rec) {
      if (e.model) rec.model = e.model
      if (typeof e.effort === 'string') rec.effort = e.effort
    }
    return yield* next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta && !e.command && e.text.trim()) {
      const self = await selfBase($)
      if (self) {
        await touch($, self, async (r, at) => {
          if (!r.title) r.title = clip(e.text, 60)
          r.prompt = e.text.slice(0, 2000)
          addEvent(r, at, 'prompt', `Prompt: “${clip(e.text, 80)}”`)
          Object.assign(r, await gitInfo($, r.cwd))
        })
      }
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const self = await selfBase($)
      if (self) {
        await touch($, self, (r, at) => {
          if (!r.prompt && e.text.trim()) {
            r.prompt = e.text.slice(0, 2000)
            if (!r.title) r.title = clip(e.text, 60)
          }
          resume(r)
          r.turn_started_at = at
          r.stopped_at = null
          r.ended_at = null
          r.error = null
          r.last_activity = 'Thinking'
        })
      }
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const self = await selfBase($)
    const tool = String(e.tool)
    if (self) {
      await touch($, self, (r, at) => {
        const act = activityOf(tool, e, r.cwd)
        r.tool_calls += 1
        r.last_activity = act
        addEvent(r, at, 'tool', act)
        if (AGENT_TOOLS.has(tool)) r.subagents = { ...r.subagents, started: r.subagents.started + 1 }
        if (tool === 'AskUserQuestion') {
          const qs = (e as { questions?: readonly { question?: string }[] }).questions ?? []
          const q = qs[0]?.question ?? 'A question for you'
          wait(r, at, `Asked: “${clip(q, 80)}”`, { label: 'Claude asks', text: q })
        } else if (r.status !== 'needs_input') {
          r.status = 'running'
        }
      })
    }
    const ran = await next(e)
    if (self) {
      const pct = await contextPct($)
      await touch($, self, r => {
        if (r.status === 'needs_input' || r.status === 'done') resume(r)
        const f = (e as { file_path?: string; notebook_path?: string }).file_path ?? (e as { notebook_path?: string }).notebook_path
        if (EDIT_TOOLS.has(tool) && f && !ran.deny && !ran.isError && !r.files.includes(f)) {
          r.files = [...r.files, f].slice(-500)
          r.files_changed = r.files.length
        }
        if (pct !== null) r.context_pct = pct
      })
    }
    return ran
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool !== 'AskUserQuestion') {
      const self = await selfBase($)
      if (self) {
        await touch($, self, (r, at) => {
          const act = activityOf(e.tool, e.input, r.cwd)
          const arg = act.slice(e.tool.length).trim()
          const isRun = e.tool === 'Bash'
          wait(r, at, `Permission: ${isRun ? `run ${arg}` : act}`, {
            label: isRun ? 'Claude wants to run' : `Claude wants to use ${e.tool}`,
            text: arg || e.tool,
          })
          addEvent(r, at, 'notify', `Waiting for permission: ${isRun ? arg : act}`)
        })
      }
    }
    return verdict
  })

  on('turn.complete', async ($, e, next) => {
    const self = await selfBase($)
    if (self) {
      const pct = e.agentId === undefined ? await contextPct($) : null
      await touch($, self, (r, at) => {
        const u = e.usage
        if (u) {
          const t = r.tokens
          t.input += u.input_tokens
          t.output += u.output_tokens
          t.cache_read += u.cache_read_input_tokens
          t.cache_write += u.cache_creation_input_tokens
          t.total = t.input + t.output + t.cache_read + t.cache_write
          if (u.model && e.agentId === undefined) r.model = u.model
        }
        if (e.agentId !== undefined) {
          r.subagents = { ...r.subagents, done: Math.min(r.subagents.started, r.subagents.done + 1) }
          addEvent(r, at, 'subagent', 'Subagent finished')
          return
        }
        if (pct !== null) r.context_pct = pct
        resume(r)
        r.stopped_at = at
        if (e.reason === 'error' || e.reason === 'refusal') {
          r.status = 'error'
          r.error = e.reason === 'refusal' ? 'The model declined the request' : 'API error'
          r.last_activity = `Stopped: ${r.error}`
          addEvent(r, at, 'error', `Stopped: ${r.error}`)
          return
        }
        r.status = 'done'
        r.last_activity = e.reason === 'aborted' ? 'Interrupted' : 'Finished'
        addEvent(r, at, 'stop', e.reason === 'aborted' ? 'Interrupted' : 'Turn finished')
        // A turn that ends on a question waits on the person.
        const last = (e.answer ?? '').trim()
        if (e.reason === 'answer' && last.endsWith('?')) {
          const q = last.split(/(?<=[.!?])\s+/).pop() ?? last
          wait(r, at, `Asked: “${clip(q, 80)}”`, { label: 'Claude asks', text: q })
        }
      })
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await touch($, { session_id: e.sessionId, cwd: rec?.cwd ?? '' }, (r, at) => {
      r.ended_at = at
      if (r.status === 'running' || r.status === 'needs_input') {
        resume(r)
        r.status = 'done'
        r.stopped_at = at
      }
      addEvent(r, at, 'stop', 'Session closed')
    })
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'agents-panel', description: 'Open the Agents panel: every running Claude Code session' })
    } catch {}
    void $.ui.open({ id: PANE, title: TITLE })
    const self = await selfBase($)
    if (self) await touch($, self, () => {})
    void poll($)
    $.clock.every(POLL_MS, () => poll($))
    return next(e)
  })

  on('command.run', { command: 'agents-panel' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await poll($)
    return { text: 'Agents panel opened.' }
  })

  // ── the pane ──
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const isTerm = e.surface === 'terminal'
    const Svg = e.surface === 'terminal' ? null : $.ui.resolve(e).Svg
    const s = await read($, snap)
    const v = await read($, view)
    const now = s.now || (await $.clock.now())
    const setView = (fn: (x: PanelView) => PanelView) => update($, view, fn)
    const sec = sections(s.agents, now)
    const padX = isTerm ? 1 : 2
    const cols = e.props.bodyColumns || e.viewport?.columns || 44
    const padY = isTerm ? 0 : 1

    const Icon = (p: { state: AgentState }) =>
      Svg ? (
        <Svg source={iconSvg(p.state)} alt={ALT[p.state]} width={18} height={18} />
      ) : (
        <Text color={TONE[p.state]} bold>
          {GLYPH[p.state]}
        </Text>
      )
    const Rule = () => (Svg ? <Svg source={HAIRLINE} alt="" height={1} /> : null)
    const Small = (p: { children?: unknown; mono?: boolean; color?: string; dim?: boolean }) => (
      <Text size="footnote" mono={p.mono} color={p.color} dimColor={p.dim} wrap="truncate-end">
        {p.children as string}
      </Text>
    )

    const resumeCmd = (r: AgentStatus) => `cd '${r.cwd.replace(/'/g, "'\\''")}' && claude --resume ${r.session_id}`
    const copyResume = async (r: AgentStatus) => {
      const done = await $.ui.copy({ text: resumeCmd(r), surface: e.surface })
      $.ui.toast(done.isCopied ? 'Resume command copied · run it in a terminal to open that session' : `Run: ${resumeCmd(r)}`)
    }

    const pills = (r: AgentStatus) => [prettyModel(r.model), `effort: ${r.effort ?? '—'}`, `${fmtTokens(r.tokens.total)} tokens`]
    const Pills = (p: { r: AgentStatus }) =>
      isTerm ? (
        <Small dim>{pills(p.r).join(' · ')}</Small>
      ) : (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {pills(p.r).map(t => (
            <Box borderStyle="single" borderColor="inactive" paddingX={1}>
              <Text size="caption">{t}</Text>
            </Box>
          ))}
        </Box>
      )

    // ── detail view ──
    const picked = v.selected ? sec.all.find(x => x.r.session_id === v.selected) : undefined
    if (picked) {
      const r = picked.r
      const isSelf = r.session_id === s.selfId
      const head =
        picked.state === 'needs_input'
          ? `Needs your input · ${fmtAgo(now - ms(r.waiting_since ?? r.last_event_at))}`
          : picked.state === 'running'
            ? `Running · ${fmtAgo(now - ms(r.last_event_at))} ago`
            : picked.state === 'error'
              ? picked.isStale
                ? 'Stale'
                : 'Stopped with error'
              : 'Done'
      const where = [tildePath(r.cwd, homeCache), r.branch ? `branch ${r.branch}` : '', isSelf ? 'this window' : SURFACE_LABEL[r.surface] ?? '']
        .filter(Boolean)
        .join(' · ')
      const t = r.tokens
      const kv: [string, string, boolean?][] = [
        ['Model', prettyModel(r.model)],
        ['Effort', r.effort ?? '—'],
        ['Tokens', `${fmtTokens(t.total)} total`],
        ['Input / output', `${fmtTokens(t.input)} / ${fmtTokens(t.output)}`, true],
        ['Cache read / write', `${fmtTokens(t.cache_read)} / ${fmtTokens(t.cache_write)}`, true],
        ['Context used', r.context_pct === null ? '—' : `${r.context_pct}% of window`],
        ['Started', hhmm(ms(r.started_at))],
        [
          'Stopped',
          picked.state === 'needs_input'
            ? `${hhmm(ms(r.waiting_since ?? r.last_event_at))} (waiting)`
            : picked.state === 'running'
              ? '—'
              : hhmm(ms(r.stopped_at ?? r.last_event_at)),
        ],
        ['Tool calls', String(r.tool_calls)],
        ['Subagents', `${r.subagents.done} done · ${Math.max(0, r.subagents.started - r.subagents.done)} running`],
        ['Files changed', String(r.files_changed)],
      ]
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1} alignItems="center" paddingX={padX} paddingY={padY}>
            <Button key="back" label="‹ Back" onPress={() => setView(x => ({ ...x, selected: null }))} />
            <Text weight="semibold" bold={isTerm}>
              Agents
            </Text>
          </Box>
          <Rule />
          <Box flexDirection="row">
            {picked.state === 'needs_input' ? <Box width={1} backgroundColor="warning" /> : null}
            <Box flexDirection="column" gap={1} paddingX={padX} paddingY={padY} flexGrow={1}>
              <Box flexDirection="row" gap={1} alignItems="center">
                <Icon state={picked.state} />
                <Text size="caption" weight="semibold" bold={isTerm} color={TONE[picked.state]}>
                  {head.toUpperCase()}
                </Text>
              </Box>
              <Text size="heading" weight="semibold" bold={isTerm}>
                {r.title || 'Untitled session'}
              </Text>
              <Small mono dim>
                {where}
              </Small>
              {r.request ? (
                <Box flexDirection="column" borderStyle="single" borderColor="inactive" paddingX={1}>
                  <Small dim>{r.request.label}</Small>
                  <Text mono>{clip(r.request.text, 400)}</Text>
                </Box>
              ) : null}
              {picked.state === 'error' && r.error ? <Small color="error">{`Stopped: ${r.error}`}</Small> : null}
              {r.prompt ? (
                <Box flexDirection="column">
                  <Small dim>Prompt</Small>
                  <Text size="footnote">{clip(r.prompt, 600)}</Text>
                </Box>
              ) : null}
              {!isSelf ? (
                <Box flexDirection="row" gap={1}>
                  <Button key="resume" label="Open session" variant="primary" onPress={() => copyResume(r)} />
                </Box>
              ) : null}
            </Box>
          </Box>
          <Rule />
          <Box flexDirection="column" paddingX={padX} paddingY={padY}>
            {kv.map(([k, val, indent]) => (
              <Box flexDirection="row" justifyContent="space-between" paddingLeft={indent ? 2 : 0}>
                <Small dim>{k}</Small>
                <Small>{val}</Small>
              </Box>
            ))}
          </Box>
          <Box flexDirection="column" gap={isTerm ? 0 : 1} paddingX={padX} paddingBottom={padY}>
            <Text size="caption" weight="semibold" bold={isTerm} dimColor>
              RECENT ACTIVITY
            </Text>
            {r.events.length === 0 ? <Small dim>Nothing yet</Small> : null}
            {[...r.events].reverse().map(ev => (
              <Box flexDirection="row" gap={1}>
                <Text size="footnote" dimColor tabular>
                  {hhmm(ms(ev.at))}
                </Text>
                <Text size="footnote" color={EVENT_TONE[ev.kind]}>
                  ●
                </Text>
                <Small>{ev.text}</Small>
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    // ── list view ──
    const counts = { all: sec.all.length, needs: sec.needs.length, running: sec.running.length, done: sec.done.length }
    const today = startOfDay(now)
    const tokensToday = sec.all.filter(x => ms(x.r.last_event_at) >= today).reduce((n, x) => n + x.r.tokens.total, 0)
    const chips: [Filter, string][] = [
      ['all', `All ${counts.all}`],
      ['needs', `Needs you ${counts.needs}`],
      ['running', `Running ${counts.running}`],
      ['done', `Done ${counts.done}`],
    ]
    const show = (f: Filter) => v.filter === 'all' || v.filter === f

    const Row = (p: { x: Shown }) => {
      const { r, state } = p.x
      const isSelf = r.session_id === s.selfId
      const meta = [r.repo, r.branch, isSelf ? 'this window' : r.surface && r.surface !== 'terminal' ? SURFACE_LABEL[r.surface] : '']
        .filter(Boolean)
        .join(' · ')
      const sub = r.subagents.started > 0 ? ` · ${r.subagents.done} of ${r.subagents.started} subagents done` : ''
      const extra =
        state === 'running' && r.turn_started_at
          ? `${fmtAgo(now - ms(r.turn_started_at))} elapsed · ${r.tool_calls} tool calls${sub}`
          : null
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            {state === 'needs_input' ? <Box width={1} backgroundColor="warning" /> : null}
            <Box flexDirection="row" gap={1} paddingX={padX} paddingY={padY} flexGrow={1}>
              <Icon state={state} />
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                <Box flexDirection="row" justifyContent="space-between" gap={1}>
                  <Box flexShrink={1}>
                    <Button key={`open:${r.session_id}`} plain onPress={() => setView(x => ({ ...x, selected: r.session_id }))}>
                      <Text weight="semibold" bold={isTerm} wrap="truncate-end">
                        {clip(r.title || 'Untitled session', Math.max(12, Math.min(60, cols - timeLabel(p.x, now).length - 8)))}
                      </Text>
                    </Button>
                  </Box>
                  <Box flexShrink={0}>
                    <Text size="footnote" dimColor>
                      {timeLabel(p.x, now)}
                    </Text>
                  </Box>
                </Box>
                <Small mono dim>
                  {meta}
                </Small>
                <Pills r={r} />
                <Small color={state === 'error' ? 'error' : undefined}>{activityLabel(p.x, now)}</Small>
                {extra ? <Small dim>{extra}</Small> : null}
                {state === 'needs_input' && !isSelf ? (
                  <Box flexDirection="row" gap={1} marginTop={isTerm ? 0 : 1}>
                    <Button key={`resume:${r.session_id}`} label="Open" variant="primary" onPress={() => copyResume(r)} />
                  </Box>
                ) : null}
              </Box>
            </Box>
          </Box>
          <Rule />
        </Box>
      )
    }

    const Section = (p: { label: string; hint: string; state: AgentState; rows: Shown[] }) =>
      p.rows.length === 0 ? null : (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" paddingX={padX} paddingTop={1}>
            <Text size="caption" weight="semibold" bold={isTerm} color={TONE[p.state]}>
              {`${p.label} · ${p.rows.length}`.toUpperCase()}
            </Text>
            <Text size="caption" dimColor>
              {p.hint.toUpperCase()}
            </Text>
          </Box>
          {p.rows.map(x => (
            <Row x={x} />
          ))}
        </Box>
      )

    const surfacesSeen = [...new Set(sec.all.map(x => SURFACE_LABEL[x.r.surface]).filter(Boolean))]
    const isEmpty =
      (v.filter === 'all' && counts.all === 0) ||
      (v.filter === 'needs' && counts.needs === 0) ||
      (v.filter === 'running' && counts.running === 0) ||
      (v.filter === 'done' && counts.done === 0)

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" gap={1} paddingX={padX} paddingY={padY}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            <Text size="heading" weight="semibold" bold={isTerm}>
              Agents
            </Text>
            <Text size="footnote" dimColor>
              {`${counts.all} session${counts.all === 1 ? '' : 's'} · ${fmtTokens(tokensToday)} tokens today`}
            </Text>
          </Box>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {chips.map(([f, label]) => (
              <Button
                key={`filter:${f}`}
                label={label}
                variant={v.filter === f ? 'primary' : 'secondary'}
                onPress={() => setView(x => ({ ...x, filter: f }))}
              />
            ))}
          </Box>
        </Box>
        <Rule />
        {isEmpty ? (
          <Box paddingX={padX} paddingY={1}>
            <Text dimColor>{counts.all === 0 ? 'No sessions yet. They show up here as soon as they start.' : 'Nothing here right now.'}</Text>
          </Box>
        ) : null}
        {show('needs') ? <Section label="Needs your input" hint="oldest first" state="needs_input" rows={sec.needs} /> : null}
        {show('running') ? <Section label="Running" hint="last activity" state="running" rows={sec.running} /> : null}
        {show('done') ? <Section label="Done" hint="finished at" state="done" rows={sec.done} /> : null}
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingX={padX} paddingY={padY}>
          <Text size="footnote" dimColor>
            {surfacesSeen.join(' · ') || ' '}
          </Text>
          {counts.done > 0 ? <Button key="clear" plain label="Clear finished" onPress={() => clearFinished($)} /> : null}
        </Box>
      </Box>
    ) as RenderElement
  })
}
