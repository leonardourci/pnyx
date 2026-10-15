// Starts a Claude Code or Codex agent for a task through the local Paseo daemon,
// then attaches its session to the task through the board's own writer. Paseo runs
// and keeps the agent; the conversation continues in Pnyx or in Paseo.
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { decidePush, decideSession, findCard, type Meta } from '../../core/decide.ts'
import { BoardError, type AgentRef } from '../../core/model.ts'
import { paseoUrl } from '../../core/paseo.ts'
import { sessionId } from '../../core/tasks.ts'
import { canonical, drainSpool, type Output } from '../../cli/commands.ts'
import { pnyxHome, withWriter } from '../../store/board-store.ts'
import { openPaseo, type Connect } from './client.ts'

export const HARNESSES = { claude: 'claude-code', codex: 'codex' } as const
export type Harness = keyof typeof HARNESSES
const MAX_PROMPT = 32000

export async function startAgent({
  board, task, harness, prompt, folder, url, meta, connect = openPaseo,
}: {
  board: string
  task: string
  harness: string
  prompt: string
  folder?: string
  url?: string
  meta: Meta
  connect?: Connect
}): Promise<Output> {
  if (!(harness in HARNESSES)) {
    throw new BoardError({ message: `unknown harness: ${harness}`, code: 'VALIDATION_ERROR', help: ['Use claude or codex'] })
  }

  if (!prompt.trim() || prompt.length > MAX_PROMPT) {
    throw new BoardError({ message: `the opening message must be 1 to ${MAX_PROMPT} characters`, code: 'VALIDATION_ERROR' })
  }

  const endpoint = paseoUrl({ url })
  // Paseo creates at most one agent per key, so a retried start never starts a second one.
  const id = meta.id ?? randomUUID()
  const attachId = `${id}:attach`
  const claimed = withWriter({
    board,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const card = findCard({ state: writer.state, ref: task })

      if (attachId in writer.state.eventIds) {
        return { card, cwd: '', duplicate: true }
      }

      if (meta.ifRevision !== undefined && meta.ifRevision !== card.revision) {
        throw new BoardError({ message: `card ${card.id} is at revision ${card.revision}, not ${meta.ifRevision}`, code: 'REVISION_CONFLICT', help: [`Run \`pnyx-axi card ${card.id}\` and retry`] })
      }

      if (card.sessionIds?.length) {
        throw new BoardError({ message: `task ${card.id} already has an attached agent; detach it first`, code: 'SESSION_CONFLICT' })
      }

      const cwd = canonical({ path: folder }) ?? card.folder

      if (!cwd || !isFolder({ path: cwd })) {
        throw new BoardError({ message: cwd ? `folder not found: ${cwd}` : 'choose the folder the agent works in', code: 'VALIDATION_ERROR', help: ['Pass --folder <absolute path>'] })
      }

      if (cwd !== card.folder) {
        const decision = decidePush({ state: writer.state, key: card.key, input: { folder: cwd }, meta: { ...meta, id: `${id}:folder`, ifRevision: undefined } })

        if ('event' in decision) {
          writer.append({ event: decision.event })
        }
      }

      return { card, cwd, duplicate: false }
    },
  })

  if (claimed.duplicate) {
    return { task: claimed.card.id, event: 'none: duplicate', help: ['This start was already recorded; nothing was started again'] }
  }

  const { agent, ref } = await createPaseoAgent({
    harness: harness as Harness,
    prompt,
    cwd: claimed.cwd,
    title: claimed.card.title,
    id,
    env: { PNYX_HOME: pnyxHome(), PNYX_BOARD: board, PNYX_TASK: claimed.card.id },
    labels: { 'pnyx.task': claimed.card.id },
    url: endpoint,
    connect,
  })

  try {
    return withWriter({
      board,
      fn: ({ writer }) => {
        drainSpool({ writer })
        // The session is recorded as its own observation, then attached like any other.
        const pushed = decidePush({
          state: writer.state,
          key: `paseo:${agent.id}`,
          input: {
            title: claimed.card.title,
            agent: ref,
            activity: 'working',
            source: { adapter: 'paseo', instanceId: endpoint, objectId: agent.id, observedAt: meta.at },
          },
          meta: { ...meta, id: `${id}:session`, ifRevision: undefined },
        })

        if ('event' in pushed) {
          writer.append({ event: pushed.event })
        }

        const attached = decideSession({
          state: writer.state,
          ref: sessionId({ agent: ref }),
          task: claimed.card.id,
          meta: { ...meta, id: attachId, ifRevision: undefined },
        })

        if ('event' in attached) {
          writer.append({ event: attached.event })
        }

        return {
          task: claimed.card.id,
          agent: { harness, paseo: agent.id, folder: claimed.cwd },
          help: [`Run \`pnyx-axi reply ${claimed.card.id} --text <text>\` to continue, or open the agent in Paseo`],
        }
      },
    })
  } catch (error) {
    const reason = error instanceof BoardError ? error.message : 'the board could not record it'
    throw new BoardError({
      message: `Paseo started agent ${agent.id}, but it was not attached: ${reason}`,
      code: 'NOT_ATTACHED',
      help: [`Run \`pnyx-axi attach ${claimed.card.id} --session ${sessionId({ agent: ref })}\` once the task is free`],
    })
  }
}

// Asks the daemon for one agent. The idempotency key makes a retried create return
// the agent the first one made. env reaches the agent's own hooks, so they report to
// this Pnyx home, board and task rather than the installed defaults.
export async function createPaseoAgent({
  harness, prompt, cwd, title, id, env, labels, url, connect = openPaseo,
}: {
  harness: Harness
  prompt: string
  cwd: string
  title: string
  id: string
  env: Record<string, string>
  labels: Record<string, string>
  url: string
  connect?: Connect
}): Promise<{ agent: { id: string }; ref: AgentRef }> {
  const client = await connect({ url })
  let agent: { id: string }

  try {
    const { models } = await client.providers.listModels(harness, { cwd })
    const model = models?.find(m => m.isDefault) ?? models?.[0]

    if (!model) {
      throw new BoardError({ message: `Paseo has no ${harness} model available`, code: 'PASEO_ERROR', help: [`Check \`paseo status\` for the ${harness} provider`] })
    }

    agent = await client.agents.create({ config: { provider: `${harness}/${model.id}` }, cwd, title, prompt, idempotencyKey: id, labels, env })
  } catch (error) {
    if (error instanceof BoardError) {
      throw error
    }

    throw new BoardError({ message: `Paseo did not start the agent: ${(error as Error).message}`.slice(0, 500), code: 'PASEO_ERROR', help: ['Check the Paseo app before retrying'] })
  } finally {
    await client.close().catch(() => undefined)
  }

  const ref = {
    provider: HARNESSES[harness], sessionId: agent.id, paseoAgentId: agent.id, paseoUrl: url, cwd,
  }

  return { agent, ref }
}

function isFolder({ path }: { path: string }): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// Whether the daemon answers, for a form that should say why it cannot start yet.
export async function paseoStatus({ url, connect = openPaseo }: {
  url?: string
  connect?: Connect
}): Promise<Output> {
  const endpoint = paseoUrl({ url })
  const client = await connect({ url: endpoint })
  await client.close().catch(() => undefined)

  return { paseo: 'running', url: endpoint }
}
