import type { HydraEvent, HydraState } from '#app/model.ts'
import { ownerActor } from '#app/actors.ts'
import { HydraError } from '#store/errors.ts'
import { countTokens } from '#workers/token-count.ts'
import { redact } from '#oracle/text.ts'
import type { ChatEvent, HydraOperation } from './model.ts'
import type { ThreadEntry } from './transcripts-read.ts'
import { HYDRA_CARD } from './identity.ts'
import { operationLabel } from './operation-label.ts'
import { effectiveChatEvents } from './chat-records.ts'
import { messageReference } from './message-reference.ts'
import { HISTORY_BUDGET } from './history-command.ts'

export { HISTORY_BUDGET, historyCommand } from './history-command.ts'

const HISTORY_PAGE_BYTES = 24000
export const NEITHER_LIMIT = 15000
export const NEITHER_REASON = 'Neither requires less than 15,000 tokens since the last successful compaction.'

export const canSkipCompaction = ({ tokens }: { tokens: number }) => tokens < NEITHER_LIMIT

export interface HistoryMilestone extends HydraOperation {
  seq: number
  through: number
  summary?: string
}

export function lastMilestone({
  state,
  kind,
}: {
  state: HydraState
  kind: 'compaction' | 'inscribe'
}): HistoryMilestone | undefined {
  return state.historyMilestones?.filter(item => item.kind === kind && item.state === 'finished')
    .toSorted((
      a,
      b,
    ) => kind === 'compaction' ? a.seq - b.seq : a.through - b.through)
    .at(-1)
}

export function compactionContext({ state }: { state: HydraState }): {
  since: string
  summary?: string
} {
  const milestone = lastMilestone({
    state,
    kind: 'compaction',
  })

  return {
    since: milestone?.id ?? 'origin',
    summary: milestone ? milestone.summary : state.hydraContext?.summary,
  }
}

export function inscribeSince({ state }: { state: HydraState }): string {
  return lastMilestone({
    state,
    kind: 'inscribe',
  })?.id ?? lastMilestone({
    state,
    kind: 'compaction',
  })?.id ?? 'origin'
}

export function historyBoundary({
  state,
  since,
}: {
  state: HydraState
  since: string
}): number {
  if (since === 'last-compaction' || since === 'last-inscribe') {
    const kind = since === 'last-compaction' ? 'compaction' : 'inscribe'
    const milestone = lastMilestone({
      state,
      kind,
    })

    if (!milestone && kind === 'inscribe') {
      return historyBoundary({
        state,
        since: 'last-compaction',
      })
    }

    return milestone?.through ?? 0
  }

  if (since === 'origin') {
    return 0
  }

  const milestone = state.historyMilestones?.find(item => item.id === since && item.state === 'finished')

  if (!milestone) {
    throw new HydraError({
      message: 'History needs a successful milestone ID, last-compaction or last-inscribe',
      code: 'VALIDATION_ERROR',
    })
  }

  return milestone.through
}

// Transport parts rejoin before rendering or counting, including parts from different pages.
export function joinMessageParts({ entries }: { entries: ThreadEntry[] }): ThreadEntry[] {
  const result: ThreadEntry[] = []

  for (const entry of entries) {
    const prior = result.at(-1)

    if (entry.messageId && prior?.messageId === entry.messageId && prior.kind === entry.kind
      && (prior.part ?? 0) + prior.text.length === entry.part) {
      prior.text += entry.text
    } else {
      result.push({
        ...entry,
        id: entry.messageId && entry.part === 0 ? entry.messageId : entry.id,
      })
    }
  }

  return result
}

export function taskWords({ event }: { event: HydraEvent }): {
  action: string
  text: string
} | undefined {
  if (event.type === 'task.created') {
    const text = [
      event.data.ask?.text,
      event.data.intent,
      event.data.brief,
    ].filter(Boolean).join('\n\n')

    return text ? {
      action: 'task created',
      text,
    } : undefined
  }

  if (event.type === 'task.brief') {
    return {
      action: 'brief',
      text: [
        event.data.intent,
        event.data.after,
      ].filter(Boolean).join('\n\n'),
    }
  }

  if (event.type === 'task.owner-ask' || event.type === 'task.intent') {
    return {
      action: 'owner ask',
      text: event.data.text,
    }
  }

  return undefined
}

