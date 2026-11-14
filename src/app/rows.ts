import { hash } from 'node:crypto'
import { restoreObservations, sourceFacts, sessionFacts, type ObservationRow } from '#tasks/observations.ts'
import type { HydraEvent, HydraState } from './model.ts'
import type { Ask, Card, NoteRef, TaskDeclaration } from '#tasks/model.ts'
import type { Link } from '#tasks/delivery/model.ts'
import type { HydraConfig, HydraMessage } from '#hydra/model.ts'
import type { HydraColumn } from '#tasks/columns-model.ts'
import type { AgentSession, Reply } from '#workers/model.ts'
import type { Statement } from '#store/postgres.ts'
import { EVENT_VERSION } from '#store/events.ts'
import { HydraError } from '#store/errors.ts'
import { unmetPrerequisites } from '#tasks/dependencies.ts'
import { canonicalMergeQuestion } from '#tasks/delivery/merge-questions.ts'
import { agentActivity } from '#workers/activity.ts'
import type { Touched } from './preimage.ts'
import { summarize } from './hydra-summary.ts'
import { LIST_LIMIT } from '#store/zero-schema.ts'
import { updateTasks } from '#tasks/updates.ts'

// Bounded serialization keeps a legacy log below V8's single-string ceiling.
const EVENT_BATCH_SIZE = 500

type Row = Record<string, unknown>

// Each table's primary key, in the order rows are written; deletes run in reverse.
const TABLES = {
  hydras: ['id'],
  hydra_values: [
    'hydra_id',
    'key',
  ],
  columns: [
    'hydra_id',
    'id',
  ],
  cards: [
    'hydra_id',
    'id',
  ],
  card_bodies: [
    'hydra_id',
    'card_id',
  ],
  card_private: [
    'hydra_id',
    'card_id',
  ],
  card_references: [
    'hydra_id',
    'card_id',
  ],
  replies: [
    'hydra_id',
    'card_id',
    'id',
  ],
  questions: [
    'hydra_id',
    'card_id',
    'id',
  ],
  declarations: [
    'hydra_id',
    'card_id',
    'id',
  ],
  links: [
    'hydra_id',
    'card_id',
    'url',
  ],
  notes: [
    'hydra_id',
    'card_id',
    'id',
  ],
  messages: [
    'hydra_id',
    'id',
  ],
  sessions: [
    'hydra_id',
    'id',
  ],
} as const

type Table = keyof typeof TABLES

// Card arrays held as rows of their own table, and the fields the page never reads.
const CARD_LISTS = [
  'asks',
  'statusLog',
  'notes',
  'links',
  'replies',
] as const
const PRIVATE_FIELDS = [
  'steering',
  'externalSources',
] as const
// What a hidden task's reference leaves out: histories, texts and worker setup. It keeps what chips, prerequisites,
// waits and answer leads read.
const UNREFERENCED = [
  ...PRIVATE_FIELDS,
  'statusLog',
  'notes',
  'replies',
  'brief',
  'initialPrompt',
  'intent',
  'progress',
  'projectRefresh',
  'launch',
  'settings',
  'copy',
] as const satisfies readonly (keyof Card)[]

// HydraState fields with a table of their own, or derived on load.
const STRUCTURED = new Set<string>([
  'v',
  'seq',
  'cards',
  'keys',
  'eventIds',
  'sessions',
  'hydraMessages',
  'config',
])

// The rows last committed for one Hydra, as JSON, so a write sends only what changed. A row names the group it is
// rebuilt with, so a write that rebuilds only some groups keeps the others' rows.
// What the server keeps of each row it saved: a digest of its JSON, enough to tell whether a write changes it, so the
// saved rows are not a second copy of the state.
export type SavedRows = Map<string, {
  digest: string
  group?: string
}>

export const emptySaved = (): SavedRows => new Map()

const rowKey = ({
  table,
  row,
}: {
  table: Table
  row: Row
}) => [
  table,
  ...TABLES[table].map(column => String(row[column])),
].join('\u0000')

const nullable = ({ value }: { value: unknown }) => value === undefined ? null : value

