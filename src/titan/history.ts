import { inform } from '#app/command-notices.ts'
import type { TitanEvent, TitanState } from '#app/model.ts'
import { TitanError } from '#store/errors.ts'
import type { TitanOperation } from './model.ts'
import type { ThreadEntry } from './transcripts-read.ts'
import { TITAN_CARD } from './identity.ts'
import { operationLabel } from './operation-label.ts'

export const HISTORY_BUDGET = 6000

export interface HistoryMilestone extends TitanOperation {
  receipts?: Extract<TitanEvent, { type: 'hydra.operation' }>[]
  seq: number
  through: number
  summary?: string
}

function lastMilestone({
  state,
  kind,
}: {
  state: TitanState
  kind: 'compaction' | 'inscribe'
}): HistoryMilestone | undefined {
  return state.historyMilestones?.filter(item => item.kind === kind && item.state === 'finished')
    .toSorted((
      a,
      b,
    ) => kind === 'compaction' ? a.seq - b.seq : a.through - b.through)
    .at(-1)
}

export function compactionContext({ state }: { state: TitanState }): {
  summary?: string
} {
  const milestone = lastMilestone({
    state,
    kind: 'compaction',
  })

  return {
    summary: milestone ? milestone.summary : state.hydraContext?.summary,
  }
}

function inscribeSince({ state }: { state: TitanState }): string {
  return lastMilestone({
    state,
    kind: 'inscribe',
  })?.id ?? lastMilestone({
    state,
    kind: 'compaction',
  })?.id ?? 'origin'
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

export function inscribeOperation({
  state,
  id,
  action,
  through,
  error,
}: {
  state: TitanState
  id: string
  action?: string
  through?: number
  error?: string
}): TitanOperation {
  if (action !== 'start' && action !== 'finish' && action !== 'fail') {
    throw new TitanError({
      message: 'Use hydra inscribe start|finish|fail [--key <milestone-id>]',
      code: 'VALIDATION_ERROR',
    })
  }

  if (!/^[a-zA-Z0-9:_.-]+$/.test(id)) {
    throw new TitanError({
      message: 'Use letters, numbers, dots, colons, hyphens or underscores for a milestone ID',
      code: 'VALIDATION_ERROR',
    })
  }

  const invalidThrough = through !== undefined
    && (!Number.isSafeInteger(through) || through < 0 || through > state.seq)

  if (invalidThrough) {
    throw new TitanError({
      message: '--through must name an existing log position',
      code: 'VALIDATION_ERROR',
    })
  }

  const previous = state.historyMilestones?.find(item => item.id === id)

  if ((previous && previous.kind !== 'inscribe') || (action !== 'start' && !previous)) {
    throw new TitanError({
      message: 'No inscribe pass has started with that ID',
      code: 'VALIDATION_ERROR',
    })
  }

  const active = state.historyMilestones?.findLast(item => item.kind === 'inscribe' && item.state === 'started')

  if (action === 'start' && active && active.id !== id) {
    inform({
      reason: `Inscribe pass ${active.id} is still open; started another pass`,
      clear: `Review the unfinished inscribe pass ${active.id} before saving another summary.`,
    })
  }

  let nextState: TitanOperation['state'] = 'started'

  if (action === 'finish') {
    nextState = 'finished'
  } else if (action === 'fail') {
    nextState = 'failed'
  }

  if (previous && previous.state !== 'started' && previous.state !== nextState) {
    throw new TitanError({
      message: 'This inscribe pass has already ended; start a new pass',
      code: 'VALIDATION_ERROR',
    })
  }

  if (action === 'finish' && through !== previous?.through) {
    inform({
      reason: 'Inscribe finished without confirming its history snapshot',
      clear: `Read pass ${id} in hydra.log: its inscribe.since and inscribe.throughSeq are the saved bounds. Resolve each reference in its file scope before reading recorded transcripts.`,
    })
  }

  const snapshot = previous?.through ?? through ?? state.seq

  if (!Number.isSafeInteger(snapshot) || snapshot < 0 || snapshot > state.seq) {
    throw new TitanError({
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

// Entries of different sessions can share an id, so a session's entry is known by both.
export const positionKey = ({ entry }: { entry: ThreadEntry }) => `${entry.session ?? ''}\n${entry.id}`

// A native entry has a time but no log position: it takes the seq of the first event after its time, so milestones and
// snapshots bound it like the events around it. An entry newer than the log takes the next seq, outside every snapshot
// taken before it, and entries between two events share one seq.
export function placeEntries<Entry extends ThreadEntry>({
  entries,
  positions,
}: {
  positions: ReadonlyMap<string, number>
  entries: Entry[]
}): {
  seq: number
  entry: Entry
}[] {
  return entries.flatMap(entry => {
    const seq = positions.get(positionKey({ entry }))

    return seq === undefined ? [] : [
      {
        entry,
        seq,
      },
    ]
  })
}

// Both requested operations and native auto-compactions leave durable milestones.
export function applyHistory({
  state,
  event,
}: {
  state: TitanState
  event: TitanEvent
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

  if (event.type === 'card.noted' && event.cardId === TITAN_CARD && event.data.kind === 'summary' && event.data.operation) {
    const milestone = milestones.find(item => item.id === event.data.operation && item.kind === 'compaction')

    if (milestone) {
      milestone.summary = event.data.text
    }
  }

  let operation: TitanOperation

  if (event.type === 'hydra.operation') {
    operation = event.data
  } else if (event.type === 'session.compaction' && event.cardId === TITAN_CARD && event.data.kind === 'status') {
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

  const boundary = event.type === 'session.compaction' ? event.seq : event.seq - 1
  const through = operation.through ?? previous?.through ?? operation.after ?? boundary
  const milestone: HistoryMilestone = {
    ...previous,
    ...operation,
    through,
    seq: event.seq,
  }

  if (event.type === 'hydra.operation' && operation.kind === 'inscribe') {
    milestone.receipts = [
      ...previous?.receipts ?? [],
      structuredClone(event),
    ]
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
