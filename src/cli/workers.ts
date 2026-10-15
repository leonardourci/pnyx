import { checkAttachments } from '../integrations/presence/check.ts'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { AxiError } from 'axi-sdk-js'
import { boardConfig, hydraEvent } from '../core/hydra.ts'
import { BoardError, HARNESS_NAMES, QUOTA_BUCKETS, type AgentConfig, type BoardEvent, type EventType } from '../core/model.ts'
import { boardDir, loadBoard, readEventsFrom } from '../store/board-store.ts'
import { COMMON, WRITE, commit, commands, guard, integer, meta, parse, required, summarize, type Output } from './commands.ts'

const HYDRA_ACTOR = 'hydra'
const SAFE = /^[\w.:/[\]-]{1,100}$/

function kindCommand({ args }: { args: string[] }): Output {
  const { values, positionals, board } = parse({ args, options: { ...WRITE, harness: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, mode: { type: 'string' }, quota: { type: 'string' } }, positionals: 2 })
  const action = positionals[0] ?? 'list'

  if (action === 'list') {
    const agents = boardConfig({ state: loadBoard({ board }).state, id: board }).agents ?? {}

    return {
      board,
      kinds: Object.keys(agents).length ? Object.entries(agents).map(([kind, a]) => ({ kind, harness: a.harness, model: a.model ?? 'default', effort: a.effort ?? 'default', mode: a.mode ?? 'default', quota: a.quota ?? 'off' })) : 'none: workers launch on Claude Code with its own defaults',
      help: [`Run \`pnyx-axi kind set <kind> --harness claude|codex [--model <m>] [--effort <e>] [--mode <m>] [--quota high|medium|low] --board ${board}\``],
    }
  }

  if (action !== 'set' && action !== 'remove') {
    throw new BoardError({ message: 'Use kind list, set <kind> or remove <kind>', code: 'VALIDATION_ERROR' })
  }

  const kind = required({ value: positionals[1], what: 'kind' })

  if (!/^[a-z][a-z0-9-]{0,39}$/.test(kind)) {
    throw new BoardError({ message: 'kinds use lowercase letters, digits and dashes', code: 'VALIDATION_ERROR' })
  }

  const harness = values.harness as string | undefined
  const quota = values.quota as string | undefined

  if (harness !== undefined && !(HARNESS_NAMES as readonly string[]).includes(harness)) {
    throw new BoardError({ message: `--harness must be ${HARNESS_NAMES.join(' or ')}`, code: 'VALIDATION_ERROR' })
  }

  if (quota !== undefined && quota !== 'off' && !(QUOTA_BUCKETS as readonly string[]).includes(quota)) {
    throw new BoardError({ message: `--quota must be ${QUOTA_BUCKETS.join(', ')} or off`, code: 'VALIDATION_ERROR' })
  }

  for (const flag of ['model', 'effort', 'mode'] as const) {
    if (values[flag] && !SAFE.test(String(values[flag]))) {
      throw new BoardError({ message: `--${flag} has characters a harness flag cannot take`, code: 'VALIDATION_ERROR' })
    }
  }

  const m = meta({ values })

  return commit({
    board,
    meta: m,
    intent: { type: 'board.agents', card: '$board' },
    decide: ({ state }) => {
      const before = boardConfig({ state, id: board }).agents ?? {}
      const agents = { ...before }
      const existing = Object.hasOwn(before, kind) ? before[kind] : undefined

      if (action === 'remove') {
        if (!existing) {
          return { skipped: 'unchanged' }
        }

        delete agents[kind]
      } else {
        const agent: AgentConfig = { ...existing, harness: (harness ?? existing?.harness ?? 'claude') as AgentConfig['harness'] }

        for (const [flag, value] of [['model', values.model], ['effort', values.effort], ['mode', values.mode], ['quota', quota === 'off' ? '' : quota]] as const) {
          if (value === '') {
            delete agent[flag]
          } else if (value !== undefined) {
            Object.assign(agent, { [flag]: String(value) })
          }
        }

        if (isDeepStrictEqual(agent, existing)) {
          return { skipped: 'unchanged' }
        }

        agents[kind] = agent
      }

      return hydraEvent({ state, meta: m, cardId: '$board', change: { type: 'board.agents', data: { agents, before } } })
    },
  })
}