function cardRows({
  hydraId,
  card,
}: {
  hydraId: string
  card: Card
}): Partial<Record<Table, Row[]>> {
  const data: Record<string, unknown> = { ...card }
  const hidden: Record<string, unknown> = {}

  // An empty list stays in the body, so a reload tells an empty list from a missing one.
  for (const list of CARD_LISTS) {
    if (card[list]?.length) {
      delete data[list]
    }
  }

  for (const field of PRIVATE_FIELDS) {
    if (card[field] !== undefined) {
      hidden[field] = card[field]
      delete data[field]
    }
  }

  return {
    card_bodies: [
      {
        hydra_id: hydraId,
        card_id: card.id,
        data,
      },
    ],
    card_references: [
      {
        hydra_id: hydraId,
        card_id: card.id,
        data: cardReference({ card }),
      },
    ],
    replies: (card.replies ?? []).map((
      reply,
      position,
    ) => ({
      hydra_id: hydraId,
      card_id: card.id,
      id: reply.id,
      position,
      answers: nullable({ value: reply.answers }),
      data: reply,
    })),
    card_private: Object.keys(hidden).length ? [
      {
        hydra_id: hydraId,
        card_id: card.id,
        data: hidden,
      },
    ] : [],
    questions: (card.asks ?? []).map((
      ask,
      position,
    ) => ({
      hydra_id: hydraId,
      card_id: card.id,
      id: ask.id,
      position,
      audience: ask.audience,
      question: ask.question,
      asked_at: ask.at,
      actor: ask.actor,
      answered: nullable({ value: ask.answered }),
      answered_at: nullable({ value: ask.answeredAt }),
      closed: ask.closed !== undefined,
      data: ask,
    })),
    declarations: (card.statusLog ?? []).map((
      declaration,
      position,
    ) => ({
      hydra_id: hydraId,
      card_id: card.id,
      id: declaration.id,
      position,
      state: declaration.state,
      note: declaration.note,
      at: declaration.at,
      actor: declaration.actor,
      until: nullable({ value: declaration.until }),
      data: declaration,
    })),
    notes: (card.notes ?? []).map((
      note,
      position,
    ) => ({
      hydra_id: hydraId,
      card_id: card.id,
      id: note.id,
      position,
      kind: note.kind,
      source: note.source,
      at: nullable({ value: note.at }),
    })),
  }
}

// The cards row carries the facts that read other cards, so it is rebuilt for every card on each write.
function cardSummary({
  hydraId,
  state,
  card,
  working,
}: {
  hydraId: string
  state: HydraState
  card: Card
  working: Set<string>
}): Row {
  const agent = card.agent

  return {
    hydra_id: hydraId,
    id: card.id,
    key: card.key,
    title: card.title,
    column_id: card.column,
    rank: nullable({ value: card.rank }),
    parent_id: nullable({ value: card.parentId }),
    project: nullable({ value: card.project }),
    kind: nullable({ value: card.kind }),
    status: nullable({ value: card.status?.state }),
    hidden: card.hidden === true,
    automatic_task: card.automaticTask === true,
    done_at: nullable({ value: card.doneAt }),
    created_seq: card.createdSeq,
    updated_seq: card.updatedSeq,
    updated_at: card.updatedAt,
    child_working: Boolean(agent && !agent.agentId && working.has(`${agent.provider}:${agent.sessionId}`)),
    wait_title: nullable({ value: card.wait && state.cards[card.wait.task]?.title }),
    unmet_prerequisites: unmetPrerequisites({
      state,
      card,
    }),
  }
}

export function cardReference({ card }: { card: Card }): Card {
  const reference: Card = {
    ...card,
    links: card.links.slice(-LIST_LIMIT),
    sourceRefs: sourceFacts({ refs: card.sourceRefs }),
  }

  if (card.asks) {
    reference.asks = card.asks.slice(-LIST_LIMIT)
  }

  for (const field of UNREFERENCED) {
    delete reference[field]
  }

  return reference
}

