import { recordTools } from './tools.ts'
import { ORCHESTRATE_SKILL } from '#setup/skill-names.ts'
import { requireReady } from '#tasks/dependencies.ts'
import { requireUnheld } from '#tasks/holds.ts'
import { dispatchTask, ruleCandidates, startCandidates, type DispatchChoice, type Override } from './dispatch.ts'
import { modelIds, type ModelOption } from './provider.ts'
import { effectiveDispatch } from './dispatch-config.ts'
import { openPaseo } from '#integrations/paseo/client.ts'
import { randomUUID } from 'node:crypto'
import type { HydraState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { findCard } from '#tasks/push-rules.ts'
import { hydraConfig } from '#hydra/config.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { HydraError } from '#store/errors.ts'
import type { Card } from '#tasks/model.ts'
import { paseoUrl } from '#integrations/paseo/url.ts'
import { liveTask } from '#tasks/select.ts'
import { taskFolder } from '#projects/copy-create.ts'
import { fmNote } from '#integrations/firstmate/reply.ts'
import { startAgent } from '#integrations/paseo/launch.ts'
import type { Harness } from '#workers/providers.ts'
import type { Connect } from '#integrations/paseo/client.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
import { canonical } from '#store/paths.ts'
import { askHost } from '#app/server-state.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import type { Output } from '#app/cli-support.ts'
import { requestCwd } from '#app/request-context.ts'
import { requireOwnerToRaise } from './permission-level.ts'
import { applyDecision } from '#app/decision.ts'
import { taskPrompt } from './worker-brief.ts'
import { namedProjectCommand, startCommand } from './start-command.ts'

const VIAS = [
  'pnyx',
  'paseo',
  'firstmate',
  'command',
] as const
type Via = (typeof VIAS)[number]

function chooseVia({
  state,
  via,
}: {
  state: HydraState
  via?: string
}): Via {
  const chosen = via ?? (state.config?.hydra.kind === 'firstmate' ? 'firstmate' : 'pnyx')

  if (!(VIAS as readonly string[]).includes(chosen)) {
    throw new HydraError({
      message: `unknown start route: ${chosen}`,
      code: 'VALIDATION_ERROR',
      help: [`Use --via ${VIAS.join('|')}`],
    })
  }

  return chosen as Via
}

export function freeTask({
  state,
  ref,
}: {
  state: HydraState
  ref: string
}): Card {
  const card = findCard({
    state,
    ref,
  })

  if (!liveTask({ card }) || card.id === HYDRA_CARD) {
    throw new HydraError({
      message: `task not found: ${ref}`,
      code: 'NOT_FOUND',
      help: ['Run `pnyx-axi task list`'],
    })
  }

  requireUnheld({ card })
  requireReady({
    state,
    card,
  })

  if (card.queue) {
    throw new HydraError({
      message: 'unqueue this task before starting a separate worker',
      code: 'CONFLICT',
    })
  }

  if (card.sessionIds?.length) {
    throw new HydraError({
      message: `task ${card.id} already has an attached agent; detach it first`,
      code: 'SESSION_CONFLICT',
    })
  }

  return card
}

// The harness catalogs the Hydra's server reads; one it cannot read is left out, so its models are not checked.
async function hostedOffers({
  hydraId,
  harnesses,
}: {
  hydraId: string
  harnesses: Harness[]
}): Promise<Partial<Record<Harness, string[]>>> {
  const offers: Partial<Record<Harness, string[]>> = {}

  await Promise.all([...new Set(harnesses)].map(async harness => {
    try {
      const { models } = await askHost({
        hydraId,
        body: {
          action: 'models',
          harness,
        },
      }) as { models: ModelOption[] }
      offers[harness] = modelIds({ models })
    } catch (error) {
      if (error instanceof HydraError && error.code === 'NOT_RUNNING') {
        throw error
      }
    }
  }))

  return offers
}

export async function startTask({
  hydraId,
  task,
  via,
  rule,
  harness,
  override,
  tools,
  prompt,
  folder: given,
  inPlace,
  replacement,
  commandName,
  url,
  meta,
  connect,
}: {
  hydraId: string
  task: string
  replacement?: string
  commandName?: string
  via?: string
  rule?: string
  harness?: string
  override?: Override
  tools?: string[]
  prompt?: string
  folder?: string
  inPlace?: boolean
  url?: string
  meta: Meta
  connect?: Connect
}): Promise<Output> {
  const state = loadHydra({ hydraId }).state
  const card = findCard({
    state,
    ref: task,
  })

  requireUnheld({ card })
  requireReady({
    state,
    card,
  })

  if (card.queue) {
    throw new HydraError({
      message: 'unqueue this task before starting a separate worker',
      code: 'CONFLICT',
    })
  }

  const how = chooseVia({
    state,
    via,
  })

  if (commandName && how !== 'command') {
    throw new HydraError({
      message: '--command needs --via command',
      code: 'VALIDATION_ERROR',
    })
  }

  if (replacement && how !== 'pnyx') {
    throw new HydraError({
      message: 'starting fresh from an outside session uses Pnyx',
      code: 'VALIDATION_ERROR',
    })
  }

  if (override && (how === 'firstmate' || how === 'command')) {
    throw new HydraError({
      message: '--account, --model, --effort, --mode and --fast apply to an agent Pnyx or Paseo starts',
      code: 'VALIDATION_ERROR',
      help: ['Use --via pnyx or --via paseo'],
    })
  }

  if (tools?.length && how !== 'pnyx') {
    throw new HydraError({
      message: 'Tool grants require the pnyx launch route',
      code: 'VALIDATION_ERROR',
    })
  }

  if (how === 'firstmate') {
    return askFirstmate({
      hydraId,
      task,
      prompt,
      meta,
    })
  }

  if (meta.id && (how === 'pnyx' || how === 'paseo') && `${meta.id}:attach` in state.eventIds) {
    return {
      task: card.id,
      event: 'none: duplicate',
    }
  }

  let dispatch: DispatchChoice | undefined

  if (how !== 'command') {
    let offers: Partial<Record<Harness, string[]>> | undefined
    const { dispatch: effective } = effectiveDispatch()
    const list = harness ? startCandidates({
      dispatch: effective,
      rule,
      harness,
      override,
    }) ?? []
      : override?.model ? ([
        'claude',
        'codex',
      ] as const).map(harness => ({
        harness,
        model: override.model,
      }))
        : ruleCandidates({
          dispatch: effective,
          rule,
        }) ?? []

    if (how === 'pnyx') {
      // Only a candidate that names a model needs its harness's catalog.
      const named = list.filter(c => (!harness || c.harness === harness)
        && (override?.model || c.model))
      offers = await hostedOffers({
        hydraId,
        harnesses: named.map(c => c.harness),
      })
    }

    if (how === 'paseo') {
      offers = {}
      const client = await (connect ?? openPaseo)({ url: paseoUrl({ url }) })

      try {
        for (const candidate of list) {
          if (!offers[candidate.harness]) {
            const { models } = await client.providers.listModels(
              candidate.harness,
              {
                cwd: given ?? card.folder ?? requestCwd(),
              },
            )
            offers[candidate.harness] = models?.map(m => m.id) ?? []
          }
        }
      } finally {
        await client.close()
      }
    }

    dispatch = await dispatchTask({
      project: card.project,
      rule,
      harness,
      override,
      offers,
    })
  }

  const agent = dispatch?.candidate

  // The host checks a Pnyx start when it receives it; a Paseo start is checked here.
  if (how === 'paseo' && agent) {
    requireOwnerToRaise({
      state,
      actor: meta.actor,
      harness: agent.harness,
      before: agent.mode,
      after: override?.mode,
    })
  }

  const command = how === 'command' || !agent
  const selectedCommand = commandName
    ? namedProjectCommand({
      state,
      card,
      name: commandName,
    }) : undefined
  const ownsFolder = commandName
    ? selectedCommand?.bringsOwnFolder : Boolean(state.config?.commandOwnsFolder)
  const ownFolder = command && ownsFolder
  const currentState = loadHydra({ hydraId }).state
  const currentCard = findCard({
    state: currentState,
    ref: task,
  })
  requireUnheld({ card: currentCard })
  requireReady({
    state: currentState,
    card: currentCard,
  })

  const folder = replacement ? given
    : await taskFolder({
      hydraId,
      task,
      folder: given,
      inPlace,
      ownFolder,
      meta,
    })

  if (command) {
    return startCommand({
      hydraId,
      role: 'worker',
      task,
      prompt,
      folder,
      harness,
      commandName,
      meta,
    })
  }

  if (how === 'pnyx') {
    if (tools?.length) {
      const catalog = await askHost({
        hydraId,
        body: {
          action: 'tool-catalog',
          task: card.id,
          harness: dispatch!.provider,
          account: dispatch!.account,
          actor: meta.actor,
        },
      })
      const missing = tools.find(name => !(catalog.tools as string[]).includes(name))

      if (missing) {
        throw new HydraError({
          message: `Tool capability is not configured: ${missing}`,
          code: 'TOOL_UNAVAILABLE',
        })
      }

      recordTools({
        hydraId,
        task: card.id,
        grant: tools,
        meta,
      })
    }

    return askHost({
      hydraId,
      body: {
        action: 'start',
        dispatch,
        task: card.id,
        ...(replacement ? { replacement } : {}),
        prompt: await taskPrompt({
          hydraId,
          card,
          prompt,
          replacing: replacement,
        }),
        ...(canonical({ path: folder }) ? { folder: canonical({ path: folder }) } : {}),
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
    agent: {
      ...agent,
      ...dispatch?.override,
    },
    dispatch,
    prompt: await taskPrompt({
      hydraId,
      card,
      prompt,
    }),
    folder,
    url,
    meta,
    connect,
  })
}

// Puts the request in Hydra's chat, then hands it to the Firstmate home that is
// this Hydra as an inbox note, which wakes Firstmate. The note's request id
// is the message's, so a retry replays the same note.
async function askFirstmate({
  hydraId,
  task,
  prompt,
  meta,
}: {
  hydraId: string
  task: string
  prompt?: string
  meta: Meta
}): Promise<Output> {
  const initial = findCard({
    state: loadHydra({ hydraId }).state,
    ref: task,
  })
  const brief = await taskPrompt({
    hydraId,
    card: initial,
    prompt: prompt ? `Request: ${prompt}` : undefined,
  })
  const queued = withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const card = findCard({
        state: writer.state,
        ref: task,
      })

      if (card.revision !== initial.revision) {
        throw new HydraError({
          message: 'Task changed while preparing its worker brief',
          code: 'REVISION_CONFLICT',
        })
      }

      requireUnheld({ card })
      requireReady({
        state: writer.state,
        card,
      })

      if (!liveTask({ card }) || card.id === HYDRA_CARD) {
        throw new HydraError({
          message: `task not found: ${task}`,
          code: 'NOT_FOUND',
        })
      }

      const config = hydraConfig({
        state: writer.state,
        id: hydraId,
      })

      if (config.hydra.kind !== 'firstmate' || !config.hydra.home) {
        throw new HydraError({
          message: `Hydra ${hydraId} has no Firstmate Hydra`,
          code: 'NO_ROUTE',
          help: [`Run \`pnyx-axi setup hydra --home <firstmate home> --hydra ${hydraId}\``],
        })
      }

      const text = [
        `Pnyx Hydra ${hydraId} asks for a worker on task ${card.id} "${card.title}"${card.folder ? ` in ${card.folder}` : ''}.`,
        `Task brief (give this to the worker as its first prompt):\n${brief}`,
        `Use the ${ORCHESTRATE_SKILL} skill: read \`pnyx-axi task show ${card.id} --hydra ${hydraId}\`, dispatch the worker, and keep the task's status current.`,
      ].join('\n')
      const id = meta.id ?? randomUUID()
      applyDecision({
        writer,
        decision: hydraEvent({
          state: writer.state,
          meta: {
            ...meta,
            id,
          },
          cardId: card.id,
          change: {
            type: 'hydra.message',
            data: {
              task: card.id,
              action: 'worker',
              text,
              hydra: config.hydra.id,
            },
          },
        }),
      })

      return {
        card: card.id,
        home: config.hydra.home,
        id,
        text,
      }
    },
  })
  const sent = await fmNote({
    home: queued.home,
    requestId: `pnyx:${hydraId}:${queued.id}`,
    text: queued.text,
  })

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