// What Hydra tracks. Its own writes (actor hydra) and hook chatter never wake it.
const TRACKED: readonly EventType[] = ['hydra.message', 'task.created', 'task.declared', 'task.session', 'board.columns', 'card.moved', 'card.linked', 'task.launched']
const CHECK_LIMIT = 20
const POLL_MS = 2000

async function hydraCheck({ args }: { args: string[] }): Promise<Output> {
  const { values, board } = parse({ args, options: { ...COMMON, after: { type: 'string' }, wait: { type: 'string' } }, positionals: 1 })
  const wait = integer({ value: values.wait, flag: '--wait' }) ?? 0

  if (wait > 3600) {
    throw new AxiError('--wait is at most 3600 seconds', 'VALIDATION_ERROR')
  }

  const after = integer({ value: values.after, flag: '--after' }) ?? loadBoard({ board }).state.seq
  boardDir({ board })
  const deadline = Date.now() + wait * 1000
  const changes: BoardEvent[] = []
  let offset = 0
  let last = after

  for (;;) {
    const read = readEventsFrom({ board, offset })

    if (read) {
      offset = read.end

      for (const e of read.events) {
        last = Math.max(last, e.seq)

        if (e.seq > after && TRACKED.includes(e.type) && e.actor !== HYDRA_ACTOR) {
          changes.push(e)
        }
      }
    }

    if (changes.length || Date.now() >= deadline) {
      break
    }

    await sleep(Math.min(POLL_MS, deadline - Date.now()))
  }

  const page = changes.slice(0, CHECK_LIMIT)
  const through = changes.length > CHECK_LIMIT ? page.at(-1)!.seq : last
  const row = ({ e }: { e: BoardEvent }) => ({
    seq: e.seq,
    id: e.id,
    type: e.type,
    task: e.cardId === '$board' ? 'none' : e.cardId,
    action: e.type === 'hydra.message' ? e.data.action : 'none',
    actor: e.actor,
    summary: summarize({ event: e }),
  })

  return {
    board,
    changes: page.length ? page.map(e => row({ e })) : `none: nothing Hydra tracks changed after seq ${after}`,
    through,
    agents: await checkAttachments({ state: loadBoard({ board }).state }),
    help: [`Run \`pnyx-axi hydra check --after ${through} --wait 1800 --board ${board}\` to wait for the next change`],
  }
}

// guard catches only synchronous errors; the check can wait.
const hydraCheckHandler = guard({
  handler: ({ args }) => hydraCheck({ args }).catch((error: unknown) => {
    if (error instanceof BoardError) {
      throw new AxiError(error.message, error.code, error.help)
    }

    throw error
  }),
})

export const workerCommands = {
  kind: guard({ handler: kindCommand }),
  hydra: guard({
    handler: ({ args }) => (args[0] === 'check' ? hydraCheckHandler(args) : commands.hydra(args)),
  }),
}

export const WORKER_HELP: Record<string, string> = {
  kind: `usage: pnyx-axi kind list
pnyx-axi kind set <kind> [--harness claude|codex] [--model <model>] [--effort <effort>] [--mode <mode>] [--quota high|medium|low|off]
pnyx-axi kind remove <kind>
set changes only the flags given: an empty --model, --effort or --mode, or --quota off, clears that field; a new kind starts on claude.
The agent \`task start --via paseo\` starts for each kind of task. \`default\` is used when --kind is not given, and \`hydra\` is what \`hydra start --via paseo\` starts; both fall back to Claude Code with its own defaults.
--effort is the Paseo thinking option and --mode the Paseo mode (for Claude Code: plan, default, acceptEdits, auto or bypassPermissions); --harness on a start overrides the kind's harness. --quota picks, at launch, the model with the most runway in that intelligence bucket for the harness through quota-axi, keeping --model when quota-axi cannot tell.
`,
}