// Every row a Hydra's state holds, each tagged with the group it is rebuilt with. The hydras, cards and links rows
// read across cards, so they are rebuilt on every write; any other group only when its part of the state changed, or
// always without touched.
function stateRows({
  hydraId,
  state,
  touched,
}: {
  hydraId: string
  state: HydraState
  touched?: Touched
}): {
  rows: Record<Table, Row[]>
  groups: Map<Row, string>
  built: Set<string>
} {
  const rows = Object.fromEntries(Object.keys(TABLES).map(table => [
    table,
    [],
  ])) as unknown as Record<Table, Row[]>
  const groups = new Map<Row, string>()
  const built = new Set<string>()
  const allCards = !touched || touched.fields.has('cards')
  const changed = ({ field }: { field: string }) => !touched || touched.fields.has(field)

  const add = ({
    table,
    row,
    group,
  }: {
    table: Table
    row: Row
    group?: string
  }) => {
    rows[table].push(row)

    if (group !== undefined) {
      groups.set(
        row,
        group,
      )
    }
  }

  const { config } = state
  const configRest: Record<string, unknown> | null = config ? { ...config } : null
  delete configRest?.columns
  add({
    table: 'hydras',
    row: {
      id: hydraId,
      config: configRest,
      // ponytail: a Firstmate home's projects change without an event; the row catches up on the next write.
      summary: summarize({
        id: hydraId,
        state,
      }).summary,
    },
  })

  for (const key of touched ? touched.fields : Object.keys(state)) {
    const value = (state as unknown as Record<string, unknown>)[key]

    if (STRUCTURED.has(key)) {
      continue
    }

    built.add(`value:${key}`)

    if (value !== undefined) {
      add({
        table: 'hydra_values',
        row: {
          hydra_id: hydraId,
          key,
          value,
        },
        group: `value:${key}`,
      })
    }
  }

  if (changed({ field: 'config' })) {
    built.add('columns')

    for (const [
      position,
      column,
    ] of (config?.columns ?? []).entries()) {
      add({
        table: 'columns',
        row: {
          hydra_id: hydraId,
          id: column.id,
          position,
          title: column.title,
          role: nullable({ value: column.role }),
          data: column,
        },
        group: 'columns',
      })
    }
  }

  const all = Object.values(state.cards)
  const working = new Set(all.flatMap(card => card.agent?.agentId && agentActivity({ card }) === 'working'
    ? [`${card.agent.provider}:${card.agent.sessionId}`]
    : []))
  // Each pull request's merge questions are read from the cards that ask about it, not from every card.
  const asking = new Map<string, Record<string, Card>>()

  for (const card of all) {
    for (const ask of card.asks ?? []) {
      if (ask.kind === 'merge' && ask.url) {
        const cards = asking.get(ask.url) ?? {}
        cards[card.id] = card
        asking.set(
          ask.url,
          cards,
        )
      }
    }
  }

  for (const card of all) {
    add({
      table: 'cards',
      row: cardSummary({
        hydraId,
        state,
        card,
        working,
      }),
    })

    for (const [
      position,
      link,
    ] of card.links.entries()) {
      const merge = link.kind === 'github_pr' ? canonicalMergeQuestion({
        cards: asking.get(link.url) ?? {},
        card,
        url: link.url,
      }) : undefined
      add({
        table: 'links',
        row: {
          hydra_id: hydraId,
          card_id: card.id,
          url: link.url,
          position,
          kind: link.kind,
          number: nullable({ value: link.number }),
          title: nullable({ value: link.title }),
          state: nullable({ value: link.state }),
          draft: nullable({ value: link.draft }),
          merge_question_card: nullable({ value: merge?.card.id }),
          merge_question: nullable({ value: merge?.ask.id }),
          data: link,
        },
      })
    }

    if (!allCards && !touched?.cards.has(card.id)) {
      continue
    }

    built.add(`card:${card.id}`)

    for (const [
      table,
      list,
    ] of Object.entries(cardRows({
        hydraId,
        card,
      }))) {
      for (const row of list) {
        add({
          table: table as Table,
          row,
          group: `card:${card.id}`,
        })
      }
    }
  }

  if (changed({ field: 'hydraMessages' })) {
    built.add('messages')

    for (const [
      position,
      message,
    ] of (state.hydraMessages ?? []).entries()) {
      add({
        table: 'messages',
        row: {
          hydra_id: hydraId,
          id: message.id,
          position,
          task_id: nullable({ value: message.task }),
          action: message.action,
          kind: nullable({ value: message.kind }),
          text: message.text,
          at: message.at,
          actor: message.actor,
          received: nullable({ value: message.received }),
          data: message,
        },
        group: 'messages',
      })
    }
  }

  if (changed({ field: 'sessions' })) {
    built.add('sessions')

    for (const session of Object.values(state.sessions ?? {})) {
      add({
        table: 'sessions',
        row: {
          hydra_id: hydraId,
          id: session.id,
          task_id: nullable({ value: session.taskId }),
          data: session,
        },
        group: 'sessions',
      })
    }
  }

  return {
    rows,
    groups,
    built,
  }
}

