import { isDeepStrictEqual } from 'node:util'
import type { TitanEvent, TitanState } from './model.ts'
import { emptyTitan } from './reducer.ts'
import { recordEventId } from './command-meta.ts'
import { projectSession } from '#workers/session-attachments.ts'
import { applyHistory } from '#titan/history.ts'
import { applyTitan } from '#titan/reduce.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import type { Card } from '#tasks/model.ts'
import type { AgentSession } from '#workers/model.ts'
import { TitanError } from '#store/errors.ts'
import { plainJson, type LogEntry, type LogFact } from '#store/log.ts'
import type { Output } from './cli-support.ts'

interface Inscription {
  id: string
  at: string
  actor: string
  seq: number
  acknowledged: number
  key: string
  phase: 'started' | 'finished' | 'failed'
  throughSeq?: number
  afterSeq?: number
  since?: string
  parent?: string
  blocking?: false
  error?: string
  notices?: TitanEvent['notices']
}

type TitanFields = Omit<TitanState, 'cards' | 'sessions' | 'keys' | 'eventIds' | 'undone' | 'seq' | 'movedOut'>

export interface NativeState {
  fields?: Partial<TitanFields>
  card?: Card
  sessions?: Record<string, AgentSession>
  undone?: Record<string, string>
  moves?: {
    id: string
    n: number
    at: string
    from: string
    to: string
    key?: string
  }[]
  inscriptions?: Inscription[]
  receipts?: Record<string, {
    digest: string
    value: Output
  }>
}

export interface NativeChange {
  path: string[]
  value?: unknown
  remove?: true
  splice?: {
    at: number
    remove: number
    values: unknown[]
  }
}

export interface NativeFact extends LogFact {
  inscribe?: Omit<Inscription, 'id' | 'at'>
  event?: Omit<TitanEvent, 'seq' | 'id' | 'at'>
  change?: NativeChange[]
  receipt?: {
    id: string
    digest: string
    value: Output
  }
}

const METADATA = new Set([
  'cards',
  'sessions',
  'keys',
  'eventIds',
  'undone',
  'seq',
  'movedOut',
  'changedAt',
  'nativeTimes',
])
const MAX_PATH_DEPTH = 128

function record({ value }: { value: unknown }): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function ownValue({
  value,
  key,
}: {
  value: Record<string, unknown>
  key: string
}): unknown {
  return Object.hasOwn(
    value,
    key,
  ) ? value[key] : undefined
}

export function nativeChanges({
  before,
  after,
  path = [],
}: {
  before: unknown
  after: unknown
  path?: string[]
}): NativeChange[] {
  if (Object.is(
    before,
    after,
  ) || (Array.isArray(before) && Array.isArray(after) && isDeepStrictEqual(
    before,
    after,
  ))) {
    return []
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    let start = 0
    let end = 0

    while (start < before.length && start < after.length && isDeepStrictEqual(
      before[start],
      after[start],
    )) {
      start++
    }

    while (end < before.length - start && end < after.length - start
      && isDeepStrictEqual(
        before[before.length - end - 1],
        after[after.length - end - 1],
      )) {
      end++
    }

    return [
      {
        path,
        splice: {
          at: start,
          remove: before.length - start - end,
          values: plainJson({
            value: after.slice(
              start,
              after.length - end,
            ),
          }),
        },
      },
    ]
  }

  const left = record({ value: before })
  const right = record({ value: after })

  if (left && right) {
    return [
      ...new Set([
        ...Object.keys(left),
        ...Object.keys(right),
      ]),
    ].flatMap(key => nativeChanges({
      before: ownValue({
        value: left,
        key,
      }),
      after: ownValue({
        value: right,
        key,
      }),
      path: [
        ...path,
        key,
      ],
    }))
  }

  if (after === undefined) {
    return [
      {
        path,
        remove: true,
      },
    ]
  }

  return [
    {
      path,
      value: plainJson({ value: after }),
    },
  ]
}

