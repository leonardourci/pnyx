import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { openHydra } from '../setup/browser.ts'
import { startPnyx, until, type Pnyx } from '../setup/pnyx.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx({ zeroCache: true })
})

test(
  'the project view follows a task from queued through running to done in Ideas',
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
    await column({ title: 'Ideas' }).locator(shown({ title: 'Ship the export' }))
      .waitFor()
    await shown({ title: 'Ship the export' }).locator(
      '.agent-activity',
      { hasText: 'Queued' },
    )
      .waitFor()
    pnyx.claude.plan({
      hydra: hydra.id,
      hold: true,
      partial: 'Building the export',
    })

    await hydra.owner({
      args: [
        'task',
        'start',
        'export',
      ],
    })
    await column({ title: 'Ideas' }).locator(shown({ title: 'Ship the export' }))
      .locator(
        '.agent-activity',
        { hasText: 'Running' },
      )
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
    await column({ title: 'Ideas' }).locator(shown({ title: 'Ship the export' }))
      .locator(
        '.agent-activity',
        { hasText: 'Done' },
      )
      .waitFor()
    expect(await shown({ title: 'Ship the export' }).count()).toBe(1)
  },
)

test(
  'a card\'s Activity exposes recent changes and its creation through a long history',
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

      if (!interrupt) {
        throw new Error('The data connection did not open')
      }

      interrupt()
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

test(
  'repository grouping combines tasks while unmatched project values stay in Ideas',
  async () => {
    const hydra = await pnyx.hydra()
    const root = hydra.folder({ name: 'grouping' })
    const api = join(
        root,
        'api',
      ), web = join(
        root,
        'web',
      ), docs = join(
        root,
        'docs',
      )
    mkdirSync(
      join(
        api,
        '.git',
      ),
      { recursive: true },
    )
    mkdirSync(
      join(
        web,
        '.git',
      ),
      { recursive: true },
    )
    mkdirSync(
      join(
        docs,
        '.git',
      ),
      { recursive: true },
    )
    await hydra.owner({
      args: [
        'project',
        'add',
        api,
      ],
    })
    await hydra.owner({
      args: [
        'project',
        'add',
        web,
      ],
    })
    await hydra.owner({
      args: [
        'project',
        'add',
        docs,
      ],
    })
    await hydra.owner({
      args: [
        'project',
        'group',
        'Suite',
        api,
        web,
      ],
    })
    await hydra.owner({
      args: [
        'project',
        'group',
        'Suite',
        api,
        docs,
      ],
    })
    await hydra.owner({
      args: [
        'push',
        '--key',
        'api',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        title: 'API work',
        project: api,
        tags: ['Backend'],
      }),
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'web',
        '--title',
        'Web work',
        '--project',
        web,
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'docs',
        '--title',
        'Docs work',
        '--project',
        docs,
      ],
    })
    await hydra.owner({
      args: [
        'push',
        '--key',
        'idea',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        title: 'Unassigned work',
        project: 'Old notes',
      }),
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })

    try {
      const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)
      const suite = workspace.locator('.project-column[aria-label="Suite"]')
      await suite.getByRole(
        'button',
        {
          name: 'Docs work',
          exact: true,
        },
      ).waitFor()
      await until({
        what: 'all grouped repository tasks',
        check: async () => (await suite.locator('.card-open').allTextContents()).join('|') === 'API work|Web work|Docs work',
      })
      await workspace.locator('.project-column[aria-label="Ideas"]').getByRole(
        'button',
        {
          name: 'Unassigned work',
          exact: true,
        },
      )
        .waitFor()
      expect(await suite.getByText(
        'api',
        { exact: true },
      ).isVisible()).toBe(true)
      expect(await suite.getByText(
        'Backend',
        { exact: true },
      ).isVisible()).toBe(true)
      expect(await workspace.getByText(
        'Old notes',
        { exact: true },
      ).isVisible()).toBe(true)
      await suite.getByRole(
        'button',
        {
          name: 'API work',
          exact: true,
        },
      ).click()
      expect(await suite.getByText(
        'Backend',
        { exact: true },
      ).isVisible()).toBe(true)
      await suite.getByRole(
        'button',
        {
          name: 'API work',
          exact: true,
        },
      ).click()
      expect(await suite.getByText(
        'Backend',
        { exact: true },
      ).isVisible()).toBe(true)
      expect(await workspace.locator('.project-column').count()).toBe(2)
    } finally {
      await page.context().close()
    }
  },
)

