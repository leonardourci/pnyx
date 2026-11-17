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
        project: 'Old launch documentation and research notes',
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
        'Old launch documentation and research notes',
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
      const legacy = workspace.locator('.project-column[aria-label="Ideas"] .task-label')
      expect(await legacy.evaluate(({
        scrollWidth,
        clientWidth,
      }) => scrollWidth <= clientWidth)).toBe(true)
      expect(await workspace.locator('.project-column').count()).toBe(2)
    } finally {
      await page.context().close()
    }
  },
)

test(
  'dragging reorders calmly and only Shift nests a task',
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
      const connected = page.locator(`[data-hydra-workspace="${hydra.id}"][data-connected=true]`)
      await connected.waitFor()
      const instruction = page.getByText(
        'Hold Shift and drop on a task to make it a sub-task',
        { exact: true },
      )
      expect(await instruction.count()).toBe(0)
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
        from.x + 32,
        from.y + 13,
        { steps: 5 },
      )
      const ghost = page.locator('.physical-ghost')
      await ghost.waitFor()
      await page.evaluate(() => new Promise<void>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }))
      expect((await cards.allTextContents()).join('|')).toBe('First task|Second task|Third task')
      expect(await instruction.count()).toBe(1)
      expect(await instruction.isVisible()).toBe(true)
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
      expect(await instruction.count()).toBe(0)
      expect((await hydra.task({ key: 'c' })).parent).toBe('none')
      await page.reload()
      await until({
        what: 'saved card order',
        check: async () => (await cards.allTextContents()).join('|') === 'Third task|First task|Second task',
      })
      await connected.waitFor()

      const keyboardMove = async ({
        key,
        expected,
      }: {
        key: string
        expected: string
      }) => {
        await first.hover()
        const grip = first.locator('xpath=ancestor::article').getByRole(
          'button',
          {
            name: 'Move First task',
            exact: true,
          },
        )
        await grip.focus()
        await page.keyboard.press('Space')
        await ghost.waitFor()
        await page.evaluate(() => new Promise<void>(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        }))
        await page.keyboard.press(key)
        await until({
          what: 'keyboard movement changes the rendered order',
          check: async () => (await cards.allTextContents()).join('|') === expected,
        })
        await page.keyboard.press('Enter')
        await ghost.waitFor({ state: 'detached' })
        await page.reload()
        await until({
          what: 'keyboard order persists after reload',
          check: async () => (await cards.allTextContents()).join('|') === expected,
        })
        await connected.waitFor()
      }

      await keyboardMove({
        key: 'ArrowDown',
        expected: 'Third task|Second task|First task',
      })
      await keyboardMove({
        key: 'ArrowUp',
        expected: 'Third task|First task|Second task',
      })
      await first.scrollIntoViewIfNeeded()
      await third.scrollIntoViewIfNeeded()
      const cancelledFrom = await first.boundingBox()
      const cancelledTo = await third.boundingBox()

      if (!cancelledFrom || !cancelledTo) {
        throw new Error('The drag cards are not visible after reload')
      }

      await page.mouse.move(
        cancelledFrom.x + 12,
        cancelledFrom.y + 8,
      )
      await page.mouse.down()
      await page.mouse.move(
        cancelledTo.x + 8,
        cancelledTo.y + 3,
        { steps: 15 },
      )
      await until({
        what: 'valid preview before cancelling the drag',
        check: async () => (await cards.allTextContents()).join('|') === 'First task|Third task|Second task',
      })
      await page.mouse.move(
        0,
        0,
      )
      await page.mouse.up()
      await ghost.waitFor({ state: 'detached' })
      await page.reload()
      await until({
        what: 'dropping outside the workspace preserves saved order',
        check: async () => (await cards.allTextContents()).join('|') === 'Third task|First task|Second task',
      })
      const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)
      const coordinator = await hydra.chat({ text: 'Coordinate the release tasks' })
      await hydra.as({ session: coordinator }).run({
        args: [
          'task',
          'ask',
          'a',
          '--to',
          'owner',
          '--question',
          'Choose a release direction?',
          '--reason',
          'The owner chooses the release direction',
        ],
      })
      const parent = first.locator('xpath=ancestor::article')
      await parent.locator('.agent-activity').filter({ hasText: /needs you/i })
        .waitFor()
      await first.click()
      await parent.locator('.worker-chat').waitFor()
      await connected.waitFor()

      const dragOverParent = async ({
        releaseShift,
        cancel = false,
      }: {
        releaseShift: boolean
        cancel?: boolean
      }) => {
        await third.hover({
          position: {
            x: 12,
            y: 8,
          },
        })
        const source = await third.boundingBox()

        if (!source) {
          throw new Error('The nesting cards are not visible')
        }

        await page.mouse.down()
        await page.mouse.move(
          source.x + 32,
          source.y + 8,
          { steps: 5 },
        )
        await ghost.waitFor()
        await page.keyboard.down('Shift')
        const target = await parent.boundingBox()
        const visible = await parent.locator('xpath=ancestor::*[contains(@class, "project-cards")]').boundingBox()

        if (!target || !visible) {
          throw new Error('The open parent is not visible')
        }

        await page.mouse.move(
          Math.max(
            visible.x,
            target.x,
          ) + Math.min(
            visible.width,
            target.width,
          ) / 2,
          (Math.max(
            target.y,
            visible.y,
          ) + Math.min(
            target.y + target.height,
            visible.y + visible.height,
          )) / 2,
          { steps: 16 },
        )
        await until({
          what: 'Shift arms the open parent as a nesting target',
          check: async () => await parent.getAttribute('data-nest-armed') === 'true',
        })

        if (releaseShift) {
          await page.keyboard.up('Shift')
        }

        if (cancel) {
          await page.keyboard.press('Escape')
        }

        const nests = !releaseShift && !cancel
        const original = nests ? await ghost.boundingBox() : null
        const shrinking = nests ? page.evaluate(async () => {
          const widths: number[] = []

          for (let frame = 0; frame < 20; frame++) {
            await new Promise(requestAnimationFrame)
            const node = document.querySelector('.physical-ghost')
            const width = node?.getBoundingClientRect().width

            if (width) {
              widths.push(width)
            }
          }

          return widths
        }) : null

        const release = async () => {
          await page.mouse.up()
          await page.keyboard.up('Shift')
        }

        const [widths] = await Promise.all([
          shrinking,
          release(),
        ])

        if (widths && original) {
          expect(Math.min(...widths)).toBeLessThan(original.width * 0.75)
        }

        await ghost.waitFor({ state: 'detached' })
      }

      await dragOverParent({ releaseShift: true })
      expect((await hydra.task({ key: 'c' })).parent).toBe('none')
      await connected.waitFor()
      await dragOverParent({
        releaseShift: false,
        cancel: true,
      })
      expect((await hydra.task({ key: 'c' })).parent).toBe('none')
      expect(await parent.locator('.worker-chat').isVisible()).toBe(true)
      await dragOverParent({ releaseShift: false })
      const parentId = (await hydra.task({ key: 'a' })).id
      await until({
        what: 'Shift-drop nests under the open parent in another state group',
        check: async () => (await hydra.task({ key: 'c' })).parent === parentId,
      })
      const nested = workspace.getByRole(
        'button',
        {
          name: 'Third task',
          exact: true,
        },
      )
      await nested.waitFor()
      await until({
        what: 'the nested card appears after the shrink',
        check: () => nested.evaluate(({ parentElement }) => {
          const row = parentElement?.closest('[data-child]')

          return !!row && Number(getComputedStyle(row).opacity) === 1
        }),
      })
      await connected.waitFor()
      await nested.hover({
        position: {
          x: 12,
          y: 8,
        },
      })
      const source = await nested.boundingBox(), project = await workspace.locator('[data-column=ideas]').boundingBox()

      if (!source || !project) {
        throw new Error('The nested task is not visible')
      }

      await page.mouse.down()
      await page.mouse.move(
        source.x + 32,
        source.y + 8,
        { steps: 5 },
      )
      await ghost.waitFor()
      await page.mouse.move(
        project.x + project.width - 20,
        project.y + project.height - 20,
        { steps: 16 },
      )
      await page.mouse.up()
      await ghost.waitFor({ state: 'detached' })
      expect((await hydra.task({ key: 'c' })).parent).toBe(parentId)
      expect(await parent.locator('.worker-chat').isVisible()).toBe(true)
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
          name: 'Fold chat',
          exact: true,
        },
      ).click()
      await workspace.locator('.workspace-chat.collapsed').waitFor()
      await page.getByRole(
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
      await page.getByRole(
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
      await workspace.locator('.workspace-chat.collapsed').waitFor()
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
      await page.getByRole(
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
      const identity = await hydra.owner({
        args: [
          'hydra',
          'show',
        ],
      })
      const name = identity.hydra.name
      await page.getByRole(
        'button',
        {
          name: 'Oracle',
          exact: true,
        },
      ).click()
      await page.getByRole(
        'combobox',
        {
          name: 'Oracle',
          exact: true,
        },
      ).fill('kind:conversations')
      await page.getByRole('option').filter({ hasText: 'Conversations' })
        .click()
      await page.getByRole('option').filter({ hasText: `${name}’s chat` })
        .click()
      await until({
        what: 'Oracle opens the folded chat from Settings',
        check: async () => page.url().endsWith(`/hydra/${hydra.id}/`)
          && await workspace.locator('.workspace-chat:not(.collapsed)').count() === 1,
      })

      await draft.waitFor()
      expect(await draft.inputValue()).toBe('Keep my unsent reply')
    } finally {
      await page.context().close()
    }
  },
)

