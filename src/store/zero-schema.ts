import { type ReadonlyJSONValue, boolean, createBuilder, createSchema, defineQueries, defineQuery, enumeration, json, number, relationships, string, table } from '@rocicorp/zero'
import type { HydraConfig, HydraMessage } from '#hydra/model.ts'
import { OWNER_ACTORS } from '#app/actors.ts'
import type { HydraColumn } from '#tasks/columns-model.ts'
import type { Ask, Card, NoteKind, TaskDeclaration, TaskKind, TaskStatus } from '#tasks/model.ts'
import type { Link, LinkKind, LinkState } from '#tasks/delivery/model.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'
import type { HydraSummary } from '#app/server-hydras.ts'
import type { HydraQueue } from '#hydra/wakes.ts'
import type { Reply } from '#workers/model.ts'
import type { Settings } from '#settings/model.ts'
import type { unmetPrerequisites } from '#tasks/dependencies.ts'

// The page's view of src/store/schema.sql. zero-cache replicates only the tables of the pnyx_page publication, whole
// rows, and the page reads them only through the queries below.

// Zero's json columns take only types with index signatures; this restates an interface as a plain object type.
type Stored<T> = unknown extends T ? ReadonlyJSONValue
  : T extends object ? { [K in keyof T]: Stored<T[K]> } : T

const hydras = table('hydras')
  .columns({
    id: string(),
    seq: number(),
    config: json<Stored<Omit<HydraConfig, 'columns'>>>().optional(),
    summary: json<Stored<HydraSummary>>(),
    queue: json<Stored<HydraQueue>>(),
  })
  .primaryKey('id')

const settings = table('settings')
  .columns({
    id: string(),
    revision: number(),
    value: json<Stored<Settings>>(),
  })
  .primaryKey('id')

const upgradeStatus = table('upgrade_status')
  .columns({
    id: string(),
    available: boolean(),
    checked_at: string(),
  })
  .primaryKey('id')

const hydraValues = table('hydra_values')
  .columns({
    hydra_id: string(),
    key: string(),
    value: json(),
  })
  .primaryKey(
    'hydra_id',
    'key',
  )

const events = table('events')
  .columns({
    hydra_id: string(),
    seq: number(),
    id: string(),
    type: string<HydraEvent['type']>(),
    at: string(),
    actor: string(),
    card_id: string(),
    data: json<Stored<HydraEvent>>(),
  })
  .primaryKey(
    'hydra_id',
    'seq',
  )

const cardUpdates = table('card_updates')
  .columns({
    hydra_id: string(),
    card_id: string(),
    seq: number(),
  })
  .primaryKey(
    'hydra_id',
    'card_id',
    'seq',
  )

const columns = table('columns')
  .columns({
    hydra_id: string(),
    id: string(),
    position: number(),
    title: string(),
    role: string().optional(),
    data: json<Stored<HydraColumn>>(),
  })
  .primaryKey(
    'hydra_id',
    'id',
  )

const cards = table('cards')
  .columns({
    hydra_id: string(),
    id: string(),
    key: string(),
    title: string(),
    column_id: string(),
    rank: number().optional(),
    parent_id: string().optional(),
    project: string().optional(),
    kind: enumeration<TaskKind>().optional(),
    status: enumeration<TaskStatus>().optional(),
    hidden: boolean(),
    automatic_task: boolean(),
    done_at: string().optional(),
    created_seq: number(),
    updated_seq: number(),
    updated_at: string(),
    child_working: boolean(),
    wait_title: string().optional(),
    unmet_prerequisites: json<Stored<ReturnType<typeof unmetPrerequisites>>>(),
  })
  .primaryKey(
    'hydra_id',
    'id',
  )

const cardBodies = table('card_bodies')
  .columns({
    hydra_id: string(),
    card_id: string(),
    data: json<Stored<Omit<Card, 'asks' | 'statusLog' | 'links' | 'notes' | 'steering' | 'externalSources'>>>(),
  })
  .primaryKey(
    'hydra_id',
    'card_id',
  )

const cardReferences = table('card_references')
  .columns({
    hydra_id: string(),
    card_id: string(),
    data: json<Stored<Card>>(),
  })
  .primaryKey(
    'hydra_id',
    'card_id',
  )

