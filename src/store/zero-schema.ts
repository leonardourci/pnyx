import { type ReadonlyJSONValue, boolean, createBuilder, createSchema, defineQueries, defineQuery, enumeration, json, number, relationships, string, table } from '@rocicorp/zero'
import type { HydraConfig, HydraMessage } from '#hydra/model.ts'
import { OWNER_ACTORS } from '#app/actors.ts'
import type { HydraColumn } from '#tasks/columns-model.ts'
import type { Ask, Card, NoteKind, TaskDeclaration, TaskKind, TaskStatus } from '#tasks/model.ts'
import type { Link, LinkKind, LinkState } from '#tasks/delivery/model.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'
import type { HydraSummary } from '#app/server-hydras.ts'
import type { HydraQueue } from '#hydra/wakes.ts'
import type { Settings } from '#settings/model.ts'
import type { unmetPrerequisites } from '#tasks/dependencies.ts'
import type { currentState } from '#tasks/card-status.ts'

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
    open_permissions: number(),
    created_seq: number(),
    updated_seq: number(),
    updated_at: string(),
    child_working: boolean(),
    wait_title: string().optional(),
    unmet_prerequisites: json<Stored<ReturnType<typeof unmetPrerequisites>>>(),
    current_state: json<Stored<NonNullable<ReturnType<typeof currentState>>>>().optional(),
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

const noteRelationships = relationships(
  notes,
  ({ one }) => ({
    event: one({
      sourceField: [
        'hydra_id',
        'id',
      ],
      destField: [
        'hydra_id',
        'id',
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
    noteRelationships,
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

// A query's arguments come from the page, so each one is checked to be the strings it names.
function strings<T extends Record<string, string>>({
  names,
}: {
  names: (keyof T & string)[]
}): Validator<T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'pnyx',
      // eslint-disable-next-line pnyx/object-params -- Standard Schema owns this signature.
      validate: (value: unknown) => {
        const given = value as Record<string, unknown> | null

        return typeof given === 'object' && given !== null && names.every(name => typeof given[name] === 'string')
          ? { value: given as T }
          : { issues: [{ message: `expected strings: ${names.join(', ')}` }] }
      },
    },
  }
}

const hydraArgs = strings<OfHydra>({ names: ['hydraId'] })
const cardArgs = strings<OfCard>({
  names: [
    'hydraId',
    'cardId',
  ],
})

// The only reads zero-cache serves, so they are the page's permissions: the page asks for one by name and the
// server's query endpoint builds it. Every write stays a server command.
export const queries = defineQueries({
  hydras: {
    list: defineQuery(() => zql.hydras),
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
          ),
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
    // The live cards, as liveTask in src/tasks/select.ts decides them.
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
        .related('body')
        .related(
          'questions',
          query => query.orderBy(
            'position',
            'asc',
          ),
        )
        .related(
          'declarations',
          query => query.orderBy(
            'position',
            'asc',
          ),
        )
        .related(
          'links',
          query => query.orderBy(
            'position',
            'asc',
          ).related(
            'mergeQuestion',
            question => question.related('card'),
          ),
        ),
    ),
  },
  card: {
    detail: defineQuery(
      cardArgs,
      ({ args }) => zql.cards
        .where(
          'hydra_id',
          args.hydraId,
        )
        .where(
          'id',
          args.cardId,
        )
        .related('body')
        .related(
          'questions',
          query => query.orderBy(
            'position',
            'asc',
          ),
        )
        .related(
          'declarations',
          query => query.orderBy(
            'position',
            'asc',
          ),
        )
        .related(
          'links',
          query => query.orderBy(
            'position',
            'asc',
          ).related(
            'mergeQuestion',
            question => question.related('card'),
          ),
        )
        .related(
          'notes',
          query => query.orderBy(
            'position',
            'asc',
          ).related('event'),
        )
        .one(),
    ),
    // The Updates tab, newest first. A card moved in shows its updates from this Hydra on.
    history: defineQuery(
      cardArgs,
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
        .related('event'),
    ),
  },
  cards: {
    // Every card, hidden ones included, for mentions and task chips.
    references: defineQuery(
      hydraArgs,
      ({ args }) => zql.cards.where(
        'hydra_id',
        args.hydraId,
      ),
    ),
  },
  questions: {
    open: defineQuery(
      hydraArgs,
      ({ args }) => zql.questions
        .where(
          'hydra_id',
          args.hydraId,
        )
        .where(
          'closed',
          false,
        )
        .where(
          'answered',
          'IS',
          null,
        )
        .related('card'),
    ),
  },
  permissions: {
    open: defineQuery(
      hydraArgs,
      ({ args }) => zql.cards
        .where(
          'hydra_id',
          args.hydraId,
        )
        .where(
          'open_permissions',
          '>',
          0,
        )
        .related('body'),
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
