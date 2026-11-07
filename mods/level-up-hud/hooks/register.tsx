import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { FileRead, Hud, Limit, LongOutput, McpServer, Progress, TipsView, Waste } from '../types'
import { C as SC, footerSvg, gaugesSvg, heroSvg, wasteSvg } from './svg'
import type { Gauge, WasteSlice } from './svg'

const PANE = 'level-up-hud'
const TITLE = 'Claude HUD'
const DAILY_QUEST = 25 // turns per day to clear the daily quest
const STORE_KEY = 'progress-1'

// ── waste thresholds ─────────────────────────────────────────
const BIG_READ = 5000 // tokens of one whole-file read
const LONG_OUTPUT = 5000 // tokens of one command's output
const REPEAT_READS = 3 // reads of the same file
const IDLE_SERVER = 1000 // tokens an unused MCP server must cost to be worth a tip
const CONTEXT_HIGH = 70 // % of the window
const CLEAN_BONUS = 25 // XP for clearing a tip
const TOP_TIPS = 3

// ── palette: one accent, and color only where it means something ──
const ACCENT = '#60a5fa'
const OK = '#3fb950'
const WARN = '#d29922'
const BAD = '#f85149'

const hud = atom({ plugin: 'level-up-hud', key: 'hud' } as const, {
  model: '…',
  effort: 'default',
  limits: [],
  contextPct: null,
  costUsd: 0,
}, { shape: 'hud-1' })

const progress = atom({ plugin: 'level-up-hud', key: 'progress' } as const, {
  xp: 0,
  day: '',
  turnsToday: 0,
  toolsToday: 0,
}, { shape: 'progress-1' })

const waste = atom({ plugin: 'level-up-hud', key: 'waste' } as const, {
  reads: [],
  outputs: [],
  servers: [],
  usedTools: [],
}, { shape: 'waste-1' })

const tips = atom({ plugin: 'level-up-hud', key: 'tips' } as const, {
  open: null,
  showAll: false,
  dismissed: [],
  shown: [],
}, { shape: 'tips-1' })

// ── game math ────────────────────────────────────────────────
const RANKS = ['Novice', 'Apprentice', 'Coder', 'Hacker', 'Architect', 'Wizard', 'Archmage', 'Legend']
const levelOf = (xp: number) => Math.floor(Math.sqrt(xp / 40)) + 1
const xpFor = (lvl: number) => 40 * (lvl - 1) ** 2
const rankOf = (lvl: number) => RANKS[Math.min(RANKS.length - 1, Math.floor((lvl - 1) / 3))] ?? 'Legend'

const LIMIT_NAMES: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_opus: 'Opus wk',
  seven_day_sonnet: 'Sonnet wk',
  spend_limit: 'Spend',
}
const limitName = (k: string) => LIMIT_NAMES[k] ?? k.replace(/_/g, ' ')

const heat = (used: number) => (used >= 85 ? BAD : used >= 60 ? WARN : OK)

const prettyModel = (m: string) =>
  m
    .replace(/^claude-/, '')
    .replace(/\[.*\]$/, '')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .replace(/^\w/, c => c.toUpperCase())

const EFFORT_LEVEL: Record<string, number> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }

const countdown = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (!(ms > 0)) return 'resetting'
  const m = Math.round(ms / 60000)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m % 60}m` : `${m}m`
}

const today = (now: number) => new Date(now).toISOString().slice(0, 10)
const tokensOf = (text: string | undefined) => Math.ceil((text?.length ?? 0) / 4)
const fmtK = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`)
const field = (e: object, k: string) => (e as Record<string, unknown>)[k]

// ── paths ────────────────────────────────────────────────────
const slash = (p: string) => p.replace(/\\/g, '/')
const baseName = (p: string) => slash(p).split('/').pop() ?? p
const relTo = (cwd: string, p: string) => {
  const root = slash(cwd).replace(/\/$/, '') + '/'
  const s = slash(p)
  return s.toLowerCase().startsWith(root.toLowerCase()) ? s.slice(root.length) : s
}
const fileUrl = (p: string) => {
  const s = slash(p)
  return encodeURI(s.startsWith('/') ? `file://${s}` : `file:///${s}`)
}

