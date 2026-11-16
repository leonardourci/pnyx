import { beforeAll, expect, test } from 'vitest'
import { openHydra } from '../setup/browser.ts'
import { startPnyx, until, type Pnyx } from '../setup/pnyx.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx({ zeroCache: true })
})

test(
  'the open board follows a task live from Queued to In progress to Done as the CLI and its worker change it',
  async () => {
    const hydra = await pnyx.hydra()
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    await page.locator('[aria-label="Work columns"]').waitFor()
    const column = ({ title }: { title: string }) => page.locator(`[aria-label="Work columns"] [aria-label="${title}"]`)
    const folder = hydra.folder({ name: 'export' })

    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Ship the export',
        '--key',
        'export',
        '--folder',
        folder,
      ],
    })
    // A card is the article holding its title button.
    const shown = ({ title }: { title: string }) => page.locator(
      'article',
      {
        has: page.getByRole(
          'button',
          {
            name: title,
            exact: true,
          },
        ),
      },
    )
    await column({ title: 'Queued' }).locator(shown({ title: 'Ship the export' }))
      .waitFor()

    await hydra.owner({
      args: [
        'task',
        'start',
        'export',
      ],
    })
    await column({ title: 'In progress' }).locator(shown({ title: 'Ship the export' }))
      .waitFor()

    const worker = await hydra.agent({ cwd: folder })
    await hydra.as({ session: worker }).run({
      args: [
        'task',
        'status',
        'export',
        'done',
        '--note',
        'Export shipped',
      ],
    })
    await column({ title: 'Done' }).locator(shown({ title: 'Ship the export' }))
      .waitFor()
    expect(await shown({ title: 'Ship the export' }).count()).toBe(1)
  },
)

test(
  'a card\'s Activity opens on its newest updates and loads the older ones as the owner scrolls down to its creation',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Long history',
        '--key',
        'long',
      ],
    })

    // More updates than the 50 one read brings back, in one document.
    await hydra.owner({
      args: [
        'apply',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        version: 1,
        changes: Array.from(
          { length: 60 },
          (
            _,
            edit,
          ) => ({
            op: 'task.brief',
            task: 'long',
            brief: `Brief version ${edit + 1}`,
          }),
        ),
      }),
    })

    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    const shown = page.locator(
      'article',
      {
        has: page.getByRole(
          'button',
          {
            name: 'Long history',
            exact: true,
          },
        ),
      },
    )
    await shown.getByRole(
      'button',
      {
        name: 'Long history',
        exact: true,
      },
    ).click()
    await shown.getByRole(
      'tab',
      { name: 'Activity' },
    ).click()
    const updates = shown.locator('[aria-label="Task updates"]')
    await updates.getByText('Brief updated').first()
      .waitFor()
    expect(await updates.getByText('Created').count()).toBe(0)

    await updates.hover()
    await until({
      what: 'scrolling down to reach the task\'s creation',
      check: async () => {
        await page.mouse.wheel(
          0,
          2000,
        )

        return await updates.getByText('Created').count() > 0
      },
    })
    expect(await updates.getByText('Brief updated').count()).toBeGreaterThan(0)
  },
)

