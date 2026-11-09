import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { AGENTS, NOW } from './fixtures'

const PANE = {
  plugin: 'agents-panel',
  component: 'Pane',
  requestId: 'agents-panel',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

// The engine beneath the plugin: a status folder holding the six mockup sessions.
function engine(on: Parameters<TestBody>[1], files = AGENTS) {
  const written: Record<string, string> = {}
  const copied: string[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/nimrod' : undefined }))
  on('session.id', () => ({ value: 'context-navigator' }))
  on('session.cwd', () => ({ value: '/Users/nimrod/code/context-navigator' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.repo', () => ({ value: null }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 12 }, rateLimits: [] } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.check', () => ({ decision: 'ask' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('fs.list', () => ({
    value: files.map(a => ({ name: `${a.session_id}.json`, kind: 'file', size: 1, mtimeMs: NOW - 1000, isLink: false })),
  }))
  on('fs.read', (_, e) => {
    const path = String(e.path)
    // the fixtures stand still; what the mod writes is read back otherwise
    const a = files.find(x => path.endsWith(`/${x.session_id}.json`))
    if (a) return { value: JSON.stringify(a) }
    if (written[path]) return { value: written[path] }
    throw new Error('ENOENT')
  })
  on('fs.write', (_, e) => {
    written[String(e.path)] = String(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))
  return { written, copied }
}

async function open($: Parameters<TestBody>[0]) {
  await $.session.start({ cwd: '/Users/nimrod/code/context-navigator', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'agents-panel', args: '' } as Parameters<typeof $.command.run>[0])
}

test('the list shows the six sessions in mockup order, on every surface', async ($, on) => {
  engine(on)
  await open($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('6 sessions · 2.3M tokens today')
    expect(drawn).toContain('Needs you 2')
    expect(drawn).toContain('NEEDS YOUR INPUT · 2')
    // order: needs input (oldest first), running (latest first), done (latest first)
    const order = ['Refactor routing layer', 'Draft Friday digest', 'Add HTML report export', 'Fix failing dbt tests', 'Update skills README', 'Revenue query rewrite']
    const at = order.map(t => drawn.indexOf(t))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(drawn).toContain('waiting 12m')
    expect(drawn).toContain('8s ago')
    expect(drawn).toContain('context-navigator · this window')
    expect(drawn).toContain('bigabid-dbt · VS Code')
    expect(drawn).toContain('412k tokens')
    expect(drawn).toContain('1.1M tokens')
    expect(drawn).toContain('18m elapsed · 34 tool calls · 2 of 3 subagents done')
    expect(drawn).toContain('Finished · 14 files changed · 22m run')
    expect(drawn).toContain('Stopped: API error after 3 retries')
    expect(drawn).toContain('16m ago')
    await ui.unmount()
  }
})

test('a filter chip narrows the list', async ($, on) => {
  engine(on)
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'filter:running' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Add HTML report export')
  expect(drawn).not.toContain('Refactor routing layer')
  expect(drawn).not.toContain('Update skills README')
  await ui.press({ key: 'filter:all' })
  await ui.unmount()
})

test('a row opens its detail view, and Open copies the resume command', async ($, on) => {
  const { copied } = engine(on)
  await open($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'open:artlist-mcp' })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('NEEDS YOUR INPUT · 12M')
    expect(drawn).toContain('Claude wants to run')
    expect(drawn).toContain('npm run migrate')
    expect(drawn).toContain('58k / 21k')
    expect(drawn).toContain('301k / 32k')
    expect(drawn).toContain('64% of window')
    expect(drawn).toContain('1 done · 0 running')
    expect(drawn).toContain('Subagent “test-writer” finished')
    expect(drawn).toContain('~/code/artlist-mcp · branch main · Terminal')
    await ui.press({ key: 'resume' })
    expect(copied.at(-1)).toBe("cd '/Users/nimrod/code/artlist-mcp' && claude --resume artlist-mcp")
    await ui.press({ key: 'back' })
    expect(JSON.stringify(await ui.drawn())).toContain('Needs you 2')
    await ui.unmount()
  }
})

test('the hooks write this session’s status file', async ($, on) => {
  const { written } = engine(on, [])
  await open($)
  const file = '/Users/nimrod/.claude/agents-status/context-navigator.json'
  const rec = () => JSON.parse(written[file] ?? '{}')
  const prompt = 'Add an HTML export to the report command'
  await $.prompt.submit({ text: prompt, wait: false } as Parameters<typeof $.prompt.submit>[0])
  await $.turn.start({ text: prompt, turnId: 't1' })
  expect(rec().status).toBe('running')
  expect(rec().title).toBe(prompt)
  expect(rec().branch).toBe('main')

  await $.tool.check({ tool: 'Bash', input: { command: 'npm run migrate' } })
  expect(rec().status).toBe('needs_input')
  expect(rec().waiting_on).toBe('Permission: run npm run migrate')

  const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300, model: 'claude-opus-5-5' }
  const done = { durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage } as const
  await $.turn.complete({ ...done, answer: 'All done.' })
  expect(rec().status).toBe('done')
  expect(rec().tokens.total).toBe(6500)
  expect(rec().events.length).toBe(3)

  await $.turn.complete({ ...done, answer: 'Done. Use the old list or refresh it?' })
  expect(rec().status).toBe('needs_input')
  expect(rec().waiting_on).toBe('Asked: “Use the old list or refresh it?”')
  expect(rec().tokens.total).toBe(13000)
})

test('a stale run reads as an error, and a closed session hides after an hour', async ($, on) => {
  const stale = { ...AGENTS[3]!, last_event_at: new Date(NOW - 11 * 60_000).toISOString() }
  const closed = { ...AGENTS[4]!, ended_at: new Date(NOW - 61 * 60_000).toISOString() }
  engine(on, [stale, closed])
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('No activity for 11m · stale')
  expect(drawn).not.toContain('Update skills README')
  expect(drawn).toContain('1 session ·')
  await ui.unmount()
})