function reconcileNative({
  before,
  after,
  basis,
}: {
  before: unknown
  after: unknown
  basis: unknown
}): unknown {
  if (isDeepStrictEqual(
    before,
    after,
  )) {
    return basis
  }

  if (basis === undefined) {
    return structuredClone(after)
  }

  const left = record({ value: before })
  const right = record({ value: after })
  const saved = record({ value: basis })

  if (left && right && saved) {
    const next = { ...saved }

    for (const key of new Set([
      ...Object.keys(left),
      ...Object.keys(right),
    ])) {
      const beforeValue = ownValue({
        value: left,
        key,
      })
      const afterValue = ownValue({
        value: right,
        key,
      })

      if (isDeepStrictEqual(
        beforeValue,
        afterValue,
      )) {
        continue
      }

      if (afterValue === undefined) {
        delete next[key]
      } else {
        define({
          target: next,
          key,
          value: reconcileNative({
            before: beforeValue,
            after: afterValue,
            basis: ownValue({
              value: saved,
              key,
            }),
          }),
        })
      }
    }

    return next
  }

  if (Array.isArray(before) && Array.isArray(after) && Array.isArray(basis)) {
    const identified = ({ values }: { values: unknown[] }): boolean => values.every(value => typeof record({ value })?.id === 'string')

    if ([
      before,
      after,
      basis,
    ].every(values => identified({ values }))) {
      const key = ({ value }: { value: unknown }): string => record({ value })!.id as string
      const prior = new Map(before.map(value => [
        key({ value }),
        value,
      ]))
      const cached = new Map(basis.map(value => [
        key({ value }),
        value,
      ]))
      const wanted = new Set(after.map(value => key({ value })))
      const retained = basis.filter(value => {
        const id = key({ value })

        return !prior.has(id) && !wanted.has(id)
      })
      const changed = after.flatMap(value => {
        const previous = prior.get(key({ value }))
        const existing = cached.get(key({ value }))

        if (existing === undefined && isDeepStrictEqual(
          previous,
          value,
        )) {
          return []
        }

        return [
          reconcileNative({
            before: previous,
            after: value,
            basis: existing,
          }),
        ]
      })

      return [
        ...retained,
        ...changed,
      ]
    }
  }

  return structuredClone(after)
}

function nativeDecisionChanges({
  before,
  after,
  basis,
}: {
  before: NativeState
  after: NativeState
  basis: NativeState
}): NativeChange[] {
  return nativeChanges({
    before: basis,
    after: reconcileNative({
      before,
      after,
      basis,
    }),
  })
}

function define({
  target,
  key,
  value,
}: {
  target: Record<string, unknown>
  key: string
  value: unknown
}): void {
  Object.defineProperty(
    target,
    key,
    {
      value,
      configurable: true,
      enumerable: true,
      writable: true,
    },
  )
}

