import { beforeAll, expect, test } from 'vitest'
import { filterRows, prepareRow } from '#titan/suggestion-matches.ts'
import { startOthrys, type Othrys } from './setup/othrys.ts'

let othrys: Othrys

beforeAll(async () => {
  othrys = await startOthrys()
})

interface ModelsAnswer {
  models?: { value: string }[]
}

const values = ({ answer }: { answer: unknown }) => ((answer as ModelsAnswer).models ?? [])
  .map(model => model.value)

test(
  'models --refresh asks the harness again and keeps the list it had when that fails',
  async () => {
    const hydra = await othrys.hydra()
    const page = await hydra.page()
    const recorded = othrys.claude.models.list

    try {
      expect(values({
        answer: await page.send({
          name: 'models',
          args: ['claude'],
        }),
      })).toContain('haiku')
      othrys.claude.models.list = [
        ...recorded.filter(model => model.value !== 'haiku'),
        {
          value: 'claude-lyra-1',
          displayName: 'Lyra',
          description: 'A model the harness started listing',
        },
      ]
      expect(values({
        answer: await page.send({
          name: 'models',
          args: ['claude'],
        }),
      })).toContain('haiku')

      const refreshed = values({
        answer: await page.send({
          name: 'models',
          args: [
            'claude',
            '--refresh',
          ],
        }),
      })
      expect(refreshed).toContain('claude-lyra-1')
      expect(refreshed).not.toContain('haiku')

      othrys.claude.models.failure = 'Claude Code could not list its models'
      expect(await page.send({
        name: 'models',
        args: [
          'claude',
          '--refresh',
        ],
      })).toMatchObject({
        type: 'error',
        code: 'CATALOG_UNAVAILABLE',
      })
      expect(values({
        answer: await page.send({
          name: 'models',
          args: ['claude'],
        }),
      })).toEqual(refreshed)
    } finally {
      othrys.claude.models.failure = undefined
      othrys.claude.models.list = recorded
      page.close()
    }
  },
)

test(
  'title matches rank before fallback matches, then matches at the start, then words that start a word',
  () => {
    const rows = [
      prepareRow({
        item: {
          key: 'prompt',
          title: 'Water the plants',
        },
        fallback: 'Ship it on Friday',
      }),
      ...[
        {
          key: 'inside',
          title: 'Reship the build',
        },
        {
          key: 'word',
          title: 'Then ship the build',
        },
        {
          key: 'start',
          title: 'Shipping notes',
        },
      ].map(item => prepareRow({ item })),
    ]

    expect(filterRows({
      rows,
      query: 'ship',
    }).map(match => match.row.item.key)).toEqual([
      'start',
      'word',
      'inside',
      'prompt',
    ])
    expect(filterRows({
      rows,
      query: 'build reship',
    }).map(match => ({
      key: match.row.item.key,
      ranges: match.ranges.length,
    }))).toEqual([
      {
        key: 'inside',
        ranges: 11,
      },
    ])
  },
)

test(
  'a match marks each matched character once, also one that splits into several letters',
  () => {
    const rows = [
      prepareRow({
        item: {
          key: 'korean',
          title: '한국어 노트',
        },
      }),
    ]

    expect(filterRows({
      rows,
      query: '한국',
    }).map(match => match.ranges)).toEqual([
      [
        {
          from: 0,
          to: 1,
        },
        {
          from: 1,
          to: 2,
        },
      ],
    ])
  },
)
