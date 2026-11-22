import { join } from 'node:path'
import { log } from './diagnostics.ts'
import { nativeHome } from './native-home.ts'
import { nativeEvent } from './native-state.ts'
import { durableEvent } from './event-policy.ts'
import type { HydraEvent } from './model.ts'
import { heldHydra } from './store.ts'
import { readLog, type LogEntry, type LogPosition } from '#store/log.ts'
import { hydraFiles, taskFiles } from '#store/file-home.ts'

export interface EventSelection {
  hydraId: string
  cardId?: string
  cardIds?: string[]
  types?: string[]
  after?: number
  before?: number
  ids?: string[]
  seqs?: number[]
  limit?: number
  descending?: boolean
}

interface CachedLog {
  position: LogPosition
  entries: LogEntry[]
}

const homes = new WeakMap<ReturnType<typeof nativeHome>, Map<string, CachedLog>>()

function savedEvents({
  hydraId,
  cardId,
}: EventSelection): HydraEvent[] {
  const home = nativeHome()
  const logs = homes.get(home) ?? new Map<string, CachedLog>()
  homes.set(
    home,
    logs,
  )
  const view = home.files.positions({ hydra: hydraId })

  if (!view) {
    return []
  }

  if (view.issue) {
    throw view.issue
  }

  const scopes = [
    {
      foreign: false,
      scope: hydraId,
      path: join(
        hydraFiles({
          home: home.path,
          hydra: hydraId,
        }),
        'hydra.log',
      ),
      ...view,
    },
  ]

  for (const [
    task,
    scope,
  ] of view.tasks) {
    if (scope.issue) {
      if (cardId === task) {
        throw scope.issue
      }

      continue
    }

    scopes.push({
      foreign: false,
      scope: task,
      path: join(
        taskFiles({
          home: home.path,
          hydra: hydraId,
          task,
        }),
        'task.log',
      ),
      ...scope,
      tasks: new Map(),
    })
  }

  const moved = home.read({ hydra: hydraId }).state.movedOut ?? {}

  for (const task of Object.keys(moved)) {
    if (view.tasks.has(task)) {
      continue
    }

    const located = home.files.locateTask({ task })
    const scope = located && home.files.positions({ hydra: located.hydra })?.tasks.get(task)

    if (scope && !scope.issue) {
      scopes.push({
        foreign: true,
        scope: task,
        path: join(
          located!.dir,
          'task.log',
        ),
        ...scope,
        tasks: new Map(),
      })
    }
  }

  return scopes.flatMap(scope => {
    let cached = logs.get(scope.path)

    if (!cached || cached.position.bytes > scope.position.bytes) {
      cached = {
        position: {
          n: 0,
          bytes: 0,
        },
        entries: [],
      }
      logs.set(
        scope.path,
        cached,
      )
    }

    if (cached.position.bytes < scope.position.bytes) {
      const appended: LogEntry[] = []
      cached.position = readLog({
        path: scope.path,
        after: cached.position,
        through: scope.position,
        readOnly: true,
        accept: ({ entry }) => appended.push(entry),
      })

      for (const entry of appended) {
        cached.entries.push(entry)
      }
    }

    return cached.entries.flatMap(entry => {
      home.position({
        hydra: hydraId,
        id: entry.id,
        scope: scope.scope,
        seq: home.read({ hydra: hydraId }).state.eventIds[entry.id],
      })
      const event = nativeEvent({
        entry,
        ids: home.references({ hydra: hydraId }),
        scope: scope.scope,
      })

      if (!event) {
        return []
      }

      if (scope.foreign && entry.t === 'moved' && entry.from === hydraId) {
        return [
          {
            ...event,
            boardId: hydraId,
            type: 'task.moved-out',
            data: { to: entry.to },
          } as HydraEvent,
        ]
      }

      return scope.foreign && event.boardId !== hydraId ? [] : [event]
    })
  })
}