const replies = table('replies')
  .columns({
    hydra_id: string(),
    card_id: string(),
    id: string(),
    position: number(),
    answers: string().optional(),
    data: json<Stored<Reply>>(),
  })
  .primaryKey(
    'hydra_id',
    'card_id',
    'id',
  )

const questions = table('questions')
  .columns({
    hydra_id: string(),
    card_id: string(),
    id: string(),
    position: number(),
    audience: enumeration<Ask['audience']>(),
    question: string(),
    asked_at: string(),
    actor: string(),
    answered: string().optional(),
    answered_at: string().optional(),
    closed: boolean(),
    data: json<Stored<Ask>>(),
  })
  .primaryKey(
    'hydra_id',
    'card_id',
    'id',
  )

const declarations = table('declarations')
  .columns({
    hydra_id: string(),
    card_id: string(),
    id: string(),
    position: number(),
    state: enumeration<TaskStatus>(),
    note: string(),
    at: string(),
    actor: string(),
    until: string().optional(),
    data: json<Stored<TaskDeclaration>>(),
  })
  .primaryKey(
    'hydra_id',
    'card_id',
    'id',
  )

const links = table('links')
  .columns({
    hydra_id: string(),
    card_id: string(),
    url: string(),
    position: number(),
    kind: enumeration<LinkKind>(),
    number: number().optional(),
    title: string().optional(),
    state: enumeration<LinkState>().optional(),
    draft: boolean().optional(),
    merge_question_card: string().optional(),
    merge_question: string().optional(),
    data: json<Stored<Link>>(),
  })
  .primaryKey(
    'hydra_id',
    'card_id',
    'url',
  )

const notes = table('notes')
  .columns({
    hydra_id: string(),
    card_id: string(),
    id: string(),
    position: number(),
    kind: enumeration<NoteKind>(),
    source: string(),
    at: string().optional(),
  })
  .primaryKey(
    'hydra_id',
    'card_id',
    'id',
  )

const messages = table('messages')
  .columns({
    hydra_id: string(),
    id: string(),
    position: number(),
    task_id: string().optional(),
    action: enumeration<HydraMessage['action']>(),
    kind: enumeration<NonNullable<HydraMessage['kind']>>().optional(),
    text: string(),
    at: string(),
    actor: string(),
    received: string().optional(),
    data: json<Stored<HydraMessage>>(),
  })
  .primaryKey(
    'hydra_id',
    'id',
  )

const ofCard = {
  sourceField: [
    'hydra_id',
    'id',
  ],
  destField: [
    'hydra_id',
    'card_id',
  ],
} as const

const toCard = {
  sourceField: [
    'hydra_id',
    'card_id',
  ],
  destField: [
    'hydra_id',
    'id',
  ],
} as const

const cardRelationships = relationships(
  cards,
  ({
    one,
    many,
  }) => ({
    body: one({
      ...ofCard,
      destSchema: cardBodies,
    }),
    reference: one({
      ...ofCard,
      destSchema: cardReferences,
    }),
    replies: many({
      ...ofCard,
      destSchema: replies,
    }),
    questions: many({
      ...ofCard,
      destSchema: questions,
    }),
    declarations: many({
      ...ofCard,
      destSchema: declarations,
    }),
    links: many({
      ...ofCard,
      destSchema: links,
    }),
    notes: many({
      ...ofCard,
      destSchema: notes,
    }),
  }),
)

const questionRelationships = relationships(
  questions,
  ({ one }) => ({
    card: one({
      ...toCard,
      destSchema: cards,
    }),
  }),
)

const linkRelationships = relationships(
  links,
  ({ one }) => ({
    mergeQuestion: one({
      sourceField: [
        'hydra_id',
        'merge_question_card',
        'merge_question',
      ],
      destField: [
        'hydra_id',
        'card_id',
        'id',
      ],
      destSchema: questions,
    }),
  }),
)

const updateRelationships = relationships(
  cardUpdates,
  ({ one }) => ({
    event: one({
      sourceField: [
        'hydra_id',
        'seq',
      ],
      destField: [
        'hydra_id',
        'seq',
      ],
      destSchema: events,
    }),
  }),
)

const hydraRelationships = relationships(
  hydras,
  ({ many }) => ({
    columns: many({
      sourceField: ['id'],
      destField: ['hydra_id'],
      destSchema: columns,
    }),
    values: many({
      sourceField: ['id'],
      destField: ['hydra_id'],
      destSchema: hydraValues,
    }),
  }),
)

