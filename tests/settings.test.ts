import { beforeAll, expect, test } from 'vitest'
import { rows, startPnyx, until, type Hydra, type Pnyx } from './setup/pnyx.ts'

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
    await until({
      what: 'the page\'s settings row to hold the change',
      check: () => pageSettings()?.theme === 'dark' && pageSettings()?.doneAfterHours === 0,
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
    const defaultWidth = await queuedWidth({ hydra: second })
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
    expect(await queuedWidth({ hydra: second })).toBe(defaultWidth)

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

test(
  'a settings change made against a stale revision is refused and saves nothing, and the current revision saves it',
  async () => {
    const hydra = await pnyx.hydra()
    const shown = async () => (await hydra.owner({
      args: [
        'settings',
        'show',
      ],
    }))
    const before = await shown()
    const stale = before.revision as number
    // Both values are valid themes; the change must differ from what an earlier test saved.
    const [
      changed,
      other,
    ] = before.settings.theme === 'dark' ? [
      'light',
      'dark',
    ] : [
      'dark',
      'light',
    ]
    await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({ theme: changed }),
      ],
    })
    const current = (await shown()).revision as number
    expect(current).toBeGreaterThan(stale)

    expect((await hydra.ownerRefused({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({ theme: other }),
        '--if-revision',
        String(stale),
      ],
    })).code).toBe('REVISION_CONFLICT')
    expect((await shown()).settings.theme).toBe(changed)

    await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({ theme: other }),
        '--if-revision',
        String(current),
      ],
    })
    expect((await shown()).settings.theme).toBe(other)
  },
)