test(
  'visual arrangement changes card order and survives reload',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'a',
        '--title',
        'First task',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'b',
        '--title',
        'Second task',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'c',
        '--title',
        'Third task',
      ],
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })

    try {
      const cards = page.locator(`[data-hydra-workspace="${hydra.id}"] .project-column[aria-label="Ideas"] .card-open`)
      await until({
        what: 'initial card order',
        check: async () => (await cards.allTextContents()).join('|') === 'First task|Second task|Third task',
      })
      const first = cards.filter({ hasText: 'First task' })
      const third = cards.filter({ hasText: 'Third task' })
      await third.scrollIntoViewIfNeeded()
      await first.scrollIntoViewIfNeeded()
      const from = await third.boundingBox(), to = await first.boundingBox()

      if (!from || !to) {
        throw new Error('The drag cards are not visible')
      }

      await page.mouse.move(
        from.x + 12,
        from.y + 8,
      )
      await page.mouse.down()
      await page.mouse.move(
        to.x + 8,
        to.y + 3,
        { steps: 15 },
      )
      await until({
        what: 'cards slide aside while the pointer is still held',
        check: async () => {
          const moved = await first.boundingBox()

          return !!moved && moved.y > to.y + 1
            && (await cards.allTextContents()).join('|') === 'Third task|First task|Second task'
        },
      })
      const ghost = page.locator('.physical-ghost')
      const lifted = await ghost.boundingBox()

      if (!lifted) {
        throw new Error('The lifted card is not visible')
      }

      expect(lifted.y).toBeLessThan(from.y)
      await until({
        what: "the following card fills the dragged card's original position",
        check: async () => {
          const filled = await cards.filter({ hasText: 'Second task' }).boundingBox()

          return !!filled && filled.y >= from.y - 3
        },
      })
      await page.mouse.up()
      await ghost.waitFor({ state: 'detached' })
      await page.reload()
      await until({
        what: 'saved card order',
        check: async () => (await cards.allTextContents()).join('|') === 'Third task|First task|Second task',
      })
    } finally {
      await page.context().close()
    }
  },
)

test(
  'sub-tasks keep state order while folding and Settings preserve the open card and draft',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'draft',
        '--title',
        'Keep this draft',
      ],
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })

    try {
      const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)
      await workspace.getByRole(
        'button',
        {
          name: 'Keep this draft',
          exact: true,
        },
      ).click()
      const draft = workspace.getByRole(
        'textbox',
        {
          name: 'Message worker',
          exact: true,
        },
      )
      await draft.fill('Keep my unsent reply')
      const completed = await hydra.owner({
        args: [
          'task',
          'create',
          '--title',
          'Completed part',
          '--parent',
          'draft',
        ],
      })
      await hydra.owner({
        args: [
          'task',
          'status',
          completed.card.id,
          'done',
          '--note',
          'Part completed',
        ],
      })
      await hydra.owner({
        args: [
          'task',
          'create',
          '--title',
          'Waiting part',
          '--parent',
          'draft',
        ],
      })
      await until({
        what: 'unfinished sub-tasks before completed sub-tasks',
        check: async () => (await workspace.locator('.subtasks .card-open').allTextContents()).join('|') === 'Waiting part|Completed part',
      })
      const card = await workspace.locator('.card.selected').elementHandle()
      expect(card).not.toBeNull()
      await workspace.getByRole(
        'button',
        {
          name: 'Fold all projects',
          exact: true,
        },
      ).click()
      await workspace.locator('.project-column.folded').waitFor()
      await workspace.getByRole(
        'button',
        {
          name: 'Fold all projects',
          exact: true,
        },
      ).click()
      await draft.waitFor()
      expect(await draft.inputValue()).toBe('Keep my unsent reply')
      // eslint-disable-next-line pnyx/object-params -- Playwright passes the element.
      expect(await card?.evaluate(element => element.isConnected)).toBe(true)
      expect(await workspace.locator('.card.selected').count()).toBe(1)
      await workspace.getByRole(
        'button',
        {
          name: 'Settings',
          exact: true,
        },
      ).click()
      await page.waitForURL(`**/hydra/${hydra.id}/settings/`)
      await page.getByRole(
        'region',
        {
          name: 'Settings',
          exact: true,
        },
      ).waitFor()
      await workspace.getByRole(
        'button',
        {
          name: 'Close Settings',
          exact: true,
        },
      ).click()
      await page.waitForURL(`**/hydra/${hydra.id}/`)
      await page.goBack()
      await page.getByRole(
        'region',
        {
          name: 'Settings',
          exact: true,
        },
      ).waitFor()
      await page.goForward()
      await draft.waitFor()
      expect(await draft.inputValue()).toBe('Keep my unsent reply')
      // eslint-disable-next-line pnyx/object-params -- Playwright passes the element.
      expect(await card?.evaluate(element => element.isConnected)).toBe(true)
      await workspace.getByRole(
        'button',
        {
          name: 'Fold Hydra',
          exact: true,
        },
      ).click()
      await workspace.locator('.shell[hidden]').waitFor({ state: 'attached' })
      await workspace.getByRole(
        'button',
        {
          name: 'Unfold Hydra',
          exact: true,
        },
      ).click()
      await draft.waitFor()
      expect(await draft.inputValue()).toBe('Keep my unsent reply')
      // eslint-disable-next-line pnyx/object-params -- Playwright passes the element.
      expect(await card?.evaluate(element => element.isConnected)).toBe(true)
      await workspace.getByRole(
        'button',
        {
          name: 'Settings',
          exact: true,
        },
      ).click()
      await page.waitForURL(`**/hydra/${hydra.id}/settings/`)
      await page.reload()
      await page.getByRole(
        'region',
        {
          name: 'Settings',
          exact: true,
        },
      ).waitFor()
      await workspace.getByRole(
        'button',
        {
          name: 'Close Settings',
          exact: true,
        },
      ).click()
      await draft.waitFor()
      expect(await draft.inputValue()).toBe('Keep my unsent reply')
    } finally {
      await page.context().close()
    }
  },
)

