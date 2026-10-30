import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra } from '#app/reducer.ts'
import type { Hit } from '#oracle/index.ts'
import { DEFAULT_COLUMNS } from '#tasks/column-defaults.ts'
import type { Card } from '#tasks/model.ts'
import { SETTINGS_CATALOG } from '#web-settings/catalog.ts'
import { filterOptions, filterToken, hydraFilter } from './filters.ts'
import { oracleActions } from './oracle-catalog.ts'
import { menuActions, oracleResults } from './results.ts'

const hydra = {
  id: 'default',
  name: 'Zeus',
}
const hydraBadge = hydraFilter({
  hydra: {
    ...hydra,
    icon: 'zeus',
  },
})
const project = {
  name: 'pnyx',
  path: '/work/pnyx',
  references: ['/work/pnyx'],
  live: 0,
  asks: 0,
}
const options = filterOptions({
  hydra: hydraBadge,
  columns: DEFAULT_COLUMNS,
  projects: [project],
})
const option = ({ id }: { id: string }) => options.find(filter => filter.id === id)!
const now = Date.parse('2026-10-29T12:00:00Z')

const card = ({
  id,
  title,
  column = 'queued',
  at,
}: {
  id: string
  title: string
  column?: Card['column']
  at: string
}): Card => ({
  id,
  key: id,
  title,
  column,
  project: project.path,
  workspace: 'unassigned',
  tags: [],
  attention: [],
  links: [],
  sourceRefs: [],
  createdSeq: 1,
  updatedSeq: 1,
  revision: 1,
  updatedAt: at,
})

const state = emptyHydra()
state.cards = {
  old: card({
    id: 'old',
    title: 'Deploy docs',
    at: '2026-10-20T10:00:00Z',
  }),
  fresh: {
    ...card({
      id: 'fresh',
      title: 'Deploy previews',
      column: 'in_progress',
      at: '2026-10-29T11:00:00Z',
    }),
    sessionIds: ['claude-code:fresh-session'],
  },
  gone: {
    ...card({
      id: 'gone',
      title: 'Deploy hidden',
      at: '2026-10-29T11:30:00Z',
    }),
    hidden: true,
  },
}
const hits: Hit[] = [
  {
    card: 'old',
    title: 'Deploy docs',
    match: 'lexical',
    snippets: [],
  },
  {
    card: 'gone',
    title: 'Deploy hidden',
    match: 'lexical',
    snippets: [],
  },
  {
    card: '$board',
    title: 'Hydra',
    kind: 'hydra',
    match: 'lexical',
    snippets: [
      {
        kind: 'transcript',
        at: '2026-10-29T12:00:00Z',
        snippet: 'Can we deploy previews?',
      },
    ],
  },
]
const actions = oracleActions({
  columns: DEFAULT_COLUMNS,
  scope: 'hydra',
})

const listed = ({
  text,
  badges = [hydraBadge],
  found = hits,
}: {
  text: string
  badges?: typeof options
  found?: Hit[]
}) => oracleResults({
  state,
  hits: found,
  projects: [project],
  actions,
  hydra,
  text,
  badges,
  now,
}).map(group => [
  group.label,
  group.results.map(result => result.id),
])

test(
  'an empty query with only the Hydra badge lists everything: projects, live tasks by activity, the chats in state, every setting, panel and action',
  () => {
    assert.deepEqual(
      listed({
        text: '',
        found: [],
      }),
      [
        [
          'Projects',
          ['project:/work/pnyx'],
        ],
        [
          'Tasks',
          [
            'task:fresh',
            'task:old',
          ],
        ],
        [
          'Conversations',
          [
            'conversation:hydra',
            'conversation:fresh',
          ],
        ],
        [
          'Settings and actions',
          [
            ...SETTINGS_CATALOG.map(entry => `setting:${entry.id}`),
            'panel:projects',
            'panel:agents',
            ...actions.map(action => action.id),
          ],
        ],
      ],
      'only the task with a recorded session has a conversation, and the hidden task stays out',
    )
  },
)