test(
  'an open card fills its project row and the surrounding rows have no gaps',
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
        what: 'the open row and partial rows before and after fill the project',
        check: async () => {
          const expanded = await open.boundingBox()
          const filled = await filler.locator('xpath=ancestor::article').boundingBox()
          const preceding = await workspace.getByRole(
            'button',
            {
              name: 'Fourth',
              exact: true,
            },
          ).locator('xpath=ancestor::article')
            .boundingBox()
          const grid = await workspace.locator('.project-card-grid').boundingBox()

          return !!expanded && !!filled && !!preceding && !!grid
            && Math.abs(expanded.width - grid.width) < 1
            && Math.abs(preceding.width - grid.width) < 1
            && Math.abs(filled.width - grid.width) < 1
            && preceding.y < expanded.y && filled.y >= expanded.y + expanded.height
        },
      })
    } finally {
      await page.context().close()
    }
  },
)

test(
  'project resizing starts only on the visible grip and persists a genuine drag',
  async () => {
    const hydra = await pnyx.hydra()
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })

    try {
      const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)
      const column = workspace.locator('[data-column=ideas]')
      const grip = workspace.getByRole(
        'separator',
        {
          name: 'Resize Ideas',
          exact: true,
        },
      )
      await grip.waitFor()
      await column.scrollIntoViewIfNeeded()
      const bounds = await column.boundingBox()

      if (!bounds) {
        throw new Error('The project is not visible')
      }

      const original = Number(await grip.getAttribute('aria-valuenow'))
      const edge = bounds.x + bounds.width - 2
      const top = bounds.y + 90
      await page.mouse.move(
        edge,
        top,
      )
      await page.mouse.down()
      await page.mouse.move(
        edge + 80,
        top,
        { steps: 8 },
      )
      expect(Number(await grip.getAttribute('aria-valuenow'))).toBe(original)
      await page.mouse.up()
      expect(Number(await grip.getAttribute('aria-valuenow'))).toBe(original)
      await grip.hover()
      const handle = await grip.boundingBox()

      if (!handle) {
        throw new Error('The resize grip is not visible')
      }

      await page.mouse.move(
        handle.x + handle.width / 2,
        handle.y + handle.height / 2,
      )
      await page.mouse.down()
      await page.mouse.move(
        handle.x + handle.width / 2 + 32,
        handle.y + handle.height / 2,
        { steps: 8 },
      )
      await until({
        what: 'the grip previews the held resize',
        check: async () => Number(await grip.getAttribute('aria-valuenow')) === original + 32,
      })
      await page.mouse.up()
      await until({
        what: 'the genuine resize is saved',
        check: async () => {
          const view = await hydra.owner({
            args: [
              'view',
              'show',
            ],
          })

          return view.view.workspace.projectWidths.ideas === original + 32
        },
      })
      await page.reload()
      await until({
        what: 'the project keeps its resized width after reload',
        check: async () => Number(await grip.getAttribute('aria-valuenow')) === original + 32,
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
      const workerComposer = workspace.locator('.worker-chat .composer')
      await workerComposer.getByLabel(
        'Insert files or images',
        { exact: true },
      ).setInputFiles({
        name: 'reply-context.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Synthetic worker attachment'),
      })
      await workerComposer.getByText(
        'reply-context.txt',
        { exact: true },
      ).waitFor()
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
      const delivered = worker.received.filter(text => text.includes('Send this reply once'))
      expect(delivered).toHaveLength(1)
      expect(delivered[0]).toContain('File: reply-context.txt')
      expect(delivered[0]).toContain('Synthetic worker attachment')
    } finally {
      await page.context().close()
    }
  },
)