test(
  'later cards fill space before and beside an open card',
  async () => {
    const hydra = await pnyx.hydra()
    const add = ({
      key,
      parent,
    }: {
      key: string
      parent?: string
    }) => hydra.owner({
      args: [
        'push',
        '--key',
        key,
        '--file',
        '-',
      ],
      input: JSON.stringify({
        title: key,
        parent,
      }),
    })
    await add({ key: 'First group' })
    await add({ key: 'Second' })
    await add({ key: 'Third' })
    await add({ key: 'Fourth' })
    await add({ key: 'Open this' })
    await add({ key: 'Fill the gap' })
    await add({
      key: 'First part',
      parent: 'First group',
    })
    await add({
      key: 'Second part',
      parent: 'First group',
    })
    await hydra.owner({
      args: [
        'view',
        'set',
        '--json',
        JSON.stringify({ workspace: { projectWidths: { ideas: 944 } } }),
      ],
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })

    try {
      const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)
      await workspace.getByRole(
        'button',
        {
          name: 'Sub-tasks of First group',
          exact: true,
        },
      ).click()
      await workspace.getByRole(
        'button',
        {
          name: 'Open this',
          exact: true,
        },
      ).click()
      const open = workspace.locator('.card.selected')
      const filler = workspace.getByRole(
        'button',
        {
          name: 'Fill the gap',
          exact: true,
        },
      )
      await until({
        what: 'a later card fills the earlier space beside the open family',
        check: async () => {
          const expanded = await open.boundingBox()
          const filled = await filler.boundingBox()

          return !!expanded && !!filled && filled.y < expanded.y
        },
      })
    } finally {
      await page.context().close()
    }
  },
)

test(
  'worker reply recovery delivers an uncertain reply once after reconnect',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'reply-recovery' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'reply',
        '--title',
        'Reply recovery',
        '--folder',
        folder,
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'start',
        'reply',
      ],
    })
    const worker = await hydra.agent({ cwd: folder })
    let lost = false
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      prepare: async ({ page }) => page.routeWebSocket(
        /\/ws\?/,
        // eslint-disable-next-line pnyx/object-params -- Playwright owns the route callback.
        socket => {
          const server = socket.connectToServer()
          // eslint-disable-next-line pnyx/object-params -- Playwright passes the frame.
          socket.onMessage(message => {
            const sent = JSON.parse(String(message)) as {
              type?: string
              name?: string
            }

            if (sent.type === 'command' && sent.name === 'reply' && !lost) {
              lost = true
              socket.close({
                code: 1001,
                reason: 'Lost reply receipt',
              })
            } else {
              server.send(message)
            }
          })
        },
      ),
    })

    try {
      const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)
      await workspace.getByRole(
        'button',
        {
          name: 'Reply recovery',
          exact: true,
        },
      ).click()
      await workspace.getByRole(
        'textbox',
        {
          name: 'Message worker',
          exact: true,
        },
      ).fill('Send this reply once')
      await workspace.getByRole(
        'button',
        {
          name: 'Send to worker',
          exact: true,
        },
      ).click()
      await until({
        what: 'reply received after reconnect',
        check: () => worker.received.some(text => text.includes('Send this reply once')),
      })
      await until({
        what: 'reconnected workspace',
        check: async () => await workspace.getAttribute('data-connected') === 'true',
      })
      await workspace.locator('.worker-messages').getByText(
        'Send this reply once',
        { exact: true },
      )
        .first()
        .waitFor()
      await until({
        what: 'reply delivery confirmed',
        check: async () => await workspace.locator('.worker-messages .message[data-sending=true]').count() === 0,
      })
      expect(lost).toBe(true)
      expect(worker.received.filter(text => text.includes('Send this reply once'))).toHaveLength(1)
    } finally {
      await page.context().close()
    }
  },
)
