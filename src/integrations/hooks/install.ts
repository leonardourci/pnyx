import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { HydraError } from '../../store/errors.ts'
import { pnyxHome } from '../../store/storage.ts'
import type { Harness } from './observe.ts'

const SCRIPT = 'pnyx-hook.sh'
const SCRIPT_SOURCE = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'setup',
  'hooks',
  SCRIPT,
)
// The events Pnyx reads, for every tool: turn starts and ends, open requests, session
// start and end, compaction for harvesting, and model switches. Claude Code worktree
// events are left out because a command hook there replaces its own worktree handling.
const EVENTS: Record<Harness, string[]> = {
  claude: [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PermissionRequest',
    'PermissionDenied',
    'PostToolUse',
    'PostToolUseFailure',
    'Notification',
    'Elicitation',
    'ElicitationResult',
    'SubagentStart',
    'SubagentStop',
    'PostCompact',
    'Stop',
    'StopFailure',
    'SessionEnd',
    'PostModelSwitch',
  ],
  codex: [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'SubagentStart',
    'SubagentStop',
    'PostCompact',
    'Stop',
    'Interrupt',
    'SessionEnd',
  ],
}
// Codex caps SessionEnd and Interrupt hooks at 3 seconds; the script takes milliseconds, and
// the session-start summary well under a second.
const TIMEOUT_SECONDS = 3

interface Handler {
  type?: string
  command?: unknown
  [field: string]: unknown
}
interface Group {
  matcher?: string
  hooks?: Handler[]
  [field: string]: unknown
}
type Config = { hooks?: Record<string, Group[]> } & Record<string, unknown>

export function configPath({ harness }: { harness: Harness }): string {
  if (harness === 'claude') {
    return join(
      process.env.CLAUDE_CONFIG_DIR || join(
        homedir(),
        '.claude',
      ),
      'settings.json',
    )
  }

  return join(
    process.env.CODEX_HOME || join(
      homedir(),
      '.codex',
    ),
    'hooks.json',
  )
}

// The CLI the session-start hook runs for its summary; setup rewrites it on every run.
const CLI_ENTRY = join(
  import.meta.dirname,
  '..',
  '..',
  'cli',
  import.meta.url.endsWith('.ts') ? 'pnyx-axi.ts' : 'pnyx-axi.js',
)

export function scriptPath(): string {
  return join(
    pnyxHome(),
    'hooks',
    SCRIPT,
  )
}

function quote({ value }: { value: string }): string {
  return `'${value.replace(
    /'/g,
    '\'\\\'\'',
  )}'`
}

function isPnyx({ handler }: { handler: Handler }): boolean {
  return typeof handler.command === 'string' && handler.command.includes(`/${SCRIPT}`)
}

function readConfig({ path }: { path: string }): Config {
  if (!existsSync(path)) {
    return {}
  }

  let config: unknown

  try {
    config = JSON.parse(readFileSync(
      path,
      'utf8',
    ))
  } catch (error) {
    throw new HydraError({
      message: `cannot read ${path}: ${(error as Error).message}`,
      code: 'VALIDATION_ERROR',
      help: ['Fix the JSON by hand, then rerun'],
    })
  }

  const hooks = (config as Config | null)?.hooks
  const isObject = ({ value: v }: { value: unknown }) => typeof v === 'object' && v !== null && !Array.isArray(v)

  if (!isObject({ value: config }) || (hooks !== undefined && !isObject({ value: hooks }))) {
    throw new HydraError({
      message: `${path} is not a hook config object`,
      code: 'VALIDATION_ERROR',
      help: ['Fix it by hand, then rerun'],
    })
  }

  return config as Config
}

// The config with each event's first Pnyx handler updated in place and any other Pnyx
// handler taken out; Pnyx entries still missing are appended. Removing takes them all out.
function merged({
  config,
  harness,
  remove,
}: {
  config: Config
  harness: Harness
  remove: boolean
}): Config {
  const wanted = new Map(
    remove
      ? []
      : EVENTS[harness].map(event => [
        event,
        {
          type: 'command',
          command: `${quote({ value: scriptPath() })} ${harness} ${event}${event === 'SessionStart' ? ` ${quote({ value: CLI_ENTRY })}` : ''}`,
          timeout: TIMEOUT_SECONDS,
        },
      ]),
  )
  const hooks: Record<string, Group[]> = {}

  for (const [
    event,
    groups,
  ] of Object.entries(config.hooks ?? {})) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups
      continue
    }

    const kept = groups.flatMap(group => {
      if (!Array.isArray(group?.hooks) || !group.hooks.some(handler => isPnyx({ handler }))) {
        return [group]
      }

      const handlers = group.hooks.flatMap(h => {
        if (!isPnyx({ handler: h })) {
          return [h]
        }

        const want = wanted.get(event)

        // Pnyx groups match every tool, so one left from a version with a matcher is replaced.
        if (!want || group.matcher !== undefined) {
          return []
        }

        wanted.delete(event)

        return [
          {
            ...h,
            ...want,
          },
        ]
      })

      return handlers.length ? [
        {
          ...group,
          hooks: handlers,
        },
      ] : []
    })

    if (kept.length) {
      hooks[event] = kept
    }
  }

  for (const [
    event,
    handler,
  ] of wanted) {
    hooks[event] = [
      ...(hooks[event] ?? []),
      { hooks: [handler] },
    ]
  }

  const next: Config = {
    ...config,
    hooks,
  }

  if (Object.keys(hooks).length === 0) {
    delete next.hooks
  }

  return next
}

export interface SetupResult {
  harness: Harness
  config: string
  change: 'installed' | 'removed' | 'unchanged'
}

export function hookStatus(): 'current' | 'outdated' | 'missing' {
  if (!existsSync(scriptPath())) {
    return 'missing'
  }

  return readFileSync(scriptPath()).equals(readFileSync(SCRIPT_SOURCE)) ? 'current' : 'outdated'
}

export function setupHooks(
  {
    harness,
    opts,
  }: {
    harness: Harness
    opts: {
      remove: boolean
      preview: boolean
    }
  },
): SetupResult {
  const path = configPath({ harness })
  const config = readConfig({ path })
  const next = merged({
    config,
    harness,
    remove: opts.remove,
  })
  const changed = JSON.stringify(next) !== JSON.stringify(config)

  if (!opts.preview && !opts.remove) {
    mkdirSync(
      dirname(scriptPath()),
      { recursive: true },
    )
    copyFileSync(
      SCRIPT_SOURCE,
      scriptPath(),
    )
    chmodSync(
      scriptPath(),
      0o755,
    )
  }

  if (changed && !opts.preview) {
    mkdirSync(
      dirname(path),
      { recursive: true },
    )
    const target = existsSync(path) ? realpathSync(path) : path
    const tmp = `${target}.pnyx-${process.pid}`
    writeFileSync(
      tmp,
      `${JSON.stringify(
        next,
        null,
        2,
      )}\n`,
    )
    renameSync(
      tmp,
      target,
    )
  }

  return {
    harness,
    config: path,
    change: changed ? (opts.remove ? 'removed' : 'installed') : 'unchanged',
  }
}

export function detectedHarnesses(): Harness[] {
  return ([
    'claude',
    'codex',
  ] as const).filter(h => existsSync(dirname(configPath({ harness: h }))))
}