export const schema = createSchema({
  tables: [
    hydras,
    settings,
    upgradeStatus,
    hydraValues,
    events,
    cardUpdates,
    columns,
    cards,
    cardBodies,
    cardReferences,
    replies,
    questions,
    declarations,
    links,
    notes,
    messages,
  ],
  relationships: [
    cardRelationships,
    questionRelationships,
    linkRelationships,
    updateRelationships,
    hydraRelationships,
  ],
})

const zql = createBuilder(schema)

// Zero's client and query types take this schema by default, so the page's typed client and these queries agree.
declare module '@rocicorp/zero' {
  interface DefaultTypes {
    schema: typeof schema
  }
}

// How many rows each query syncs at most, so none grows with the Hydra's history.
const HYDRA_LIMIT = 200
const BOARD_LIMIT = 1_000
const REFERENCE_LIMIT = 1_000
export const LIST_LIMIT = 100
// One page of the Updates tab, and the most Older updates reaches.
export const HISTORY_PAGE = 50
export const MAX_HISTORY = 5_000

// The Hydra-wide fields the page reads; the rest of hydra_values is the server's.
const PAGE_VALUES = [
  'configured',
  'configRevision',
  'view',
  'viewRevision',
  'labelColors',
  'projects',
  'projectsRevision',
  'hydraStatus',
  'hydraOperation',
  'hydraAgent',
  'hydraAgentChange',
  'helper',
  'dispatchProposals',
  'upgrades',
] as const satisfies readonly (keyof HydraState)[]

type OfHydra = { hydraId: string }

type OfCard = OfHydra & { cardId: string }

// The Standard Schema shape Zero takes as a query's validator.
interface Validator<T> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    // eslint-disable-next-line pnyx/object-params -- Standard Schema owns this signature.
    readonly validate: (value: unknown) => { value: T } | { issues: readonly { message: string }[] }
    readonly types?: {
      readonly input: T
      readonly output: T
    }
  }
}

// A query's arguments come from the page, so each one is checked to be what it names: strings, and the number of
// updates a page of card history reads.
function validator<T extends Record<string, string | number>>({
  names,
  counts = [],
}: {
  names: (keyof T & string)[]
  counts?: (keyof T & string)[]
}): Validator<T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'pnyx',
      // eslint-disable-next-line pnyx/object-params -- Standard Schema owns this signature.
      validate: (value: unknown) => {
        const given = value as Record<string, unknown> | null
        const isObject = typeof given === 'object' && given !== null
        const valid = isObject && names.every(name => typeof given[name] === 'string')
          && counts.every(name => Number.isInteger(given[name]) && (given[name] as number) > 0
            && (given[name] as number) <= MAX_HISTORY)

        return valid
          ? { value: given as T }
          : { issues: [{ message: `expected strings ${names.join(', ')} and counts ${counts.join(', ')} up to ${MAX_HISTORY}` }] }
      },
    },
  }
}

const hydraArgs = validator<OfHydra>({ names: ['hydraId'] })
const refArgs = validator<OfHydra & { ref: string }>({
  names: [
    'hydraId',
    'ref',
  ],
})
const historyArgs = validator<OfCard & { limit: number }>({
  names: [
    'hydraId',
    'cardId',
  ],
  counts: ['limit'],
})

// The newest replies that answer a question, which the page reads to know an answer is still on its way.
// eslint-disable-next-line pnyx/object-params -- Zero owns related query callbacks.
const answering = (query: ReturnType<typeof zql.replies.where>) => query.where(
  'answers',
  'IS NOT',
  null,
)
  .orderBy(
    'position',
    'desc',
  )
  .limit(LIST_LIMIT)