export function reduceNative({
  state = {},
  entry,
}: {
  state?: NativeState
  entry: LogEntry
  id: string
}): NativeState {
  const fact = entry as NativeFact & { n: number }
  let next = state as Record<string, unknown>

  if (fact.change !== undefined && !Array.isArray(fact.change)) {
    throw new TitanError({
      code: 'INVALID_EVENT',
      message: 'native changes must be an array',
    })
  }

  for (const change of fact.change ?? []) {
    if (!change || !Array.isArray(change.path) || change.path.length > MAX_PATH_DEPTH
      || change.path.some(key => typeof key !== 'string')) {
      throw new TitanError({
        code: 'INVALID_EVENT',
        message: 'invalid native change path',
      })
    }

    if (!change.path.length) {
      const replacement = record({ value: change.value })

      if (!replacement || change.remove) {
        throw new TitanError({
          code: 'INVALID_EVENT',
          message: 'native state must be an object',
        })
      }

      next = structuredClone(replacement)
      continue
    }

    let parent = next

    for (const key of change.path.slice(
      0,
      -1,
    )) {
      const current = Object.hasOwn(
        parent,
        key,
      ) ? parent[key] : undefined

      if (!record({ value: current })) {
        define({
          target: parent,
          key,
          value: {},
        })
      }

      parent = parent[key] as Record<string, unknown>
    }

    const key = change.path.at(-1)!

    if (change.splice) {
      const array = parent[key]
      const splice = change.splice

      if (!Array.isArray(array) || !Number.isInteger(splice.at) || !Number.isInteger(splice.remove)
        || splice.at < 0 || splice.remove < 0 || splice.at + splice.remove > array.length
        || !Array.isArray(splice.values)) {
        throw new TitanError({
          code: 'INVALID_EVENT',
          message: 'invalid native array change',
        })
      }

      array.splice(
        splice.at,
        splice.remove,
        ...structuredClone(splice.values),
      )
      continue
    }

    if (change.remove) {
      delete parent[key]
    } else {
      define({
        target: parent,
        key,
        value: structuredClone(change.value),
      })
    }
  }

  const value = next as NativeState

  if (fact.inscribe) {
    if (typeof fact.inscribe.key !== 'string'
      || ![
        'started',
        'finished',
        'failed',
      ].includes(fact.inscribe.phase)
      || !Number.isSafeInteger(fact.inscribe.acknowledged) || fact.inscribe.acknowledged < 1) {
      throw new TitanError({
        code: 'INVALID_EVENT',
        message: 'invalid native inscribe decision',
      })
    }

    value.inscriptions = [
      ...value.inscriptions ?? [],
      {
        id: fact.id,
        at: fact.at,
        ...fact.inscribe,
      },
    ]
  }

  if (fact.event?.undoes) {
    value.undone ??= {}
    define({
      target: value.undone,
      key: fact.event.undoes,
      value: fact.id,
    })
  }

  if (fact.receipt) {
    if (typeof fact.receipt.id !== 'string' || typeof fact.receipt.digest !== 'string'
      || !record({ value: fact.receipt.value })) {
      throw new TitanError({
        code: 'INVALID_EVENT',
        message: 'invalid native command receipt',
      })
    }

    value.receipts ??= {}
    define({
      target: value.receipts,
      key: fact.receipt.id,
      value: {
        digest: fact.receipt.digest,
        value: fact.receipt.value,
      },
    })
  }

  if (fact.t === 'moved') {
    if (typeof fact.from !== 'string' || typeof fact.to !== 'string') {
      throw new TitanError({
        code: 'INVALID_EVENT',
        message: 'native move needs both Titans',
      })
    }

    const move: NonNullable<NativeState['moves']>[number] = {
      id: fact.id,
      n: entry.n,
      at: fact.at,
      from: fact.from,
      to: fact.to,
    }

    if (typeof fact.key === 'string') {
      move.key = fact.key
    }

    value.moves = [
      ...value.moves ?? [],
      move,
    ]
  }

  return value
}

export const nativeId = ({
  scope,
  id,
}: {
  scope: string
  id: string
}): string => `${scope}\0${id}`

const STATE_FIELDS = new Set([
  'fields',
  'card',
  'sessions',
  'undone',
  'moves',
  'inscriptions',
  'receipts',
])
const SEQUENCE_FIELDS = new Set([
  'seq',
  'createdSeq',
  'updatedSeq',
  'turnEndedSeq',
  'turnFinishedSeq',
  'throughSeq',
  'afterSeq',
  'finishedThrough',
  'steeringGeneration',
  'stateSeq',
])
const GENERATION_PARENTS = new Set([
  'claim',
  'queuedFor',
])
const THROUGH_PARENTS = new Set([
  'data',
  'historyMilestones',
  'hydraOperation',
  'hydraAgentChange',
  'receipt',
  'value',
])
const AFTER_PARENTS = new Set([
  'historyMilestones',
  'hydraContext',
  'hydraStatus',
  'hydraOperation',
  'hydraAgentChange',
])

