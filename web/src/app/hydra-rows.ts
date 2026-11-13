import type { QueryResultType } from '@rocicorp/zero'
import type { HydraState } from '#app/model.ts'
import { emptyHydra } from '#app/reducer.ts'
import type { Card } from '#tasks/model.ts'
import type { queries } from '#store/zero-schema.ts'

export type HydraRow = NonNullable<QueryResultType<typeof queries.hydra.one>>
export type CardRow = QueryResultType<typeof queries.board.cards>[number]
export type DetailRow = NonNullable<QueryResultType<typeof queries.card.detail>>
export type ReferenceRow = QueryResultType<typeof queries.cards.references>[number]
export type MessageRow = NonNullable<QueryResultType<typeof queries.hydra.ownerMessage>>

// Rows keep their identity while unchanged, so each card does too.
const built = new WeakMap<object, Card>()

// The server moves a list with items to its rows and keeps an empty one in the body, so a card tells empty from missing.
function stored<Value>({
  rows,
  body,
  name,
}: {
  rows: Value[]
  body: object | undefined
  name: string
}): Value[] | undefined {
  if (rows.length) {
    return rows
  }

  return body && Array.isArray(Reflect.get(
    body,
    name,
  )) ? [] : undefined
}

export function cardFromRow({ row }: { row: CardRow | DetailRow }): Card {
  const cached = built.get(row)

  if (cached) {
    return cached
  }

  const body = row.body?.data
  const card = {
    ...body,
    asks: stored({
      rows: row.questions.map(question => question.data),
      body,
      name: 'asks',
    }),
    statusLog: stored({
      rows: row.declarations.map(declaration => declaration.data),
      body,
      name: 'statusLog',
    }),
    links: row.links.map(link => link.data),
    facts: {
      childWorking: row.child_working,
      waitTitle: row.wait_title ?? undefined,
      unmetPrerequisites: row.unmet_prerequisites,
      mergeQuestions: Object.fromEntries(row.links.map(({
        url,
        mergeQuestion,
      }) => {
        const owner = mergeQuestion?.card
        const another = owner && owner.id !== row.id

        return [
          url,
          owner ? {
            card: another ? referenceCard({ row: owner }) : undefined,
            ask: mergeQuestion.data,
          } : undefined,
        ]
      })),
    },
    notes: 'notes' in row ? stored({
      body,
      name: 'notes',
      rows: row.notes.map(({
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
  const same = previous === next || JSON.stringify(previous) === JSON.stringify(next)

  return same ? previous : next
}

const referenceLists = new WeakMap<readonly ReferenceRow[], Pick<HydraState, 'keys'> & {
  references: Record<string, Card>
  shown: Set<string>
}>()

const ownerMessages = new WeakMap<MessageRow, NonNullable<HydraState['hydraOwnerMessage']>>()

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

function ownerMessageOf({ row }: { row?: MessageRow }): HydraState['hydraOwnerMessage'] {
  if (!row) {
    return undefined
  }

  const message = ownerMessages.get(row) ?? {
    id: row.id,
    task: row.task_id ?? undefined,
    text: row.text,
  }
  ownerMessages.set(
    row,
    message,
  )

  return message
}

export function hydraFromRows({
  hydra,
  cards,
  opened,
  references,
  ownerMessage,
  previous,
}: {
  hydra: HydraRow
  cards: readonly CardRow[]
  opened: readonly DetailRow[]
  references: readonly ReferenceRow[]
  ownerMessage?: MessageRow
  previous?: HydraState
}): HydraState {
  // An opened card's detail row replaces its board row.
  const byId = Object.fromEntries([
    ...cards,
    ...opened,
  ].map(row => [
    row.id,
    cardFromRow({ row }),
  ]))
  const shown = Object.values(byId)
  const sameCards = previous !== undefined && Object.keys(previous.cards).length === shown.length
    && shown.every(card => previous.cards[card.id] === card)
  const listed = referencesOf({
    rows: references,
    shown: new Set(Object.keys(byId)),
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
    cards: sameCards ? previous.cards : byId,
    references: listed.references,
    keys: listed.keys,
    hydraOwnerMessage: ownerMessageOf({ row: ownerMessage }),
  }
}
