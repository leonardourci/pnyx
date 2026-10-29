import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra } from '#app/reducer.ts'
import type { Hit } from '#oracle/index.ts'
import { DEFAULT_COLUMNS } from '#tasks/column-defaults.ts'
import type { Card } from '#tasks/model.ts'
import { filterOptions, hydraFilter } from './filters.ts'
import { oracleActions } from './oracle-catalog.ts'
import { oracleResults } from './results.ts'

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
  fresh: card({
    id: 'fresh',
    title: 'Deploy previews',
    column: 'in_progress',
    at: '2026-10-29T11:00:00Z',
  }),
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
  'an empty query with only the Hydra badge lists the live tasks by latest activity',
  () => {
    assert.deepEqual(
      listed({
        text: '',
        found: [],
      }),
      [
        [
          'Recent tasks',
          [
            'task:fresh',
            'task:old',
          ],
        ],
      ],
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