// The only reads zero-cache serves, so they are the page's permissions: the page asks for one by name and the
// server's query endpoint builds it. Every write stays a server command. Every query is bounded, so the page never
// syncs a history that grows with time: each list a card relates holds its newest LIST_LIMIT rows, which the page
// puts back in order.
export const queries = defineQueries({
  hydras: {
    list: defineQuery(() => zql.hydras.orderBy(
      'id',
      'asc',
    ).limit(HYDRA_LIMIT)),
  },
  hydra: {
    one: defineQuery(
      hydraArgs,
      ({ args }) => zql.hydras
        .where(
          'id',
          args.hydraId,
        )
        .related(
          'columns',
          query => query.orderBy(
            'position',
            'asc',
          ).limit(LIST_LIMIT),
        )
        .related(
          'values',
          query => query.where(
            'key',
            'IN',
            PAGE_VALUES,
          ),
        )
        .one(),
    ),
    // The owner's latest message is all of the conversation the page holds outside its thread pages.
    ownerMessage: defineQuery(
      hydraArgs,
      ({ args }) => zql.messages
        .where(
          'hydra_id',
          args.hydraId,
        )
        .where(
          'action',
          'send',
        )
        .where(
          'actor',
          'IN',
          OWNER_ACTORS,
        )
        .orderBy(
          'position',
          'desc',
        )
        .one(),
    ),
  },
  board: {
    // The live cards, as liveTask in src/tasks/select.ts decides them, most recently changed first.
    cards: defineQuery(
      hydraArgs,
      ({ args }) => zql.cards
        .where(
          'hydra_id',
          args.hydraId,
        )
        .where(
          'hidden',
          false,
        )
        .where(
          'automatic_task',
          false,
        )
        .orderBy(
          'updated_seq',
          'desc',
        )
        .limit(BOARD_LIMIT)
        .related('body')
        .related(
          'replies',
          answering,
        )
        .related(
          'questions',
          query => query.orderBy(
            'position',
            'desc',
          ).limit(LIST_LIMIT),
        )
        .related(
          'declarations',
          query => query.orderBy(
            'position',
            'desc',
          ).limit(LIST_LIMIT),
        )
        .related(
          'links',
          query => query.orderBy(
            'position',
            'desc',
          ).limit(LIST_LIMIT)
            .related(
              'mergeQuestion',
              question => question.related(
                'card',
                card => card.related('reference'),
              ),
            ),
        ),
    ),
  },
  card: {
    // A card the page opens by its id or key, whether or not the board or the references hold it.
    detail: defineQuery(
      refArgs,
      ({ args }) => zql.cards
        .where(
          'hydra_id',
          args.hydraId,
        )
        .where(({
          or,
          cmp,
        }) => or(
          cmp(
            'id',
            args.ref,
          ),
          cmp(
            'key',
            args.ref,
          ),
        ))
        .related('body')
        .related(
          'replies',
          answering,
        )
        .related(
          'questions',
          query => query.orderBy(
            'position',
            'desc',
          ).limit(LIST_LIMIT),
        )
        .related(
          'declarations',
          query => query.orderBy(
            'position',
            'desc',
          ).limit(LIST_LIMIT),
        )
        .related(
          'links',
          query => query.orderBy(
            'position',
            'desc',
          ).limit(LIST_LIMIT)
            .related(
              'mergeQuestion',
              question => question.related(
                'card',
                card => card.related('reference'),
              ),
            ),
        )
        .related(
          'notes',
          query => query.orderBy(
            'position',
            'desc',
          ).limit(LIST_LIMIT),
        )
        .one(),
    ),
    // The Updates tab, newest first, `limit` at a time: Older updates asks for more. A card moved in shows its updates
    // from this Hydra on.
    history: defineQuery(
      historyArgs,
      ({ args }) => zql.card_updates
        .where(
          'hydra_id',
          args.hydraId,
        )
        .where(
          'card_id',
          args.cardId,
        )
        .orderBy(
          'seq',
          'desc',
        )
        .limit(args.limit)
        .related('event'),
    ),
  },
  cards: {
    // The most recently changed cards, hidden ones included, for mentions and task chips.
    references: defineQuery(
      hydraArgs,
      ({ args }) => zql.cards
        .where(
          'hydra_id',
          args.hydraId,
        )
        .where(
          'automatic_task',
          false,
        )
        .orderBy(
          'updated_seq',
          'desc',
        )
        .limit(REFERENCE_LIMIT)
        .related('reference'),
    ),
  },
  settings: {
    shared: defineQuery(() => zql.settings.where(
      'id',
      'shared',
    ).one()),
  },
  upgrade: {
    // Whether a newer Pnyx is available, as the server's last check found.
    status: defineQuery(() => zql.upgrade_status.where(
      'id',
      'current',
    ).one()),
  },
})