const upsert = ({
  table,
  rows,
}: {
  table: Table
  rows: Row[]
}): Statement => {
  const key: readonly string[] = TABLES[table]
  const columns = Object.keys(rows[0]!).filter(column => !key.includes(column))
  const update = columns.length
    ? `do update set ${columns.map(column => `${column} = excluded.${column}`).join(', ')}`
    : 'do nothing'

  return {
    text: `insert into ${table} (${Object.keys(rows[0]!).join(', ')})
      select ${Object.keys(rows[0]!).join(', ')} from json_populate_recordset(null::${table}, $1::json)
      on conflict (${TABLES[table].join(', ')}) ${update}`,
    values: [JSON.stringify(rows)],
  }
}

const remove = ({
  table,
  rows,
}: {
  table: Table
  rows: Row[]
}): Statement => ({
  text: `delete from ${table} where (${TABLES[table].join(', ')}) in
    (select ${TABLES[table].join(', ')} from json_populate_recordset(null::${table}, $1::json))`,
  values: [JSON.stringify(rows)],
})

// Observation timestamps live in private watermarks and do not dirty public rows.
function comparisonRow({
  table,
  row,
}: {
  table: Table
  row: Row
}): Row {
  if (table === 'sessions') {
    return {
      ...row,
      data: sessionFacts({ session: row.data as AgentSession }),
    }
  }

  if (table === 'card_bodies') {
    const card = row.data as Card

    return {
      ...row,
      data: {
        ...card,
        sourceRefs: sourceFacts({ refs: card.sourceRefs }),
      },
    }
  }

  return row
}

// The statements that bring the saved rows to this state, and the saved rows once they commit. touched names what
// the write changed; without it every row is compared.
export function rowChanges({
  hydraId,
  state,
  saved,
  touched,
}: {
  hydraId: string
  state: HydraState
  saved: SavedRows
  touched?: Touched
}): {
  statements: Statement[]
  next: SavedRows
} {
  const {
    rows,
    groups,
    built,
  } = stateRows({
    hydraId,
    state,
    touched,
  })
  const next: SavedRows = new Map(saved)
  const writes: Partial<Record<Table, Row[]>> = {}
  const deletes: Partial<Record<Table, Row[]>> = {}
  const present = new Set<string>()

  for (const table of Object.keys(TABLES) as Table[]) {
    for (const row of rows[table]) {
      const key = rowKey({
        table,
        row,
      })
      const digest = hash(
        'sha1',
        JSON.stringify(comparisonRow({
          table,
          row,
        })),
        'base64',
      )
      present.add(key)

      if (next.get(key)?.digest === digest) {
        continue
      }

      const group = groups.get(row)
      next.set(
        key,
        group === undefined ? { digest } : {
          digest,
          group,
        },
      )
      writes[table] = [
        ...writes[table] ?? [],
        row,
      ]
    }
  }

  // A saved row this write could have rebuilt but did not is gone; so are the rows of a card that left.
  const rebuilt = ({ group }: { group?: string }) => group === undefined || built.has(group)
    || (group.startsWith('card:') && !state.cards[group.slice('card:'.length)])

  for (const [
    key,
    entry,
  ] of saved) {
    if (present.has(key) || !rebuilt({ group: entry.group })) {
      continue
    }

    const [
      table,
      ...values
    ] = key.split('\u0000') as [Table, ...string[]]
    deletes[table] = [
      ...deletes[table] ?? [],
      Object.fromEntries(TABLES[table].map((
        column,
        index,
      ) => [
        column,
        values[index],
      ])),
    ]
    next.delete(key)
  }

  const tables = Object.keys(TABLES) as Table[]

  return {
    statements: [
      ...tables.toReversed().flatMap(table => deletes[table] ? [
        remove({
          table,
          rows: deletes[table],
        }),
      ] : []),
      ...tables.flatMap(table => writes[table] ? [
        upsert({
          table,
          rows: writes[table],
        }),
      ] : []),
    ],
    next,
  }
}

