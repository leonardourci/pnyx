import { ownerGates } from '#tasks/owner-gates.ts'
import { openAsks } from '#tasks/questions.ts'
import { openDecisions } from '#tasks/decisions.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { hydraConfig } from '#hydra/config.ts'
import { reportActor } from '#hydra/hydra.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'
import type { AgentConfig } from '#workers/model.ts'
import type { WakeKind } from '#hydra/wake-reasons.ts'

const NUDGES: WakeKind[] = [
  'turn ended',
  'quiet',
  'wait ended',
  'not confirmed',
]

// A task waiting on the owner keeps only its worker nudges and permission prompts for the helper.
const SCOPE_KINDS: Record<HelperScope, WakeKind[]> = {
  routine: [
    ...NUDGES,
    'asked',
  ],
  owner: [
    ...NUDGES,
    'permission',
  ],
}

// The named actions the helper may take; owner answers, holds, merges and new work stay main-only.
const SCOPE_ACTIONS: Record<HelperScope, HelperAction[]> = {
  routine: [
    'reply',
    'continue',
    'answer',
    'permission',
  ],
  owner: [
    'reply',
    'continue',
    'permission',
  ],
}

export const HELPER_TASKS = 3
export const HELPER_INPUT_CHARS = 24_000

export type HelperScope = 'routine' | 'owner'
export type HelperAction = 'reply' | 'continue' | 'answer' | 'permission'

export function helperAgent({
  state,
  main,
}: {
  state: HydraState
  main?: AgentConfig
}): AgentConfig | undefined {
  const config = hydraConfig({ state })

  if (config.helper === false || config.hydra.kind !== 'agent') {
    return undefined
  }

  if (config.helper) {
    return config.helper
  }

  const harness = config.hydra.agent?.harness ?? main?.harness ?? 'claude'

  return {
    harness,
    model: harness === 'claude' ? 'sonnet' : 'gpt-6-luna',
  }
}

// Routine work, a task waiting on the owner, or none for a task that is main's alone.
export function helperScope({
  state,
  task,
}: {
  state: HydraState
  task: string
}): HelperScope | undefined {
  const card = state.cards[task]

  if (!card || card.id === HYDRA_CARD || card.automaticTask || card.hold) {
    return undefined
  }

  const ownerDecision = openDecisions({ state }).some(item => item.card.id === task
    && item.kind !== 'worker question')
  const ownerAsk = openAsks({ card }).some(ask => ask.audience === 'owner' || ask.escalated)

  return ownerDecision || ownerAsk || ownerGates({ card }).length ? 'owner' : 'routine'
}

export function helperReason({
  state,
  task,
  kind,
}: {
  state: HydraState
  task: string
  kind: WakeKind
}): boolean {
  const scope = helperScope({
    state,
    task,
  })

  return !!scope && SCOPE_KINDS[scope].includes(kind)
}

export function helperEvent({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): string | undefined {
  const task = event.type === 'hydra.message' ? event.data.task : event.cardId

  if (!task) {
    return undefined
  }

  const scope = helperScope({
    state,
    task,
  })

  if (event.type === 'task.permission') {
    return scope && event.data.status === 'pending' ? task : undefined
  }

  if (scope !== 'routine') {
    return undefined
  }

  if (event.type === 'hydra.message') {
    if (reportActor({ actor: event.actor }) && event.data.ask) {
      return task
    }
  } else if (event.type === 'task.declared') {
    if (event.data.state === 'blocked' || event.data.state === 'needs_you') {
      return task
    }
  } else if (event.type === 'card.pushed') {
    if (!state.cards[task]?.links.some(link => link.kind === 'github_pr' && link.state === 'open')) {
      return task
    }
  }

  return undefined
}

// The batch to offer: the oldest worker questions first, then the oldest other tasks, within the task and input caps.
export function helperBatch({
  items,
  prompt,
}: {
  items: {
    task: string
    seq: number
    question: boolean
  }[]
  prompt({ tasks }: { tasks: string[] }): string
}): {
  tasks: string[]
  text: string
} | undefined {
  const first = new Map<string, {
    seq: number
    question: boolean
  }>()

  for (const item of items) {
    const known = first.get(item.task)

    const older = item.question === known?.question && item.seq < known.seq

    if (!known || (item.question && !known.question) || older) {
      first.set(
        item.task,
        {
          seq: item.seq,
          question: item.question,
        },
      )
    }
  }

  const order = [...first].sort((
    [
      , a,
    ],
    [
      , b,
    ],
  ) => Number(b.question) - Number(a.question) || a.seq - b.seq)
    .map(([task]) => task)
  let batch: {
    tasks: string[]
    text: string
  } | undefined

  for (const task of order.slice(
    0,
    HELPER_TASKS,
  )) {
    const tasks = [
      ...batch?.tasks ?? [],
      task,
    ]
    const text = prompt({ tasks })

    if (batch && text.length > HELPER_INPUT_CHARS) {
      break
    }

    batch = {
      tasks,
      text,
    }
  }

  return batch
}

export function helperGrant({
  state,
  task,
  actor,
  action,
}: {
  state: HydraState
  task: string
  actor: string
  action?: HelperAction
}): boolean {
  const batch = state.helper?.runs[actor.slice('helper:'.length)]
  const scope = helperScope({
    state,
    task,
  })

  return actor.startsWith('helper:') && !!batch && !batch.error && batch.tasks.includes(task)
    && !!scope && (!action || SCOPE_ACTIONS[scope].includes(action))
}
