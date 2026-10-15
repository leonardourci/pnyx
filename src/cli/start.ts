// Starts a task's worker or a board's Hydra through Paseo, Firstmate or the board's
// own command, and records each start on the board. Pnyx never supervises what it
// starts: Paseo keeps its agents, Firstmate dispatches its own crew, and a command's
// agent reports through its hooks like any other session.
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { decideNote, decidePush, findCard, type Decision, type Meta } from '../core/decide.ts'
import { boardConfig, hydraEvent, HYDRA_CARD } from '../core/hydra.ts'
import { BoardError, type BoardConfig, type BoardState, type Card } from '../core/model.ts'
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
// Same relative path from src/cli and dist/cli.
export const HYDRA_SKILL = join(import.meta.dirname, '..', '..', 'skills', 'pnyx-hydra', 'SKILL.md')
// Where a Firstmate home finds a skill of its own, outside Firstmate's tracked files.
const HOME_SKILL = join('.agents', 'skills', 'pnyx-hydra')

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

const hydraPrompt = ({ board }: { board: string }) =>
  `You are Hydra, the orchestrator of the Pnyx board "${board}". Read ${HYDRA_SKILL} and follow it. `
  + `Start with \`pnyx-axi task list --board ${board}\` and \`pnyx-axi hydra messages --board ${board}\`.`

export async function startTask({ board, task, via, harness, prompt, folder, url, meta, connect }: {
  board: string
  task: string
  via?: string
  harness?: string
  prompt?: string
  folder?: string
  url?: string
  meta: Meta
  connect?: Connect
}): Promise<Output> {
  const how = chooseVia({ state: loadBoard({ board }).state, via })

  if (how === 'firstmate') {
    return askFirstmate({ board, task, prompt, meta })
  }

  if (how === 'command') {
    return startCommand({ board, role: 'worker', task, prompt, folder, harness, meta })
  }

  if (!harness || !prompt) {
    throw new BoardError({ message: 'a Paseo start needs --harness and --prompt', code: 'VALIDATION_ERROR', help: ['Pass --harness claude|codex --prompt <opening message>'] })
  }

  return startAgent({ board, task, harness, prompt, folder, url, meta, connect })
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

// Runs the board's command with the task in its environment. The start is recorded
// first as a note, and a repeated event id runs nothing again.
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

      if (!duplicate) {
        // Hydra's own card exists once the board is configured; its start is noted there.
        if (role === 'hydra' && !writer.state.configured) {
          apply({ writer, decision: hydraEvent({ state: writer.state, meta: { ...meta, id: `${id}:board` }, cardId: '$board', change: { type: 'board.configured', data: config } }) })
        }

        const text = `Started ${role === 'hydra' ? 'Hydra' : 'a worker'} with the board command in ${cwd}`
        apply({ writer, decision: decideNote({ state: writer.state, ref: card?.id ?? HYDRA_CARD, note: { kind: 'context', source: 'pnyx:start', text }, meta: { ...meta, id: `${id}:started` } }) })
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
  board, via, harness, prompt, folder, home, url, meta, connect,
}: {
  board: string
  via?: string
  harness?: string
  prompt?: string
  folder?: string
  home?: string
  url?: string
  meta: Meta
  connect?: Connect
}): Promise<Output> {
  const how = via ?? (home ? 'firstmate' : 'paseo')

  if (how === 'firstmate') {
    if (!home) {
      throw new BoardError({ message: 'a Firstmate Hydra needs --home <firstmate home>', code: 'VALIDATION_ERROR' })
    }

    return setupHydra({ board, home, meta })
  }

  if (how === 'command') {
    return startCommand({ board, role: 'hydra', prompt, folder, harness, meta })
  }

  if (how !== 'paseo') {
    throw new BoardError({ message: `unknown start route: ${how}`, code: 'VALIDATION_ERROR', help: [`Use --via ${VIAS.join('|')}`] })
  }

  const chosen = (harness ?? 'claude') as Harness

  if (!(chosen in HARNESSES)) {
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

  const { agent, ref } = await createPaseoAgent({
    harness: chosen,
    prompt: prompt ?? hydraPrompt({ board }),
    cwd,
    title: `Hydra · ${board}`,
    id,
    env: { PNYX_HOME: pnyxHome(), PNYX_BOARD: board, PNYX_TASK: HYDRA_CARD },
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
          key: `paseo:${agent.id}`,
          input: { title: `Hydra · ${board}`, agent: ref, activity: 'working', source: { adapter: 'paseo', instanceId: endpoint, objectId: agent.id, observedAt: meta.at } },
          meta: { ...meta, id: `${id}:session`, ifRevision: undefined },
        }),
      })
      const config = boardConfig({ state: writer.state, id: board })
      const hydra = { ...config.hydra, kind: 'agent' as const, session: sessionId({ agent: ref }) }
      delete hydra.home
      apply({ writer, decision: hydraEvent({ state: writer.state, meta: { ...meta, id: `${id}:hydra` }, cardId: '$board', change: { type: 'board.configured', data: { ...config, hydra } } }) })

      return {
        hydra: { session: hydra.session, paseo: agent.id, folder: cwd },
        help: [`Talk to Hydra in Paseo, or queue work with \`pnyx-axi hydra send --board ${board} --text <message>\``],
      }
    },
  })
}

// Makes a Firstmate home this board's Hydra: the board names the home, the home gets
// the pnyx-hydra skill as its own local skill (kept out of Firstmate's tracked files
// through the clone's info/exclude), and Firstmate gets an inbox note pointing at it.
// Nothing in Firstmate's own files changes.
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
  const id = meta.id ?? `pnyx:${board}:hydra:${basename(real)}`

  withWriter({
    board,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const config = boardConfig({ state: writer.state, id: board })

      if (config.hydra.kind === 'firstmate' && config.hydra.home === real) {
        return
      }

      const data: BoardConfig = { ...config, hydra: { id: `firstmate:${basename(real)}`, kind: 'firstmate', name: config.hydra.name, home: real } }
      apply({ writer, decision: hydraEvent({ state: writer.state, meta: { ...meta, id: `${id}:board` }, cardId: '$board', change: { type: 'board.configured', data } }) })
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

// Adds the path to the clone's local exclude file once; false when the home is not a git clone.
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
