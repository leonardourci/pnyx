import { requireReady } from '../../tasks/dependencies.ts'
import { requireUnheld } from '../../tasks/holds.ts'
import { accountEnvironment, type DispatchChoice } from '../../workers/dispatch.ts'
import { hydraEvent } from '../../core/hydra.ts'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import type { Meta } from '../../app/command-meta.ts'
import { decidePush } from '../../tasks/push.ts'
import { findCard } from '../../tasks/push-rules.ts'
import { decideSession } from '../../workers/sessions.ts'
import { HydraError } from '../../store/errors.ts'
import type { AgentConfig, AgentRef } from '../../workers/model.ts'
import { paseoUrl } from './url.ts'
import { sessionId } from '../../workers/session-attachments.ts'
import { drainSpool } from '../hooks/ingest.ts'
import type { Output } from '../../app/cli-support.ts'
import { canonical } from '../../store/paths.ts'
import { withWriter } from '../../app/writer.ts'
import { pnyxHome } from '../../store/storage.ts'
import { openPaseo, type Connect } from './client.ts'

export const HARNESSES = {
  claude: 'claude-code',
  codex: 'codex',
} as const
export type Harness = keyof typeof HARNESSES
const MAX_PROMPT = 32000

export async function startAgent({
  hydraId,
  task,
  harness,
  agent: chosen,
  prompt,
  folder,
  url,
  meta,
  dispatch,
  connect = openPaseo,
}: {
  hydraId: string
  task: string
  harness: string
  agent?: AgentConfig
  dispatch?: DispatchChoice
  prompt: string
  folder?: string
  url?: string
  meta: Meta
  connect?: Connect
}): Promise<Output> {
  if (!Object.hasOwn(
    HARNESSES,
    harness,
  )) {
    throw new HydraError({
      message: `unknown harness: ${harness}`,
      code: 'VALIDATION_ERROR',
      help: ['Use claude or codex'],
    })
  }

  if (!prompt.trim() || prompt.length > MAX_PROMPT) {
    throw new HydraError({
      message: `the opening message must be 1 to ${MAX_PROMPT} characters`,
      code: 'VALIDATION_ERROR',
    })
  }

  const endpoint = paseoUrl({ url })
  // Paseo creates at most one agent per key, so a retried start never starts a second one.
  const id = meta.id ?? randomUUID()
  const attachId = `${id}:attach`
  const claimed = withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const card = findCard({
        state: writer.state,
        ref: task,
      })

      if (attachId in writer.state.eventIds) {
        return {
          card,
          cwd: '',
          duplicate: true,
        }
      }

      requireUnheld({ card })
      requireReady({
        state: writer.state,
        card,
      })

      if (meta.ifRevision !== undefined && meta.ifRevision !== card.revision) {
        throw new HydraError({
          message: `card ${card.id} is at revision ${card.revision}, not ${meta.ifRevision}`,
          code: 'REVISION_CONFLICT',
          help: [`Run \`pnyx-axi card ${card.id}\` and retry`],
        })
      }

      if (card.sessionIds?.length) {
        throw new HydraError({
          message: `task ${card.id} already has an attached agent; detach it first`,
          code: 'SESSION_CONFLICT',
        })
      }

      const cwd = canonical({ path: folder }) ?? card.folder

      if (!cwd || !isFolder({ path: cwd })) {
        throw new HydraError({
          message: cwd ? `folder not found: ${cwd}` : 'choose the folder the agent works in',
          code: 'VALIDATION_ERROR',
          help: ['Pass --folder <absolute path>'],
        })
      }

      if (cwd !== card.folder) {
        const decision = decidePush({
          state: writer.state,
          key: card.key,
          input: { folder: cwd },
          meta: {
            ...meta,
            id: `${id}:folder`,
            ifRevision: undefined,
          },
        })

        if ('event' in decision) {
          writer.append({ event: decision.event })
        }
      }

      return {
        card,
        cwd,
        duplicate: false,
      }
    },
  })

  if (claimed.duplicate) {
    return {
      task: claimed.card.id,
      event: 'none: duplicate',
      help: ['This start was already recorded; nothing was started again'],
    }
  }

  const {
    agent,
    ref,
  } = await createPaseoAgent({
    harness: harness as Harness,
    agent: chosen,
    prompt,
    cwd: claimed.cwd,
    title: claimed.card.title,
    id,
    // No PNYX_TASK: the task attaches the Paseo session below, so the agent's own
    // hooks must not race it onto the task.
    env: dispatch ? accountEnvironment({
      account: {
        provider: dispatch.provider,
        folder: dispatch.folder,
      },
      env: {
        PNYX_HOME: pnyxHome(),
        PNYX_HYDRA: hydraId,
      },
    }) as Record<string, string> : {
      PNYX_HOME: pnyxHome(),
      PNYX_HYDRA: hydraId,
    },
    beforeCreate: () => withWriter({
      hydraId,
      fn: ({ writer }) => {
        drainSpool({ writer })
        const card = findCard({
          state: writer.state,
          ref: task,
        })
        requireUnheld({ card })
        requireReady({
          state: writer.state,
          card,
        })
      },
    }),
    labels: { 'pnyx.task': claimed.card.id },
    url: endpoint,
    connect,
  })

  try {
    return withWriter({
      hydraId,
      fn: ({ writer }) => {
        drainSpool({ writer })
        const card = findCard({
          state: writer.state,
          ref: task,
        })
        requireUnheld({ card })
        requireReady({
          state: writer.state,
          card,
        })
        const pushed = decidePush({
          state: writer.state,
          key: `paseo:${agent.id}`,
          input: {
            title: claimed.card.title,
            agent: {
              ...ref,
              ...(dispatch ? {
                account: dispatch.account,
                loginFolder: dispatch.folder,
              } : {}),
            },
            activity: 'working',
            source: {
              adapter: 'paseo',
              instanceId: endpoint,
              objectId: agent.id,
              observedAt: meta.at,
            },
          },
          meta: {
            ...meta,
            id: `${id}:session`,
            ifRevision: undefined,
          },
        })

        if ('event' in pushed) {
          writer.append({ event: pushed.event })
        }

        const attached = decideSession({
          state: writer.state,
          ref: sessionId({ agent: ref }),
          task: claimed.card.id,
          working: true,
          meta: {
            ...meta,
            id: attachId,
            ifRevision: undefined,
          },
        })

        if ('event' in attached) {
          writer.append({ event: attached.event })
        }

        if (dispatch) {
          const event = hydraEvent({
            state: writer.state,
            meta: {
              ...meta,
              id: `${id}:dispatch`,
            },
            cardId: claimed.card.id,
            change: {
              type: 'task.launched',
              data: {
                via: 'paseo',
                at: meta.at,
                folder: claimed.cwd,
                harness,
                dispatch: dispatch.reason,
                ...(dispatch.override ? { override: dispatch.override } : {}),
              },
            },
          })

          if ('event' in event) {
            writer.append({ event: event.event })
          }
        }

        return {
          task: claimed.card.id,
          agent: {
            harness,
            paseo: agent.id,
            folder: claimed.cwd,
          },
          help: [`Run \`pnyx-axi reply ${claimed.card.id} --text <text>\` to continue, or open the agent in Paseo`],
        }
      },
    })
  } catch (error) {
    const reason = error instanceof HydraError ? error.message : 'the Hydra could not record it'
    throw new HydraError({
      message: `Paseo started agent ${agent.id}, but it was not attached: ${reason}`,
      code: 'NOT_ATTACHED',
      help: [`Run \`pnyx-axi attach ${claimed.card.id} --session ${sessionId({ agent: ref })}\` once the task is free`],
    })
  }
}