// The statements that append events and move the Hydra's seq from the one this write started at to the one it
// ended at, failing when another writer moved it first.
export function eventStatements({
  hydraId,
  from,
  to,
  events,
}: {
  hydraId: string
  from: number
  to: number
  events: HydraEvent[]
}): Statement[] {
  const claim: Statement = from === 0 ? {
    text: 'insert into hydras (id, seq, summary) values ($1, $2, \'{}\') on conflict do nothing',
    values: [
      hydraId,
      to,
    ],
    expectRows: 1,
  } : {
    text: 'update hydras set seq = $2 where id = $1 and seq = $3',
    values: [
      hydraId,
      to,
      from,
    ],
    expectRows: 1,
  }

  const updates = events.flatMap(event => updateTasks({ event }).map(card => ({
    hydra_id: hydraId,
    card_id: card,
    seq: event.seq,
  })))

  const statements = [claim]

  for (let offset = 0; offset < events.length; offset += EVENT_BATCH_SIZE) {
    const batch = events.slice(
      offset,
      offset + EVENT_BATCH_SIZE,
    )
    statements.push({
      text: `insert into events (hydra_id, seq, id, type, at, actor, card_id, data)
        select hydra_id, seq, id, type, at, actor, card_id, data from json_populate_recordset(null::events, $1::json)`,
      values: [
        JSON.stringify(batch.map(event => ({
          hydra_id: hydraId,
          seq: event.seq,
          id: event.id,
          type: event.type,
          at: event.at,
          actor: event.actor,
          card_id: event.cardId,
          data: event,
        }))),
      ],
    })
  }

  for (let offset = 0; offset < updates.length; offset += EVENT_BATCH_SIZE) {
    statements.push({
      text: `insert into card_updates (hydra_id, card_id, seq)
        select hydra_id, card_id, seq from json_populate_recordset(null::card_updates, $1::json)`,
      values: [
        JSON.stringify(updates.slice(
          offset,
          offset + EVENT_BATCH_SIZE,
        )),
      ],
    })
  }

  return statements
}

// A Hydra's state as its rows hold it, with the rows themselves so the next write compares against them.
export function loadStatements({ hydraId }: { hydraId: string }): Statement[] {
  return [
    'select seq, config, imported_bytes from hydras where id = $1',
    'select key, value from hydra_values where hydra_id = $1',
    'select data from columns where hydra_id = $1 order by position',
    'select id from cards where hydra_id = $1 order by created_seq, id',
    'select card_id, data from card_bodies where hydra_id = $1',
    'select card_id, data from card_private where hydra_id = $1',
    'select card_id, data from replies where hydra_id = $1 order by card_id, position',
    'select card_id, data from questions where hydra_id = $1 order by card_id, position',
    'select card_id, data from declarations where hydra_id = $1 order by card_id, position',
    'select card_id, data from links where hydra_id = $1 order by card_id, position',
    'select card_id, id, kind, source, at from notes where hydra_id = $1 order by card_id, position',
    'select data from messages where hydra_id = $1 order by position',
    'select id, data from sessions where hydra_id = $1',
    'select id, seq from events where hydra_id = $1',
    'select card_id, adapter, instance_id, object_id, generation, observed_at, seen_at from source_observations where hydra_id = $1',
  ].map(text => ({
    text,
    values: [hydraId],
  }))
}

