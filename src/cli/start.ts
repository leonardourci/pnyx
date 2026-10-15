import { randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { decideNote, decidePush, findCard, type Decision, type Meta } from '../core/decide.ts'
import { boardConfig, hydraEvent, HYDRA_CARD } from '../core/hydra.ts'
import { BoardError, type AgentConfig, type BoardConfig, type BoardState, type Card } from '../core/model.ts'
import { paseoUrl } from '../core/paseo.ts'
import { liveTask, sessionId } from '../core/tasks.ts'
import { runCommand } from '../integrations/command/run.ts'
import { resolveHome } from '../integrations/firstmate/home.ts'
import { fmNote } from '../integrations/firstmate/reply.ts'
import { HARNESSES, createPaseoAgent, startAgent, type Harness } from '../integrations/paseo/launch.ts'
import type { Connect } from '../integrations/paseo/client.ts'
import { loadBoard, pnyxHome, withWriter, type Writer } from '../store/board-store.ts'
import { canonical, drainSpool, type Output } from './commands.ts'

export const VIAS = ['paseo', 'firstmate', 'command'] as const
type Via = (typeof VIAS)[number]
export const HYDRA_SKILL = join(import.meta.dirname, '..', '..', 'skills', 'pnyx-hydra', 'SKILL.md')
export const HOME_SKILL = join('.agents', 'skills', 'pnyx-hydra')

function chooseVia({ state, via }: { state: BoardState; via?: string }): Via {
  const chosen = via ?? (state.board?.hydra.kind === 'firstmate' ? 'firstmate' : 'paseo')

  if (!(VIAS as readonly string[]).includes(chosen)) {
    throw new BoardError({ message: `unknown start route: ${chosen}`, code: 'VALIDATION_ERROR', help: [`Use --via ${VIAS.join('|')}`] })
  }

  return chosen as Via
}

function apply({ writer, decision }: { writer: Writer; decision: Decision }): void {
  if ('event' in decision) {
    writer.append({ event: decision.event })
  }
}

function freeTask({ state, ref }: { state: BoardState; ref: string }): Card {
  const card = findCard({ state, ref })

  if (!liveTask({ card }) || card.id === HYDRA_CARD) {
    throw new BoardError({ message: `task not found: ${ref}`, code: 'NOT_FOUND', help: ['Run `pnyx-axi task list`'] })
  }

  if (card.sessionIds?.length) {
    throw new BoardError({ message: `task ${card.id} already has an attached agent; detach it first`, code: 'SESSION_CONFLICT' })
  }

  return card
}

interface QuotaModel {
  provider: string
  id: string
  effective?: { effectivePercentRemaining?: number }
}

function quotaModel({ harness, quota }: {
  harness: AgentConfig['harness']
  quota: NonNullable<AgentConfig['quota']>
}): string | undefined {
  try {
    const out = execFileSync('quota-axi', ['models', '--intelligence', quota, '--sort', 'runway', '--json', '--max-age', '5m', '--provider', harness], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] })
    const { models = [] } = JSON.parse(out) as { models?: QuotaModel[] }

    return models.find(m => m.provider === harness
      && (m.effective?.effectivePercentRemaining ?? 1) > 0)?.id
  } catch {
    return undefined
  }
}

// The agent a start uses: the named kind, else `default` (or `hydra`), else Claude Code's defaults.
export function agentFor({ state, board, kind }: {
  state: BoardState
  board: string
  kind: string
}): AgentConfig {
  const agents = boardConfig({ state, id: board }).agents ?? {}
  const configured = Object.hasOwn(agents, kind) ? agents[kind] : undefined

  if (!configured && kind !== 'default' && kind !== 'hydra') {
    throw new BoardError({ message: `no agent configured for kind ${kind}`, code: 'NOT_FOUND', help: [`Run \`pnyx-axi kind set ${kind} --harness claude --board ${board}\``] })
  }

  const agent: AgentConfig = { ...(configured ?? { harness: 'claude' }) }

  if (agent.quota) {
    agent.model = quotaModel({ harness: agent.harness, quota: agent.quota }) ?? agent.model
  }

  return agent
}

