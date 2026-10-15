// Agent kinds, worker launches and Hydra's light check. Launching types a harness
// command line into a new Paseo terminal; Pnyx records it and never supervises it.
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { AxiError } from 'axi-sdk-js'
import { boardConfig, hydraEvent } from '../core/hydra.ts'
import { findCard } from '../core/decide.ts'
import { liveTask } from '../core/tasks.ts'
import { BoardError, HARNESS_NAMES, QUOTA_BUCKETS, type AgentConfig, type BoardEvent, type BoardState, type EventType } from '../core/model.ts'
import { boardDir, loadBoard, readEvents } from '../store/board-store.ts'
import { commandLine, createTerminal, quotaModel, typeCommand } from '../integrations/paseo/launch.ts'
import { COMMON, WRITE, canonical, commit, commands, guard, integer, meta, parse, required, summarize, type Output } from './commands.ts'

const DEFAULT_AGENT: AgentConfig = { harness: 'claude' }
const HYDRA_ACTOR = 'hydra'
const SAFE = /^[\w.:/[\]-]{1,100}$/

function agentFor({ state, board, kind }: {
  state: BoardState
  board: string
  kind: string
}): AgentConfig {
  const configured = boardConfig({ state, id: board }).agents?.[kind]

  if (!configured && kind !== 'default' && kind !== 'hydra') {
    throw new BoardError({ message: `no agent configured for kind ${kind}`, code: 'NOT_FOUND', help: [`Run \`pnyx-axi kind set ${kind} --harness claude --board ${board}\``] })
  }

  const agent = { ...(configured ?? DEFAULT_AGENT) }

  if (agent.quota) {
    agent.model = quotaModel({ agent }) ?? agent.model
  }

  return agent
}

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

  const harness = String(values.harness ?? 'claude')
  const quota = values.quota === 'off' ? undefined : values.quota as string | undefined

  if (!(HARNESS_NAMES as readonly string[]).includes(harness)) {
    throw new BoardError({ message: `--harness must be ${HARNESS_NAMES.join(' or ')}`, code: 'VALIDATION_ERROR' })
  }

  if (quota !== undefined && !(QUOTA_BUCKETS as readonly string[]).includes(quota)) {
    throw new BoardError({ message: `--quota must be ${QUOTA_BUCKETS.join(', ')} or off`, code: 'VALIDATION_ERROR' })
  }

  for (const flag of ['model', 'effort', 'mode'] as const) {
    if (values[flag] !== undefined && !SAFE.test(String(values[flag]))) {
      throw new BoardError({ message: `--${flag} has characters a harness flag cannot take`, code: 'VALIDATION_ERROR' })
    }
  }

  const m = meta({ values })

  return commit({
    board,
    meta: m,
    intent: { type: 'board.configured', card: '$board' },
    decide: ({ state }) => {
      const current = boardConfig({ state, id: board })
      const agents = { ...current.agents }

      if (action === 'remove') {
        if (!agents[kind]) {
          return { skipped: 'unchanged' }
        }

        delete agents[kind]
      } else {
        agents[kind] = {
          harness: harness as AgentConfig['harness'],
          ...(values.model ? { model: String(values.model) } : {}),
          ...(values.effort ? { effort: String(values.effort) } : {}),
          ...(values.mode ? { mode: String(values.mode) } : {}),
          ...(quota ? { quota: quota as AgentConfig['quota'] } : {}),
        }
      }

      return hydraEvent({ state, meta: m, cardId: '$board', change: { type: 'board.configured', data: { ...current, agents } } })
    },
  })
}

function workerPrompt({ board, id, title, request, text }: {
  board: string
  id: string
  title: string
  request?: string
  text?: string
}): string {
  return [
    `You are the Pnyx worker for task ${id} "${title}" on board ${board}. Follow the pnyx-worker skill when it is installed.`,
    `Start with \`pnyx-axi task show ${id} --board ${board}\` and \`pnyx-axi task history ${id} --board ${board}\`.`,
    `Declare progress only with \`pnyx-axi task status ${id} working|needs_you|paused|blocked|done --note <text> --board ${board}\`; silence changes nothing.`,
    ...(request ? [`Hydra's request: ${request}`] : []),
    ...(text ? [text] : []),
  ].join(' ')
}

