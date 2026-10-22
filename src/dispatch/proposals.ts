import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { hydraBypasses, hydraEvent, HYDRA_CARD } from '../core/hydra.ts'
import { HydraError, type DispatchProposal } from '../core/model.ts'
import { loadHydra, withRegistryLock, withWriter } from '../store/hydra-store.ts'
import { meta, type Output } from '../cli/commands.ts'
import { configPath, effectiveDispatch, parseAccounts, parseDispatch, readConfig, writeConfig } from './config.ts'

function configuration({
  hydraId,
  shared,
  accounts,
}: {
  hydraId: string
  shared: boolean
  accounts: boolean
}): string {
  const state = withWriter({
    hydraId,
    fn: ({ writer }) => writer.state,
  })

  return JSON.stringify({
    file: readConfig({
      path: configPath({
        hydraId,
        shared,
        accounts,
      }),
    }),
    effective: effectiveDispatch({
      hydraId,
      state,
    }),
  })
}

export function saveOrPropose({
  hydraId,
  shared,
  accounts = false,
  value,
  values,
  summary,
  propose,
}: {
  hydraId: string
  shared: boolean
  accounts?: boolean
  value: unknown
  values: Record<string, string | boolean | undefined>
  summary: string
  propose: boolean
}): Output | undefined {
  const actor = meta({ values })

  if (!propose) {
    if ((actor.actor === 'hydra' || process.env.PNYX_ACTOR === 'hydra') && !hydraBypasses({ state: loadHydra({ hydraId }).state })) {
      throw new HydraError({
        message: 'Hydra must propose rule and account changes for the owner to confirm',
        code: 'OWNER_ONLY',
      })
    }

    writeConfig({
      path: configPath({
        hydraId,
        shared,
        accounts,
      }),
      accounts,
      value,
    })

    return undefined
  }

  const parsed = accounts ? parseAccounts({ value }) : parseDispatch({ value })
  const before = configuration({
    hydraId,
    shared,
    accounts,
  })
  const proposal: DispatchProposal = {
    token: '',
    kind: accounts ? 'account' : 'rule',
    shared,
    before,
    value: JSON.stringify(parsed),
    summary,
  }
  proposal.token = createHash('sha256').update(JSON.stringify({
    hydraId,
    ...proposal,
  }))
    .digest('hex')
    .slice(
      0,
      24,
    )
  withWriter({
    hydraId,
    fn: ({ writer }) => {
      const decision = hydraEvent({
        state: writer.state,
        meta: actor,
        cardId: HYDRA_CARD,
        change: {
          type: 'hydra.dispatch-proposed',
          data: proposal,
        },
      })

      if ('event' in decision) {
        writer.append({ event: decision.event })
      }
    },
  })

  return {
    confirmation: 'needed',
    token: proposal.token,
    action: summary,
    preview: parsed,
    help: ['The owner can Confirm or Dismiss this proposal in Hydra’s chat'],
  }
}

export function resolveProposal({
  hydraId,
  action,
  token,
  confirm,
  values,
}: {
  hydraId: string
  action: 'confirm' | 'dismiss'
  token: string
  confirm?: string
  values: Record<string, string | boolean | undefined>
}): Output {
  const actor = meta({ values })

  if (actor.actor === 'hydra' || process.env.PNYX_ACTOR === 'hydra') {
    throw new HydraError({
      message: 'Only the owner can confirm or dismiss a dispatch proposal',
      code: 'OWNER_ONLY',
    })
  }

  return withRegistryLock({
    fn: () => {
      const state = withWriter({
        hydraId,
        fn: ({ writer }) => writer.state,
      })
      const proposal = state.dispatchProposals?.find(p => p.token === token)

      if (!proposal) {
        return { event: 'none: proposal already resolved or missing' }
      }

      if (proposal.kind === 'command') {
        throw new HydraError({
          message: 'Answer this question with approval confirm|dismiss',
          code: 'VALIDATION_ERROR',
        })
      }

      if (action === 'confirm') {
        if (confirm !== proposal.token) {
          return {
            confirmation: 'needed',
            token,
            action: proposal.summary,
            preview: JSON.parse(proposal.value),
          }
        }

        const accounts = proposal.kind === 'account'

        if (configuration({
          hydraId,
          shared: proposal.shared,
          accounts,
        }) !== proposal.before) {
          throw new HydraError({
            message: 'Dispatch configuration changed; dismiss this proposal and ask Hydra for a new one',
            code: 'CONFLICT',
          })
        }

        const path = configPath({
          hydraId,
          shared: proposal.shared,
          accounts,
        })
        const value: unknown = JSON.parse(proposal.value)

        if (!isDeepStrictEqual(
          readConfig({ path }),
          value,
        )) {
          writeConfig({
            path,
            accounts,
            value,
          })
        }
      }

      withWriter({
        hydraId,
        fn: ({ writer }) => {
          const decision = hydraEvent({
            state: writer.state,
            meta: actor,
            cardId: HYDRA_CARD,
            change: {
              type: 'hydra.dispatch-resolved',
              data: {
                token,
                action: action === 'confirm' ? 'confirmed' : 'dismissed',
              },
            },
          })

          if ('event' in decision) {
            writer.append({ event: decision.event })
          }
        },
      })

      return {
        proposal: token,
        state: action === 'confirm' ? 'confirmed' : 'dismissed',
      }
    },
  })
}