export async function createPaseoAgent({
  harness,
  agent: chosen,
  prompt,
  cwd,
  title,
  id,
  env,
  labels,
  url,
  connect = openPaseo,
  beforeCreate,
}: {
  harness: Harness
  agent?: AgentConfig
  prompt: string
  cwd: string
  title: string
  id: string
  env: Record<string, string>
  labels: Record<string, string>
  url: string
  connect?: Connect
  beforeCreate?(): void
}): Promise<{
  agent: { id: string }
  ref: AgentRef
}> {
  const client = await connect({ url })
  let agent: { id: string }

  try {
    const { models } = await client.providers.listModels(
      harness,
      { cwd },
    )
    const kind = chosen?.harness === harness ? chosen : undefined
    const wanted = kind?.model ? models?.find(m => m.id === kind.model) : undefined

    if (kind?.model && !wanted) {
      throw new HydraError({
        message: `Paseo has no ${harness} model ${kind.model}`,
        code: 'VALIDATION_ERROR',
        help: [
          `Use one of: ${(models ?? []).map(m => m.id).slice(
            0,
            12,
          )
            .join(', ')}`,
        ],
      })
    }

    const model = wanted ?? models?.find(m => m.isDefault) ?? models?.[0]

    if (!model) {
      throw new HydraError({
        message: `Paseo has no ${harness} model available`,
        code: 'PASEO_ERROR',
        help: [`Check \`paseo status\` for the ${harness} provider`],
      })
    }

    const config = {
      provider: `${harness}/${model.id}`,
      ...(kind?.effort ? { thinkingOptionId: kind.effort } : {}),
      ...(kind?.mode ? { modeId: kind.mode } : {}),
      ...(kind?.fast === undefined ? {} : { featureValues: { fast_mode: kind.fast } }),
    }
    beforeCreate?.()
    agent = await client.agents.create({
      config,
      cwd,
      title,
      prompt,
      idempotencyKey: id,
      labels,
      env,
    })
  } catch (error) {
    if (error instanceof HydraError) {
      throw error
    }

    throw new HydraError({
      message: `Paseo did not start the agent: ${(error as Error).message}`.slice(
        0,
        500,
      ),
      code: 'PASEO_ERROR',
      help: ['Check the Paseo app before retrying'],
    })
  } finally {
    await client.close().catch(() => undefined)
  }

  const ref = {
    provider: HARNESSES[harness],
    sessionId: agent.id,
    paseoAgentId: agent.id,
    paseoUrl: url,
    cwd,
  }

  return {
    agent,
    ref,
  }
}

function isFolder({ path }: { path: string }): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export async function paseoStatus({
  url,
  connect = openPaseo,
}: {
  url?: string
  connect?: Connect
}): Promise<Output> {
  const endpoint = paseoUrl({ url })
  const client = await connect({ url: endpoint })
  await client.close().catch(() => undefined)

  return {
    paseo: 'running',
    url: endpoint,
  }
}
