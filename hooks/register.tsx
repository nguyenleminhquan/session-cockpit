import { atom, read, update } from 'claude-code'
import type { Hook, Register, Timer } from 'claude-code'

import type { Agent, Finder, Hud, Limit, Session, Turn } from '../types'

type Dollar = Parameters<Hook<'turn.complete'>>[0]

const PANE = 'cockpit-agents'
const PANE_TITLE = 'Subagents'
const FINDER = 'cockpit-sessions'
const FINDER_TITLE = 'Sessions'
const FOUND_MAX = 30
const SEARCH_TIMEOUT_MS = 20_000
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
const NO_SEARCH: Finder = { query: '', isSearching: false, found: [] }
const finder = atom({ plugin: 'session-cockpit', key: 'finder' } as const, NO_SEARCH, {
  shape: 'finder-1',
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

const age = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60_000))

  if (minutes < 60) {
    return `${minutes}p`
  }

  return minutes < 60 * 24
    ? `${Math.round(minutes / 60)}g`
    : `${Math.round(minutes / (60 * 24))}n`
}

const projectsDir = async ($: Dollar): Promise<string> => {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '~'

  return `${home.replace(/\\/g, '/')}/.claude/projects`
}

const unescape = (raw: string): string => {
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return raw
  }
}

// `git grep --no-index` is the one fast text search every machine here has.
const grep = async ($: Dollar, dir: string, args: readonly string[]): Promise<string[]> => {
  try {
    const ran = await $.process.run(['git', 'grep', '--no-index', ...args], {
      cwd: dir,
      timeoutMs: SEARCH_TIMEOUT_MS,
    })

    return ran.stdout.split('\n').filter(line => line !== '')
  } catch {
    return []
  }
}

const findSessions = async ($: Dollar, query: string): Promise<Session[]> => {
  const dir = await projectsDir($)
  let wanted: Set<string> | null = null
  let projects: string[]

  if (query === '') {
    projects = (await $.fs.list(dir).catch(() => []))
      .filter(entry => entry.kind === 'dir')
      .map(entry => entry.name)
  } else {
    const hits = await grep($, dir, ['-l', '-i', '-F', '-e', query, '--', '*.jsonl'])
    // A subagent's transcript sits under its session's folder: same key.
    const keys = hits.map(hit => {
      const [project = '', second = ''] = hit.split('/')

      return `${project}/${second.replace(/\.jsonl$/, '')}`
    })
    wanted = new Set(keys)
    projects = [...new Set(keys.map(key => key.split('/')[0] ?? ''))]
  }

  const listed = await Promise.all(
    projects.map(async project => {
      const entries = await $.fs.list(`${dir}/${project}`).catch(() => [])

      return entries
        .filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl'))
        .map(
          (entry): Session => ({
            id: entry.name.replace(/\.jsonl$/, ''),
            project,
            cwd: null,
            title: null,
            mtimeMs: entry.mtimeMs,
          }),
        )
    }),
  )
  const found = listed
    .flat()
    .filter(one => wanted === null || wanted.has(`${one.project}/${one.id}`))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, FOUND_MAX)

  if (found.length === 0) {
    return found
  }

  const files = found.map(one => `${one.project}/${one.id}.jsonl`)
  const aiTitles = new Map<string, string>()
  const ownTitles = new Map<string, string>()
  const cwds = new Map<string, string>()
  const titleLines = await grep($, dir, [
    '-o',
    '-E',
    '"(aiTitle|customTitle)":"[^"]*"',
    '--',
    ...files,
  ])
  const cwdLines = await grep($, dir, ['-m', '1', '-o', '-E', '"cwd":"[^"]*"', '--', ...files])

  for (const line of titleLines) {
    const match = /^(.*?\.jsonl):"(aiTitle|customTitle)":"(.*)"$/.exec(line)

    if (match !== null) {
      const titles = match[2] === 'customTitle' ? ownTitles : aiTitles
      titles.set(match[1] ?? '', unescape(match[3] ?? ''))
    }
  }

  for (const line of cwdLines) {
    const match = /^(.*?\.jsonl):"cwd":"(.*)"$/.exec(line)

    if (match !== null) {
      cwds.set(match[1] ?? '', unescape(match[2] ?? ''))
    }
  }

  return found.map(one => {
    const file = `${one.project}/${one.id}.jsonl`

    // A title the person set wins over a generated one.
    return {
      ...one,
      title: ownTitles.get(file) ?? aiTitles.get(file) ?? null,
      cwd: cwds.get(file) ?? null,
    }
  })
}

const search = async ($: Dollar, query: string): Promise<void> => {
  const text = query.trim()
  await update($, finder, held => ({ ...held, query: text, isSearching: true }))
  const found = await findSessions($, text).catch(() => [])
  await update($, finder, () => ({ query: text, isSearching: false, found }))
}

// Opens the session in a new Windows Terminal tab; elsewhere it hands over the command.
const resume = async ($: Dollar, one: Session): Promise<void> => {
  const cwd = one.cwd ?? (await $.session.cwd())

  try {
    const ran = await $.process.run(
      ['wt.exe', '-w', '0', 'nt', '-d', cwd, 'claude', '--resume', one.id],
      { timeoutMs: 10_000 },
    )

    if (ran.exitCode === 0) {
      void $.ui.toast(`Đã mở tab mới: ${one.title ?? one.id}`)

      return
    }
  } catch {
    // No Windows Terminal here: fall through to the clipboard.
  }

  const copied = await $.ui.copy({ text: `cd "${cwd}" && claude --resume ${one.id}` })
  void $.ui.toast(
    copied.isCopied
      ? 'Không mở được tab mới; đã copy lệnh resume vào clipboard'
      : `Không mở được tab mới: claude --resume ${one.id}`,
  )
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
    await $.command.register({
      name: 'sessions',
      description: 'Tìm session Claude ở mọi project và mở lại trong tab mới',
      argumentHint: '[từ khóa]',
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

  on('command.run', { command: 'sessions' }, async ($, e) => {
    await $.ui
      .open({ id: FINDER, title: FINDER_TITLE, focus: true, closeOnEscape: true })
      .catch(() => undefined)
    await search($, e.args)
    const { found } = await read($, finder)
    const scope = e.args.trim() === '' ? ' gần đây' : ''

    return { text: `Tìm thấy ${found.length} session${scope}.` }
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

  on('ui.render', { component: 'Pane', requestId: FINDER }, async ($, e) => {
    const { Box, Text, Input, Button } = $.ui.resolve(e)
    const held = await read($, finder)
    const time = await $.clock.now()
    const room = Math.max(12, e.props.bodyColumns - 30)
    const scope = held.query === '' ? ' gần đây' : ''

    return (
      <Box flexDirection="column">
        <Input
          key="q"
          label="⌕ "
          placeholder="từ khóa, Enter để tìm ở mọi project"
          value={held.query}
          submitLabel="tìm"
          autoFocus
          onSubmit={value => void search($, value)}
        />
        <Text dimColor>
          {held.isSearching
            ? 'đang tìm…'
            : `${held.found.length} session${scope} · Tab để chọn, Enter mở tab mới`}
        </Text>
        {held.found.map(one => (
          <Button key={one.id} plain onPress={() => void resume($, one)}>
            <Text color="cyan">
              {(one.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? one.project).slice(0, 18)}
            </Text>
            <Text> {(one.title ?? one.id).slice(0, room)} </Text>
            <Text dimColor>{age(time - one.mtimeMs)}</Text>
          </Button>
        ))}
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
