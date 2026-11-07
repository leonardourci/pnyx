import type { Host } from '#app/host-types.ts'
import type { HydraState } from '#app/model.ts'
import { loadHydra } from '#app/store.ts'
import { accountFor } from '#workers/account-choice.ts'
import type { trackChildren } from '#workers/children.ts'
import { accountEnv, accountEnvironment } from '#workers/dispatch.ts'
import { defaultLogin, effectiveDispatch, loginFolder, type EffectiveDispatch } from '#workers/dispatch-config.ts'
import type { AgentConfig } from '#workers/model.ts'
import { hydraFastReaches, type Provider } from '#workers/provider.ts'
import { providerIdOf, type ProviderId } from '#workers/providers.ts'
import { helperAgent, helperChoice } from './route.ts'
import { createRoutineHelper } from './runner.ts'
import { outcomeLines, type HelperAgent } from './state.ts'

// The routine helper as a Hydra's server runs it: whether it may take work, and the agent, account and context it runs with.
export function createHostedHelper({
  hydraId,
  providers,
  children,
  helperBound,
  changed,
  environment,
  digest,
  armWake,
  host,
}: {
  hydraId: string
  providers: Record<ProviderId, Provider>
  children: ReturnType<typeof trackChildren>
  helperBound?: number
  changed(): void
  environment({ hydra }: { hydra?: boolean }): NodeJS.ProcessEnv
  digest({ remember }: { remember?: boolean }): Promise<string>
  armWake(): void
  host(): Host
}) {
  const helperFailed = ({ state }: { state: HydraState }) => Object.values(state.helper?.runs ?? {})
    .some(batch => batch.error)

  const helperPending = () => {
    const state = loadHydra({ hydraId }).state

    return outcomeLines({ state }).length > 0 || helperFailed({ state })
  }

  // A helper on an account runs only while that account is still registered for its harness.
  const accountKept = ({
    candidate,
    effective,
  }: {
    candidate: AgentConfig
    effective?: EffectiveDispatch
  }) => {
    if (candidate.account === undefined) {
      return true
    }

    const known = effective ?? effectiveDispatch()

    return known.accounts[candidate.account]?.provider === candidate.harness
  }

  // No helper agent when it is off or its account is no longer registered, so main takes the updates and no other login is used.
  const usableHelper = ({
    state,
    effective,
  }: {
    state: HydraState
    effective: EffectiveDispatch
  }) => {
    const candidate = helperAgent({
      state,
      dispatch: effective.dispatch,
    })

    return candidate && accountKept({
      candidate,
      effective,
    }) ? candidate : undefined
  }

  // A failed batch sends routine work to main until main has seen the failure.
  // An automatic helper has no account, so its openness never reads the dispatch file.
  const helperOpen = ({ state }: { state: HydraState }) => {
    const choice = helperChoice({ state })

    return choice !== undefined
      && (choice === 'auto' || accountKept({ candidate: choice }))
      && !helperFailed({ state })
  }

  const helper = createRoutineHelper({
    hydraId,
    spawned: children.spawned,
    provider: ({ harness }) => providers[providerIdOf({ harness })],
    environment: ({
      harness,
      actor,
      account: selectedAccount,
      loginFolder: selectedFolder,
    }) => {
      const env = {
        ...environment({ hydra: true }),
        PNYX_ACTOR: actor,
      }

      if (selectedFolder) {
        return accountEnvironment({
          account: {
            provider: harness,
            folder: selectedFolder,
          },
          env,
        })
      }

      const { account } = accountFor({
        effective: effectiveDispatch(),
        harness,
        prefer: selectedAccount,
      })

      return accountEnv({
        account,
        env,
      })
    },
    context: () => digest({ remember: false }),
    changed: () => {
      changed()
      armWake()
    },
    bound: helperBound,
    agentFor: async () => {
      const state = loadHydra({ hydraId }).state
      const effective = effectiveDispatch()
      const candidate = usableHelper({
        state,
        effective,
      })

      if (!candidate) {
        return undefined
      }

      const {
        name,
        account,
      } = accountFor({
        effective,
        harness: candidate.harness,
        prefer: candidate.account,
      })

      const nativeDefault = defaultLogin({ provider: candidate.harness })
      const folder = account ? loginFolder({ account }) : nativeDefault
      const hydraFast = await hydraFastReaches({
        hydraFast: state.config?.hydra.agent?.fast,
        models: () => host().models({
          harness: candidate.harness,
          account: name,
        }),
        model: candidate.model,
      })
      const agent: HelperAgent = {
        ...candidate,
        account: name,
        loginFolder: folder,
      }

      if (candidate.fast || hydraFast) {
        agent.fast = true
      }

      return agent
    },
    handback: armWake,
    outcomesReady: armWake,
  })

  return {
    helper,
    helperPending,
    helperOpen,
  }
}
