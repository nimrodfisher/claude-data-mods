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
  for (const ev of ['UserPromptSubmit', 'PermissionRequest', 'Stop'] as const) on(`classic.${ev}`, () => ({}))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('fs.list', () => ({
    value: files.map(a => ({ name: `${a.session_id}.json`, kind: 'file', size: 1, mtimeMs: NOW - 1000, isLink: false })),
  }))
  on('fs.read', (_, e) => {
    const path = String(e.path)
    if (written[path]) return { value: written[path] }
    const a = files.find(x => path.endsWith(`/${x.session_id}.json`))
    if (!a) throw new Error('ENOENT')
    return { value: JSON.stringify(a) }
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
  const base = { session_id: 'abc', cwd: '/Users/nimrod/code/demo', transcript_path: '/t.jsonl' }
  await $.classic.UserPromptSubmit({ ...base, prompt: 'Add an HTML export to the report command' })
  const file = '/Users/nimrod/.claude/agents-status/abc.json'
  let rec = JSON.parse(written[file] ?? '{}')
  expect(rec.status).toBe('running')
  expect(rec.title).toBe('Add an HTML export to the report command')
  expect(rec.branch).toBe('main')

  await $.classic.PermissionRequest({ ...base, tool_name: 'Bash', tool_input: { command: 'npm run migrate' } })
  rec = JSON.parse(written[file] ?? '{}')
  expect(rec.status).toBe('needs_input')
  expect(rec.waiting_on).toBe('Permission: run npm run migrate')

  await $.classic.Stop({ ...base, stop_hook_active: false, last_assistant_message: 'All done.', effort: { level: 'high' } })
  rec = JSON.parse(written[file] ?? '{}')
  expect(rec.status).toBe('done')
  expect(rec.effort).toBe('high')
  expect(rec.events.length).toBe(3)

  await $.classic.Stop({ ...base, stop_hook_active: false, last_assistant_message: 'Done. Use the old list or refresh it?' })
  rec = JSON.parse(written[file] ?? '{}')
  expect(rec.status).toBe('needs_input')
  expect(rec.waiting_on).toBe('Asked: “Use the old list or refresh it?”')
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