function workerCommand({ args }: { args: string[] }): Output {
  const { values, positionals, board } = parse({ args, options: { ...WRITE, kind: { type: 'string' }, cwd: { type: 'string' }, request: { type: 'string' }, text: { type: 'string' }, preview: { type: 'boolean' } }, positionals: 2 })

  if (positionals[0] !== 'create') {
    throw new BoardError({ message: 'Use worker create <task> [--kind <kind>] [--cwd <dir>] [--request <message>] [--text <instructions>] [--preview]', code: 'VALIDATION_ERROR' })
  }

  const ref = required({ value: positionals[1], what: 'task id' })
  const kind = String(values.kind ?? 'default')
  const state = loadBoard({ board }).state
  const task = findCard({ state, ref })

  if (!liveTask({ card: task })) {
    throw new BoardError({ message: 'choose a task, not an unassigned session', code: 'VALIDATION_ERROR' })
  }

  if (task.sessionIds?.length) {
    throw new BoardError({ message: `task ${task.id} already has a worker: ${task.sessionIds[0]}`, code: 'CONFLICT', help: [`Run \`pnyx-axi task detach ${task.id} --board ${board}\` first`] })
  }

  const request = values.request === undefined
    ? undefined
    : state.hydraMessages?.find(h => h.id === values.request)

  if (values.request !== undefined && !request) {
    throw new BoardError({ message: `no Hydra message ${String(values.request)}`, code: 'NOT_FOUND', help: [`Run \`pnyx-axi hydra messages --board ${board}\``] })
  }

  const folder = canonical({ path: values.cwd ?? task.folder ?? process.cwd() })

  if (!folder) {
    throw new BoardError({ message: '--cwd must be an absolute path', code: 'VALIDATION_ERROR' })
  }

  const agent = agentFor({ state, board, kind })
  const command = commandLine({
    agent,
    prompt: workerPrompt({
      board,
      id: task.id,
      title: task.title,
      request: request?.text,
      text: values.text as string | undefined,
    }),
    env: { PNYX_BOARD: board, PNYX_TASK: task.id, PNYX_ACTOR: `worker:${task.id}` },
  })

  if (values.preview) {
    return { task: task.id, kind, agent, folder, command, help: ['Run the command in any terminal in that folder; its first session there joins the task when the task has that folder'] }
  }

  const terminal = createTerminal({ cwd: folder, name: `pnyx ${task.id} ${task.title}`.slice(0, 60) })
  const m = meta({ values })
  const out = commit({
    board,
    meta: m,
    intent: { type: 'worker.launched', card: task.id },
    decide: ({ state: current }) => {
      if (findCard({ state: current, ref: task.id }).sessionIds?.length) {
        throw new BoardError({ message: `task ${task.id} gained a worker meanwhile`, code: 'CONFLICT' })
      }

      return hydraEvent({ state: current, meta: m, cardId: task.id, change: { type: 'worker.launched', data: { kind, agent, folder, terminal, ...(request ? { request: request.id } : {}) } } })
    },
  })
  typeCommand({ terminal, command })

  return { ...out, terminal, agent, help: [`Its first session in that terminal joins the task; run \`pnyx-axi task show ${task.id} --board ${board}\` to see it`] }
}

function hydraStart({ args }: { args: string[] }): Output {
  const { values, board } = parse({ args, options: { ...COMMON, cwd: { type: 'string' }, preview: { type: 'boolean' } }, positionals: 1 })
  const state = loadBoard({ board }).state
  const config = boardConfig({ state, id: board })

  if (config.hydra.kind === 'firstmate') {
    throw new BoardError({ message: 'this board\'s Hydra is Firstmate, which runs on its own', code: 'VALIDATION_ERROR' })
  }

  const folder = canonical({ path: values.cwd ?? process.cwd() })

  if (!folder) {
    throw new BoardError({ message: '--cwd must be an absolute path', code: 'VALIDATION_ERROR' })
  }

  const agent = agentFor({ state, board, kind: 'hydra' })
  const command = commandLine({
    agent,
    prompt: `You are Hydra, the orchestrator of Pnyx board ${board}. Follow the pnyx-hydra skill. First run \`pnyx-axi board set --session self --board ${board}\`, then read \`pnyx-axi hydra messages --board ${board}\` and \`pnyx-axi task list --board ${board}\`.`,
    env: { PNYX_BOARD: board, PNYX_ACTOR: HYDRA_ACTOR },
  })

  if (values.preview) {
    return { board, agent, folder, command }
  }

  const terminal = createTerminal({ cwd: folder, name: `pnyx hydra ${board}` })
  typeCommand({ terminal, command })

  return { board, terminal, agent, help: [`Hydra binds itself with \`board set --session self\`; run \`pnyx-axi board show --board ${board}\` to see it`] }
}

