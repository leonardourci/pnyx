import { claudeProvider } from './claude.ts'
import { codexProvider } from './codex.ts'
import { HARNESSES, PROVIDERS, harnessOf } from './providers.ts'
import { mergeWindows, type AgentUsage, type PlanWindow, type UsageReading } from './provider.ts'
import type { AgentRef } from './model.ts'
import type { TaskSpend } from './task-spend.ts'
import type { HelperUsageTotal } from '#routine-helper/state.ts'
import { countTokens } from './token-count.ts'

const adapters = {
  claude: claudeProvider({}),
  codex: codexProvider({}),
}

export function transcriptProvider({ provider }: { provider: string }) {
  const harness = HARNESSES.find(harness => harness === provider
    || PROVIDERS[harness].provider === provider)

  return harness ? adapters[harness] : undefined
}

const validCount = ({ value }: { value?: number }): boolean =>
  value !== undefined && Number.isFinite(value) && Number.isInteger(value) && value >= 0

export function usageFor({
  agent,
  model,
  live = {},
  transcript = {},
  plan,
  spend,
  contextText,
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
  // Only the complete current context qualifies for an estimate.
  contextText?: string
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
      icon: registry?.icon ?? 'robot',
      model,
      account: agent?.account,
      plan: reading.plan ?? plan?.plan,
    },
    recorded: {
      tokens: spend?.total,
      cost: typeof reading.cost === 'number' && Number.isFinite(reading.cost)
        && reading.cost >= 0 ? reading.cost : undefined,
      worker: spend?.worker,
      hydra: spend?.hydra,
      unavailable: spend?.unavailable ?? 0,
      sharedHydra: spend?.sharedHydra ?? false,
    },
    windows: mergeWindows({
      base: plan?.windows ?? [],
      over: (reading.limits ?? []).filter(limit =>
        !limit.resetsAt || Date.parse(limit.resetsAt) > now),
    }).filter(window => Number.isFinite(window.used) && window.used >= 0),
  }

  if (helper) {
    usage.helper = helper

    if (usage.recorded.cost !== undefined && helper.cost !== undefined
      && helper.measuredBatches === helper.batches) {
      usage.combinedCost = usage.recorded.cost + helper.cost
    }
  }

  const reported = validCount({ value: reading.used }) ? reading.used : undefined

  if (reported === undefined && contextText === undefined) {
    usage.unavailable = 'Current context has not been reported'

    return usage
  }

  const count = countTokens({
    text: contextText ?? '',
    reported,
  })
  usage.context = {
    used: count.tokens,
    source: count.source,
  }

  if (reading.window !== undefined && validCount({ value: reading.window }) && reading.window > 0) {
    usage.context.window = reading.window
    usage.context.left = Math.max(
      0,
      reading.window - count.tokens,
    )
  }

  return usage
}