export function nativeReferences({
  value,
  ids,
  restore = false,
  references = true,
  kind = 'state',
}: {
  value: unknown
  ids: ReadonlyMap<string, number>
  restore?: boolean
  references?: boolean
  kind?: 'state' | 'card' | 'event' | 'inscribe' | 'receipt'
}): unknown {
  const convert = ({
    value,
    path = [],
    owner,
    enabled = references,
  }: {
    value: unknown
    path?: string[]
    owner?: Record<string, unknown>
    enabled?: boolean
  }): unknown => {
    const key = path.at(-1) ?? ''
    const parent = path.at(-2) ?? ''
    const unknownRoot = kind === 'state' && path.length === 1 && !STATE_FIELDS.has(key)
    const permissionPayload = (key === 'input' || key === 'values') && typeof owner?.tool === 'string'
      && typeof owner.session === 'string' && typeof owner.status === 'string'
    const internal = enabled && !unknownRoot && !permissionPayload
    const fields = record({ value })
    const sequence = SEQUENCE_FIELDS.has(key) || (key === 'generation' && GENERATION_PARENTS.has(parent))
      || (key === 'through' && THROUGH_PARENTS.has(parent))
      || (key === 'after' && (AFTER_PARENTS.has(parent)
        || (kind === 'event' && path.length === 2 && parent === 'data'
          && owner?.kind === 'compaction' && typeof owner.id === 'string')))

    if (restore && internal && (sequence || key === 'through' || key === 'after')
      && typeof fields?.native === 'string' && Object.keys(fields).length === 1) {
      return ids.get(fields.native) ?? 0
    }

    if (!restore && internal && sequence && typeof value === 'number' && value > 0) {
      const found = [...ids].findLast(([
        , seq,
      ]) => seq === value)

      return found ? { native: found[0] } : 0
    }

    if (Array.isArray(value)) {
      return value.map(item => convert({
        value: item,
        path,
        enabled: internal,
      }))
    }

    const prototype = fields && Object.getPrototypeOf(fields)
    const plain = prototype === Object.prototype || prototype === null

    if (fields && (!plain || Object.getOwnPropertySymbols(fields).length > 0)) {
      throw new TitanError({
        code: 'INVALID_EVENT',
        message: 'native decision values must be plain objects',
      })
    }

    return fields ? Object.fromEntries(Object.entries(fields).filter(([
      , item,
    ]) => item !== undefined)
      .map(([
        field,
        item,
      ]) => [
        field,
        convert({
          value: item,
          path: [
            ...path,
            field,
          ],
          owner: fields,
          enabled: internal,
        }),
      ])) : value
  }

  return convert({ value })
}

export const nativeJson = <Value>({ value }: { value: Value }): Value => plainJson({
  value: nativeReferences({
    value,
    ids: new Map(),
    references: false,
  }) as Value,
})

export function projectNative({
  state,
  task,
  ids = new Map(Object.entries(state.eventIds)),
}: {
  state: TitanState
  task?: string
  ids?: ReadonlyMap<string, number>
}): NativeState {
  const card = state.cards[task ?? TITAN_CARD]
  const sessions = Object.fromEntries(Object.entries(state.sessions ?? {}).filter(([
    , session,
  ]) => {
    const owner = session.taskId ?? session.originCardId

    return task === undefined ? owner === TITAN_CARD || !state.cards[owner] : owner === task
  }))
  const projected: NativeState = { sessions }

  if (card) {
    projected.card = card
  }

  if (task === undefined) {
    const fields = Object.entries(state).filter(([key]) => !METADATA.has(key))
    projected.fields = Object.fromEntries(fields)
  }

  return nativeReferences({
    value: projected,
    ids,
  }) as NativeState
}