// ── tips ─────────────────────────────────────────────────────
type Action = { label: string; fill: string; kind: 'command' | 'prompt' }
type Tip = {
  id: string
  title: string
  saves: number | null // tokens a fix would free; null where it is no single number
  why: string[]
  file?: string
  actions: Action[]
}

const ruleAction = (rule: string): Action => ({
  label: 'Save as project rule',
  fill: `Add this rule to CLAUDE.md: ${rule}`,
  kind: 'prompt',
})

function tipsFor(w: Waste, contextPct: number | null, cwd: string): Tip[] {
  const out: Tip[] = []
  const used = new Set(w.usedTools)

  const idle = w.servers
    .filter(s => s.tokens >= IDLE_SERVER && !s.tools.some(t => used.has(t)))
    .sort((a, b) => b.tokens - a.tokens)
  if (idle.length > 0) {
    const total = idle.reduce((n, s) => n + s.tokens, 0)
    const names = idle.slice(0, 4).map(s => `${s.name} (${fmtK(s.tokens)})`)
    out.push({
      id: 'mcp',
      title: `${idle.length} idle MCP server${idle.length === 1 ? '' : 's'}`,
      saves: total,
      why: [
        'Their tools sit in context but went unused:',
        ...names.map(n => `  · ${n}`),
        ...(idle.length > 4 ? [`  · +${idle.length - 4} more`] : []),
        'Turn off what this project does not need.',
      ],
      actions: [{ label: '/mcp', fill: '/mcp', kind: 'command' }],
    })
  }

  for (const r of w.reads) {
    const rel = relTo(cwd, r.path)
    if (r.count >= REPEAT_READS) {
      out.push({
        id: `repeat:${r.path}`,
        title: `Read ${r.count}× · ${baseName(r.path)}`,
        saves: r.tokens * (r.count - 1),
        why: [
          `The same file entered context ${r.count} times.`,
          'Ask for what you need from it once, or',
          'keep a short summary to refer back to.',
        ],
        file: r.path,
        actions: [ruleAction(`summarize ${rel} once and refer back to the summary instead of re-reading it.`)],
      })
    } else if (!r.isRanged && r.tokens >= BIG_READ) {
      out.push({
        id: `read:${r.path}`,
        title: `Large read · ${baseName(r.path)}`,
        saves: Math.round(r.tokens * 0.8),
        why: [
          `Read whole: ~${fmtK(r.tokens)} tokens.`,
          'Search it with Grep first, then read just',
          'the line range you need.',
        ],
        file: r.path,
        actions: [ruleAction('for large files, search with Grep and read line ranges instead of the whole file.')],
      })
    }
  }

  const long = w.outputs.filter(o => o.tokens >= LONG_OUTPUT).sort((a, b) => b.tokens - a.tokens)
  if (long.length > 0) {
    out.push({
      id: 'output',
      title: `Long command output${long.length > 1 ? ` ×${long.length}` : ''}`,
      saves: long.reduce((n, o) => n + o.tokens - 500, 0),
      why: [
        ...long.slice(0, 3).map(o => `  $ ${clip(o.command, 26)}  ${fmtK(o.tokens)}`),
        'Pipe through head, tail or grep to keep',
        'only what matters.',
      ],
      actions: [ruleAction('keep command output short: pipe long output through head, tail or grep.')],
    })
  }

  out.sort((a, b) => (b.saves ?? 0) - (a.saves ?? 0))

  if (contextPct !== null && contextPct >= CONTEXT_HIGH) {
    const tip: Tip = {
      id: 'context',
      title: `Context ${Math.round(contextPct)}% full`,
      saves: null,
      why: [
        'Auto-compact will kick in soon and may',
        'drop details. Compact now with a focus,',
        'or /clear before starting a new task.',
      ],
      actions: [
        { label: '/compact', fill: '/compact ', kind: 'command' },
        { label: '/context', fill: '/context', kind: 'command' },
      ],
    }
    if (contextPct >= 85) out.unshift(tip)
    else out.push(tip)
  }
  return out
}

const totalSaves = (list: Tip[]) => list.reduce((n, t) => n + (t.saves ?? 0), 0)