function matches({
  event,
  selection,
}: {
  event: HydraEvent
  selection: EventSelection
}): boolean {
  if (event.seq <= (selection.after ?? 0)
    || (selection.before !== undefined && event.seq >= selection.before)) {
    return false
  }

  if (selection.types && !selection.types.includes(event.type)) {
    return false
  }

  if (selection.ids && !selection.ids.includes(event.id)) {
    return false
  }

  if (selection.seqs && !selection.seqs.includes(event.seq)) {
    return false
  }

  const cards = selection.cardIds
    ?? (selection.cardId === undefined ? undefined : [selection.cardId])

  if (!cards || cards.includes(event.cardId)) {
    return true
  }

  if (event.type === 'task.session') {
    return cards.includes(event.data.before ?? '') || cards.includes(event.data.after ?? '')
  }

  return event.type === 'hydra.message' && (cards.includes(event.data.task ?? '') || cards.some(card =>
    event.data.text.includes(card) || event.data.text.includes(encodeURIComponent(card))))
}

function selected({
  events,
  selection,
}: {
  events: Iterable<HydraEvent>
  selection: EventSelection
}): HydraEvent[] {
  return [...events].filter(event => matches({
    event,
    selection,
  }))
    .sort((
      a,
      b,
    ) => selection.descending ? b.seq - a.seq : a.seq - b.seq)
    .slice(
      0,
      selection.limit,
    )
}

function readSaved({ selection }: { selection: EventSelection }): HydraEvent[] {
  const saved = new Map(savedEvents(selection).map(event => [
    event.id,
    event,
  ]))

  return selected({
    events: saved.values(),
    selection,
  })
}

export function readEvents({ ...selection }: EventSelection): HydraEvent[] {
  const started = performance.now()
  const events = readSaved({ selection })
  const ms = performance.now() - started
  log({
    operation: 'events.read',
    hydraId: selection.hydraId,
    taskId: selection.cardId,
    count: events.length,
    ms,
    detailed: ms < 100,
  })

  return events
}

export function readChanges({
  ...selection
}: EventSelection & { measured?: boolean }): HydraEvent[] {
  const live = heldHydra({ hydraId: selection.hydraId })
  const receipts = live?.state.historyMilestones
    ?.flatMap(milestone => milestone.receipts ?? []) ?? []
  const events = new Map(savedEvents(selection).map(event => [
    event.id,
    event,
  ]))

  for (const event of [
    ...live?.pending ?? [],
    ...live?.changes ?? [],
    ...receipts,
  ]) {
    events.set(
      event.id,
      event,
    )
  }

  return selected({
    events: events.values(),
    selection,
  })
}

export function* scanEvents({ ...selection }: Omit<EventSelection, 'limit'>): Generator<HydraEvent> {
  const started = performance.now()
  const events = readSaved({ selection })
  yield* events
  const ms = performance.now() - started
  log({
    operation: 'events.read',
    name: 'scan',
    hydraId: selection.hydraId,
    count: events.length,
    pages: 1,
    ms,
    detailed: ms < 100,
  })
}

export function* scanChanges({ ...selection }: Omit<EventSelection, 'limit'>): Generator<HydraEvent> {
  yield* readChanges(selection)
}

export const eventsOrLegacy = ({
  hydraId,
  types,
}: {
  hydraId: string
  types?: string[]
}): HydraEvent[] =>
  readEvents({
    hydraId,
    types,
  })

interface EventClock {
  seq: number
  at: string
  complete?: boolean
}