function factType({ event }: { event: TitanEvent }): string {
  switch (event.type) {
    case 'task.created': return 'created'
    case 'task.brief': return 'brief'
    case 'task.session':
    case 'task.launched': return 'agent'
    case 'card.replied':
    case 'hydra.message': return 'say'
    case 'task.worker-line': return 'worker'
    case 'card.linked': return 'link'
    case 'card.outcome': return 'outcome'
    case 'task.held': return 'hold'
    case 'task.released': return 'release'
    case 'task.queue': return 'queue'
    case 'board.configured': return 'config'
    case 'hydra.project': return 'project'
    case 'hydra.memory': return 'memory'
    case 'board.view': return 'layout'
    default: return event.type.replace(
      /^(task|card|hydra)\./,
      '',
    )
  }
}

function author({ actor }: { actor: string }): LogFact['by'] {
  if (actor.startsWith('worker:')) {
    return 'worker'
  }

  if (actor === 'hydra') {
    return 'hydra'
  }

  return actor === 'owner' || actor === 'cli' || actor === 'web' ? 'owner' : 'daemon'
}

export function nativeInscribe({
  event,
  ids,
  basis,
  beforeSeq,
}: {
  event: Extract<TitanEvent, { type: 'hydra.operation' }>
  ids: ReadonlyMap<string, number>
  basis: NativeState
  beforeSeq: number
}): NativeFact {
  const previous = basis.inscriptions?.findLast(item => item.key === event.data.id)
  const boundary = event.data.through === beforeSeq ? event.seq : event.data.through

  return {
    t: 'memory',
    id: event.id,
    at: event.at,
    by: author({ actor: event.actor }),
    inscribe: nativeReferences({
      kind: 'inscribe',
      ids,
      value: {
        actor: event.actor,
        seq: event.seq,
        acknowledged: event.seq,
        key: event.data.id,
        phase: event.data.state,
        throughSeq: previous?.throughSeq ?? boundary,
        afterSeq: event.data.after ?? previous?.afterSeq,
        since: event.data.historySince ?? previous?.since,
        parent: event.data.parent ?? previous?.parent,
        blocking: event.data.blocking ?? previous?.blocking,
        error: event.data.error,
        notices: event.notices,
      },
    }) as NativeFact['inscribe'],
  }
}

export function nativeSessionSource({
  session,
  previous,
  event,
}: {
  session: AgentSession
  previous?: AgentSession
  event: TitanEvent
}): NativeFact | undefined {
  const agent = nativeJson({ value: session.agent })

  if (agent.host === 'pnyx' || !agent.transcriptPath || isDeepStrictEqual(
    previous?.agent,
    agent,
  )) {
    return undefined
  }

  const saved: AgentSession = previous ? {
    ...previous,
    agent,
  } : {
    id: session.id,
    agent,
    originCardId: session.originCardId,
    taskId: session.taskId,
    attention: [],
    sourceRefs: [],
    launch: {
      via: 'hooks',
      at: event.at,
      folder: agent.cwd,
      harness: agent.provider,
    },
  }

  return {
    t: 'config',
    id: `native-source:${event.id}:${session.id}`,
    at: event.at,
    by: author({ actor: event.actor }),
    change: nativeChanges({
      before: previous,
      after: nativeJson({ value: saved }),
      path: [
        'sessions',
        session.id,
      ],
    }),
  }
}

export function nativeDecision({
  event,
  ids,
}: {
  event: TitanEvent
  ids: ReadonlyMap<string, number>
}): NativeFact['event'] {
  const decision = Object.fromEntries(Object.entries(event).filter(([key]) => ![
    'seq',
    'id',
    'at',
  ].includes(key)))

  return nativeReferences({
    kind: 'event',
    value: decision,
    ids,
  }) as NativeFact['event']
}

