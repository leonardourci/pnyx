import { readClaudeUsage } from './claude.ts'
import { readCodexUsage } from './codex.ts'
import { PROVIDERS, harnessOf } from './providers.ts'
import { mergeWindows, type AgentUsage, type PlanWindow, type UsageReading } from './provider.ts'
import type { AgentRef } from './model.ts'
import type { TaskSpend } from './task-spend.ts'
import type { HelperUsageTotal } from '#routine-helper/state.ts'
import { usageNumber } from './transcript-usage.ts'

const transcriptReaders = {
  claude: readClaudeUsage,
  codex: readCodexUsage,
}

export const transcriptProvider = ({ provider }: { provider: string }) =>
  transcriptReaders[harnessOf({ provider })]

export function usageFor({
  agent,
  model,
  live = {},
  transcript = {},
  plan,
  spend,
  account,
  helper,
  now = Date.now(),
}: {
  agent?: AgentRef
  model?: string
  live?: UsageReading
  transcript?: UsageReading
  plan?: {
    plan?: string
    windows: PlanWindow[]
  }
  spend?: TaskSpend
  account?: string
  helper?: HelperUsageTotal
  now?: number
}): AgentUsage {
  const registry = agent ? PROVIDERS[harnessOf({ provider: agent.provider })] : undefined
  const reading = {
    ...transcript,
    ...live,
  }
  const usage: AgentUsage = {
    who: {
      provider: registry?.usageName ?? 'Agent',
      icon: registry?.icon ?? 'agent',
      model,
      account: account ?? agent?.account,
      plan: reading.plan ?? plan?.plan,
    },
    recorded: {
      tokens: spend?.total,
      cost: usageNumber({ value: reading.cost }),
      worker: spend?.worker,
      hydra: spend?.hydra,
      unavailable: spend?.unavailable ?? 0,
      sharedHydra: spend?.sharedHydra ?? false,
    },
    windows: mergeWindows({
      base: plan?.windows ?? [],
      over: (reading.limits ?? []).filter(limit =>
        !limit.resetsAt || Date.parse(limit.resetsAt) > now),
    }).filter(window => usageNumber({ value: window.used }) !== undefined),
  }

  if (helper) {
    usage.helper = helper

    if (usage.recorded.cost !== undefined && helper.cost !== undefined
      && helper.measuredBatches === helper.batches) {
      usage.combinedCost = usage.recorded.cost + helper.cost
    }
  }

  const used = usageNumber({
    value: reading.used,
    integer: true,
  })

  if (used === undefined) {
    usage.unavailable = 'Current context has not been reported'

    return usage
  }

  usage.context = {
    used,
    source: 'reported',
  }
  const window = usageNumber({
    value: reading.window,
    integer: true,
  })

  if (window !== undefined && window > 0) {
    usage.context.window = window
    usage.context.left = Math.max(
      0,
      window - used,
    )
  }

  return usage
}