function clocks({ hydraId }: { hydraId: string }): EventClock[] {
  const live = heldHydra({ hydraId })
  const events = readChanges({ hydraId }).map(event => ({
    seq: event.seq,
    at: event.at,
    complete: event.type === 'session.observed' && 'fields' in event.data
      && event.data.fields.activity === 'finished',
    decision: durableEvent({ event }),
  }))
  const lastDecisionTime = events.reduce(
    (
      latest,
      event,
    ) => event.decision
      ? Math.max(
        latest,
        Date.parse(event.at),
      ) : latest,
    -Infinity,
  )
  const tail = ({ at }: { at: string }) => Date.parse(at) >= lastDecisionTime
  const observed: EventClock[] = live?.state.nativeTimes?.map(clock => ({
    ...clock,
    complete: true,
  })) ?? []

  if (live?.state.changedAt) {
    observed.push({
      seq: live.state.seq,
      at: live.state.changedAt,
    })
  }

  const decisions = events.filter(event => event.decision)
  const liveReceipts = events.filter(event => !event.decision && tail(event))

  return [
    ...decisions,
    ...liveReceipts,
    ...observed.filter(tail),
  ]
}

export function eventPositions({
  hydraId,
  entries,
}: {
  hydraId: string
  entries: {
    id: string
    at?: string
  }[]
}): Map<string, number> {
  const events = clocks({ hydraId }).sort((
    a,
    b,
  ) => Date.parse(a.at) - Date.parse(b.at)
    || a.seq - b.seq)
  const next = events.reduce(
    (
      last,
      event,
    ) => Math.max(
      last,
      event.seq,
    ),
    heldHydra({ hydraId })?.state.seq ?? 0,
  ) + 1
  const positions = new Map<string, number>()

  for (const entry of entries) {
    const time = Date.parse(entry.at ?? '')

    if (Number.isFinite(time)) {
      let low = 0
      let high = events.length

      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        const event = events[middle]!
        const at = Date.parse(event.at)

        if (at >= time) {
          high = middle
        } else {
          low = middle + 1
        }
      }

      while (low < events.length) {
        const event = events[low]!

        if (Date.parse(event.at) > time || event.complete) {
          break
        }

        low++
      }

      positions.set(
        entry.id,
        events[low]?.seq ?? next,
      )
    }
  }

  return positions
}

export function eventTime({
  hydraId,
  seq,
  exact = false,
}: {
  hydraId: string
  seq: number
  exact?: boolean
}): string | undefined {
  if (exact) {
    const retained = readChanges({
      hydraId,
      seqs: [seq],
    })[0]

    if (retained) {
      return retained.at
    }
  }

  const found = clocks({ hydraId }).filter(clock => exact ? clock.seq === seq : clock.seq <= seq)
    .sort((
      a,
      b,
    ) => {
      if (exact) {
        return b.seq - a.seq
      }

      return b.at.localeCompare(a.at) || Number(Boolean(b.complete)) - Number(Boolean(a.complete))
    })[0]

  if (!found || exact || !found.complete) {
    return found?.at
  }

  const exclusiveEnd = Date.parse(found.at) + 1

  return new Date(exclusiveEnd).toISOString()
}

export function seqsAround({
  hydraId,
  time,
}: {
  hydraId: string
  time: number
}): {
  first: number
  last: number
} {
  const events = clocks({ hydraId })

  return {
    first: events.reduce(
      (
        first,
        event,
      ) => Date.parse(event.at) >= time - 1000 ? Math.min(
        first,
        event.seq,
      ) : first,
      Infinity,
    ),
    last: events.reduce(
      (
        last,
        event,
      ) => Date.parse(event.at) <= time + 1000 ? Math.max(
        last,
        event.seq,
      ) : last,
      0,
    ),
  }
}

export const eventSeq = ({
  hydraId,
  id,
}: {
  hydraId: string
  id: string
}): number | undefined =>
  nativeHome().read({ hydra: hydraId }).state.eventIds[id]

export const replySeq = ({
  hydraId,
  card,
  reply,
}: {
  hydraId: string
  card: string
  reply: string
}): number | undefined =>
  readEvents({
    hydraId,
    cardId: card,
    types: ['card.replied'],
  }).find(event =>
    event.type === 'card.replied' && event.data.reply === reply)?.seq