export function nativeFact({
  event,
  before,
  after,
  task,
  ids,
  basis,
}: {
  event: TitanEvent
  before: TitanState
  after: TitanState
  task?: string
  ids?: ReadonlyMap<string, number>
  basis?: NativeState
}): NativeFact {
  const fact: NativeFact = {
    at: event.at,
    by: author({ actor: event.actor }),
    t: factType({ event }),
    id: event.id,
    event: nativeDecision({
      event,
      ids: ids ?? new Map(Object.entries(after.eventIds)),
    }),
    change: nativeDecisionChanges({
      before: projectNative({
        state: before,
        task,
        ids,
      }),
      after: projectNative({
        state: after,
        task,
        ids,
      }),
      basis: basis ?? projectNative({
        state: before,
        task,
        ids,
      }),
    }),
  }

  if ((event.type === 'card.replied' || event.type === 'hydra.message') && event.data.text !== undefined) {
    fact.text = event.data.text
  } else if (event.type === 'task.brief') {
    fact.text = event.data.after
  } else if (event.type === 'task.worker-line') {
    Object.assign(
      fact,
      nativeJson({ value: event.data }),
    )
  } else if (event.type === 'task.created') {
    Object.assign(
      fact,
      nativeJson({ value: event.data }),
    )
  }

  return fact
}

export function nativeEvent({
  entry,
  ids,
  scope,
}: {
  entry: LogEntry
  ids: ReadonlyMap<string, number>
  scope: string
}): TitanEvent | undefined {
  const fact = entry as NativeFact

  return fact.event ? {
    ...nativeReferences({
      kind: 'event',
      value: fact.event,
      ids,
      restore: true,
    }) as TitanEvent,
    id: entry.id,
    at: entry.at,
    seq: ids.get(nativeId({
      scope,
      id: entry.id,
    })) ?? 0,
  } : undefined
}

export function assembleNative({
  hydra,
  tasks,
  positions = new Map(),
}: {
  hydra?: NativeState
  tasks: Iterable<[string, NativeState]>
  positions?: ReadonlyMap<string, number>
}): TitanState {
  const state = {
    ...emptyTitan(),
    ...hydra?.fields,
  }

  if (hydra?.card) {
    state.cards[TITAN_CARD] = hydra.card
  }

  state.sessions = { ...hydra?.sessions }
  state.undone = { ...hydra?.undone }

  for (const inscription of hydra?.inscriptions ?? []) {
    const event: Extract<TitanEvent, { type: 'hydra.operation' }> = {
      v: 1,
      id: inscription.id,
      seq: inscription.seq,
      at: inscription.at,
      actor: inscription.actor,
      cardId: TITAN_CARD,
      type: 'hydra.operation',
      data: {
        id: inscription.key,
        kind: 'inscribe',
        state: inscription.phase,
        through: inscription.throughSeq,
        after: inscription.afterSeq,
        historySince: inscription.since,
        parent: inscription.parent,
        blocking: inscription.blocking,
        error: inscription.error,
      },
      notices: inscription.notices,
    }
    applyHistory({
      state,
      event,
    })
    applyTitan({
      state,
      event,
    })
    const milestone = state.historyMilestones?.find(item => item.id === inscription.key)
    const receipt = milestone?.receipts?.at(-1)

    if (receipt?.id === inscription.id) {
      receipt.seq = inscription.acknowledged
    }
  }

  for (const [
    id,
    value,
  ] of tasks) {
    if (value.card) {
      state.cards[id] = value.card
      define({
        target: state.keys,
        key: value.card.key,
        value: id,
      })
      state.seq = Math.max(
        state.seq,
        value.card.updatedSeq,
      )
    }

    Object.assign(
      state.sessions,
      value.sessions,
    )
    Object.assign(
      state.undone,
      value.undone,
    )
  }

  for (const session of Object.values(state.sessions)) {
    projectSession({
      state,
      session,
    })
  }

  for (const [
    key,
    seq,
  ] of positions) {
    recordEventId({
      state,
      id: key.slice(key.indexOf('\0') + 1),
      seq,
    })
    state.seq = Math.max(
      state.seq,
      seq,
    )
  }

  return state
}