export function workerPrompt({ board, id, title }: {
  board: string
  id: string
  title: string
}): string {
  return [
    `You are the Pnyx worker for task ${id} "${title}" on board ${board}. Follow the pnyx-worker skill when it is installed.`,
    `Start with \`pnyx-axi task show ${id} --board ${board}\` and \`pnyx-axi task history ${id} --board ${board}\`.`,
    `Declare progress only with \`pnyx-axi task status ${id} working|needs_you|paused|blocked|done --note <text> --board ${board}\`; silence changes nothing.`,
  ].join(' ')
}

const hydraPrompt = ({ board }: { board: string }) =>
  `You are Hydra, the orchestrator of the Pnyx board "${board}". Read ${HYDRA_SKILL} and follow it. `
  + `Start with \`pnyx-axi task list --board ${board}\` and \`pnyx-axi hydra messages --board ${board}\`.`

export async function startTask({
  board, task, via, kind, harness, prompt, folder, url, meta, connect,
}: {
  board: string
  task: string
  via?: string
  kind?: string
  harness?: string
  prompt?: string
  folder?: string
  url?: string
  meta: Meta
  connect?: Connect
}): Promise<Output> {
  const state = loadBoard({ board }).state
  const how = chooseVia({ state, via })

  if (how === 'firstmate') {
    return askFirstmate({ board, task, prompt, meta })
  }

  if (how === 'command') {
    return startCommand({ board, role: 'worker', task, prompt, folder, harness, meta })
  }

  const agent = agentFor({ state, board, kind: kind ?? 'default' })
  const card = findCard({ state, ref: task })

  return startAgent({
    board,
    task,
    harness: harness ?? agent.harness,
    agent,
    prompt: prompt ?? workerPrompt({ board, id: card.id, title: card.title }),
    folder,
    url,
    meta,
    connect,
  })
}

// Puts the request in Hydra's board chat, then hands it to the Firstmate home that is
// this board's Hydra as an inbox note, which wakes Firstmate. The note's request id
// is the message's, so a retry replays the same note.
function askFirstmate({ board, task, prompt, meta }: {
  board: string
  task: string
  prompt?: string
  meta: Meta
}): Output {
  const queued = withWriter({
    board,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const card = freeTask({ state: writer.state, ref: task })
      const config = boardConfig({ state: writer.state, id: board })

      if (config.hydra.kind !== 'firstmate' || !config.hydra.home) {
        throw new BoardError({ message: `board ${board} has no Firstmate Hydra`, code: 'NO_ROUTE', help: [`Run \`pnyx-axi setup hydra --home <firstmate home> --board ${board}\``] })
      }

      const text = [
        `Pnyx board ${board} asks for a worker on task ${card.id} "${card.title}"${card.folder ? ` in ${card.folder}` : ''}.`,
        ...(prompt ? [`Request: ${prompt}`] : []),
        `Use the pnyx-hydra skill: read \`pnyx-axi task show ${card.id} --board ${board}\`, dispatch the worker, and keep the task's status current.`,
      ].join('\n')
      const id = meta.id ?? randomUUID()
      apply({ writer, decision: hydraEvent({ state: writer.state, meta: { ...meta, id }, cardId: card.id, change: { type: 'hydra.message', data: { task: card.id, action: 'worker', text, hydra: config.hydra.id } } }) })

      return { card: card.id, home: config.hydra.home, id, text }
    },
  })
  const sent = fmNote({ home: queued.home, requestId: `pnyx:${board}:${queued.id}`, text: queued.text })

  return {
    task: queued.card,
    via: 'firstmate',
    message: queued.id,
    sent: sent.state,
    ...(sent.detail ? { detail: sent.detail } : {}),
    help: sent.state === 'failed'
      ? [`The request stays in \`pnyx-axi hydra messages --board ${board}\`; retry with --event-id ${queued.id}`]
      : [`Firstmate dispatches the worker; follow it with \`pnyx-axi task history ${queued.card} --board ${board}\``],
  }
}