export function inscribeOperation({
  state,
  id,
  action,
  through,
  error,
}: {
  state: HydraState
  id: string
  action?: string
  through?: number
  error?: string
}): HydraOperation {
  if (action !== 'start' && action !== 'finish' && action !== 'fail') {
    throw new HydraError({
      message: 'Use hydra inscribe start|finish|fail [--key <milestone-id>]',
      code: 'VALIDATION_ERROR',
    })
  }

  if (!/^[a-zA-Z0-9:_.-]+$/.test(id)) {
    throw new HydraError({
      message: 'Use letters, numbers, dots, colons, hyphens or underscores for a milestone ID',
      code: 'VALIDATION_ERROR',
    })
  }

  const previous = state.historyMilestones?.find(item => item.id === id)

  if ((previous && previous.kind !== 'inscribe') || (action !== 'start' && !previous)) {
    throw new HydraError({
      message: 'No inscribe pass has started with that ID',
      code: 'VALIDATION_ERROR',
    })
  }

  const active = state.historyMilestones?.findLast(item => item.kind === 'inscribe' && item.state === 'started')

  if (action === 'start' && active && active.id !== id) {
    throw new HydraError({
      message: 'An inscribe pass is already running; resume it with hydra inscribe start',
      code: 'CONFLICT',
    })
  }

  let nextState: HydraOperation['state'] = 'started'

  if (action === 'finish') {
    nextState = 'finished'
  } else if (action === 'fail') {
    nextState = 'failed'
  }

  if (previous && previous.state !== 'started' && previous.state !== nextState) {
    throw new HydraError({
      message: 'This inscribe pass has already ended; start a new pass',
      code: 'VALIDATION_ERROR',
    })
  }

  if (action === 'finish' && through !== previous?.through) {
    throw new HydraError({
      message: 'Read every history page before finishing; --through must equal the pass snapshot',
      code: 'INSCRIBE_INCOMPLETE',
    })
  }

  const snapshot = previous?.through ?? through ?? state.seq

  if (!Number.isSafeInteger(snapshot) || snapshot < 0 || snapshot > state.seq) {
    throw new HydraError({
      message: '--through must name an existing log position',
      code: 'VALIDATION_ERROR',
    })
  }

  return {
    parent: previous?.parent,
    historySince: previous?.historySince ?? inscribeSince({ state }),
    after: previous?.after,
    id,
    kind: 'inscribe',
    state: nextState,
    through: snapshot,
    error: action === 'fail' ? error ?? 'Inscribe did not complete' : undefined,
  }
}

export function loggedEntry({ event }: { event: ChatEvent }): ThreadEntry {
  // Older harvests kept the transport position only in nativeId.
  const legacy = /^(.*)\.(\d+)$/.exec(event.data.nativeId)
  const nativeId = event.data.messageId ?? legacy?.[1]
  const messageId = nativeId ? `${event.data.session}:${nativeId}` : undefined
  const part = event.data.part ?? (legacy ? Number(legacy[2]) : undefined)

  return {
    id: event.id,
    reference: messageReference({
      session: event.data.session,
      id: event.data.nativeId,
      messageId: nativeId,
    }),
    messageId,
    part,
    kind: event.data.kind ?? 'message',
    block: event.data.block,
    hidden: event.data.hidden,
    call: event.data.call,
    role: event.data.role,
    final: event.data.final,
    text: event.data.text,
    at: event.at,
    session: event.data.session,
  }
}