export function stateFromRows({
  hydraId,
  results,
}: {
  hydraId: string
  results: Record<string, unknown>[][]
}): {
  state: HydraState
  saved: SavedRows
  // The size events.jsonl had when this Hydra was imported from it, for a Hydra that was.
  importedBytes?: number
} | undefined {
  type Of<T> = (T & Record<string, unknown>)[]
  type CardRow<T> = Of<{
    card_id: string
    data: T
  }>
  // The rows loadStatements asks for, in its order.
  const [
    hydra,
    values,
    columns,
    ids,
    bodies,
    privates,
    replies,
    questions,
    declarations,
    links,
    notes,
    messages,
    sessions,
    events,
    observations,
  ] = results as unknown as [
    Of<{
      seq: string
      config: Omit<HydraConfig, 'columns'> | null
      imported_bytes: string | null
    }>,
    Of<{
      key: string
      value: unknown
    }>,
    Of<{ data: HydraColumn }>,
    Of<{ id: string }>,
    CardRow<Card>,
    CardRow<Partial<Card>>,
    CardRow<Reply>,
    CardRow<Ask>,
    CardRow<TaskDeclaration>,
    CardRow<Link>,
    Of<{
      card_id: string
      id: string
      kind: NoteRef['kind']
      source: string
      at: string | null
    }>,
    Of<{ data: HydraMessage }>,
    Of<{
      id: string
      data: AgentSession
    }>,
    Of<{
      id: string
      seq: string
    }>,
    ObservationRow[],
  ]
  const head = hydra[0]

  if (!head) {
    return undefined
  }

  const lists = new Map<string, Record<string, unknown[]>>()

  const add = ({
    card,
    list,
    item,
  }: {
    card: string
    list: string
    item: unknown
  }) => {
    const owned = lists.get(card) ?? {}
    owned[list] = [
      ...owned[list] ?? [],
      item,
    ]
    lists.set(
      card,
      owned,
    )
  }

  for (const row of questions) {
    add({
      card: row.card_id,
      list: 'asks',
      item: row.data,
    })
  }

  for (const row of replies) {
    add({
      card: row.card_id,
      list: 'replies',
      item: row.data,
    })
  }

  for (const row of declarations) {
    add({
      card: row.card_id,
      list: 'statusLog',
      item: row.data,
    })
  }

  for (const row of links) {
    add({
      card: row.card_id,
      list: 'links',
      item: row.data,
    })
  }

  for (const row of notes) {
    const note: Record<string, unknown> = {
      id: row.id,
      kind: row.kind,
      source: row.source,
    }

    if (row.at !== null) {
      note.at = row.at
    }

    add({
      card: row.card_id,
      list: 'notes',
      item: note,
    })
  }

  const body = new Map(bodies.map(row => [
    row.card_id,
    row.data,
  ]))
  const hidden = new Map(privates.map(row => [
    row.card_id,
    row.data,
  ]))
  const state: HydraState = {
    v: EVENT_VERSION,
    seq: Number(head.seq),
    cards: {},
    keys: {},
    eventIds: {},
    undone: {},
  }

  for (const row of values) {
    // hydra_values holds only HydraState fields, each under its own name.
    (state as unknown as Record<string, unknown>)[row.key] = row.value
  }

  if (head.config) {
    state.config = {
      ...head.config,
      columns: columns.map(row => row.data),
    }
  }

  for (const { id } of ids) {
    const row = body.get(id)

    // The foreign key ties a body to its card, not a card to a body, so a missing one is named rather than read.
    if (!row) {
      throw new HydraError({
        message: `card ${id} of Hydra ${hydraId} has no stored body`,
        code: 'LOG_CORRUPT',
      })
    }

    const card: Card = {
      ...row,
      ...hidden.get(id),
      ...lists.get(id),
    }
    state.cards[id] = card
    state.keys[card.key] = id
  }

  if (messages.length) {
    state.hydraMessages = messages.map(row => row.data)
  }

  if (sessions.length) {
    state.sessions = Object.fromEntries(sessions.map(row => [
      row.id,
      row.data,
    ]))
  }

  for (const {
    id,
    seq,
  } of events) {
    state.eventIds[id] = Number(seq)
  }

  restoreObservations({
    state,
    rows: observations ?? [],
  })

  const loaded = {
    state,
    saved: rowChanges({
      hydraId,
      state,
      saved: emptySaved(),
    }).next,
  }

  return head.imported_bytes === null ? loaded : {
    ...loaded,
    importedBytes: Number(head.imported_bytes),
  }
}
