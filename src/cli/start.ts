import { randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { decideNote, decidePush, findCard, type Decision, type Meta } from '../core/decide.ts'
import { hydraConfig, hydraEvent, HYDRA_CARD } from '../core/hydra.ts'
import { HydraError, type AgentConfig, type HydraConfig, type HydraState, type Card } from '../core/model.ts'
import { paseoUrl } from '../core/paseo.ts'
import { liveTask, sessionId } from '../core/tasks.ts'
import { runCommand } from '../integrations/command/run.ts'
import { taskFolder } from '../copies/copies.ts'
import { resolveHome } from '../integrations/firstmate/home.ts'
import { fmNote } from '../integrations/firstmate/reply.ts'
import { HARNESSES, createPaseoAgent, startAgent, type Harness } from '../integrations/paseo/launch.ts'
import type { Connect } from '../integrations/paseo/client.ts'
import { drainSpool } from '../integrations/hooks/ingest.ts'
import { canonical } from '../store/paths.ts'
import { askHost } from '../server/state.ts'
import { loadHydra, pnyxHome, withWriter, type Writer } from '../store/hydra-store.ts'
import type { Output } from './commands.ts'

export const VIAS = ['pnyx', 'paseo', 'firstmate', 'command'] as const
type Via = (typeof VIAS)[number]
export const HYDRA_SKILL = join(import.meta.dirname, '..', '..', 'skills', 'pnyx-hydra', 'SKILL.md')
export const HOME_SKILL = join('.agents', 'skills', 'pnyx-hydra')

function chooseVia({ state, via }: {
  state: HydraState
  via?: string
}): Via {
  const chosen = via ?? (state.config?.hydra.kind === 'firstmate' ? 'firstmate' : 'pnyx')

  if (!(VIAS as readonly string[]).includes(chosen)) {
    throw new HydraError({ message: `unknown start route: ${chosen}`, code: 'VALIDATION_ERROR', help: [`Use --via ${VIAS.join('|')}`] })
  }

  return chosen as Via
}

function apply({ writer, decision }: { writer: Writer; decision: Decision }): void {
  if ('event' in decision) {
    writer.append({ event: decision.event })
  }
}

export function freeTask({ state, ref }: { state: HydraState; ref: string }): Card {
  const card = findCard({ state, ref })

  if (!liveTask({ card }) || card.id === HYDRA_CARD) {
    throw new HydraError({ message: `task not found: ${ref}`, code: 'NOT_FOUND', help: ['Run `pnyx-axi task list`'] })
  }

  if (card.sessionIds?.length) {
    throw new HydraError({ message: `task ${card.id} already has an attached agent; detach it first`, code: 'SESSION_CONFLICT' })
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
export function agentFor({ state, hydraId, kind, harness }: {
  state: HydraState
  hydraId: string
  kind: string
  harness?: string
}): AgentConfig {
  const agents = hydraConfig({ state, id: hydraId }).agents ?? {}
  const configured = Object.hasOwn(agents, kind) ? agents[kind] : undefined

  if (!configured && kind !== 'default' && kind !== 'hydra') {
    throw new HydraError({ message: `no agent configured for kind ${kind}`, code: 'NOT_FOUND', help: [`Run \`pnyx-axi kind set ${kind} --harness claude --hydra ${hydraId}\``] })
  }

  if (harness !== undefined && harness !== 'claude' && harness !== 'codex') {
    throw new HydraError({ message: `unknown harness: ${harness}`, code: 'VALIDATION_ERROR', help: ['Use claude or codex'] })
  }

  const defaults = configured ?? { harness: 'claude' as const }
  const agent: AgentConfig = harness && harness !== defaults.harness
    ? { harness, ...(defaults.quota ? { quota: defaults.quota } : {}) }
    : { ...defaults }

  if (agent.quota) {
    agent.model = quotaModel({ harness: agent.harness, quota: agent.quota }) ?? agent.model
  }

  return agent
}

export function workerPrompt({ hydraId, id, title }: {
  hydraId: string
  id: string
  title: string
}): string {
  return [
    `You are the Pnyx worker for task ${id} "${title}" on Hydra ${hydraId}. Follow the pnyx-worker skill when it is installed.`,
    `Start with \`pnyx-axi task show ${id} --hydra ${hydraId}\` and \`pnyx-axi task history ${id} --hydra ${hydraId}\`.`,
    `Declare progress only with \`pnyx-axi task status ${id} working|needs_you|paused|blocked|done --note <text> --hydra ${hydraId}\`; silence changes nothing.`,
  ].join(' ')
}

export function taskPrompt({ hydraId, card, prompt }: {
  hydraId: string
  card: Card
  prompt?: string
}): string {
  const instructions = prompt ?? workerPrompt({ hydraId, id: card.id, title: card.title })

  return card.brief?.trim() ? `${card.brief}\n\n${instructions}` : instructions
}

const hydraPrompt = ({ hydraId }: { hydraId: string }) =>
  `You are Hydra, the orchestrator of the Pnyx Hydra "${hydraId}". Read ${HYDRA_SKILL} and follow it. `
  + `Start with \`pnyx-axi task list --hydra ${hydraId}\` and \`pnyx-axi hydra messages --hydra ${hydraId}\`.`

export async function startTask({
  hydraId, task, via, kind, harness, prompt, folder: given, inPlace, replacement, url, meta,
  connect,
}: {
  hydraId: string
  task: string
  replacement?: string
  via?: string
  kind?: string
  harness?: string
  prompt?: string
  folder?: string
  inPlace?: boolean
  url?: string
  meta: Meta
  connect?: Connect
}): Promise<Output> {
  const state = loadHydra({ hydraId }).state
  const card = findCard({ state, ref: task })
  const agent = via === 'firstmate' || via === 'command' || (!via && state.config?.hydra.kind === 'firstmate')
    ? undefined : agentFor({ state, hydraId, kind: kind ?? 'default', harness })
  const how = chooseVia({ state, via })

  if (replacement && how !== 'pnyx') {
    throw new HydraError({ message: 'starting fresh from an outside session uses Pnyx', code: 'VALIDATION_ERROR' })
  }

  if (how === 'firstmate') {
    return askFirstmate({ hydraId, task, prompt, meta })
  }

  const command = how === 'command' || !agent
  const ownFolder = command && Boolean(state.config?.commandOwnsFolder)
  const folder = replacement ? given
    : taskFolder({ hydraId, task, folder: given, inPlace, ownFolder, meta })

  if (command) {
    return startCommand({ hydraId, role: 'worker', task, prompt, folder, harness, meta })
  }

  if (how === 'pnyx') {
    const chosen = harness ?? agent.harness

    if (chosen !== 'claude' && chosen !== 'codex') {
      throw new HydraError({ message: `unknown harness: ${chosen}`, code: 'VALIDATION_ERROR', help: ['Use claude or codex'] })
    }

    const settings = { model: agent.model, effort: agent.effort, mode: agent.mode, provider: chosen === 'codex' ? 'codex' : 'claude-code' }

    return askHost({
      hydraId,
      body: {
        action: 'start',
        task: card.id,
        ...(replacement ? { replacement } : {}),
        prompt: taskPrompt({ hydraId, card, prompt }),
        ...(canonical({ path: folder }) ? { folder: canonical({ path: folder }) } : {}),
        settings: Object.fromEntries(Object.entries(settings).filter(([, v]) => v)),
        id: meta.id ?? randomUUID(),
        actor: meta.actor,
        ...(meta.reason ? { reason: meta.reason } : {}),
      },
    }) as Promise<Output>
  }

  return startAgent({
    hydraId,
    task,
    harness: harness ?? agent.harness,
    agent,
    prompt: taskPrompt({ hydraId, card, prompt }),
    folder,
    url,
    meta,
    connect,
  })
}

// Puts the request in Hydra's chat, then hands it to the Firstmate home that is
// this Hydra as an inbox note, which wakes Firstmate. The note's request id
// is the message's, so a retry replays the same note.
function askFirstmate({ hydraId, task, prompt, meta }: {
  hydraId: string
  task: string
  prompt?: string
  meta: Meta
}): Output {
  const queued = withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const card = freeTask({ state: writer.state, ref: task })
      const config = hydraConfig({ state: writer.state, id: hydraId })

      if (config.hydra.kind !== 'firstmate' || !config.hydra.home) {
        throw new HydraError({ message: `Hydra ${hydraId} has no Firstmate Hydra`, code: 'NO_ROUTE', help: [`Run \`pnyx-axi setup hydra --home <firstmate home> --hydra ${hydraId}\``] })
      }

      const text = [
        `Pnyx Hydra ${hydraId} asks for a worker on task ${card.id} "${card.title}"${card.folder ? ` in ${card.folder}` : ''}.`,
        ...(card.brief?.trim() ? [`Task brief (give this to the worker as its first prompt):\n${card.brief}`] : []),
        ...(prompt ? [`Request: ${prompt}`] : []),
        `Use the pnyx-hydra skill: read \`pnyx-axi task show ${card.id} --hydra ${hydraId}\`, dispatch the worker, and keep the task's status current.`,
      ].join('\n')
      const id = meta.id ?? randomUUID()
      apply({ writer, decision: hydraEvent({ state: writer.state, meta: { ...meta, id }, cardId: card.id, change: { type: 'hydra.message', data: { task: card.id, action: 'worker', text, hydra: config.hydra.id } } }) })

      return { card: card.id, home: config.hydra.home, id, text }
    },
  })
  const sent = fmNote({ home: queued.home, requestId: `pnyx:${hydraId}:${queued.id}`, text: queued.text })

  return {
    task: queued.card,
    via: 'firstmate',
    message: queued.id,
    sent: sent.state,
    ...(sent.detail ? { detail: sent.detail } : {}),
    help: sent.state === 'failed'
      ? [`The request stays in \`pnyx-axi hydra messages --hydra ${hydraId}\`; retry with --event-id ${queued.id}`]
      : [`Firstmate dispatches the worker; follow it with \`pnyx-axi task history ${queued.card} --hydra ${hydraId}\``],
  }
}