// What Hydra tracks. Its own writes (actor hydra) and hook chatter never wake it.
const TRACKED: readonly EventType[] = ['hydra.message', 'task.created', 'task.declared', 'task.session', 'board.columns', 'card.moved', 'card.linked', 'worker.launched']
const CHECK_LIMIT = 20
const POLL_MS = 2000

async function hydraCheck({ args }: { args: string[] }): Promise<Output> {
  const { values, board } = parse({ args, options: { ...COMMON, after: { type: 'string' }, wait: { type: 'string' } }, positionals: 1 })
  const wait = integer({ value: values.wait, flag: '--wait' }) ?? 0

  if (wait > 3600) {
    throw new AxiError('--wait is at most 3600 seconds', 'VALIDATION_ERROR')
  }

  const after = integer({ value: values.after, flag: '--after' }) ?? loadBoard({ board }).state.seq
  const log = join(boardDir({ board }), 'events.jsonl')

  const size = () => {
    try {
      return statSync(log).size
    } catch {
      return 0
    }
  }

  let events: BoardEvent[] = []
  const tracked = () => events.filter(e => e.seq > after && TRACKED.includes(e.type)
    && e.actor !== HYDRA_ACTOR)
  const deadline = Date.now() + wait * 1000
  let seen = -1

  // ponytail: rereads the whole log whenever it grows; read from a byte offset if logs get large.
  for (;;) {
    if (size() !== seen) {
      seen = size()
      events = readEvents({ board })
    }

    if (tracked().length || Date.now() >= deadline) {
      break
    }

    await sleep(Math.min(POLL_MS, deadline - Date.now()))
  }

  const changes = tracked()
  const page = changes.slice(0, CHECK_LIMIT)
  const through = changes.length > CHECK_LIMIT
    ? page.at(-1)!.seq
    : Math.max(after, events.at(-1)?.seq ?? 0)

  return {
    board,
    changes: page.length ? page.map(e => ({ seq: e.seq, type: e.type, task: e.cardId, actor: e.actor, summary: summarize({ event: e }) })) : `none: nothing Hydra tracks changed after seq ${after}`,
    through,
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
const hydraStartHandler = guard({ handler: hydraStart })

export const workerCommands = {
  kind: guard({ handler: kindCommand }),
  worker: guard({ handler: workerCommand }),
  hydra: guard({
    handler: ({ args }) => (args[0] === 'check' ? hydraCheckHandler(args)
      : args[0] === 'start' ? hydraStartHandler(args) : commands.hydra(args)),
  }),
}

export const WORKER_HELP: Record<string, string> = {
  kind: `usage: pnyx-axi kind list
pnyx-axi kind set <kind> [--harness claude|codex] [--model <model>] [--effort <effort>] [--mode <mode>] [--quota high|medium|low|off]
pnyx-axi kind remove <kind>
The agent each task kind's workers launch on. \`default\` is used when worker create names no kind, and \`hydra\` is what hydra start launches; both fall back to Claude Code with its own defaults.
--mode is Claude Code's --permission-mode, or for Codex bypass or a --sandbox mode. --quota picks, at launch, the model with the most runway in that intelligence bucket for the harness through quota-axi, keeping --model when quota-axi cannot tell.
`,
  worker: `usage: pnyx-axi worker create <task> [--kind <kind>] [--cwd <dir>] [--request <hydra-message-id>] [--text <instructions>] [--preview]
Opens a Paseo terminal in --cwd (the task's folder, else the current one), types the kind's harness command with a first prompt, and records worker.launched on the task.
The first session in that terminal and folder joins the task. --request links the Hydra message being answered and adds its text to the prompt.
--preview prints the command line without launching anything. A task with a worker must be detached first.
`,
}