test(
  'a bare > lists every action, setting and panel beside the filter menu, > and letters those whose names start with them, and nothing else does',
  () => {
    const typed = ({
      query,
      text = '',
    }: {
      query: string
      text?: string
    }) => menuActions({
      token: filterToken({ query }),
      text,
      actions,
      state,
      hydra,
    }).map(result => result.id)

    assert.deepEqual(
      typed({ query: '>' }),
      [
        ...actions.map(action => action.id),
        ...SETTINGS_CATALOG.map(entry => `setting:${entry.id}`),
        'panel:projects',
        'panel:agents',
      ],
    )
    assert.deepEqual(
      typed({ query: '>ask' }),
      ['action:ask'],
      'Ask is an action, so > reaches it',
    )
    assert.deepEqual(
      typed({ query: '>theme' }),
      ['setting:theme'],
      'a setting is reachable from > by its name',
    )
    assert.ok(
      typed({ query: '>proj' }).includes('panel:projects'),
      'the Projects panel too',
    )

    const columnWords = typed({ query: '>col' })

    assert.ok(
      columnWords.includes('action:column'),
      'New column',
    )
    assert.ok(
      columnWords.includes('action:key:board.left'),
      'Previous column',
    )
    assert.ok(
      !columnWords.includes('action:task:queued'),
      'New task in Queued has no word starting with col',
    )
    assert.deepEqual(
      typed({ query: 'in:prog' }),
      [],
      'a long form names a filter type, not actions',
    )
    assert.deepEqual(
      typed({
        query: 'deploy >prog',
        text: 'deploy',
      }),
      [],
      'text before the token keeps the plain filter menu',
    )
    assert.deepEqual(
      typed({ query: 'deploy' }),
      [],
    )
  },
)

test(
  'a query groups projects, server task hits, the Hydra chat as one conversation, then settings and actions',
  () => {
    const groups = listed({ text: 'deploy' })

    assert.deepEqual(
      groups.map(([label]) => label),
      [
        'Tasks',
        'Conversations',
      ],
    )
    assert.deepEqual(
      groups[0]![1],
      ['task:old'],
      'tasks come from the server hits, and a hidden card stays out',
    )
    assert.deepEqual(
      groups[1]![1],
      ['conversation:hydra'],
    )
    assert.deepEqual(
      listed({
        text: 'pnyx theme',
        found: [],
      }),
      [],
    )
    assert.deepEqual(
      listed({
        text: 'theme',
        found: [],
      }),
      [
        [
          'Settings and actions',
          ['setting:theme'],
        ],
      ],
    )
    assert.deepEqual(
      listed({
        text: 'pnyx',
        found: [],
      })[0],
      [
        'Projects',
        ['project:/work/pnyx'],
      ],
    )
  },
)

test(
  'badges narrow every group: a column keeps only its tasks, and a Settings badge lists settings and actions without text',
  () => {
    assert.deepEqual(
      listed({
        text: '',
        badges: [
          hydraBadge,
          option({ id: 'column:in_progress' }),
        ],
        found: [],
      }),
      [
        [
          'Tasks',
          ['task:fresh'],
        ],
      ],
    )

    const [settings] = listed({
      text: '',
      badges: [
        hydraBadge,
        option({ id: 'kind:settings' }),
      ],
      found: [],
    })

    assert.equal(
      settings![0],
      'Settings and actions',
    )
    assert.ok((settings![1] as string[]).includes('setting:theme'))
    assert.ok((settings![1] as string[]).includes('panel:projects'))
    assert.ok((settings![1] as string[]).includes('panel:agents'))
    assert.ok((settings![1] as string[]).includes('action:column'))
    assert.deepEqual(
      listed({
        text: 'deploy',
        badges: [
          hydraBadge,
          option({ id: 'when:today' }),
        ],
      }).map(([label]) => label),
      ['Conversations'],
      'the old task falls outside Today, and the chat matched today',
    )
  },
)

test(
  'without text, a badge narrows the whole list and keeps the task conversations it applies to',
  () => {
    const empty = ({ badge }: { badge: string }) => listed({
      text: '',
      badges: [
        hydraBadge,
        option({ id: badge }),
      ],
      found: [],
    })

    assert.deepEqual(
      empty({ badge: 'kind:conversations' }),
      [
        [
          'Conversations',
          [
            'conversation:hydra',
            'conversation:fresh',
          ],
        ],
      ],
    )
    assert.deepEqual(
      empty({ badge: 'when:today' }),
      [
        [
          'Tasks',
          ['task:fresh'],
        ],
        [
          'Conversations',
          ['conversation:fresh'],
        ],
      ],
      'the Hydra chat has no activity time in this state, so Today leaves it out',
    )
    assert.deepEqual(
      empty({ badge: 'project:/work/pnyx' }),
      [
        [
          'Projects',
          ['project:/work/pnyx'],
        ],
        [
          'Tasks',
          [
            'task:fresh',
            'task:old',
          ],
        ],
        [
          'Conversations',
          ['conversation:fresh'],
        ],
      ],
    )
  },
)

test(
  'the Projects and Agents panels are found by their old words, among settings and actions',
  () => {
    assert.deepEqual(
      listed({
        text: 'detach',
        found: [],
      }),
      [
        [
          'Settings and actions',
          ['panel:projects'],
        ],
      ],
    )
    assert.deepEqual(
      listed({
        text: 'dispatch',
        found: [],
      }),
      [
        [
          'Settings and actions',
          ['panel:agents'],
        ],
      ],
    )
  },
)
