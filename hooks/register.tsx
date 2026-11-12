import { atom, read, update } from 'claude-code'
import type { Hook, Register, Timer } from 'claude-code'

import type { Agent, Hud, Limit, Turn } from '../types'

type Dollar = Parameters<Hook<'turn.complete'>>[0]

const PANE = 'cockpit-agents'
const PANE_TITLE = 'Subagents'
const BAR_CELLS = 14
const KEPT_AGENTS = 20
const NOTIFY_AFTER_MS = 60_000
const CHEAP_MODEL = /sonnet|haiku/i
// Agent types that pick their own cheap model, so asking would only nag.
const TRUSTED_TYPES = ['fork', 'Explore', 'sonnet-xhigh', 'statusline-setup']

const hud = atom({ plugin: 'session-cockpit', key: 'hud' } as const, null, {
  shape: 'hud-2',
})
const last = atom({ plugin: 'session-cockpit', key: 'last' } as const, null, {
  shape: 'turn-2',
})
const agents = atom({ plugin: 'session-cockpit', key: 'agents' } as const, [], {
  shape: 'agents-1',
})
const now = atom({ plugin: 'session-cockpit', key: 'now' } as const, 0)
const spawnedCount = atom(
  { plugin: 'session-cockpit', key: 'spawnedCount' } as const,
  0,
)

const RISKY: readonly { label: string; pattern: RegExp }[] = [
  { label: 'git push', pattern: /\bgit\s+(?:-\S+\s+)*push\b/ },
  {
    label: 'kubectl sửa cluster',
    pattern:
      /\bkubectl\b[^|;&]*\s(apply|delete|patch|edit|scale|replace|create|annotate|label|drain|cordon|rollout\s+(restart|undo))\b/,
  },
  {
    label: 'helm/helmfile sửa cluster',
    pattern:
      /\b(helm\s+(upgrade|install|uninstall|rollback)|helmfile\b[^|;&]*\s(apply|sync|destroy))\b/,
  },
  { label: 'tofu/terraform apply', pattern: /\b(tofu|terraform)\s+(apply|destroy)\b/ },
]

const LOOK_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch']
const CHANGE_TOOLS = ['Edit', 'Write', 'NotebookEdit']
const SHELL_TOOLS = ['Bash', 'PowerShell']
const AGENT_TOOLS = ['Agent', 'Workflow']
const LIMIT_LABELS: Record<string, string> = { five_hour: '5H', seven_day: '7D' }

const RUN = 'Chạy'
const BLOCK = 'Chặn'
const TO_SONNET = 'Đổi sang Sonnet'
const KEEP = 'Giữ nguyên'

const bar = (percent: number): string => {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * BAR_CELLS)

  return '█'.repeat(filled) + '░'.repeat(BAR_CELLS - filled)
}

const heat = (percent: number): string =>
  percent >= 85 ? 'red' : percent >= 60 ? 'yellow' : 'green'

const elapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))

  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

const toolColor = (tool: string, input: unknown, isErrored: boolean): string => {
  if (isErrored) {
    return 'red'
  }

  if (SHELL_TOOLS.includes(tool)) {
    const command = (input as { command?: unknown } | null)?.command
    const isRisky =
      typeof command === 'string' && RISKY.some(rule => rule.pattern.test(command))

    return isRisky ? 'red' : 'magenta'
  }

  if (LOOK_TOOLS.includes(tool)) {
    return 'blue'
  }

  if (CHANGE_TOOLS.includes(tool)) {
    return 'yellow'
  }

  return AGENT_TOOLS.includes(tool) ? 'cyan' : 'gray'
}

const gitBranch = async ($: Dollar): Promise<string | null> => {
  try {
    const ran = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeoutMs: 3000,
    })
    const name = ran.stdout.trim()

    return ran.exitCode === 0 && name !== '' ? name : null
  } catch {
    return null
  }
}

const refreshHud = async ($: Dollar): Promise<Hud> => {
  const cwd = await $.session.cwd()
  const usage = await $.session.usage()
  const limits: Limit[] = usage.rateLimits.map(one => ({
    kind: one.kind,
    percent: Math.round(one.percentUsed),
  }))
  const fresh: Hud = {
    folder: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd,
    branch: await gitBranch($),
    percent: usage.context.percent ?? null,
    usd: usage.cost?.usd ?? null,
    limits,
  }
  await update($, hud, () => fresh)

  return fresh
}

