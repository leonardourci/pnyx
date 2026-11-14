import type { QueryResultType } from '@rocicorp/zero'
import type { HydraState } from '#app/model.ts'
import { emptyHydra } from '#app/reducer.ts'
import type { Card } from '#tasks/model.ts'
import type { queries } from '#store/zero-schema.ts'
import { kept } from '#web-shared/stable.ts'

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

// Each list a card relates arrives newest first, so the card puts it back oldest first, as the server keeps it.
function inPosition<Row extends { position: number }>({ rows }: { rows: readonly Row[] }): Row[] {
  return rows.toSorted((
    a,
    b,
  ) => a.position - b.position)
}

function cardFromRow({ row }: { row: CardRow | DetailRow }): Card {
  const cached = built.get(row)

  if (cached) {
    return cached
  }

  const body = row.body?.data
  // Zero types json columns as plain JSON; the body and the list rows hold the card's parts as the server stored them.
  const card = {
    ...body,
    asks: stored({
      rows: inPosition({ rows: row.questions }).map(question => question.data),
      body,
      name: 'asks',
    }),
    statusLog: stored({
      rows: inPosition({ rows: row.declarations }).map(declaration => declaration.data),
      body,
      name: 'statusLog',
    }),
    replies: stored({
      rows: inPosition({ rows: row.replies }).map(reply => reply.data),
      body,
      name: 'replies',
    }),
    links: inPosition({ rows: row.links }).map(link => link.data),
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
      rows: inPosition({ rows: row.notes }).map(({
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

// A hidden task, for the chips, waits, prerequisites and answer leads that read it, once its reference row has synced.
function referenceCard({ row }: { row: ReferenceRow }): Card | undefined {
  const reference = row.reference?.data

  if (!reference) {
    return undefined
  }

  const cached = built.get(row)

  if (cached) {
    return cached
  }

  // Zero types json columns as plain JSON; this one holds the card the server stored for references.
  const card = {
    ...reference,
    facts: {
      childWorking: row.child_working,
      waitTitle: row.wait_title ?? undefined,
      unmetPrerequisites: row.unmet_prerequisites,
      mergeQuestions: {},
    },
  } as Card
  built.set(
    row,
    card,
  )

  return card
}

const referenceLists = new WeakMap<readonly ReferenceRow[], {
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
    references: Object.fromEntries(rows.filter(row => !shown.has(row.id)).flatMap(row => {
      const card = referenceCard({ row })

      return card ? [
        [
          row.id,
          card,
        ],
      ] : []
    })),
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
  const keys = Object.fromEntries([
    ...references,
    ...cards,
    ...opened,
  ].map(row => [
    row.key,
    row.id,
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
  // The config and its columns are the HydraConfig the server stored, split across a json column and rows.
  const config = hydra.config ? {
    ...hydra.config,
    columns: hydra.columns.map(column => column.data),
  } as HydraState['config'] : undefined

  return {
    ...emptyHydra(),
    ...values,

    config: kept({
      previous: previous?.config,
      next: config,
    }),
    cards: sameCards ? previous.cards : byId,
    references: listed.references,
    keys: kept({
      previous: previous?.keys ?? keys,
      next: keys,
    }),
    hydraOwnerMessage: ownerMessageOf({ row: ownerMessage }),
  }
}