function historyMessages({ events }: { events: HydraEvent[] }): {
  seq: number
  text: string
}[] {
  const entries: ThreadEntry[] = []
  const sequences = new Map<string, number>()

  for (const event of effectiveChatEvents({ events })) {
    if (event.type === 'hydra.helper-finished') {
      for (const outcome of event.data.outcomes) {
        if (outcome.status === 'still_waiting') {
          continue
        }

        const id = `${event.id}:${outcome.task}`
        entries.push({
          id,
          kind: 'message',
          role: `helper:${outcome.task} ${outcome.status ?? outcome.audience}`,
          at: event.at,
          text: outcome.summary,
        })
        sequences.set(
          id,
          event.seq,
        )
      }

      continue
    }

    let entry: ThreadEntry

    if (event.type === 'chat.message' && event.cardId === HYDRA_CARD && event.data.role.startsWith('assistant')) {
      entry = {
        ...loggedEntry({ event }),
        role: 'Hydra',
      }
    } else if (event.type === 'hydra.message' && event.data.kind !== 'divider' && ownerActor({ actor: event.actor })) {
      entry = {
        id: event.id,
        kind: 'message',
        role: 'owner',
        at: event.at,
        text: [
          event.data.enteredText ?? event.data.text,
          event.data.details,
        ].filter(Boolean).join('\n\n'),
      }
    } else {
      const words = taskWords({ event })

      if (!words) {
        continue
      }

      entry = {
        id: event.id,
        kind: 'message',
        role: `task:${event.cardId} ${words.action}`,
        at: event.at,
        text: words.text,
      }
    }

    entries.push(entry)
    sequences.set(
      entry.messageId ?? entry.id,
      event.seq,
    )
  }

  const messages = joinMessageParts({
    entries: entries.sort((
      a,
      b,
    ) => {
      const time = (a.at ?? '').localeCompare(b.at ?? '')

      if (time) {
        return time
      }

      if (a.messageId && a.messageId === b.messageId) {
        return (a.part ?? 0) - (b.part ?? 0)
      }

      return sequences.get(a.messageId ?? a.id)! - sequences.get(b.messageId ?? b.id)!
    }),
  })

  return messages.map(entry => ({
    seq: sequences.get(entry.messageId ?? entry.id)!,
    text: `[${entry.role}] ${redact({ text: entry.text })}`,
  }))
}

export function readHistory({
  state,
  events,
  since,
  after,
  through = state.seq,
  budget = HISTORY_BUDGET,
}: {
  state: HydraState
  events: HydraEvent[]
  since: string
  after?: string
  through?: number
  budget?: number
}) {
  const validBudget = Number.isSafeInteger(budget) && budget > 0
  const validSnapshot = Number.isSafeInteger(through) && through >= 0 && through <= state.seq

  if (!validBudget || !validSnapshot) {
    throw new HydraError({
      message: '--budget must be positive and --through must name an existing log position',
      code: 'VALIDATION_ERROR',
    })
  }

  let boundary = historyBoundary({
    state,
    since,
  })
  let position = 0

  if (after !== undefined) {
    const cursor = /^h1:(\d+):(\d+):(\d+)$/.exec(after)

    if (!cursor) {
      throw new HydraError({
        message: 'Invalid history cursor; use the after value from the previous page',
        code: 'VALIDATION_ERROR',
      })
    }

    boundary = Number(cursor[1])
    through = Number(cursor[2])
    position = Number(cursor[3])

    if (![
      boundary,
      through,
      position,
    ].every(Number.isSafeInteger) || boundary > through || through > state.seq) {
      throw new HydraError({
        message: 'History cursor is outside this log',
        code: 'VALIDATION_ERROR',
      })
    }
  }

  if (boundary > through) {
    throw new HydraError({
      message: 'The history snapshot precedes its milestone',
      code: 'VALIDATION_ERROR',
    })
  }

  const messages = historyMessages({
    events: events.filter(event => event.seq <= through),
  })
    .filter(message => message.seq > boundary)
  const totalTokens = countTokens({ text: messages.map(message => message.text).join('\n\n') })

  if (position > messages.length) {
    throw new HydraError({
      message: 'History cursor is outside this snapshot',
      code: 'VALIDATION_ERROR',
    })
  }

  const pending = messages.slice(position)
  const page: typeof messages = []

  let bytes = 0
  let outputBytes = 0
  const encoder = new TextEncoder()

  for (const message of pending) {
    const separator = page.length ? 2 : 0
    const nextBytes = bytes + separator + encoder.encode(message.text).length
    const encoded = encoder.encode(JSON.stringify(message.text)).length - 2
    const nextOutput = outputBytes + separator * 2 + encoded

    if (page.length && (nextBytes > budget * 4 || nextOutput > HISTORY_PAGE_BYTES)) {
      break
    }

    page.push(message)
    bytes = nextBytes
    outputBytes = nextOutput
  }

  const text = page.map(message => message.text).join('\n\n')
  const more = page.length < pending.length
  const end = more ? page.at(-1)!.seq : through
  const cursor = `h1:${boundary}:${through}:${position + page.length}`

  return {
    since,
    boundary,
    through: end,
    snapshot: through,
    text,
    tokens: countTokens({ text }),
    budget,
    totalTokens,
    more,
    after: cursor,
    note: more
      ? 'More follows. Read the next page with --after before completing inscribe or compaction; carry forward what you learned from this page.'
      : 'End of this history snapshot.',
  }
}

