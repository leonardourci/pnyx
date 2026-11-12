import { isDeepStrictEqual } from 'node:util'
import type { HydraState } from '#app/model.ts'
import { harnessAccount } from './account-choice.ts'
import { readUsage } from './dispatch.ts'
import { defaultLogin, effectiveDispatch } from './dispatch-config.ts'
import type { AgentRef } from './model.ts'
import { mergeWindows, type HostedUsage } from './provider.ts'
import { harnessOf } from './providers.ts'
import { sessionId } from './session-attachments.ts'
import { usageFor } from './usage.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { findCard } from '#tasks/push-rules.ts'
import { loadHydra } from '#app/store.ts'
import type { Host } from '#app/host-types.ts'

const plans = new Map<string, Awaited<ReturnType<typeof readUsage>>>()
const planReads = new Map<string, number>()
let nextPlanRead = 0
const trackers = new Set<({ account }: { account: string }) => void>()

// What each hosted session and login reported about its usage, and the usage views built from it.
export function createUsageTracker({
  hydraId,
  streamed,
}: {
  hydraId: string
  streamed({ session }: { session: string }): void
}) {
  // The latest size and spend each session reported, kept after its process idles out.
  const usages = new Map<string, Omit<HostedUsage, 'type'>>()

  const usageAccount = ({ agent }: { agent: AgentRef }) => {
    const harness = harnessOf({ provider: agent.provider })
    const effective = effectiveDispatch()
    const name = agent.account ?? harnessAccount({
      effective,
      harness,
    })
    const account = name ? effective.accounts[name] : undefined
    const configuredFolder = account?.provider === harness ? account.folder : undefined
    const folder = agent.loginFolder ?? configuredFolder ?? defaultLogin({ provider: harness })

    return {
      name,
      folder,
      harness,
      key: `${harness}:${folder}`,
    }
  }

  const accountSessions = ({
    state,
    account,
  }: {
    state: HydraState
    account: string
  }) =>
    new Set(Object.values(state.cards).flatMap(task => {
      if (!task.agent || usageAccount({ agent: task.agent }).key !== account) {
        return []
      }

      return [sessionId({ agent: task.agent })]
    }))

  const notifyPlan = ({ account }: { account: string }) => {
    for (const session of accountSessions({
      state: loadHydra({ hydraId }).state,
      account,
    })) {
      streamed({ session })
    }
  }

  trackers.add(notifyPlan)

  const mergeUsage = ({
    key,
    activity,
  }: {
    key: string
    activity: HostedUsage
  }) => {
    const before = usages.get(key) ?? {}
    usages.set(
      key,
      {
        ...before,
        ...Object.fromEntries(([
          'used',
          'window',
          'cost',
          'inputTokens',
          'plan',
        ] as const).flatMap(field => activity[field] === undefined ? [] : [
          [
            field,
            activity[field],
          ],
        ])),
        ...(activity.limits ? {
          limits: mergeWindows({
            base: before.limits ?? [],
            over: activity.limits,
          }),
        } : {}),
      },
    )

    streamed?.({ session: key })
  }

  const usageViews: Host['usageViews'] = ({
    spend = {},
    readings = {},
  }) => {
    const state = loadHydra({ hydraId }).state

    return Object.fromEntries(Object.values(state.cards).flatMap(card => {
      const agent = card.agent

      if (!agent) {
        return []
      }

      const key = sessionId({ agent })
      const account = usageAccount({ agent })

      return [
        [
          card.id,
          usageFor({
            agent: card.agent,
            model: card.settings?.model,
            live: usages.get(key),
            transcript: readings[key],
            plan: plans.get(account.key),
            account: account.name,
            spend: spend[card.id],
            helper: card.id === HYDRA_CARD ? state.helper?.usage : undefined,
          }),
        ],
      ]
    }))
  }

  const usage: Host['usage'] = async ({
    card: ref,
    spend = {},
    readings = {},
  } = {}) => {
    const state = loadHydra({ hydraId }).state
    const card = ref ? findCard({
      state,
      ref,
    }) : state.cards[HYDRA_CARD]
    const agent = card?.agent

    if (!agent) {
      return { usage: ref ? 'none: task has no agent session' : 'none: Hydra has not started a session' }
    }

    const key = sessionId({ agent })
    const account = usageAccount({ agent })

    return usageFor({
      agent,
      account: account.name,
      model: card.settings?.model,
      live: usages.get(key),
      transcript: readings[key],
      plan: plans.get(account.key),
      spend: spend[card.id],
      helper: card.id === HYDRA_CARD ? state.helper?.usage : undefined,
    })
  }

  const refreshUsage: Host['refreshUsage'] = async ({
    card: ref,
    force = false,
  }) => {
    const state = loadHydra({ hydraId }).state
    const card = ref ? findCard({
      state,
      ref,
    }) : state.cards[HYDRA_CARD]

    if (!card?.agent) {
      return { refreshed: 'none: no agent session' }
    }

    const account = usageAccount({ agent: card.agent })
    const generation = ++nextPlanRead
    planReads.set(
      account.key,
      generation,
    )
    const before = accountSessions({
      state,
      account: account.key,
    })
    const plan = await readUsage({
      refresh: force,
      account: {
        provider: account.harness,
        folder: account.folder,
      },
    })

    if (planReads.get(account.key) !== generation) {
      return { refreshed: 'cached plan limits' }
    }

    const changed = !plans.has(account.key) || !isDeepStrictEqual(
      plans.get(account.key),
      plan,
    )

    if (changed) {
      plans.set(
        account.key,
        plan,
      )

      for (const notify of trackers) {
        notify({ account: account.key })
      }

      return { refreshed: 'plan limits' }
    }

    const sessions = accountSessions({
      state: loadHydra({ hydraId }).state,
      account: account.key,
    })

    for (const session of sessions) {
      if (!before.has(session)) {
        streamed({ session })
      }
    }

    return { refreshed: 'cached plan limits' }
  }

  return {
    close() {
      trackers.delete(notifyPlan)

      if (trackers.size === 0) {
        plans.clear()
        planReads.clear()
      }
    },
    mergeUsage,
    usageViews,
    usage,
    refreshUsage,
  }
}