// Runs the Hydra's command with the task in its environment, then notes the start;
// a repeated event id runs nothing again.
function startCommand({ hydraId, role, task, prompt, folder, harness, meta }: {
  hydraId: string
  role: 'worker' | 'hydra'
  task?: string
  prompt?: string
  folder?: string
  harness?: string
  meta: Meta
}): Output {
  const id = meta.id ?? randomUUID()
  const claimed = withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const config = hydraConfig({ state: writer.state, id: hydraId })

      if (!config.command) {
        throw new HydraError({ message: `Hydra ${hydraId} has no start command`, code: 'NO_COMMAND', help: [`Run \`pnyx-axi hydra set --hydra ${hydraId} --command '<shell command>'\``] })
      }

      const card = role === 'worker' ? freeTask({ state: writer.state, ref: task! }) : undefined
      const cwd = canonical({ path: folder }) ?? card?.folder ?? (role === 'hydra' ? process.cwd() : undefined)

      if (!cwd || !existsSync(cwd)) {
        throw new HydraError({ message: cwd ? `folder not found: ${cwd}` : 'choose the folder the agent works in', code: 'VALIDATION_ERROR', help: ['Pass --folder <absolute path>'] })
      }

      const duplicate = `${id}:started` in writer.state.eventIds

      if (!duplicate && role === 'hydra' && !writer.state.configured) {
        apply({ writer, decision: hydraEvent({ state: writer.state, meta: { ...meta, id: `${id}:config` }, cardId: '$board', change: { type: 'board.configured', data: config } }) })
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
      PNYX_HYDRA: hydraId,
      PNYX_TASK: target,
      PNYX_ROLE: role,
      PNYX_TASK_TITLE: claimed.card?.title ?? 'Hydra',
      PNYX_PROMPT: claimed.card
        ? taskPrompt({ hydraId, card: claimed.card, prompt }) : prompt ?? hydraPrompt({ hydraId }),
      PNYX_HARNESS: harness ?? '',
      PNYX_FOLDER: claimed.cwd,
    },
  })
  const text = `Started ${role === 'hydra' ? 'Hydra' : 'a worker'} with the Hydra command in ${claimed.cwd}`
  withWriter({
    hydraId,
    fn: ({ writer }) => {
      apply({ writer, decision: hydraEvent({ state: writer.state, meta: { ...meta, id: `${id}:launch` }, cardId: target, change: { type: 'task.launched', data: { via: 'command', at: meta.at, folder: claimed.cwd, pid, command: claimed.command, ...(harness ? { harness } : {}) } } }) })
      apply({ writer, decision: decideNote({ state: writer.state, ref: target, note: { kind: 'context', source: 'pnyx:start', text }, meta: { ...meta, id: `${id}:started` } }) })
    },
  })

  return {
    [role === 'hydra' ? 'hydra' : 'task']: target,
    via: 'command',
    pid,
    folder: claimed.cwd,
    help: [role === 'hydra'
      ? `Its first session becomes the Hydra; check \`pnyx-axi hydra show --hydra ${hydraId}\``
      : `Its session attaches to ${target} when its hooks first report; check \`pnyx-axi task show ${target} --hydra ${hydraId}\``],
  }
}

