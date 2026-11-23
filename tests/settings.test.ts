import { readSettings, saveSettings, settingsLogPath } from '#settings/store.ts'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { startOthrys, until, type Titan, type Othrys } from './setup/othrys.ts'

let othrys: Othrys

beforeAll(async () => {
  othrys = await startOthrys()
})

const settings = async ({ hydra }: { hydra: Titan }) => (await hydra.owner({
  args: [
    'settings',
    'show',
  ],
})).settings

const pageSettings = () => othrys.home().settings.settings

const projectWidth = async ({ hydra }: { hydra: Titan }) => {
  const { view } = await hydra.owner({
    args: [
      'view',
      'show',
    ],
  })

  return view.workspace.projectWidths.ideas ?? null
}

test(
  'shared settings reach other Titans and their pages, saved 24-hour retention survives a restart, and dragged widths stay local',
  async () => {
    const first = await othrys.hydra()
    const second = await othrys.hydra()

    expect((await first.owner({
      args: [
        'settings',
        'schema',
      ],
    })).defaults.doneAfterHours).toBe(1)

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
    })).toMatchObject({
      settings: {
        theme: 'dark',
        doneAfterHours: 0,
      },
    })
    page.close()

    const defaultWidth = await projectWidth({ hydra: second })
    await first.owner({
      args: [
        'view',
        'set',
        '--json',
        '{"workspace":{"projectWidths":{"ideas":600}}}',
      ],
    })
    expect(await projectWidth({ hydra: first })).toBe(600)
    expect(await projectWidth({ hydra: second })).toBe(defaultWidth)

    await first.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"doneAfterHours":24}',
      ],
    })
    await othrys.restart()
    expect(await settings({ hydra: second })).toMatchObject({
      theme: 'dark',
      doneAfterHours: 24,
    })
    await until({
      what: 'the page settings to show 24-hour retention after restart',
      check: () => pageSettings()?.doneAfterHours === 24,
    })
    expect(await projectWidth({ hydra: first })).toBe(600)
  },
)

test(
  'settings refuse unknown keys and invalid values without saving, and a repeated event id saves once without undoing a newer edit',
  async () => {
    const hydra = await othrys.hydra()
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
      '{"keyboard":{"bindings":{}}}',
      '{"defaultColumnWidth":460}',
      '{"defaultColumnWidths":{"ideas":460}}',
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
    const hydra = await othrys.hydra()
    const shown = async () => await hydra.owner({
      args: [
        'settings',
        'show',
      ],
    })
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

test(
  'hiding Titans is shared page state that a restart writes back into an older build\'s page row, and preserves their tasks and workers',
  async () => {
    const first = await othrys.hydra()
    const second = await othrys.hydra()
    const { worker } = await first.startTask({ key: 'kept' })
    const before = await first.owner({
      args: [
        'task',
        'show',
        'kept',
      ],
    })
    await first.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({
          hiddenHydras: [
            first.id,
            second.id,
          ],
        }),
      ],
    })
    expect((await settings({ hydra: second })).hiddenHydras).toEqual([
      first.id,
      second.id,
    ])
    await until({
      what: 'hidden Titan ids on the page',
      check: () => JSON.stringify(pageSettings()?.hiddenHydras) === JSON.stringify([
        first.id,
        second.id,
      ]),
    })
    expect(await first.owner({
      args: [
        'task',
        'show',
        'kept',
      ],
    })).toEqual(before)

    await first.owner({
      args: [
        'reply',
        'kept',
        '--text',
        'Continue while hidden',
      ],
    })
    await until({
      what: 'the hidden Titan worker receiving a reply',
      check: () => worker.received.some(text => text.includes('Continue while hidden')),
    })

    for (const hiddenHydras of [
      true,
      ['bad id'],
      [
        first.id,
        first.id,
      ],
    ]) {
      expect((await first.ownerRefused({
        args: [
          'settings',
          'set',
          '--json',
          JSON.stringify({ hiddenHydras }),
        ],
      })).code).toBe('VALIDATION_ERROR')
    }

    await othrys.restart()
    expect((await settings({ hydra: first })).hiddenHydras).toEqual([
      first.id,
      second.id,
    ])
    await until({
      what: 'the restarted server to give the page\'s row the hidden Titan ids again',
      check: () => JSON.stringify(pageSettings()?.hiddenHydras) === JSON.stringify([
        first.id,
        second.id,
      ]),
    })
    await first.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"hiddenHydras":[]}',
      ],
    })
    expect((await settings({ hydra: second })).hiddenHydras).toEqual([])
  },
)

