import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Hud, Limit, Progress } from '../types'

const PANE = 'level-up-hud'
const TITLE = 'Claude HUD'
const DAILY_QUEST = 25 // turns per day to clear the daily quest
const STORE_KEY = 'progress-1'

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

// ── game math ────────────────────────────────────────────────
const RANKS = ['Novice', 'Apprentice', 'Coder', 'Hacker', 'Architect', 'Wizard', 'Archmage', 'Legend']
const levelOf = (xp: number) => Math.floor(Math.sqrt(xp / 40)) + 1
const xpFor = (lvl: number) => 40 * (lvl - 1) ** 2
const rankOf = (lvl: number) => RANKS[Math.min(RANKS.length - 1, Math.floor((lvl - 1) / 3))]

const LIMIT_NAMES: Record<string, string> = {
  five_hour: '5-Hour',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly Opus',
  seven_day_sonnet: 'Weekly Sonnet',
  spend_limit: 'Spend',
}
const limitName = (k: string) => LIMIT_NAMES[k] ?? k.replace(/_/g, ' ')

const bar = (pct: number, width: number, full = '█', empty = '░') => {
  const n = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return full.repeat(n) + empty.repeat(width - n)
}
// energy left → color: plenty / caution / danger
const heat = (used: number) => (used >= 85 ? '#ef4444' : used >= 60 ? '#f59e0b' : '#22c55e')

const prettyModel = (m: string) =>
  m
    .replace(/^claude-/, '')
    .replace(/\[.*\]$/, '')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .replace(/^\w/, c => c.toUpperCase())

const EFFORT_PIPS: Record<string, number> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }

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

async function pushStatus($: EngineInterface) {
  const hd = await read($, hud)
  const p = await read($, progress)
  const parts = [`⚔ Lv${levelOf(p.xp)}`, prettyModel(hd.model), `⚙ ${hd.effort}`]
  for (const l of hd.limits) {
    if (l.kind === 'five_hour' || l.kind === 'seven_day') {
      parts.push(`${l.kind === 'five_hour' ? '5h' : 'wk'} ${bar(l.percentUsed, 6, '▰', '▱')} ${Math.round(l.percentUsed)}%`)
    }
  }
  parts.push(`☀ ${p.turnsToday}/${DAILY_QUEST}`)
  $.ui.status(parts.join(' · '))
}

function rollDay(p: Progress, now: number): Progress {
  return p.day === today(now) ? p : { ...p, day: today(now), turnsToday: 0, toolsToday: 0 }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'hud', description: 'Open the gamified Claude HUD pane' })

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

    void $.ui.open({ id: PANE, title: TITLE })
    await pushStatus($)
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
        await pushStatus($)
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
    await pushStatus($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    await update($, progress, p => ({ ...p, xp: p.xp + 2, toolsToday: p.toolsToday + 1 }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    const before = await read($, progress)
    const p = rollDay(before, now)
    const after: Progress = { ...p, xp: p.xp + 10, turnsToday: p.turnsToday + 1 }
    await update($, progress, () => after)
    await $.store.set(STORE_KEY, after)

    if (levelOf(after.xp) > levelOf(before.xp)) {
      $.ui.toast(`🎉 Level up! Lv${levelOf(after.xp)} · ${rankOf(levelOf(after.xp))}`)
    }
    if (after.turnsToday === DAILY_QUEST) $.ui.toast('🏆 Daily quest cleared!')
    await pushStatus($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const hd = await read($, hud)
    const p = await read($, progress)
    const now = await $.clock.now()
    const width = Math.max(10, Math.min(28, (e.viewport?.columns ?? 40) - 14))

    const lvl = levelOf(p.xp)
    const lvlPct = ((p.xp - xpFor(lvl)) / (xpFor(lvl + 1) - xpFor(lvl))) * 100
    const pips = EFFORT_PIPS[hd.effort] ?? 0
    const quest = Math.min(100, (p.turnsToday / DAILY_QUEST) * 100)

    const Meter = (props: { icon: string; label: string; used: number; note: string }) => (
      <Box flexDirection="column" marginBottom={1}>
        <Box justifyContent="space-between">
          <Text bold>
            {props.icon} {props.label}
          </Text>
          <Text dimColor>{props.note}</Text>
        </Box>
        <Box>
          <Text color={heat(props.used)}>{bar(props.used, width)}</Text>
          <Text bold color={heat(props.used)}> {Math.round(props.used)}%</Text>
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column" paddingX={1}>
        {/* player card */}
        <Box borderStyle="round" borderColor="#a78bfa" paddingX={1} flexDirection="column" marginBottom={1}>
          <Box justifyContent="space-between">
            <Text bold color="#a78bfa">⚔ Lv {lvl} · {rankOf(lvl)}</Text>
            <Text dimColor>{p.xp} XP</Text>
          </Box>
          <Text color="#a78bfa">{bar(lvlPct, width + 5, '▰', '▱')}</Text>
          <Text dimColor>{xpFor(lvl + 1) - p.xp} XP to Lv {lvl + 1}</Text>
        </Box>

        {/* loadout */}
        <Box flexDirection="column" marginBottom={1}>
          <Box justifyContent="space-between">
            <Text bold>🧠 Model</Text>
            <Text bold color="#38bdf8">{prettyModel(hd.model)}</Text>
          </Box>
          <Box justifyContent="space-between">
            <Text bold>⚙ Effort</Text>
            <Text>
              <Text color="#f472b6">{'◆'.repeat(pips)}</Text>
              <Text dimColor>{'◇'.repeat(5 - pips)}</Text>
              <Text> {hd.effort}</Text>
            </Text>
          </Box>
        </Box>

        {/* limits */}
        {hd.limits.length === 0 && (
          <Text dimColor>Usage limits appear after the first reply (subscription plans only).</Text>
        )}
        {hd.limits.map(l => (
          <Meter
            icon={l.kind === 'five_hour' ? '⚡' : l.kind === 'spend_limit' ? '💰' : '🛡'}
            label={limitName(l.kind)}
            used={l.percentUsed}
            note={l.resetsAt ? `resets in ${countdown(l.resetsAt, now)}` : ''}
          />
        ))}
        {hd.contextPct !== null && (
          <Meter icon="📜" label="Context" used={hd.contextPct} note="this session" />
        )}

        {/* daily quest */}
        <Box flexDirection="column" marginBottom={1}>
          <Box justifyContent="space-between">
            <Text bold>☀ Daily quest</Text>
            <Text dimColor>{p.turnsToday}/{DAILY_QUEST} turns · {p.toolsToday} tools</Text>
          </Box>
          <Text color={quest >= 100 ? '#facc15' : '#60a5fa'}>
            {bar(quest, width + 5)} {quest >= 100 ? '🏆' : ''}
          </Text>
        </Box>

        <Text dimColor>💸 ${hd.costUsd.toFixed(2)} this session</Text>
      </Box>
    )
  })
}