// one color per kind of waste, shared by the stacked bar and the tip cards
const tipColor = (id: string) =>
  id === 'mcp' ? SC.indigo
  : id.startsWith('read:') ? SC.cyan
  : id.startsWith('repeat:') ? SC.violet
  : id === 'output' ? SC.warn
  : SC.bad
const sliceLabel = (t: Tip) =>
  t.id === 'mcp' ? 'Idle MCP'
  : t.id === 'output' ? 'Long output'
  : t.file ? baseName(t.file)
  : t.title

// ── status line ──────────────────────────────────────────────
async function pushStatus($: EngineInterface, cwd: string) {
  const hd = await read($, hud)
  const p = await read($, progress)
  const parts = [`Lv${levelOf(p.xp)}`, prettyModel(hd.model), hd.effort]
  for (const l of hd.limits) {
    if (l.kind === 'five_hour') parts.push(`5h ${Math.round(l.percentUsed)}%`)
    if (l.kind === 'seven_day') parts.push(`wk ${Math.round(l.percentUsed)}%`)
  }
  if (hd.contextPct !== null) parts.push(`ctx ${Math.round(hd.contextPct)}%`)
  const v = await read($, tips)
  const open = tipsFor(await read($, waste), hd.contextPct, cwd).filter(t => !v.dismissed.includes(t.id))
  const saves = totalSaves(open)
  if (saves >= 2000) parts.push(`save ~${fmtK(saves)}`)
  $.ui.status(parts.join(' · '))
}

function rollDay(p: Progress, now: number): Progress {
  return p.day === today(now) ? p : { ...p, day: today(now), turnsToday: 0, toolsToday: 0 }
}

async function refreshServers($: EngineInterface) {
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    const byServer = new Map<string, McpServer>()
    for (const t of u.context.breakdown?.mcpTools ?? []) {
      if (!t.isLoaded) continue // schemas loaded on demand cost nothing until searched
      const s = byServer.get(t.serverName) ?? { name: t.serverName, tokens: 0, tools: [] }
      s.tokens += t.tokens
      s.tools.push(t.name)
      byServer.set(t.serverName, s)
    }
    await update($, waste, w => ({ ...w, servers: [...byServer.values()] }))
  } catch {
    // no breakdown on this host: the MCP tip stays quiet
  }
}

