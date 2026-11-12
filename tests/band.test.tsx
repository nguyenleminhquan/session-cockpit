import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'session-cockpit',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

test('an Edit result draws one summary line, not the diff', async $ => {
  const ui = await $.ui.mount({
    plugin: 'session-cockpit',
    component: 'ToolResult',
    requestId: 'tu1',
    surface: 'terminal',
    props: {
      tool_use_id: 'tu1',
      tool: 'Edit',
      isErrored: false,
      output: {
        structuredPatch: [
          { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' a', '-b', '+c', '+d'] },
        ],
      },
    },
  })

  expect((await ui.find({ type: 'Text', text: /dòng/ }))?.text).toContain('+2 −1 dòng')
  await ui.unmount()
})

test('the band shows folder, context, cost and the last main turn', async ($, on) => {
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
  on('session.cwd', () => ({ value: 'C:\\work\\demo' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000, tokens: 124000, percent: 62 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 23.5 }],
      cost: { usd: 1.84 },
    },
  }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: 'feat/hud\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  await $.turn.complete({
    answer: 'ok',
    durationMs: 5000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /COCKPIT/ }))?.text).toContain('COCKPIT')
  expect((await ui.find({ type: 'Text', text: /^demo$/ }))?.text).toBe('demo')
  expect((await ui.find({ type: 'Text', text: /62%/ }))?.text).toContain('62%')
  expect(await ui.find({ type: 'Text', text: /\$1\.84/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /5s/ }))?.text).toContain('5s · 0 tool · 0 file sửa')
  expect((await ui.find({ type: 'Text', text: /feat\/hud/ }))?.text).toContain('feat/hud')
  expect((await ui.find({ type: 'Text', text: /5H/ }))?.text).toContain('24%')
  await ui.unmount()
})

test('the pane lists a subagent and marks it done when its turn ends', async ($, on) => {
  let time = 1_000
  on('clock.now', () => ({ value: time }))
  on('clock.every', () => new Promise(() => undefined))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ agentId: 'a1', model: 'sonnet' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.agent.spawn({
    description: 'Tìm giá OpenProject',
    prompt: 'x',
    subagentType: 'Explore',
    model: 'sonnet',
    tool_use_id: 'tu9',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'opus',
    background: false,
    fork: false,
  })
  time = 43_000
  await $.turn.complete({
    answer: 'ok',
    durationMs: 42_000,
    isAborted: false,
    turnId: 't2',
    reason: 'answer',
    agentId: 'a1',
  })

  const ui = await $.ui.mount({
    plugin: 'session-cockpit',
    component: 'Pane',
    requestId: 'cockpit-agents',
    surface: 'terminal',
    props: {
      title: 'Subagents',
      isFocused: false,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })
  expect((await ui.find({ type: 'Text', text: /OpenProject/ }))?.text).toBe('Tìm giá OpenProject')
  expect((await ui.find({ type: 'Text', text: /^42s$/ }))?.text).toBe('42s')
  expect((await ui.find({ type: 'Text', text: /✓/ }))?.text).toBe('✓')
  await ui.unmount()
})

test('/sessions searches every project and lists the hit with its title', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: 3_600_000 }))
  on('env.get', () => ({ value: 'C:/Users/me' }))
  on('fs.list', () => ({
    value: [{ name: 's1.jsonl', kind: 'file', size: 1, mtimeMs: 0, isLink: false }],
  }))
  on('process.run', (_, e) => {
    const argv = e.argv.join(' ')
    const stdout = argv.includes(' -l ')
      ? 'proj-a/s1.jsonl\n'
      : argv.includes('aiTitle')
        ? 'proj-a/s1.jsonl:"aiTitle":"So sánh Jira"\n'
        : 'proj-a/s1.jsonl:"cwd":"C:\\work\\jira"\n'

    return {
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })

  await $.command.run({
    command: 'sessions',
    args: 'openproject',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

  const ui = await $.ui.mount({
    plugin: 'session-cockpit',
    component: 'Pane',
    requestId: 'cockpit-sessions',
    surface: 'terminal',
    props: {
      title: 'Sessions',
      isFocused: true,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })
  expect((await ui.find({ type: 'Text', text: /So sánh Jira/ }))?.text).toContain('So sánh Jira')
  expect((await ui.find({ type: 'Text', text: /^jira$/ }))?.text).toBe('jira')
  expect((await ui.find({ type: 'Text', text: /^1g$/ }))?.text).toBe('1g')
  await ui.unmount()
})