// Both requested operations and native auto-compactions leave durable milestones.
export function applyHistory({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): void {
  const milestones = state.historyMilestones ?? []

  if (event.type === 'hydra.agent-change' && event.data.state === 'finished' && event.data.summary !== undefined) {
    const change = event.data
    let id = change.operation
    const active = state.hydraOperation

    // Older switch records name the owner message but carry no operation ID.
    if (!id && active?.kind === 'compaction' && active.id.startsWith(`agent-change:${change.id}:`)) {
      id = active.id
    }

    const milestone = milestones.find(item => item.id === id && item.kind === 'compaction')

    if (milestone) {
      milestone.summary = change.summary
    }
  }

  if (event.type === 'card.noted' && event.cardId === HYDRA_CARD && event.data.kind === 'summary' && event.data.operation) {
    const milestone = milestones.find(item => item.id === event.data.operation && item.kind === 'compaction')

    if (milestone) {
      milestone.summary = event.data.text
    }
  }

  let operation: HydraOperation

  if (event.type === 'hydra.operation') {
    operation = event.data
  } else if (event.type === 'session.compaction' && event.cardId === HYDRA_CARD && event.data.kind === 'status') {
    const native = event.data.operation
    operation = {
      id: native.id,
      kind: 'compaction',
      state: 'failed',
      error: native.error,
    }

    if (native.state === 'running') {
      operation.state = 'started'
    } else if (native.state === 'done') {
      operation.state = 'finished'
    }
  } else {
    return
  }

  if (operation.kind !== 'compaction' && operation.kind !== 'inscribe') {
    return
  }

  const previous = milestones.find(item => item.id === operation.id)

  if (previous && previous.state !== 'started') {
    return
  }

  const through = operation.through ?? previous?.through ?? operation.after ?? event.seq - 1
  const milestone: HistoryMilestone = {
    ...previous,
    ...operation,
    through,
    seq: event.seq,
  }
  state.historyMilestones = [
    ...milestones.filter(item => item.id !== operation.id),
    milestone,
  ]

  if (previous?.state === operation.state || operation.state === 'started') {
    return
  }

  if (operation.parent && operation.state === 'failed') {
    return
  }

  const inscribed = milestones.some(item => item.parent === operation.id
    && item.kind === 'inscribe' && item.state === 'finished')
  const label = operationLabel({
    ...operation,
    inscribed,
  })

  const dividerId = `milestone:${operation.id}`
  const combined = operation.kind === 'compaction' && operation.state === 'finished'
  const children = combined
    ? milestones.filter(item => item.parent === operation.id).map(item => `milestone:${item.id}`)
    : []
  state.hydraMessages = [
    ...(state.hydraMessages ?? []).filter(message => message.id !== dividerId
      && !children.includes(message.id)),
    {
      id: dividerId,
      action: 'send',
      kind: 'divider',
      text: label,
      at: event.at,
      actor: 'pnyx',
      hydra: state.config?.hydra.id ?? 'hydra',
    },
  ]
}