test(
  'layout reset removes project widths and keeps card heights',
  async () => {
    const hydra = await othrys.hydra()
    const task = await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Sized card',
      ],
    })
    await hydra.owner({
      args: [
        'view',
        'set',
        '--json',
        JSON.stringify({
          workspace: { projectWidths: { ideas: 944 } },
          cardHeights: { [task.card.id]: 640 },
        }),
      ],
    })
    expect(await hydra.owner({
      args: [
        'layout',
        'show',
      ],
    })).toMatchObject({
      widths: { projects: { ideas: 944 } },
    })
    const reset = await hydra.owner({
      args: [
        'layout',
        'reset',
        '--all',
      ],
    })
    expect(reset.hydras).toContainEqual(expect.objectContaining({ hydra: hydra.id }))
    const { view } = await hydra.owner({
      args: [
        'view',
        'show',
      ],
    })
    expect(view.workspace.projectWidths).toEqual({})
    expect(view.cardHeights[task.card.id]).toBe(640)
  },
)

test(
  'concurrent settings saves keep the revision guard until their dependent write settles',
  async () => {
    await saveSettings({
      patch: { theme: 'dark' },
      meta: {
        at: new Date().toISOString(),
        actor: 'cli',
      },
    })
    const revision = readSettings().revision
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const first = saveSettings({
      patch: { theme: 'light' },
      meta: {
        id: 'concurrent-settings-a',
        at: new Date().toISOString(),
        actor: 'cli',
        ifRevision: revision,
      },
      beforeSave: () => {
        entered.resolve()

        return gate.promise
      },
    })

    try {
      const phase = await Promise.race([
        entered.promise.then(() => 'waiting'),
        first,
      ])
      expect(phase).toBe('waiting')
      expect(readSettings().settings.theme).toBe('dark')
      const second = saveSettings({
        patch: { theme: 'dark' },
        meta: {
          id: 'concurrent-settings-b',
          at: new Date().toISOString(),
          actor: 'cli',
          ifRevision: revision,
        },
      })
      gate.resolve()
      const results = await Promise.allSettled([
        first,
        second,
      ])
      expect(results[0]?.status).toBe('fulfilled')
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: { code: 'REVISION_CONFLICT' },
      })
      expect(readSettings().settings.theme).toBe('light')
    } finally {
      gate.resolve()
      await Promise.allSettled([first])
    }
  },
)

test(
  'existing serialized layout and hidden-Titan settings survive the rebrand without conversion',
  async () => {
    const hydra = await othrys.hydra()
    const before = await settings({ hydra })
    await othrys.restart({
      whileStopped: () => {
        const path = settingsLogPath()
        mkdirSync(
          dirname(path),
          { recursive: true },
        )
        appendFileSync(
          path,
          `${JSON.stringify({
            v: 1,
            id: 'legacy-preference-keys',
            at: new Date().toISOString(),
            actor: 'cli',
            before: {},
            after: {
              defaultHydraWidth: 612,
              hiddenHydras: [hydra.id],
            },
          })}\n`,
        )
      },
    })

    try {
      expect(await settings({ hydra })).toMatchObject({
        defaultHydraWidth: 612,
        hiddenHydras: [hydra.id],
      })
      await until({
        what: 'the page to retain persisted legacy preference keys',
        check: () => {
          const saved = pageSettings()

          return saved?.defaultHydraWidth === 612 && saved?.hiddenHydras.includes(hydra.id)
        },
      })
    } finally {
      await hydra.owner({
        args: [
          'settings',
          'set',
          '--json',
          JSON.stringify({
            defaultHydraWidth: before.defaultHydraWidth,
            hiddenHydras: before.hiddenHydras,
          }),
        ],
      })
    }
  },
)