export const register: Register = on => {
  let mainTools = 0
  let mainFiles = new Set<string>()
  let tick: Timer | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cockpit',
      description: 'Mở pane subagent và tóm tắt các rule đang chặn',
    })
    const started = await next(e)
    await refreshHud($).catch(() => undefined)

    return started
  })

  on('command.run', { command: 'cockpit' }, async $ => {
    await $.ui.open({ id: PANE, title: PANE_TITLE }).catch(() => undefined)
    const list = await read($, agents)
    const total = await read($, spawnedCount)
    const live = list.filter(one => one.endedAt === null)
    const lines = [
      `Subagent đã spawn: ${total}, đang chạy: ${live.length}`,
      ...live.map(one => `  - ${one.description} (${one.model})`),
      `Hỏi trước khi chạy: ${RISKY.map(rule => rule.label).join(', ')}`,
      'Hỏi trước khi spawn subagent không phải Sonnet/Haiku',
    ]

    return { text: lines.join('\n') }
  })

  on('prompt.submit', ($, e, next) => {
    mainTools = 0
    mainFiles = new Set()

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const limits: Limit[] = e.rateLimits.map(one => ({
      kind: one.kind,
      percent: Math.round(one.percentUsed),
    }))
    await update($, hud, held =>
      held === null
        ? held
        : {
            ...held,
            percent: e.context.percent ?? held.percent,
            usd: e.cost?.usd ?? held.usd,
            limits,
          },
    )

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) {
      mainTools += 1

      if (e.tool === 'Edit' || e.tool === 'Write') {
        mainFiles.add(e.file_path)
      }
    }

    if (e.tool !== 'Bash' && e.tool !== 'PowerShell') {
      return next(e)
    }

    const command = e.command
    const hit = RISKY.find(rule => rule.pattern.test(command))

    if (hit === undefined) {
      return next(e)
    }

    const answer = await $.ui.ask(
      `${hit.label}: cho chạy lệnh này?\n${command.slice(0, 300)}`,
      { header: 'Lệnh rủi ro', options: [RUN, BLOCK] },
    )

    return answer === RUN
      ? next(e)
      : { deny: `session-cockpit: người dùng không cho chạy (${hit.label}).` }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'session-cockpit: guard lỗi, không chạy.' },
  )

  on('agent.spawn', async ($, e, next) => {
    let input = e
    const isCostly =
      !TRUSTED_TYPES.includes(e.subagentType) &&
      (e.model === undefined || !CHEAP_MODEL.test(e.model))

    if (isCostly) {
      const model = e.model ?? 'mặc định (kế thừa session nếu agent không tự chọn)'
      const answer = await $.ui.ask(
        `Subagent "${e.description}" (${e.subagentType}) sẽ chạy model ${model}.`,
        { header: 'Subagent', options: [TO_SONNET, KEEP, BLOCK] },
      )

      if (answer === BLOCK) {
        return { deny: 'session-cockpit: người dùng chặn subagent này.' }
      }

      if (answer === TO_SONNET) {
        input = { ...e, model: 'sonnet' }
      }
    }

    const started = await next(input)

    if (started.deny === undefined && started.agentId !== undefined) {
      const startedAt = await $.clock.now()
      const one: Agent = {
        id: started.agentId,
        description: e.description,
        model: started.model ?? input.model ?? '?',
        startedAt,
        endedAt: null,
      }
      await update($, agents, list => [...list, one].slice(-KEPT_AGENTS))
      await update($, spawnedCount, count => count + 1)
      await update($, now, () => startedAt)
      void $.ui.open({ id: PANE, title: PANE_TITLE }).catch(() => undefined)

      // One ticker redraws the elapsed times; it stops itself when all are done.
      tick ??= $.clock.every(1000, () => {
        void (async () => {
          const list = await read($, agents)

          if (!list.some(agent => agent.endedAt === null)) {
            tick?.cancel()
            tick = undefined

            return
          }

          const time = await $.clock.now()
          await update($, now, () => time)
        })().catch(() => undefined)
      })
    }

    return started
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'session-cockpit: guard lỗi, không spawn.' },
  )

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const id = e.agentId
      const endedAt = await $.clock.now()
      await update($, agents, list =>
        list.map(one =>
          one.id === id && one.endedAt === null ? { ...one, endedAt } : one,
        ),
      )

      return next(e)
    }

    const turn: Turn = {
      seconds: Math.round(e.durationMs / 1000),
      tools: mainTools,
      files: mainFiles.size,
    }
    await update($, last, () => turn)
    const fresh = await refreshHud($)

    if (e.durationMs >= NOTIFY_AFTER_MS && !e.isAborted) {
      void $.ui.notify(`Xong sau ${turn.seconds}s, ${turn.tools} tool call`, {
        title: `Claude: ${fresh.folder}`,
        key: 'turn-done',
      })
    }

    return next(e)
  })

  // A colored gutter per tool kind, so a glance tells reads from writes from shell.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const { tool, input, isErrored } = e.props
    const row = await next(e)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text color={toolColor(tool, input, isErrored)}>▌</Text>
        {row}
      </Box>
    )
  })

  // Replaces the diff under Edit/Write rows with one line; ctrl+o still shows it.
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    const { tool, output, isErrored, isExpanded } = e.props
    const isFileChange = tool === 'Edit' || tool === 'Write'

    if (!isFileChange || isErrored || isExpanded === true) {
      return next(e)
    }

    const patch = (output as { structuredPatch?: unknown } | null)?.structuredPatch
    const lines = Array.isArray(patch)
      ? patch.flatMap(hunk =>
          Array.isArray((hunk as { lines?: unknown }).lines)
            ? ((hunk as { lines: unknown[] }).lines as unknown[])
            : [],
        )
      : []
    const added = lines.filter(line => typeof line === 'string' && line.startsWith('+')).length
    const removed = lines.filter(line => typeof line === 'string' && line.startsWith('-')).length
    const { Text } = $.ui.resolve(e)

    return (
      <Text dimColor>
        {'  '}⎿ +{added} −{removed} dòng
      </Text>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, agents)
    const time = await read($, now)
    const live = list.filter(one => one.endedAt === null).length
    const room = Math.max(8, e.props.bodyColumns - 22)

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold color="magenta">
            {live} đang chạy
          </Text>
          <Text dimColor> · {list.length - live} xong</Text>
        </Text>
        {list.length === 0 && <Text dimColor>Chưa có subagent nào.</Text>}
        {list.map(one => {
          const isLive = one.endedAt === null
          const span = (one.endedAt ?? Math.max(time, one.startedAt)) - one.startedAt

          return (
            <Box gap={1}>
              <Text color={isLive ? 'magenta' : 'green'}>{isLive ? '●' : '✓'}</Text>
              <Text dimColor={!isLive}>{one.description.slice(0, room)}</Text>
              <Text color={CHEAP_MODEL.test(one.model) ? 'cyan' : 'yellow'}>
                {one.model}
              </Text>
              <Text dimColor={!isLive} bold={isLive}>
                {elapsed(span)}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const live = (await read($, agents)).filter(one => one.endedAt === null)
    const turn = await read($, last)
    const info = await read($, hud)
    const { Box, Text } = $.ui.resolve(e)
    const percent = info?.percent ?? null

    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={live.length > 0 ? 'magenta' : 'cyan'}
        paddingX={1}
      >
        <Box gap={2}>
          <Text bold color="cyan">
            ◆ COCKPIT
          </Text>
          {info !== null && <Text bold>{info.folder}</Text>}
          {info !== null && info.branch !== null && (
            <Text color="blue">⎇ {info.branch}</Text>
          )}
          {percent !== null && (
            <Text>
              <Text dimColor>CTX </Text>
              <Text color={heat(percent)}>{bar(percent)}</Text>
              <Text bold color={heat(percent)}>
                {' '}
                {percent}%
              </Text>
            </Text>
          )}
          {(info?.limits ?? []).map(limit => (
            <Text>
              <Text dimColor>{LIMIT_LABELS[limit.kind] ?? limit.kind} </Text>
              <Text color={heat(limit.percent)}>{limit.percent}%</Text>
            </Text>
          ))}
        </Box>
        <Box gap={2}>
          {turn !== null && (
            <Text>
              <Text dimColor>TURN </Text>
              {turn.seconds}s · {turn.tools} tool · {turn.files} file sửa
            </Text>
          )}
          {turn === null && <Text dimColor>sẵn sàng</Text>}
          {live.length > 0 && (
            <Text color="magenta">
              ▸ {live.length} subagent đang chạy
            </Text>
          )}
        </Box>
      </Box>
    )
  })
}