export const register: Register = on => {
  let cwd = ''

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({ name: 'hud', description: 'Open the Claude HUD pane' })

    const now = await $.clock.now()
    const saved = (await $.store.get(STORE_KEY)) as Progress | undefined
    await update($, progress, p => rollDay(saved && typeof saved.xp === 'number' ? saved : p, now))

    const model = await $.session.model()
    const effort = (await $.env.get('CLAUDE_EFFORT')) ?? (await $.env.get('CLAUDE_CODE_EFFORT_LEVEL'))
    const u = await $.session.usage()
    await update($, hud, prev => ({
      ...prev,
      model,
      effort: effort ?? prev.effort,
      limits: u.rateLimits as Limit[],
      contextPct: u.context.percent ?? null,
      costUsd: u.cost?.usd ?? prev.costUsd,
    }))
    await refreshServers($)

    void $.ui.open({ id: PANE, title: TITLE })
    await pushStatus($, cwd)
    return next(e)
  })

  on('command.run', { command: 'hud' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Claude HUD opened.' }
  })

  // live model + effort, as each main-loop request goes out
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const effort = e.effort === undefined ? 'default' : String(e.effort)
      const hd = await read($, hud)
      if (hd.model !== e.model || hd.effort !== effort) {
        await update($, hud, x => ({ ...x, model: e.model, effort }))
        await pushStatus($, cwd)
      }
    }
    return yield* next(e)
  })

  // limits, context and cost, pushed by the engine
  on('session.measure', async ($, e, next) => {
    await update($, hud, prev => ({
      ...prev,
      limits: e.rateLimits as Limit[],
      contextPct: e.context.percent ?? prev.contextPct,
      costUsd: e.cost?.usd ?? prev.costUsd,
    }))
    await pushStatus($, cwd)
    return next(e)
  })

  // what each tool call put into the main context
  on('tool.call', async ($, e, next) => {
    await update($, progress, p => ({ ...p, xp: p.xp + 2, toolsToday: p.toolsToday + 1 })).catch(() => undefined)
    const ran = await next(e)
    if (ran.deny !== undefined || field(e, 'agentId') !== undefined) return ran

    const tokens = tokensOf(ran.text)
    const tool = e.tool
    await update($, waste, w => {
      const usedTools = tool.startsWith('mcp__') && !w.usedTools.includes(tool) ? [...w.usedTools, tool] : w.usedTools
      let reads: FileRead[] = w.reads
      let outputs: LongOutput[] = w.outputs
      const path = field(e, 'file_path')
      if (tool === 'Read' && typeof path === 'string' && !ran.isError) {
        const isRanged = field(e, 'offset') !== undefined || field(e, 'limit') !== undefined
        const had = w.reads.find(r => r.path === path)
        reads = had
          ? w.reads.map(r =>
              r.path === path
                ? { ...r, count: r.count + 1, tokens: Math.max(r.tokens, tokens), isRanged: r.isRanged && isRanged }
                : r,
            )
          : [...w.reads, { path, tokens, count: 1, isRanged }].slice(-100)
      }
      const command = field(e, 'command')
      if (tool === 'Bash' && typeof command === 'string' && tokens >= LONG_OUTPUT) {
        outputs = [...w.outputs, { command, tokens }].slice(-20)
      }
      return { ...w, usedTools, reads, outputs }
    }).catch(() => undefined)
    return ran
  })

  // a compaction clears what reads and outputs put in context
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    await update($, waste, w => ({ ...w, reads: [], outputs: [] })).catch(() => undefined)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    const before = await read($, progress)
    const p = rollDay(before, now)
    let after: Progress = { ...p, xp: p.xp + 10, turnsToday: p.turnsToday + 1 }

    // a tip that was shown and is gone now was cleaned up: reward it
    await refreshServers($)
    const hd = await read($, hud)
    const v = await read($, tips)
    const live = tipsFor(await read($, waste), hd.contextPct, cwd).map(t => t.id)
    const cleared = v.shown.filter(id => !live.includes(id) && !v.dismissed.includes(id))
    if (cleared.length > 0) {
      after = { ...after, xp: after.xp + CLEAN_BONUS * cleared.length }
      $.ui.toast(`✓ Context cleaned up · +${CLEAN_BONUS * cleared.length} XP`)
    }
    await update($, tips, t => ({ ...t, shown: live, open: t.open && live.includes(t.open) ? t.open : null }))

    await update($, progress, () => after)
    await $.store.set(STORE_KEY, after)

    if (levelOf(after.xp) > levelOf(before.xp)) {
      $.ui.toast(`Level up · Lv ${levelOf(after.xp)} ${rankOf(levelOf(after.xp))}`)
    }
    if (after.turnsToday === DAILY_QUEST) $.ui.toast('Daily quest cleared ✓')
    await pushStatus($, cwd)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const hd = await read($, hud)
    const p = await read($, progress)
    const v = await read($, tips)
    const w = await read($, waste)
    const now = await $.clock.now()

    const cols = Math.max(26, Math.min(52, e.props.bodyColumns ?? e.viewport?.columns ?? 40)) - 2
    const LABEL = 9
    const barW = Math.max(6, cols - LABEL - 5)

    const lvl = levelOf(p.xp)
    const lvlPct = ((p.xp - xpFor(lvl)) / (xpFor(lvl + 1) - xpFor(lvl))) * 100
    const all = tipsFor(w, hd.contextPct, cwd).filter(t => !v.dismissed.includes(t.id))
    const shown = v.showAll ? all : all.slice(0, TOP_TIPS)
    const saves = totalSaves(all)

    const Bar = (props: { pct: number; width: number; color: string }) => {
      const n = Math.max(0, Math.min(props.width, Math.round((props.pct / 100) * props.width)))
      return (
        <Text>
          <Text color={props.color}>{'█'.repeat(n)}</Text>
          <Text dimColor>{'░'.repeat(props.width - n)}</Text>
        </Text>
      )
    }

    const Meter = (props: { label: string; used: number; note?: string }) => (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>{props.label.padEnd(LABEL)}</Text>
          <Bar pct={props.used} width={barW} color={heat(props.used)} />
          <Text> {String(Math.round(props.used)).padStart(3)}%</Text>
        </Box>
        {props.note ? <Text dimColor>{' '.repeat(LABEL)}{props.note}</Text> : null}
      </Box>
    )

    const Row = (props: { label: string; children?: RenderChildren }) => (
      <Box>
        <Text dimColor>{props.label.padEnd(LABEL)}</Text>
        <Text>{props.children}</Text>
      </Box>
    )

    const Divider = () => <Text dimColor>{'─'.repeat(cols)}</Text>

    const setView = (fn: (t: TipsView) => TipsView) => update($, tips, fn)

    const runAction = async (a: Action) => {
      const r = await $.prompt.fill({ text: a.fill, mode: 'replace' })
      if (!r.isFilled) $.ui.toast(`Type ${a.fill.trim()} in the prompt`)
      else if (a.kind === 'command') $.ui.toast(`${a.fill.trim()} is in your prompt · press Enter`)
      else $.ui.toast('Rule is in your prompt · press Enter to send')
    }

    const TipRow = (props: { tip: Tip; framed?: boolean }) => {
      const t = props.tip
      const isOpen = v.open === t.id
      const tint = tipColor(t.id)
      return (
        <Box
          flexDirection="column"
          {...(props.framed
            ? { borderStyle: 'round', borderColor: isOpen ? tint : undefined, borderDimColor: !isOpen, paddingX: 1 }
            : {})}
        >
          <Box justifyContent="space-between">
            <Button
              key={`tip:${t.id}`}
              plain
              onPress={() => setView(x => ({ ...x, open: x.open === t.id ? null : t.id }))}
            >
              <Text color={isOpen ? (props.framed ? tint : ACCENT) : undefined} bold={isOpen}>
                {isOpen ? '▾' : '▸'} {clip(t.title, cols - 8)}
              </Text>
            </Button>
            <Text color={t.saves === null ? BAD : WARN}>{t.saves === null ? '!' : fmtK(t.saves)}</Text>
          </Box>
          {isOpen ? (
            <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
              {t.why.map(line => (
                <Text dimColor>{clip(line, cols - 2)}</Text>
              ))}
              {t.file ? (
                <Box>
                  <Text dimColor>Open </Text>
                  <Link href={fileUrl(t.file)} label={clip(relTo(cwd, t.file), cols - 8)} />
                </Box>
              ) : null}
              <Box marginTop={1}>
                {t.actions.map(a => (
                  <Box marginRight={1}>
                    <Button
                      key={`do:${t.id}:${a.label}`}
                      label={a.label}
                      variant="primary"
                      onPress={() => runAction(a)}
                    />
                  </Box>
                ))}
                <Button
                  key={`dismiss:${t.id}`}
                  label="Dismiss"
                  onPress={() => setView(x => ({ ...x, open: null, dismissed: [...x.dismissed, t.id] }))}
                />
              </Box>
            </Box>
          ) : null}
        </Box>
      )
    }

    const pips = EFFORT_LEVEL[hd.effort]

    // ── graphic surfaces (VS Code, desktop, mobile): SVG cards + native tip rows ──
    if (e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve(e)
      const gauges: Gauge[] = [
        ...hd.limits
          .filter(l => l.kind === 'five_hour' || l.kind === 'seven_day')
          .map(l => ({ label: limitName(l.kind), pct: l.percentUsed, note: l.resetsAt ? countdown(l.resetsAt, now) : undefined })),
        ...(hd.contextPct !== null ? [{ label: 'Context', pct: hd.contextPct, note: 'this session' }] : []),
      ]
      const slices: WasteSlice[] = all
        .filter(t => (t.saves ?? 0) > 0)
        .map(t => ({ label: sliceLabel(t), tokens: t.saves ?? 0, color: tipColor(t.id) }))
      const urgent = all.find(t => t.id === 'context')?.title ?? null
      const gaugeAlt = gauges.map(g => `${g.label} ${Math.round(g.pct)}%`).join(', ')

      return (
        <Box flexDirection="column" gap={1}>
          <Svg
            source={heroSvg({
              level: lvl,
              rank: rankOf(lvl),
              xp: p.xp,
              nextXp: xpFor(lvl + 1),
              levelPct: lvlPct,
              model: prettyModel(hd.model),
              effort: hd.effort,
              effortLevel: pips ?? 0,
            })}
            alt={`Level ${lvl} ${rankOf(lvl)}, ${p.xp} XP. ${prettyModel(hd.model)}, effort ${hd.effort}.`}
          />
          <Svg source={gaugesSvg(gauges)} alt={gaugeAlt || 'Usage limits show after the first reply'} />
          <Svg
            source={wasteSvg(saves > 0 ? fmtK(saves) : null, slices, urgent)}
            alt={all.length === 0 ? 'Looking clean' : `Save context: about ${fmtK(saves)} tokens recoverable`}
          />
          {all.length > 0 ? (
            <Box flexDirection="column" gap={1}>
              {shown.map(t => (
                <TipRow tip={t} framed />
              ))}
              {all.length > TOP_TIPS ? (
                <Button key="tips:more" plain onPress={() => setView(x => ({ ...x, showAll: !x.showAll }))}>
                  <Text dimColor>{v.showAll ? 'Show less' : `+${all.length - TOP_TIPS} more tips`}</Text>
                </Button>
              ) : null}
            </Box>
          ) : null}
          <Svg
            source={footerSvg(p.turnsToday, DAILY_QUEST, p.toolsToday, hd.costUsd.toFixed(2))}
            alt={`Daily quest ${p.turnsToday} of ${DAILY_QUEST}. $${hd.costUsd.toFixed(2)} this session.`}
          />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        {/* header */}
        <Box justifyContent="space-between">
          <Text bold>Claude HUD</Text>
          <Text bold color={ACCENT}>Lv {lvl}</Text>
        </Box>
        <Text dimColor>
          {rankOf(lvl)} · {p.xp.toLocaleString('en-US')} / {xpFor(lvl + 1).toLocaleString('en-US')} XP
        </Text>
        <Bar pct={lvlPct} width={cols} color={ACCENT} />

        {/* loadout */}
        <Box flexDirection="column" marginTop={1}>
          <Row label="Model">
            <Text bold>{prettyModel(hd.model)}</Text>
          </Row>
          <Row label="Effort">
            <Text bold>{hd.effort}</Text>
            {pips ? <Text dimColor> · {pips}/5</Text> : null}
          </Row>
        </Box>

        {/* usage */}
        <Box flexDirection="column" marginTop={1}>
          {hd.limits.length === 0 && <Text dimColor>Usage limits show after the first reply.</Text>}
          {hd.limits.map(l => (
            <Meter
              label={limitName(l.kind)}
              used={l.percentUsed}
              note={l.resetsAt ? `resets in ${countdown(l.resetsAt, now)}` : undefined}
            />
          ))}
          {hd.contextPct !== null && <Meter label="Context" used={hd.contextPct} />}
        </Box>

        {/* save context */}
        <Box flexDirection="column" marginTop={1}>
          <Divider />
          <Box justifyContent="space-between">
            <Text bold>Save context</Text>
            <Text dimColor>{saves > 0 ? `~${fmtK(saves)} tokens` : ''}</Text>
          </Box>
          {all.length === 0 ? (
            <Box flexDirection="column">
              <Text color={OK}>✓ Looking clean</Text>
              <Text dimColor>Tips show up here as the session grows.</Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              {shown.map(t => (
                <TipRow tip={t} />
              ))}
              {all.length > TOP_TIPS ? (
                <Button
                  key="tips:more"
                  plain
                  onPress={() => setView(x => ({ ...x, showAll: !x.showAll }))}
                >
                  <Text dimColor>{v.showAll ? '  Show less' : `  +${all.length - TOP_TIPS} more`}</Text>
                </Button>
              ) : null}
            </Box>
          )}
          <Divider />
        </Box>

        {/* footer */}
        <Text dimColor>
          {p.turnsToday >= DAILY_QUEST ? 'Quest cleared ✓' : `Quest ${p.turnsToday}/${DAILY_QUEST}`} ·{' '}
          {p.toolsToday} tools · ${hd.costUsd.toFixed(2)}
        </Text>
      </Box>
    )
  })
}
