// Installs Pnyx's reporting hook into the user-level Claude Code and Codex hook
// config by merging: other hook entries are kept as they are, and Pnyx's own
// entries are recognised by the hook script's name, so installing twice changes
// nothing and removing takes out only Pnyx's entries.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { BoardError } from '../../core/model.ts'
import { pnyxHome } from '../../store/board-store.ts'
import type { Harness } from './observe.ts'

const SCRIPT = 'pnyx-hook.sh'
// Same relative path from src/integrations/hooks and dist/integrations/hooks.
const SCRIPT_SOURCE = join(import.meta.dirname, '..', '..', '..', 'setup', 'hooks', SCRIPT)
// The tool events only report pull request and deploy commands, all run through the shell tool.
const EVENTS: { event: string; matcher?: string }[] = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'PreToolUse', matcher: 'Bash' },
  { event: 'PostToolUse', matcher: 'Bash' },
  { event: 'Stop' },
  { event: 'SubagentStart' },
  { event: 'SubagentStop' },
  { event: 'SessionEnd' },
]
// Codex caps SessionEnd hooks at 3 seconds; the script takes milliseconds.
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

export function configPath(harness: Harness): string {
  if (harness === 'claude') {
    return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')
  }

  return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json')
}

export function scriptPath(): string {
  return join(pnyxHome(), 'hooks', SCRIPT)
}

function quote(value: string): string {
  return `'${value.replace(/'/g, '\'\\\'\'')}'`
}

function isPnyx(handler: Handler): boolean {
  return typeof handler.command === 'string' && handler.command.includes(`/${SCRIPT}`)
}

function readConfig(path: string): Config {
  if (!existsSync(path)) {
    return {}
  }

  let config: unknown

  try {
    config = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new BoardError(`cannot read ${path}: ${(error as Error).message}`, 'VALIDATION_ERROR', ['Fix the JSON by hand, then rerun'])
  }

  const hooks = (config as Config | null)?.hooks
  const isObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v)

  if (!isObject(config) || (hooks !== undefined && !isObject(hooks))) {
    throw new BoardError(`${path} is not a hook config object`, 'VALIDATION_ERROR', ['Fix it by hand, then rerun'])
  }

  return config as Config
}

// The config with each event's first Pnyx handler updated in place and any other Pnyx
// handler taken out; Pnyx entries still missing are appended. Removing takes them all out.
function merged(config: Config, harness: Harness, remove: boolean): Config {
  const wanted = new Map(
    remove
      ? []
      : EVENTS.map(({ event, matcher }) => [
        event,
        { matcher, handler: { type: 'command', command: `${quote(scriptPath())} ${harness} ${event}`, timeout: TIMEOUT_SECONDS } },
      ]),
  )
  const hooks: Record<string, Group[]> = {}

  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups
      continue
    }

    const kept = groups.flatMap(group => {
      if (!Array.isArray(group?.hooks) || !group.hooks.some(isPnyx)) {
        return [group]
      }

      const handlers = group.hooks.flatMap(h => {
        if (!isPnyx(h)) {
          return [h]
        }

        const want = wanted.get(event)

        if (!want || group.matcher !== want.matcher) {
          return []
        }

        wanted.delete(event)

        return [{ ...h, ...want.handler }]
      })

      return handlers.length ? [{ ...group, hooks: handlers }] : []
    })

    if (kept.length) {
      hooks[event] = kept
    }
  }

  for (const [event, { matcher, handler }] of wanted) {
    hooks[event] = [...(hooks[event] ?? []), { ...(matcher ? { matcher } : {}), hooks: [handler] }]
  }

  const next: Config = { ...config, hooks }

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

// Applies the change unless previewing. The config is replaced atomically and only
// when its content changes; a symlinked config is written through the link.
export function setupHooks(
  harness: Harness,
  opts: { remove: boolean; preview: boolean },
): SetupResult {
  const path = configPath(harness)
  const config = readConfig(path)
  const next = merged(config, harness, opts.remove)
  const changed = JSON.stringify(next) !== JSON.stringify(config)

  if (!opts.preview && !opts.remove) {
    mkdirSync(dirname(scriptPath()), { recursive: true })
    copyFileSync(SCRIPT_SOURCE, scriptPath())
    chmodSync(scriptPath(), 0o755)
  }

  if (changed && !opts.preview) {
    mkdirSync(dirname(path), { recursive: true })
    const target = existsSync(path) ? realpathSync(path) : path
    const tmp = `${target}.pnyx-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`)
    renameSync(tmp, target)
  }

  return { harness, config: path, change: changed ? (opts.remove ? 'removed' : 'installed') : 'unchanged' }
}

// Harnesses whose config folder exists, for `setup hooks` without --harness.
export function detectedHarnesses(): Harness[] {
  return (['claude', 'codex'] as const).filter(h => existsSync(dirname(configPath(h))))
}