// Runs the board's command with the task in its environment, then notes the start;
// a repeated event id runs nothing again.
function startCommand({ board, role, task, prompt, folder, harness, meta }: {
  board: string
  role: 'worker' | 'hydra'
  task?: string
  prompt?: string
  folder?: string
  harness?: string
  meta: Meta
}): Output {
  const id = meta.id ?? randomUUID()
  const claimed = withWriter({
    board,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const config = boardConfig({ state: writer.state, id: board })

      if (!config.command) {
        throw new BoardError({ message: `board ${board} has no start command`, code: 'NO_COMMAND', help: [`Run \`pnyx-axi board set --board ${board} --command '<shell command>'\``] })
      }

      const card = role === 'worker' ? freeTask({ state: writer.state, ref: task! }) : undefined
      const cwd = canonical({ path: folder }) ?? card?.folder ?? (role === 'hydra' ? process.cwd() : undefined)

      if (!cwd || !existsSync(cwd)) {
        throw new BoardError({ message: cwd ? `folder not found: ${cwd}` : 'choose the folder the agent works in', code: 'VALIDATION_ERROR', help: ['Pass --folder <absolute path>'] })
      }

      const duplicate = `${id}:started` in writer.state.eventIds

      if (!duplicate && role === 'hydra' && !writer.state.configured) {
        apply({ writer, decision: hydraEvent({ state: writer.state, meta: { ...meta, id: `${id}:board` }, cardId: '$board', change: { type: 'board.configured', data: config } }) })
      }

      return { duplicate, command: config.command, cwd, card }
    },
  })
  const target = claimed.card?.id ?? HYDRA_CARD

  if (claimed.duplicate) {
    return { task: target, event: 'none: duplicate', help: ['This start was already recorded; nothing was started again'] }
  }

  const { pid } = runCommand({
    command: claimed.command,
    cwd: claimed.cwd,
    env: {
      PNYX_HOME: pnyxHome(),
      PNYX_BOARD: board,
      PNYX_TASK: target,
      PNYX_ROLE: role,
      PNYX_TASK_TITLE: claimed.card?.title ?? 'Hydra',
      PNYX_PROMPT: prompt ?? (role === 'hydra' ? hydraPrompt({ board }) : ''),
      PNYX_HARNESS: harness ?? '',
      PNYX_FOLDER: claimed.cwd,
    },
  })
  const text = `Started ${role === 'hydra' ? 'Hydra' : 'a worker'} with the board command in ${claimed.cwd}`
  withWriter({
    board,
    fn: ({ writer }) => apply({ writer, decision: decideNote({ state: writer.state, ref: target, note: { kind: 'context', source: 'pnyx:start', text }, meta: { ...meta, id: `${id}:started` } }) }),
  })

  return {
    [role === 'hydra' ? 'hydra' : 'task']: target,
    via: 'command',
    pid,
    folder: claimed.cwd,
    help: [role === 'hydra'
      ? `Its first session becomes the board's Hydra; check \`pnyx-axi board show --board ${board}\``
      : `Its session attaches to ${target} when its hooks first report; check \`pnyx-axi task show ${target} --board ${board}\``],
  }
}

