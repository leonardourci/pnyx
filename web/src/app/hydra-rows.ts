import type { QueryResultType } from '@rocicorp/zero'
import type { HydraState } from '#app/model.ts'
import { emptyHydra } from '#app/reducer.ts'
import type { Card } from '#tasks/model.ts'
import type { queries } from '#store/zero-schema.ts'

export type HydraRow = NonNullable<QueryResultType<typeof queries.hydra.one>>
export type CardRow = QueryResultType<typeof queries.board.cards>[number]
export type DetailRow = NonNullable<QueryResultType<typeof queries.card.detail>>
export type ReferenceRow = QueryResultType<typeof queries.cards.references>[number]
export type MessageRow = QueryResultType<typeof queries.hydra.messages>[number]

// Rows keep their identity while unchanged, so each card does too.
const built = new WeakMap<object, Card>()

// A card leaves out an empty list it never had.
const orNone = <Value>({ list }: { list: Value[] }) => list.length ? list : undefined

export function cardFromRow({ row }: { row: CardRow | DetailRow }): Card {
  const cached = built.get(row)

  if (cached) {
    return cached
  }

  const card = {
    ...row.body?.data,
    asks: orNone({ list: row.questions.map(question => question.data) }),
    statusLog: orNone({ list: row.declarations.map(declaration => declaration.data) }),
    links: row.links.map(link => link.data),
    facts: {
      childWorking: row.child_working,
      waitTitle: row.wait_title ?? undefined,
      unmetPrerequisites: row.unmet_prerequisites,
      mergeQuestions: Object.fromEntries(row.links.map(link => [
        link.url,
        link.mergeQuestion?.card ? {
          card: link.mergeQuestion.card_id === row.id ? undefined : referenceCard({ row: link.mergeQuestion.card }),
          ask: link.mergeQuestion.data,
        } : undefined,
      ])),
    },
    notes: 'notes' in row ? orNone({
      list: row.notes.map(({
        id,
        kind,
        source,
        at,
      }) => ({
        id,
        kind,
        source,
        at,
      })),
    }) : undefined,
  } as Card
  built.set(
    row,
    card,
  )

  return card
}

// A hidden task, for the chips and messages that name it.
function referenceCard({ row }: { row: ReferenceRow }): Card {
  const cached = built.get(row)

  if (cached) {
    return cached
  }

  const card: Card = {
    id: row.id,
    key: row.key,
    title: row.title,
    column: row.column_id as Card['column'],
    rank: row.rank ?? undefined,
    parentId: row.parent_id ?? undefined,
    project: row.project ?? undefined,
    kind: row.kind ?? undefined,
    hidden: row.hidden,
    automaticTask: row.automatic_task,
    doneAt: row.done_at ?? undefined,
    createdSeq: row.created_seq,
    updatedSeq: row.updated_seq,
    updatedAt: row.updated_at,
    revision: 0,
    workspace: '',
    tags: [],
    attention: [],
    links: [],
    sourceRefs: [],
  }
  built.set(
    row,
    card,
  )

  return card
}

// The Hydra row changes with every write, so its fields keep their earlier value while they read the same.
function kept<Value>({
  previous,
  next,
}: {
  previous: Value
  next: Value
}): Value {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next
}

const referenceLists = new WeakMap<readonly ReferenceRow[], Pick<HydraState, 'keys'> & {
  references: Record<string, Card>
  shown: Set<string>
}>()

const messageLists = new WeakMap<readonly MessageRow[], HydraState['hydraMessages']>()

function referencesOf({
  rows,
  shown,
}: {
  rows: readonly ReferenceRow[]
  shown: Set<string>
}) {
  const cached = referenceLists.get(rows)
  const sameShown = cached && cached.shown.size === shown.size
    && [...shown].every(id => cached.shown.has(id))

  if (cached && sameShown) {
    return cached
  }

  const built = {
    shown,
    references: Object.fromEntries(rows
      .filter(row => !shown.has(row.id) && !row.automatic_task)
      .map(row => [
        row.id,
        referenceCard({ row }),
      ])),
    keys: Object.fromEntries(rows.map(row => [
      row.key,
      row.id,
    ])),
  }
  referenceLists.set(
    rows,
    built,
  )

  return built
}

function messagesOf({ rows }: { rows: readonly MessageRow[] }) {
  const cached = messageLists.get(rows)

  if (cached) {
    return cached
  }

  // Zero types the json column as plain JSON; it holds the message the server stored.
  const messages = rows.map(row => row.data) as HydraState['hydraMessages']
  messageLists.set(
    rows,
    messages,
  )

  return messages
}

export function hydraFromRows({
  hydra,
  cards,
  opened,
  references,
  messages,
  previous,
}: {
  hydra: HydraRow
  cards: readonly CardRow[]
  opened: readonly DetailRow[]
  references: readonly ReferenceRow[]
  messages: readonly MessageRow[]
  previous?: HydraState
}): HydraState {
  const shown = [
    ...cards,
    ...opened,
  ].map(row => cardFromRow({ row }))
  const sameCards = previous !== undefined && Object.keys(previous.cards).length === shown.length
    && shown.every(card => previous.cards[card.id] === card)
  const listed = referencesOf({
    rows: references,
    shown: new Set(shown.map(card => card.id)),
  })
  // Zero types json columns as plain JSON; they hold the Hydra fields the server stored.
  const values = Object.fromEntries(hydra.values.map(({
    key,
    value,
  }) => [
    key,
    kept<unknown>({
      previous: previous?.[key as keyof HydraState],
      next: value,
    }),
  ])) as Partial<HydraState>
  const config = hydra.config ? {
    ...hydra.config,
    columns: hydra.columns.map(column => column.data),
  } as HydraState['config'] : undefined

  return {
    ...emptyHydra(),
    ...values,
    seq: hydra.seq,
    config: kept({
      previous: previous?.config,
      next: config,
    }),
    cards: sameCards ? previous.cards : Object.fromEntries(shown.map(card => [
      card.id,
      card,
    ])),
    references: listed.references,
    keys: listed.keys,
    hydraMessages: messagesOf({ rows: messages }),
  }
}