export async function startHydra({
  hydraId, via, kind, harness, prompt, folder, home, url, meta, connect,
}: {
  hydraId: string
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
  const current = loadHydra({ hydraId }).state.config?.hydra
  const how = via ?? (home || current?.kind === 'firstmate' ? 'firstmate' : 'paseo')

  if (how === 'firstmate') {
    const given = home ?? current?.home

    if (!given) {
      throw new HydraError({ message: 'a Firstmate Hydra needs --home <firstmate home>', code: 'VALIDATION_ERROR' })
    }

    return setupHydra({ hydraId, home: given, meta })
  }

  if (how === 'command') {
    return startCommand({ hydraId, role: 'hydra', prompt, folder, harness, meta })
  }

  if (how !== 'paseo') {
    throw new HydraError({ message: `unknown start route: ${how}`, code: 'VALIDATION_ERROR', help: ['Use --via paseo|firstmate|command'] })
  }

  const agent = agentFor({ state: loadHydra({ hydraId }).state, hydraId, kind: kind ?? 'hydra' })
  const chosen = (harness ?? agent.harness) as Harness

  if (!Object.hasOwn(HARNESSES, chosen)) {
    throw new HydraError({ message: `unknown harness: ${chosen}`, code: 'VALIDATION_ERROR', help: ['Use claude or codex'] })
  }

  const id = meta.id ?? randomUUID()
  const cwd = canonical({ path: folder }) ?? process.cwd()
  const endpoint = paseoUrl({ url })
  const free = withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })

      if (`${id}:hydra` in writer.state.eventIds) {
        return false
      }

      if (writer.state.config?.hydra.session) {
        throw new HydraError({ message: `Hydra ${hydraId} already has a Hydra session`, code: 'CONFLICT', help: [`Run \`pnyx-axi hydra set --hydra ${hydraId} --identity <new identity>\` to replace it`] })
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
    prompt: prompt ?? hydraPrompt({ hydraId }),
    cwd,
    title: `Hydra · ${hydraId}`,
    id,
    // No PNYX_TASK: the Paseo agent is recorded as Hydra here, not by its hooks.
    env: { PNYX_HOME: pnyxHome(), PNYX_HYDRA: hydraId },
    labels: { 'pnyx.hydra': hydraId, 'pnyx.role': 'hydra' },
    url: endpoint,
    connect,
  })

  return withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })
      apply({
        writer,
        decision: decidePush({
          state: writer.state,
          key: `paseo:${started.id}`,
          input: { title: `Hydra · ${hydraId}`, agent: ref, activity: 'working', source: { adapter: 'paseo', instanceId: endpoint, objectId: started.id, observedAt: meta.at } },
          meta: { ...meta, id: `${id}:session`, ifRevision: undefined },
        }),
      })
      const config = hydraConfig({ state: writer.state, id: hydraId })
      const hydra = { ...config.hydra, kind: 'agent' as const, session: sessionId({ agent: ref }) }
      delete hydra.home
      apply({ writer, decision: hydraEvent({ state: writer.state, meta: { ...meta, id: `${id}:hydra` }, cardId: '$board', change: { type: 'board.configured', data: { ...config, hydra } } }) })

      return {
        hydra: { session: hydra.session, paseo: started.id, folder: cwd },
        help: [`Talk to Hydra in Paseo, or queue work with \`pnyx-axi hydra send --hydra ${hydraId} --text <message>\``],
      }
    },
  })
}