export async function startHydra({
  board, via, kind, harness, prompt, folder, home, url, meta, connect,
}: {
  board: string
  via?: string
  kind?: string
  harness?: string
  prompt?: string
  folder?: string
  home?: string
  url?: string
  meta: Meta
  connect?: Connect
}): Promise<Output> {
  const current = loadBoard({ board }).state.board?.hydra
  const how = via ?? (home || current?.kind === 'firstmate' ? 'firstmate' : 'paseo')

  if (how === 'firstmate') {
    const given = home ?? current?.home

    if (!given) {
      throw new BoardError({ message: 'a Firstmate Hydra needs --home <firstmate home>', code: 'VALIDATION_ERROR' })
    }

    return setupHydra({ board, home: given, meta })
  }

  if (how === 'command') {
    return startCommand({ board, role: 'hydra', prompt, folder, harness, meta })
  }

  if (how !== 'paseo') {
    throw new BoardError({ message: `unknown start route: ${how}`, code: 'VALIDATION_ERROR', help: [`Use --via ${VIAS.join('|')}`] })
  }

  const agent = agentFor({ state: loadBoard({ board }).state, board, kind: kind ?? 'hydra' })
  const chosen = (harness ?? agent.harness) as Harness

  if (!Object.hasOwn(HARNESSES, chosen)) {
    throw new BoardError({ message: `unknown harness: ${chosen}`, code: 'VALIDATION_ERROR', help: ['Use claude or codex'] })
  }

  const id = meta.id ?? randomUUID()
  const cwd = canonical({ path: folder }) ?? process.cwd()
  const endpoint = paseoUrl({ url })
  const free = withWriter({
    board,
    fn: ({ writer }) => {
      drainSpool({ writer })

      if (`${id}:hydra` in writer.state.eventIds) {
        return false
      }

      if (writer.state.board?.hydra.session) {
        throw new BoardError({ message: `board ${board} already has a Hydra session`, code: 'CONFLICT', help: [`Run \`pnyx-axi board set --board ${board} --hydra <new identity>\` to replace it`] })
      }

      return true
    },
  })

  if (!free) {
    return { hydra: HYDRA_CARD, event: 'none: duplicate', help: ['This start was already recorded; nothing was started again'] }
  }

  const { agent: started, ref } = await createPaseoAgent({
    harness: chosen,
    agent,
    prompt: prompt ?? hydraPrompt({ board }),
    cwd,
    title: `Hydra · ${board}`,
    id,
    // No PNYX_TASK: the Paseo agent is recorded as Hydra here, not by its hooks.
    env: { PNYX_HOME: pnyxHome(), PNYX_BOARD: board },
    labels: { 'pnyx.board': board, 'pnyx.role': 'hydra' },
    url: endpoint,
    connect,
  })

  return withWriter({
    board,
    fn: ({ writer }) => {
      drainSpool({ writer })
      apply({
        writer,
        decision: decidePush({
          state: writer.state,
          key: `paseo:${started.id}`,
          input: { title: `Hydra · ${board}`, agent: ref, activity: 'working', source: { adapter: 'paseo', instanceId: endpoint, objectId: started.id, observedAt: meta.at } },
          meta: { ...meta, id: `${id}:session`, ifRevision: undefined },
        }),
      })
      const config = boardConfig({ state: writer.state, id: board })
      const hydra = { ...config.hydra, kind: 'agent' as const, session: sessionId({ agent: ref }) }
      delete hydra.home
      apply({ writer, decision: hydraEvent({ state: writer.state, meta: { ...meta, id: `${id}:hydra` }, cardId: '$board', change: { type: 'board.configured', data: { ...config, hydra } } }) })

      return {
        hydra: { session: hydra.session, paseo: started.id, folder: cwd },
        help: [`Talk to Hydra in Paseo, or queue work with \`pnyx-axi hydra send --board ${board} --text <message>\``],
      }
    },
  })
}

export function setupHydra({ board, home, meta }: {
  board: string
  home: string
  meta: Meta
}): Output {
  const real = resolveHome({ path: home })
  const dir = join(real, HOME_SKILL)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), readFileSync(HYDRA_SKILL))
  const excluded = exclude({ home: real, path: `/${HOME_SKILL}/` })

  withWriter({
    board,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const config = boardConfig({ state: writer.state, id: board })

      if (config.hydra.kind === 'firstmate' && config.hydra.home === real) {
        return
      }

      const data: BoardConfig = { ...config, hydra: { id: `firstmate:${basename(real)}`, kind: 'firstmate', name: config.hydra.name, home: real } }
      apply({ writer, decision: hydraEvent({ state: writer.state, meta, cardId: '$board', change: { type: 'board.configured', data } }) })
    },
  })

  const text = [
    `Pnyx board ${board} uses this home as its Hydra.`,
    `Load the pnyx-hydra skill (${join(HOME_SKILL, 'SKILL.md')}) and follow it for that board.`,
    `Start with \`pnyx-axi task list --board ${board}\` and \`pnyx-axi hydra messages --board ${board}\`.`,
  ].join('\n')
  const sent = fmNote({ home: real, requestId: `pnyx:${board}:hydra-skill`, text })

  return {
    board,
    hydra: { kind: 'firstmate', home: real },
    skill: join(dir, 'SKILL.md'),
    excluded: excluded ? 'yes' : 'no: not a git clone',
    note: sent.state,
    ...(sent.detail ? { detail: sent.detail } : {}),
    help: [`Run \`pnyx-axi serve --board ${board}\` to see the board; Firstmate tasks sync from this home`],
  }
}

function exclude({ home, path }: { home: string; path: string }): boolean {
  const found = spawnSync('git', ['-C', home, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' })

  if (found.status !== 0 || !found.stdout.trim()) {
    return false
  }

  const given = found.stdout.trim()
  const file = isAbsolute(given) ? given : join(home, given)
  mkdirSync(dirname(file), { recursive: true })
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''

  if (!current.split('\n').includes(path)) {
    appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${path}\n`)
  }

  return true
}
