import { ownerGates } from '#tasks/owner-gates.ts'
import { openAsks } from '#tasks/questions.ts'
import { openDecisions } from '#tasks/decisions.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { hydraConfig } from '#hydra/config.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'
import type { AgentConfig } from '#workers/model.ts'
import { eventReasons, type WakeKind } from '#hydra/wake-reasons.ts'
import type { PermissionRequest } from '#workers/model.ts'
import { readSettings } from '#settings/store.ts'

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
    'declared',
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

// The lighter model auto picks on each harness, and the one a chosen harness starts from.
export const HELPER_MODELS = {
  claude: 'sonnet',
  codex: 'gpt-6-luna',
} as const
export const HELPER_TASKS = 3
export const HELPER_INPUT_CHARS = 24_000

type HelperScope = 'routine' | 'owner'
export type HelperAction = 'reply' | 'continue' | 'answer' | 'permission'

export function helperAgent({
  state,
  main,
}: {
  state: HydraState
  main?: AgentConfig
}): AgentConfig | undefined {
  const config = hydraConfig({ state })
  const helper = readSettings().settings.helper

  if (helper === 'off' || config.hydra.kind !== 'agent') {
    return undefined
  }

  if (helper !== 'auto') {
    return helper
  }

  const harness = config.hydra.agent?.harness ?? main?.harness ?? 'claude'

  return {
    harness,
    model: HELPER_MODELS[harness],
  }
}

// A task waiting on the owner gets the narrower owner scope; held and automatic tasks get none.
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
  const prompts = kind === 'permission' ? state.cards[task]?.permissions ?? [] : []

  return !!scope && SCOPE_KINDS[scope].includes(kind)
    && prompts.every(request => request.status !== 'pending' || helperPermission({ request }))
}

// A permission prompt that asks a question or shows a form is the worker asking, which only main or the owner answers.
export const helperPermission = ({ request }: { request: PermissionRequest }) => !request.questions
  && !request.form

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

  if (event.type === 'task.declared' && event.data.state !== 'blocked' && event.data.state !== 'needs_you') {
    return undefined
  }

  if (event.type === 'card.pushed'
    && state.cards[task]?.links.some(link => link.kind === 'github_pr' && link.state === 'open')) {
    return undefined
  }

  const kinds = eventReasons({
    state,
    event,
  }).map(reason => reason.kind)

  return kinds.length && kinds.every(kind => helperReason({
    state,
    task,
    kind,
  })) ? task : undefined
}

// Worker questions go first because their workers wait on the answer; an event past the input cap waits for the next batch.
export function helperBatch({
  items,
  prompt,
}: {
  items: {
    task: string
    seq: number
    question: boolean
  }[]
  prompt({ seqs }: { seqs: number[] }): string
}): {
  tasks: string[]
  seqs: number[]
  text: string
} | undefined {
  const sorted = [...items].sort((
    a,
    b,
  ) => Number(b.question) - Number(a.question) || a.seq - b.seq)
  const order = [...new Set(sorted.map(item => item.task))].slice(
    0,
    HELPER_TASKS,
  )
  const chosen: number[] = []
  let text = ''

  for (const item of order.flatMap(task => sorted.filter(item => item.task === task))) {
    const next = prompt({
      seqs: [
        ...chosen,
        item.seq,
      ],
    })

    if (chosen.length && next.length > HELPER_INPUT_CHARS) {
      break
    }

    chosen.push(item.seq)
    text = next
  }

  if (!chosen.length) {
    return undefined
  }

  return {
    tasks: [...new Set(sorted.filter(item => chosen.includes(item.seq)).map(item => item.task))],
    seqs: chosen,
    text,
  }
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
