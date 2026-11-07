import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'level-up-hud',
  component: 'Pane',
  requestId: 'level-up-hud',
  props: {
    title: 'Claude HUD',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('the HUD shows model, effort and limits on every surface', async ($, on) => {
  on('command.register', () => ({ value: { command: 'hud' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000, percent: 30 }, rateLimits: [], cost: { usd: 1.5 } },
  }))
  on('clock.now', () => ({ value: Date.parse('2026-11-06T12:00:00Z') }))
  on('ui.status', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('env.get', () => ({ value: 'high' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({
    context: { window: 200000, percent: 30 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 42, resetsAt: '2099-01-01T00:00:00Z' },
      { kind: 'seven_day', percentUsed: 90 },
    ],
    changed: ['rateLimits'],
  })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5-Hour/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /42%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Weekly/ })).toBeDefined()
    await ui.unmount()
  }
})
