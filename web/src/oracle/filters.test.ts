import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_COLUMNS } from '#tasks/column-defaults.ts'
import { addBadge, committedQuery, filterMenu, filterOptions, filterToken, hydraFilter, passes, queryText, type Filter } from './filters.ts'

const hydra = hydraFilter({
  hydra: {
    id: 'default',
    name: 'Zeus',
    icon: 'zeus',
  },
})
const options = filterOptions({
  hydra,
  columns: DEFAULT_COLUMNS,
  projects: [
    {
      name: 'billing-service',
      path: '/work/billing-service',
      references: ['/work/billing-service'],
      live: 0,
      asks: 0,
    },
  ],
})
const option = ({ id }: { id: string }) => options.find(filter => filter.id === id)!
const tasks = option({ id: 'kind:tasks' })
const settings = option({ id: 'kind:settings' })
const projects = option({ id: 'kind:projects' })
const queued = option({ id: 'column:queued' })
const inProgress = option({ id: 'column:in_progress' })
const today = option({ id: 'when:today' })
const week = option({ id: 'when:week' })
const billing = option({ id: 'project:/work/billing-service' })
const now = new Date(
  2026,
  9,
  29,
  15,
).getTime()
const yesterday = new Date(
  2026,
  9,
  28,
  23,
).toISOString()
const tonight = new Date(
  2026,
  9,
  29,
  1,
).toISOString()

const menu = ({
  query,
  badges = [hydra],
}: {
  query: string
  badges?: Filter[]
}) => filterMenu({
  token: filterToken({ query })!,
  badges,
  options,
}).map(filter => filter.id)

test(
  'a > token or a long form at the end of the query is the filter being typed, and the search reads the rest',
  () => {
    assert.deepEqual(
      filterToken({ query: 'deploy >prog' }),
      {
        text: '>prog',
        needle: 'prog',
      },
    )
    assert.deepEqual(
      filterToken({ query: 'in:Progress' }),
      {
        text: 'in:Progress',
        type: 'column',
        needle: 'progress',
      },
    )
    assert.equal(
      filterToken({ query: 'deploy >prog now' }),
      null,
      'a token followed by a space is plain text',
    )
    assert.equal(
      filterToken({ query: 'a>b' }),
      null,
    )
    assert.equal(
      queryText({ query: 'deploy staging >prog' }),
      'deploy staging',
    )
    assert.equal(
      committedQuery({ query: 'deploy >prog' }),
      'deploy ',
    )
    assert.equal(
      committedQuery({ query: '>prog' }),
      '',
    )
  },
)

test(
  'the menu matches the start of any word of a filter, and a long form only its own type',
  () => {
    assert.deepEqual(
      menu({ query: '>prog' }),
      ['column:in_progress'],
    )
    assert.deepEqual(
      menu({ query: '>week' }),
      ['when:week'],
    )
    assert.deepEqual(
      menu({ query: '>billing' }),
      ['project:/work/billing-service'],
    )
    assert.deepEqual(
      menu({ query: 'kind:s' }),
      ['kind:settings'],
    )
    assert.deepEqual(
      menu({ query: 'when:' }),
      [
        'when:today',
        'when:week',
      ],
    )
    assert.equal(
      menu({ query: '>' }).length,
      options.length - 1,
      'a bare > lists every filter not chosen yet',
    )
  },
)

test(
  'the menu offers only filters that still leave some result next to the badges',
  () => {
    const withSettings = menu({
      query: '>',
      badges: [
        hydra,
        settings,
      ],
    })

    assert.ok(
      !withSettings.includes(queued.id),
      'a column means tasks, which Settings rules out',
    )
    assert.ok(
      !withSettings.includes(today.id),
      'the time filter does not apply to settings',
    )
    assert.ok(
      withSettings.includes(tasks.id),
      'another kind means either',
    )

    const withColumn = menu({
      query: '>',
      badges: [
        hydra,
        queued,
      ],
    })

    assert.ok(
      withColumn.includes(inProgress.id),
      'a second column means either',
    )
    assert.ok(!withColumn.includes(projects.id))
    assert.ok(!withColumn.includes(settings.id))
    assert.ok(withColumn.includes(billing.id))
  },
)

test(
  'different types narrow together and badges of one type mean either',
  () => {
    const task = {
      kind: 'task' as const,
      hydra: 'default',
      column: 'queued',
      project: '/work/billing-service',
      at: tonight,
    }
    const badges = [
      hydra,
      queued,
      inProgress,
      billing,
    ]

    assert.ok(passes({
      item: task,
      badges,
      now,
    }))
    assert.ok(passes({
      item: {
        ...task,
        column: 'in_progress',
      },
      badges,
      now,
    }))
    assert.ok(!passes({
      item: {
        ...task,
        column: 'done',
      },
      badges,
      now,
    }))
    assert.ok(!passes({
      item: {
        ...task,
        project: '/work/other',
      },
      badges,
      now,
    }))
  },
)

test(
  'a badge keeps only results it applies to, and settings pass the Hydra badge',
  () => {
    const setting = { kind: 'setting' as const }
    const project = {
      kind: 'project' as const,
      hydra: 'default',
      project: '/work/billing-service',
    }

    assert.ok(passes({
      item: setting,
      badges: [hydra],
      now,
    }))
    assert.ok(
      !passes({
        item: setting,
        badges: [
          hydra,
          queued,
        ],
        now,
      }),
      'a column badge means tasks',
    )
    assert.ok(
      !passes({
        item: project,
        badges: [week],
        now,
      }),
      'the time filter excludes projects',
    )
    assert.ok(passes({
      item: project,
      badges: [billing],
      now,
    }))
    assert.ok(!passes({
      item: {
        kind: 'task',
        hydra: 'athena',
      },
      badges: [hydra],
      now,
    }))
  },
)

test(
  'Today starts at local midnight and This week covers the last seven days',
  () => {
    const task = ({ at }: { at: string }) => ({
      kind: 'task' as const,
      at,
    })

    assert.ok(passes({
      item: task({ at: tonight }),
      badges: [today],
      now,
    }))
    assert.ok(!passes({
      item: task({ at: yesterday }),
      badges: [today],
      now,
    }))
    assert.ok(
      passes({
        item: task({ at: yesterday }),
        badges: [
          today,
          week,
        ],
        now,
      }),
      'Today or This week',
    )
    assert.ok(!passes({
      item: task({
        at: new Date(
          2026,
          9,
          20,
        ).toISOString(),
      }),
      badges: [week],
      now,
    }))
  },
)

test(
  'Hydra badges lead the bar',
  () => {
    assert.deepEqual(
      addBadge({
        badges: [queued],
        filter: hydra,
      }).map(badge => badge.id),
      [
        hydra.id,
        queued.id,
      ],
    )
    assert.deepEqual(
      addBadge({
        badges: [hydra],
        filter: queued,
      }).map(badge => badge.id),
      [
        hydra.id,
        queued.id,
      ],
    )
  },
)
