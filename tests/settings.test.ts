import { beforeAll, expect, test } from 'vitest'
import { rows, startPnyx, type Hydra, type Pnyx } from './setup/pnyx.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx()
})

const settings = async ({ hydra }: { hydra: Hydra }) => (await hydra.owner({
  args: [
    'settings',
    'show',
  ],
})).settings

// The shared settings row the page reads through Zero.
const pageSettings = () => rows<{ value: Record<string, unknown> }>({ text: 'select value from settings where id = \'shared\'' })[0]?.value

const queuedWidth = async ({ hydra }: { hydra: Hydra }) => {
  const { view } = await hydra.owner({
    args: [
      'view',
      'show',
    ],
  })
  const queued = (await hydra.owner({
    args: [
      'column',
      'list',
    ],
  })).columns.find((column: { role: string }) => column.role === 'queued').id

  return view.columnWidths?.[queued] ?? view.defaultColumnWidths[queued]
}

test(
  'a shared setting changed from one Hydra is what every Hydra and its page read, while a column width stays with its own board',
  async () => {
    const first = await pnyx.hydra()
    const second = await pnyx.hydra()

    await first.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"theme":"dark","doneAfterHours":0}',
      ],
    })
    expect(await settings({ hydra: second })).toMatchObject({
      theme: 'dark',
      doneAfterHours: 0,
    })
    expect(pageSettings()).toMatchObject({
      theme: 'dark',
      doneAfterHours: 0,
    })
    const page = await second.page()
    expect(await page.send({
      name: 'settings',
      args: ['show'],
    })).toMatchObject({ settings: { theme: 'dark' } })
    page.close()

    const queued = (await first.owner({
      args: [
        'column',
        'list',
      ],
    })).columns.find((column: { role: string }) => column.role === 'queued').id
    await first.owner({
      args: [
        'column',
        'resize',
        queued,
        '--width',
        '600',
      ],
    })
    expect(await queuedWidth({ hydra: first })).toBe(600)
    expect(await queuedWidth({ hydra: second })).toBe(460)

    await pnyx.restart()
    expect(await settings({ hydra: second })).toMatchObject({ theme: 'dark' })
    expect(await queuedWidth({ hydra: first })).toBe(600)
  },
)

test(
  'settings refuse unknown keys and invalid values without saving, and a repeated event id saves once without undoing a newer edit',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"theme":"light"}',
      ],
    })
    const saved = await settings({ hydra })

    for (const patch of [
      '{"nope":1}',
      '{"theme":"purple"}',
      '{"logDays":0}',
    ]) {
      expect((await hydra.ownerRefused({
        args: [
          'settings',
          'set',
          '--json',
          patch,
        ],
      })).code).toBe('VALIDATION_ERROR')
    }

    expect(await settings({ hydra })).toEqual(saved)

    await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"theme":"dark"}',
        '--event-id',
        'theme-once',
      ],
    })
    await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"theme":"light"}',
      ],
    })
    const retried = await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"theme":"dark"}',
        '--event-id',
        'theme-once',
      ],
    })
    expect(retried.event).toBe('none: duplicate')
    expect((await settings({ hydra })).theme).toBe('light')
  },
)