test(
  'a Hydra can be hidden and restored without closing its page or removing its work',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'visible-work',
        '--title',
        'Keep this work',
      ],
    })
    const name = (await hydra.owner({
      args: [
        'hydra',
        'show',
      ],
    })).hydra.name as string
    const held: (() => void)[] = []
    let refuse = true
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      prepare: ({ page }) => page.routeWebSocket(
        /\/ws\?/,
        // eslint-disable-next-line pnyx/object-params -- Playwright owns this callback's signature.
        socket => {
          const server = socket.connectToServer()
          // eslint-disable-next-line pnyx/object-params -- Playwright owns this callback's signature.
          socket.onMessage(message => {
            const sent = JSON.parse(String(message)) as {
              type?: string
              name?: string
              id?: string
              scope?: string
            }

            if (sent.type === 'command' && sent.name === 'settings') {
              held.push(() => {
                if (refuse) {
                  refuse = false
                  socket.send(JSON.stringify({
                    type: 'error',
                    scope: sent.scope,
                    id: sent.id,
                    error: 'Visibility refused',
                    saved: false,
                    code: 'VALIDATION_ERROR',
                  }))
                } else {
                  server.send(message)
                }
              })

              return
            }

            server.send(message)
          })
        },
      ),
    })
    const panel = page.getByRole(
      'region',
      {
        name: 'Hydras',
        exact: true,
      },
    )
    await panel.locator(`[data-hydra="${hydra.id}"]`).waitFor()
    await panel.locator(`[data-hydra="${hydra.id}"]`).hover()
    await panel.getByRole(
      'button',
      {
        name: `Hide ${name}`,
        exact: true,
      },
    ).click()
    await panel.locator(`[data-hydra="${hydra.id}"]`).waitFor({ state: 'detached' })
    await until({
      what: 'the held visibility write',
      check: () => held.length === 1,
    })
    held.shift()!()
    await panel.locator(`[data-hydra="${hydra.id}"]`).waitFor()
    await page.getByText(
      'Visibility refused',
      { exact: true },
    ).waitFor()
    await panel.locator(`[data-hydra="${hydra.id}"]`).hover()
    await panel.getByRole(
      'button',
      {
        name: `Hide ${name}`,
        exact: true,
      },
    ).click()
    await panel.locator(`[data-hydra="${hydra.id}"]`).waitFor({ state: 'detached' })
    await until({
      what: 'the accepted visibility write',
      check: () => held.length === 1,
    })
    held.shift()!()
    expect(page.url()).toContain(`/hydra/${hydra.id}/`)
    await page.getByRole(
      'button',
      {
        name: 'Keep this work',
        exact: true,
      },
    ).waitFor()
    await until({
      what: 'persisted Hydra visibility',
      check: async () => (await hydra.owner({
        args: [
          'settings',
          'show',
        ],
      })).settings.hiddenHydras.includes(hydra.id),
    })
    await page.reload()
    await page.getByRole(
      'button',
      {
        name: 'Keep this work',
        exact: true,
      },
    ).waitFor()
    await panel.getByRole(
      'button',
      {
        name: 'Show hidden Hydras',
        exact: true,
      },
    ).click()
    await panel.getByRole(
      'button',
      {
        name: `Restore ${name}`,
        exact: true,
      },
    ).waitFor()
    expect(await panel.locator(`[data-hydra="${hydra.id}"]`).count()).toBe(0)
    await panel.getByRole(
      'button',
      {
        name: `Restore ${name}`,
        exact: true,
      },
    ).click()
    await until({
      what: 'the restore visibility write',
      check: () => held.length === 1,
    })
    await panel.locator(`[data-hydra="${hydra.id}"]`).waitFor()
    held.shift()!()
    await panel.locator(`[data-hydra="${hydra.id}"]`).waitFor()
    await page.close()
  },
)

test(
  'the page reconciles tasks automatically after its data connection stops for authentication',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'recovery',
        '--title',
        'Before data recovery',
        '--brief',
        'Recovery details before',
      ],
    })
    let interrupt: (() => void) | undefined
    let connections = 0
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      prepare: async ({ page }) => {
        await page.routeWebSocket(
          /\/zero\//,
          // eslint-disable-next-line pnyx/object-params -- Playwright owns the route callback.
          socket => {
            connections++
            const server = socket.connectToServer()

            interrupt = () => {
              socket.send(JSON.stringify([
                'error',
                {
                  kind: 'AuthInvalidated',
                  message: 'Test access expired',
                },
              ]))
              server.close()
            }
          },
        )
      },
    })

    try {
      await page.getByRole(
        'button',
        {
          name: 'Before data recovery',
          exact: true,
        },
      ).click()
      await page.getByText(
        'Recovery details before',
        { exact: true },
      ).waitFor()
      expect(interrupt).toBeTypeOf('function')
      interrupt!()
      await hydra.owner({
        args: [
          'task',
          'rename',
          'recovery',
          '--title',
          'After data recovery',
        ],
      })
      await page.getByRole(
        'button',
        {
          name: 'After data recovery',
          exact: true,
        },
      ).waitFor()
      await hydra.owner({
        args: [
          'task',
          'brief',
          'recovery',
          '--brief',
          'Recovery details after',
        ],
      })
      await page.getByText(
        'Recovery details after',
        { exact: true },
      ).waitFor()
      await pnyx.restart()
      await hydra.owner({
        args: [
          'task',
          'rename',
          'recovery',
          '--title',
          'After server restart',
        ],
      })
      await page.getByRole(
        'button',
        {
          name: 'After server restart',
          exact: true,
        },
      ).waitFor()
      expect(connections).toBeGreaterThan(1)
      expect(await page.getByRole(
        'button',
        {
          name: 'Before data recovery',
          exact: true,
        },
      ).count()).toBe(0)
    } finally {
      await page.context().close()
    }
  },
)
