import { randomUUID } from 'node:crypto'
import type { Meta } from '#app/command-meta.ts'
import type { Output } from '#app/cli-support.ts'
import { applyDecision } from '#app/decision.ts'
import { requestCwd } from '#app/request-context.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
import { setupHydra } from '#integrations/firstmate/home.ts'
import { openPaseo, type Connect } from '#integrations/paseo/client.ts'
import { createPaseoAgent } from '#integrations/paseo/launch.ts'
import { paseoUrl } from '#integrations/paseo/url.ts'
import { HydraError } from '#store/errors.ts'
import { canonical } from '#store/paths.ts'
import { pnyxHome } from '#store/storage.ts'
import { decidePush } from '#tasks/push.ts'
import { accountEnvironment, chooseCandidate, ruleCandidates } from '#workers/dispatch.ts'
import { effectiveDispatch } from '#workers/dispatch-config.ts'
import type { Harness } from '#workers/providers.ts'
import { sessionId } from '#workers/session-attachments.ts'
import { startCommand } from '#workers/start-command.ts'
import { hydraPrompt } from '#workers/worker-brief.ts'
import { hydraConfig } from './config.ts'
import { hydraEvent } from './hydra.ts'
import { HYDRA_CARD } from './identity.ts'

export async function startHydra({
  hydraId,
  via,
  rule,
  harness,
  prompt,
  folder,
  home,
  url,
  meta,
  connect,
}: {
  hydraId: string
  via?: string
  rule?: string
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
      throw new HydraError({
        message: 'a Firstmate Hydra needs --home <firstmate home>',
        code: 'VALIDATION_ERROR',
      })
    }

    return setupHydra({
      hydraId,
      home: given,
      meta,
    })
  }

  if (how === 'command') {
    return startCommand({
      hydraId,
      role: 'hydra',
      prompt,
      folder,
      harness,
      meta,
    })
  }

  if (how !== 'paseo') {
    throw new HydraError({
      message: `unknown start route: ${how}`,
      code: 'VALIDATION_ERROR',
      help: ['Use --via paseo|firstmate|command'],
    })
  }

  if (meta.id && `${meta.id}:hydra` in loadHydra({ hydraId }).state.eventIds) {
    return {
      hydra: HYDRA_CARD,
      event: 'none: duplicate',
    }
  }

  const config = effectiveDispatch()
  const selectedRule = rule ?? (config.dispatch.rules.hydra ? 'hydra' : 'default')
  const mainName = config.dispatch.main
  const main = mainName && Object.hasOwn(
    config.accounts,
    mainName,
  )
    ? config.accounts[mainName] : undefined

  if (!main || !mainName) {
    throw new HydraError({
      message: 'heads dispatch needs a registered main account',
      code: 'NO_ACCOUNTS',
    })
  }

  const chosen = (harness ?? main.provider) as Harness
  const client = await (connect ?? openPaseo)({ url: paseoUrl({ url }) })
  let offered: string[]

  try {
    const { models } = await client.providers.listModels(
      chosen,
      { cwd: folder ?? requestCwd() },
    )
    offered = models?.map(m => m.id) ?? []
  } finally {
    await client.close()
  }

  const candidates = ruleCandidates({
    dispatch: config.dispatch,
    rule: selectedRule,
  })
  // Hydra runs on its rule's first candidate for the harness, as a hosted Hydra does, so none can tie.
  const first = candidates?.filter(c => c.harness === chosen).slice(
    0,
    1,
  )
  const rules = first && selectedRule !== 'default'
    ? {
      ...config.dispatch.rules,
      [selectedRule]: {
        ...config.dispatch.rules[selectedRule]!,
        candidates: first,
      },
    }
    : config.dispatch.rules
  const dispatch = await chooseCandidate({
    config: {
      ...config,
      dispatch: {
        ...config.dispatch,
        rules,
        ...(first && selectedRule === 'default' ? { default: first } : {}),
        workers: { [main.provider]: [mainName] },
        projects: {},
      },
    },
    rule: selectedRule,
    harness: chosen,
    offers: { [chosen]: offered },
  })
  const agent = dispatch.candidate

  const id = meta.id ?? randomUUID()
  const cwd = canonical({ path: folder }) ?? requestCwd()
  const endpoint = paseoUrl({ url })
  const free = withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })

      if (`${id}:hydra` in writer.state.eventIds) {
        return false
      }

      if (writer.state.config?.hydra.session) {
        throw new HydraError({
          message: `Hydra ${hydraId} already has a Hydra session`,
          code: 'CONFLICT',
          help: [`Run \`pnyx-axi hydra set --hydra ${hydraId} --identity <new identity>\` to replace it`],
        })
      }

      return true
    },
  })

  if (!free) {
    return {
      hydra: HYDRA_CARD,
      event: 'none: duplicate',
      help: ['This start was already recorded; nothing was started again'],
    }
  }

  const {
    agent: started,
    ref,
  } = await createPaseoAgent({
    harness: chosen,
    agent,
    prompt: prompt ?? hydraPrompt({ hydraId }),
    cwd,
    title: `Hydra · ${hydraId}`,
    id,
    // No PNYX_TASK: the Paseo agent is recorded as Hydra here, not by its hooks.
    env: accountEnvironment({
      account: {
        provider: dispatch.provider,
        folder: dispatch.folder,
      },
      env: {
        PNYX_HOME: pnyxHome(),
        PNYX_HYDRA: hydraId,
      },
    }) as Record<string, string>,
    labels: {
      'pnyx.hydra': hydraId,
      'pnyx.role': 'hydra',
    },
    url: endpoint,
    connect,
  })

  return withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })
      applyDecision({
        writer,
        decision: decidePush({
          state: writer.state,
          key: `paseo:${started.id}`,
          input: {
            title: `Hydra · ${hydraId}`,
            agent: ref,
            activity: 'working',
            source: {
              adapter: 'paseo',
              instanceId: endpoint,
              objectId: started.id,
              observedAt: meta.at,
            },
          },
          meta: {
            ...meta,
            id: `${id}:session`,
            ifRevision: undefined,
          },
        }),
      })
      const config = hydraConfig({
        state: writer.state,
        id: hydraId,
      })
      const hydra = {
        ...config.hydra,
        kind: 'agent' as const,
        session: sessionId({ agent: ref }),
      }
      delete hydra.home
      applyDecision({
        writer,
        decision: hydraEvent({
          state: writer.state,
          meta: {
            ...meta,
            id: `${id}:hydra`,
          },
          cardId: '$board',
          change: {
            type: 'board.configured',
            data: {
              ...config,
              hydra,
            },
          },
        }),
      })

      return {
        hydra: {
          session: hydra.session,
          paseo: started.id,
          folder: cwd,
        },
        help: [`Talk to Hydra in Paseo, or queue work with \`pnyx-axi hydra send --hydra ${hydraId} --text <message>\``],
      }
    },
  })
}