export function setupHydra({ hydraId, home, meta }: {
  hydraId: string
  home: string
  meta: Meta
}): Output {
  const real = resolveHome({ path: home })
  const dir = join(real, HOME_SKILL)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), readFileSync(HYDRA_SKILL))
  const excluded = exclude({ home: real, path: `/${HOME_SKILL}/` })

  withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const config = hydraConfig({ state: writer.state, id: hydraId })

      if (config.hydra.kind === 'firstmate' && config.hydra.home === real) {
        return
      }

      const data: HydraConfig = { ...config, hydra: { id: `firstmate:${basename(real)}`, kind: 'firstmate', name: config.hydra.name, home: real } }
      apply({ writer, decision: hydraEvent({ state: writer.state, meta, cardId: '$board', change: { type: 'board.configured', data } }) })
    },
  })

  const text = [
    `Pnyx Hydra ${hydraId} uses this home as its Hydra.`,
    `Load the pnyx-hydra skill (${join(HOME_SKILL, 'SKILL.md')}) and follow it for that Hydra.`,
    `Start with \`pnyx-axi task list --hydra ${hydraId}\` and \`pnyx-axi hydra messages --hydra ${hydraId}\`.`,
  ].join('\n')
  const sent = fmNote({ home: real, requestId: `pnyx:${hydraId}:hydra-skill`, text })

  return {
    hydraId,
    hydra: { kind: 'firstmate', home: real },
    skill: join(dir, 'SKILL.md'),
    excluded: excluded ? 'yes' : 'no: not a git clone',
    note: sent.state,
    ...(sent.detail ? { detail: sent.detail } : {}),
    help: [`Run \`pnyx-axi serve --hydra ${hydraId}\` to see the Hydra; Firstmate tasks sync from this home`],
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
