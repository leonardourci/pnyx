import type { Locator, Page } from 'playwright-core'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { localToken } from '#app/server-state.ts'
import { zeroCookieName } from '#app/server-protocol.ts'
import { queries } from '#store/zero-schema.ts'
import { beginUIWindow, reportDragResponsiveness } from '../setup/ui-metrics.ts'
import { MOTION_DURATIONS } from '../../web/src/shared/motion.ts'
import { openHydra } from '../setup/browser.ts'
import { pnyxAxi, rows, startPnyx, until, type Pnyx } from '../setup/pnyx.ts'
import { readRows, zeroReady } from '../setup/zero.ts'

const WHEEL_REST_MS = 750

// The box of an element that has stopped moving: read the same twice in a row, as hover() waits for.
const restingBox = ({ target }: { target: Locator }) => {
  let previous = ''

  return until({
    what: 'the element to rest',
    check: async () => {
      const box = await target.boundingBox()
      const read = JSON.stringify(box)
      const moved = read !== previous

      previous = read

      if (!box || moved) {
        return undefined
      }

      return box
    },
  })
}

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx({ zeroCache: true })
})

test(
  'the project view follows a task from queued through running to done in Ideas',
  async () => {
    const hydra = await pnyx.hydra()
    let releasePause: (() => void) | undefined
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      prepare: ({ page }) => page.routeWebSocket(
        /\/ws\?/,
        // eslint-disable-next-line pnyx/object-params -- Playwright owns the socket callback.
        socket => {
          const server = socket.connectToServer()
          // eslint-disable-next-line pnyx/object-params -- Playwright owns the frame callback.
          socket.onMessage(message => {
            const frame = JSON.parse(String(message))

            if (frame.type === 'command' && frame.name === 'task' && frame.args?.[0] === 'hold') {
              releasePause = () => server.send(message)

              return
            }

            server.send(message)
          })
        },
      ),
    })
    await page.locator('[aria-label="Work columns"]').waitFor()
    const needsYou = await hydra.column({ role: 'needs_you' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Review the export',
        '--column',
        needsYou,
      ],
    })
    await page.getByRole(
      'button',
      {
        name: 'Review the export',
        exact: true,
      },
    ).waitFor()

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
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'pause-preview',
        '--title',
        'Pause preview',
      ],
    })
    await page.getByRole(
      'button',
      {
        name: 'Pause preview',
        exact: true,
      },
    ).click()
    await shown({ title: 'Pause preview' }).getByRole(
      'button',
      {
        name: 'Pause task',
        exact: true,
      },
    )
      .click()
    await until({
      what: 'pause request is withheld',
      check: () => !!releasePause,
    })
    await shown({ title: 'Pause preview' }).locator(
      '.agent-activity',
      { hasText: 'hold' },
    )
      .waitFor()
    releasePause!()
    await until({
      what: 'pause persists after confirmation',
      check: async () => !!(await hydra.task({ key: 'pause-preview' })).hold,
    })
    const confirmedSeq = rows<{ seq: number }>({
      text: 'select seq from hydras where id = $1',
      values: [hydra.id],
    })[0]!.seq
    await until({
      what: 'the client reads the confirmed hold',
      check: async () => Number(await page.locator(`[data-hydra-workspace="${hydra.id}"]`).getAttribute('data-seq')) >= confirmedSeq,
    })
    await shown({ title: 'Pause preview' }).locator(
      '.agent-activity',
      { hasText: 'hold' },
    )
      .waitFor()
    await page.reload()
    await shown({ title: 'Pause preview' }).locator(
      '.agent-activity',
      { hasText: 'hold' },
    )
      .waitFor()
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
    const recentUpdate = updates.getByText('Brief updated').first()
    await recentUpdate.waitFor()
    await recentUpdate.hover()
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
      const foldAll = workspace.getByRole(
        'button',
        {
          name: 'Fold all projects',
          exact: true,
        },
      )
      const inward = await foldAll.locator('svg').innerHTML()
      await suite.getByRole(
        'button',
        {
          name: 'Fold Suite',
          exact: true,
        },
      ).click()
      await foldAll.click()
      await until({
        what: 'fold-all finishes a partially folded Hydra',
        check: async () => await workspace.locator('.project-column.folded').count() === 2,
      })
      const unfoldAll = workspace.getByRole(
        'button',
        {
          name: 'Unfold all projects',
          exact: true,
        },
      )
      expect(await unfoldAll.locator('svg').innerHTML()).not.toBe(inward)
      await unfoldAll.click()
      await until({
        what: 'unfold-all opens every project',
        check: async () => await workspace.locator('.project-column.folded').count() === 0,
      })
      expect(await foldAll.locator('svg').innerHTML()).toBe(inward)
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
      const instruction = page.locator('[data-drag-column-hint]')
      expect(await instruction.count()).toBe(0)
      const first = cards.filter({ hasText: 'First task' })
      const third = cards.filter({ hasText: 'Third task' })
      await third.hover({
        position: {
          x: 12,
          y: 8,
        },
      })
      const from = await third.boundingBox(), to = await first.boundingBox()

      if (!from || !to) {
        throw new Error('The drag cards are not visible')
      }

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
      expect(await instruction.locator('kbd').textContent()).toBe('⇧ shift')
      await page.mouse.move(
        to.x + 84,
        to.y + 20,
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
      const travel = page.evaluate(async () => {
        const positions: {
          x: number
          y: number
        }[] = []

        for (let frame = 0; frame < 30; frame++) {
          const node = document.querySelector('.physical-ghost')

          if (!node) {
            break
          }

          const {
            x,
            y,
          } = node.getBoundingClientRect()
          positions.push({
            x,
            y,
          })
          await new Promise(requestAnimationFrame)
        }

        return positions
      })
      await page.mouse.up()
      const positions = await travel
      await ghost.waitFor({ state: 'detached' })
      const landing = await third.locator('xpath=ancestor::*[@data-family][1]').boundingBox()

      if (!landing) {
        throw new Error('The destination card is not visible')
      }

      const distances = positions.map(point => Math.hypot(
        point.x - landing.x,
        point.y - landing.y,
      ))
      const distance = distances[0]!
      expect(distance).toBeGreaterThan(20)
      const motionSettings = await page.evaluate(() => ({
        mode: document.documentElement.dataset.motion,
        duration: getComputedStyle(document.documentElement).getPropertyValue('--transition-duration-base'),
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      }))
      expect(
        distances.some(value => value > 2 && value < distance * 0.8),
        JSON.stringify({
          distances,
          motionSettings,
        }),
      ).toBe(true)
      expect(Math.max(...distances)).toBeLessThan(distance + 3)
      expect(distances.at(-1)).toBeLessThan(3)
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
        await until({
          what: 'the keyboard preview finishes moving',
          // eslint-disable-next-line pnyx/object-params -- Playwright owns the element callback.
          check: () => cards.evaluateAll(async elements => {
            const before = elements.map(element => element.getBoundingClientRect())
            await new Promise(requestAnimationFrame)
            await new Promise(requestAnimationFrame)

            return elements.every((
              element,
              index,
            ) => {
              const after = element.getBoundingClientRect()

              return before[index]?.x === after.x && before[index]?.y === after.y
            })
          }),
        })
        await page.keyboard.press('Enter')
        await ghost.waitFor({ state: 'detached' })
        await until({
          what: 'the keyboard arrangement reaches stored order',
          check: () => rows<{ title: string }>({
            text: "select title from cards where hydra_id = $1 and key in ('a', 'b', 'c') order by coalesce(rank, created_seq)",
            values: [hydra.id],
          }).map(card => card.title)
            .join('|') === expected,
        })
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
          '--context',
          `The direction determines the release scope. I will build it next. [Release](pnyx-task:${(await hydra.task({ key: 'a' })).id})`,
          '--choice',
          'Small release',
          '--choice',
          'Full release',
          '--recommend',
          '1',
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
        await until({
          what: 'the source and open parent to finish moving',
          check: async () => {
            const before = await Promise.all([
              parent.boundingBox(),
              third.boundingBox(),
            ])
            await page.evaluate(() => new Promise<void>(resolve => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            }))
            const after = await Promise.all([
              parent.boundingBox(),
              third.boundingBox(),
            ])

            return before.every((
              rect,
              index,
            ) => {
              const next = after[index]

              return rect && next && ([
                'x',
                'y',
                'width',
                'height',
              ] as const)
                .every(key => Math.abs(rect[key] - next[key]) < 0.5)
            })
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
        const preview = ghost.locator('[data-drag-preview]')
        const keycap = ghost.locator('[data-drag-nest-hint]')
        const fullWidth = (await preview.boundingBox())!.width
        const keycapWidth = (await keycap.boundingBox())!.width
        await page.keyboard.down('Shift')
        const target = await parent.boundingBox()
        const visible = await parent.locator('xpath=ancestor::*[contains(@class, "project-cards")]').boundingBox()

        if (!target || !visible) {
          throw new Error('The open parent is not visible')
        }

        const viewport = await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
        }))
        const point = {
          x: (Math.max(
            0,
            visible.x,
            target.x,
          ) + Math.min(
            viewport.width,
            visible.x + visible.width,
            target.x + target.width,
          )) / 2,
          y: (Math.max(
            0,
            target.y,
            visible.y,
          ) + Math.min(
            viewport.height,
            target.y + target.height,
            visible.y + visible.height,
          )) / 2,
        }
        await page.mouse.move(
          point.x,
          point.y,
          { steps: 16 },
        )
        await until({
          what: 'Shift arms the open parent as a nesting target',
          check: async () => await parent.getAttribute('data-nest-armed') === 'true',
        })

        await until({
          what: 'Shift-hover shrinks the lifted card into the parent',
          check: async () => (await preview.boundingBox())!.width < fullWidth * 0.9,
        })
        expect((await keycap.boundingBox())!.width).toBeCloseTo(
          keycapWidth,
          0,
        )

        const heading = await workspace.locator('[data-column-heading="ideas"]').boundingBox()

        if (!heading) {
          throw new Error('The project heading is not visible')
        }

        await page.mouse.move(
          heading.x + heading.width / 2,
          heading.y + heading.height / 2,
          { steps: 8 },
        )
        await until({
          what: 'leaving the parent restores the full lifted card',
          check: async () => Math.abs((await preview.boundingBox())!.width - fullWidth) < 1,
        })
        await page.mouse.move(
          point.x,
          point.y,
          { steps: 8 },
        )
        await until({
          what: 'returning over the parent shrinks the lifted card again',
          check: async () => (await preview.boundingBox())!.width < fullWidth * 0.9,
        })

        if (releaseShift) {
          await page.keyboard.up('Shift')
          await until({
            what: 'releasing Shift restores the full lifted card',
            check: async () => Math.abs((await preview.boundingBox())!.width - fullWidth) < 1,
          })
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
      const familyColumnWidth = 1024
      await hydra.owner({
        args: [
          'view',
          'set',
          '--json',
          JSON.stringify({workspace: {projectWidths: {ideas: familyColumnWidth}}}),
        ],
      })
      await until({
        what: 'the family shares a column wide enough for several closed cards',
        check: async () => (await workspace.locator('[data-column=ideas]').boundingBox())!.width >= familyColumnWidth - 1,
      })
      await first.click()
      await until({
        what: 'an expanded closed family owns its full row',
        check: async () => {
          const family = await parent.locator('xpath=ancestor::*[@data-family]').boundingBox()
          const grid = await workspace.locator('.project-card-grid').boundingBox()

          return !!family && !!grid && Math.abs(family.width - grid.width) < 1
        },
      })
      await first.click()
      await parent.locator('.worker-chat').waitFor()
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
      await hydra.owner({
        args: [
          'apply',
          '--file',
          '-',
        ],
        input: JSON.stringify({
          version: 1,
          changes: Array.from(
            { length: 80 },
            (
              _,
              index,
            ) => ({
              op: 'task.create',
              title: `Off-screen part ${index}`,
            }),
          ),
        }),
      })
      await workspace.getByRole(
        'button',
        {
          name: 'Fold all projects',
          exact: true,
        },
      ).focus()
      const scroller = workspace.locator('[data-column="ideas"] .column-cards')
      await until({
        what: 'the new off-screen rows reach the live column',
        // eslint-disable-next-line pnyx/object-params -- Playwright owns the element callback.
        check: () => scroller.evaluate(element => element.scrollHeight > 3000),
      })
      // eslint-disable-next-line pnyx/object-params -- Playwright owns the element callback.
      await scroller.evaluate(element => element.scrollTo({
        top: element.scrollHeight,
        behavior: 'instant',
      }))
      await until({
        what: 'an unfocused open family leaves the viewport',
        check: async () => await workspace.locator('.card.selected').count() === 0,
      })
      // eslint-disable-next-line pnyx/object-params -- Playwright owns the element callback.
      await scroller.evaluate(element => element.scrollTo({
        top: 0,
        behavior: 'instant',
      }))
      await draft.waitFor()
      expect(await draft.inputValue()).toBe('Keep my unsent reply')
      expect(await workspace.locator('.subtasks .card-open').allTextContents()).toEqual([
        'Waiting part',
        'Completed part',
      ])
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
          name: 'Unfold all projects',
          exact: true,
        },
      ).click()
      await draft.waitFor()
      expect(await draft.inputValue()).toBe('Keep my unsent reply')
      expect(await workspace.locator('.card.selected').count()).toBe(1)
      expect(await workspace.locator('.subtasks .card-open').allTextContents()).toEqual([
        'Waiting part',
        'Completed part',
      ])
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
      expect(await workspace.locator('.card.selected').count()).toBe(1)
      expect(await workspace.locator('.subtasks .card-open').allTextContents()).toEqual([
        'Waiting part',
        'Completed part',
      ])
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
      expect(await workspace.locator('.card.selected').count()).toBe(1)
      expect(await workspace.locator('.subtasks .card-open').allTextContents()).toEqual([
        'Waiting part',
        'Completed part',
      ])
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
  'a refused project task draft does not appear when creating an Idea',
  async () => {
    const hydra = await pnyx.hydra()
    const path = hydra.folder({ name: 'draft-project' })
    await hydra.owner({
      args: [
        'project',
        'add',
        path,
      ],
    })
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
              args?: string[]
              id?: string
              scope?: string
            }

            if (sent.type === 'command' && sent.name === 'task' && sent.args?.[0] === 'create') {
              socket.send(JSON.stringify({
                type: 'error',
                scope: sent.scope,
                id: sent.id,
                error: 'Task creation refused',
                saved: false,
                code: 'VALIDATION_ERROR',
              }))

              return
            }

            server.send(message)
          })
        },
      ),
    })

    try {
      const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)
      await workspace.getByRole(
        'button',
        {
          name: 'New task in draft-project',
          exact: true,
        },
      ).click()
      const form = workspace.locator('.task-create')
      await form.getByRole(
        'textbox',
        {
          name: 'Task title',
          exact: true,
        },
      ).fill('Project-only draft')
      await form.getByRole(
        'button',
        {
          name: 'Save task',
          exact: true,
        },
      ).click()
      await page.getByText(
        'Task creation refused',
        { exact: true },
      ).first()
        .waitFor()
      await form.getByRole(
        'textbox',
        {
          name: 'Task title',
          exact: true,
        },
      ).waitFor()
      await until({
        what: 'the refused project draft is restored',
        check: async () => await form.getByRole(
          'textbox',
          {
            name: 'Task title',
            exact: true,
          },
        ).inputValue() === 'Project-only draft'
          && await form.getByRole(
            'button',
            {
              name: 'Cancel',
              exact: true,
            },
          ).isEnabled(),
      })
      await form.getByRole(
        'button',
        {
          name: 'Cancel',
          exact: true,
        },
      ).click()
      await workspace.getByRole(
        'button',
        {
          name: 'New task in Ideas',
          exact: true,
        },
      ).click()
      expect(await form.getByRole(
        'textbox',
        {
          name: 'Task title',
          exact: true,
        },
      ).inputValue()).toBe('')
    } finally {
      await page.context().close()
    }
  },
)

test(
  'project resizing starts only on the visible grip and persists a genuine drag',
  async () => {
    const hydra = await pnyx.hydra()
    const widthWrites: unknown[] = []
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      prepare: ({ page }) => page.routeWebSocket(
        /\/ws\?/,
        // eslint-disable-next-line pnyx/object-params -- Playwright owns the socket callback.
        socket => {
          const server = socket.connectToServer()
          // eslint-disable-next-line pnyx/object-params -- Playwright owns the frame callback.
          socket.onMessage(message => {
            const frame = JSON.parse(String(message))

            if (frame.type === 'command' && frame.name === 'view' && frame.args[0] === 'set') {
              const json = frame.args.indexOf('--json')
              const widths = json >= 0 && JSON.parse(frame.args[json + 1]).workspace?.projectWidths

              if (widths) {
                widthWrites.push(widths)
              }
            }

            server.send(message)
          })
        },
      ),
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
      await grip.hover()
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
      await grip.focus()
      const cancelledHandle = await grip.boundingBox()

      if (!cancelledHandle) {
        throw new Error('Missing resize grip')
      }

      await page.mouse.move(
        cancelledHandle.x + cancelledHandle.width / 2,
        cancelledHandle.y + cancelledHandle.height / 2,
      )
      await page.mouse.down()
      await page.mouse.move(
        cancelledHandle.x + cancelledHandle.width / 2 + 64,
        cancelledHandle.y + cancelledHandle.height / 2,
      )
      await until({
        what: 'cancelled resize previews its width',
        check: async () => Number(await grip.getAttribute('aria-valuenow')) === original + 64,
      })
      await page.keyboard.press('Escape')
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
      expect(widthWrites).toEqual([{ ideas: original + 32 }])
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
              args?: string[]
            }

            if (sent.type === 'command' && sent.name === 'task' && sent.args?.[0] === 'send' && !lost) {
              lost = true
              server.send(message)
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
      expect(await workspace.locator('.worker-chat').getByRole(
        'combobox',
        {
          name: 'Repository',
          exact: true,
        },
      )
        .isVisible()).toBe(true)
      expect(await workspace.getByRole(
        'button',
        {
          name: 'Send to worker',
          exact: true,
        },
      ).isEnabled()).toBe(true)
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
test(
  'workspace shortcuts keep focus, order and chat inside their owning Hydra',
  async () => {
    const first = await pnyx.hydra()
    const second = await pnyx.hydra()
    const atlas = second.folder({ name: 'atlas-shortcuts' })
    const boreal = second.folder({ name: 'boreal-shortcuts' })
    await second.owner({
      args: [
        'project',
        'add',
        atlas,
      ],
    })
    await second.owner({
      args: [
        'project',
        'add',
        boreal,
      ],
    })
    await second.owner({
      args: [
        'task',
        'create',
        '--key',
        'done',
        '--title',
        'Finished task',
        '--project',
        atlas,
      ],
    })
    await second.owner({
      args: [
        'task',
        'status',
        'done',
        'done',
        '--note',
        'Finished',
      ],
    })
    const a = await second.owner({
      args: [
        'task',
        'create',
        '--key',
        'a',
        '--title',
        'Shortcut Atlas',
        '--project',
        atlas,
      ],
    })
    await second.owner({
      args: [
        'task',
        'create',
        '--key',
        'b',
        '--title',
        'Shortcut Boreal',
        '--project',
        atlas,
      ],
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: first.id,
    })
    const workspace = page.locator(`[data-hydra-workspace="${second.id}"]`)
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

    try {
      await page.locator(`.topbar [data-sort-kind="hydra"][data-sort-id="${second.id}"]`).click()
      const heading = workspace.locator('[data-column-heading="ideas"]')
      await heading.scrollIntoViewIfNeeded()
      await heading.focus()
      await page.keyboard.press('ArrowDown')
      // eslint-disable-next-line pnyx/object-params -- Playwright owns the element callback.
      expect(await heading.evaluate(element => element === document.activeElement)).toBe(true)
      const ideas = workspace.locator('button[data-sort-kind="project"][data-sort-id="ideas"]')
      expect(await ideas.getAttribute('aria-disabled')).not.toBe('true')
      const title = workspace.getByRole(
        'button',
        {
          name: 'Shortcut Atlas',
          exact: true,
        },
      )
      await title.focus()
      await page.keyboard.press(`${mod}+ArrowDown`)
      await until({
        what: 'task shortcut reorders within its status group',
        check: async () => {
          const cards = await workspace.locator(`[data-column="${atlas}"] .project-card-grid [data-card]`).allTextContents()

          return cards[0]?.includes('Shortcut Boreal') === true && cards[1]?.includes('Shortcut Atlas') === true
        },
      })
      await until({
        what: 'task shortcut reaches stored sibling order',
        check: () => rows<{ key: string }>({
          text: "select key from cards where hydra_id = $1 and key in ('a', 'b') order by coalesce(rank, created_seq)",
          values: [second.id],
        }).map(card => card.key)
          .join(',') === 'b,a',
      })
      await page.reload()
      await page.locator(`[data-hydra-workspace="${second.id}"][data-connected="true"]`).waitFor()
      await title.waitFor()
      const reloadedCards = await workspace.locator(`[data-column="${atlas}"] .project-card-grid [data-card]`).allTextContents()
      expect(reloadedCards[0]).toContain('Shortcut Boreal')
      expect(reloadedCards[1]).toContain('Shortcut Atlas')
      await page.getByRole(
        'button',
        {
          name: 'Settings',
          exact: true,
        },
      ).click()
      await page.locator(`[data-settings-hydra="${second.id}"] .settings-chips`).waitFor()
      await page.getByRole(
        'button',
        {
          name: 'Close Settings',
          exact: true,
        },
      ).click()

      const stored = await second.task({ key: a.card.id })
      expect(stored.project).toBe('atlas-shortcuts')
      const status = title.locator('xpath=ancestor::article').locator('.agent-activity')
      await status.focus()
      await page.getByRole('tooltip').filter({ hasText: 'no worker assigned' })
        .waitFor()
      const projectHeading = workspace.locator(`[data-column-heading="${boreal}"]`)
      await projectHeading.focus()
      await page.keyboard.press(`${mod}+ArrowLeft`)
      await until({
        what: 'project shortcut saves project order',
        check: async () => {
          const { view } = await second.owner({
            args: [
              'view',
              'show',
            ],
          })

          return view.workspace.projectOrder[0] === boreal
        },
      })
      await title.focus()
      await page.keyboard.press(`${mod}+b`)
      await until({
        what: 'chat shortcut folds the owning chat',
        check: async () => await workspace.locator('.workspace-chat.collapsed').count() === 1,
      })
      await page.keyboard.press(`${mod}+b`)
      await until({
        what: 'chat shortcut reveals the owning chat',
        check: async () => await workspace.locator('.workspace-chat:not(.collapsed)').count() === 1,
      })
      await second.owner({
        args: [
          'push',
          '--key',
          'a',
          '--file',
          '-',
        ],
        input: JSON.stringify({
          attention: [
            {
              kind: 'question',
              key: 'direction',
              blocking: true,
              text: 'Choose the direction',
            },
          ],
        }),
      })
      await title.click()
      await second.owner({
        args: [
          'view',
          'set',
          '--json',
          JSON.stringify({ workspace: { chatCollapsed: true } }),
        ],
      })
      await workspace.locator('.workspace-chat.collapsed').waitFor()
      await title.locator('xpath=ancestor::article').getByRole(
        'button',
        {
          name: 'Answer',
          exact: true,
        },
      )
        .click()
      await workspace.locator('.workspace-chat:not(.collapsed)').waitFor()
      expect(await workspace.getByRole(
        'textbox',
        {
          name: 'Reply to Hydra',
          exact: true,
        },
      ).inputValue()).toContain('Shortcut Atlas')
      await workspace.getByRole(
        'textbox',
        {
          name: 'Reply to Hydra',
          exact: true,
        },
      ).focus()
      await page.keyboard.press(`${mod}+,`)
      const settings = page.locator(`[data-settings-hydra="${second.id}"]`).getByRole(
        'region',
        {
          name: 'Settings',
          exact: true,
        },
      )
      await settings.getByRole(
        'navigation',
        { name: 'Settings sections' },
      ).getByRole(
        'button',
        {
          name: 'Keyboard',
          exact: true,
        },
      )
        .click()
      await until({
        what: 'the second Hydra settings scroll to their own Keyboard section',
        check: async () => {
          const section = await settings.locator('#settings-keyboard').boundingBox()
          const frame = await settings.boundingBox()

          return !!section && !!frame && section.y > frame.y && section.y < frame.y + frame.height
        },
      })
    } finally {
      await page.context().close()
    }
  },
)

test(
  'legacy grandchildren stay openable in their top-level family without rewriting parentage',
  async () => {
    const id = 'legacy-deep-family'
    const folder = join(
      process.env.PNYX_HOME!,
      'hydras',
      id,
    )
    mkdirSync(
      folder,
      { recursive: true },
    )
    const events = [
      {
        seq: 1,
        id: 'legacy-root',
        cardId: 'root',
        data: {
          key: 'root',
          title: 'Legacy family',
          project: 'root-project',
        },
      },
      {
        seq: 2,
        id: 'legacy-child',
        cardId: 'child',
        data: {
          key: 'child',
          title: 'Legacy child',
          project: 'child-project',
          parentId: 'root',
        },
      },
      {
        seq: 3,
        id: 'legacy-leaf',
        cardId: 'leaf',
        data: {
          key: 'leaf',
          title: 'Legacy grandchild',
          parentId: 'child',
        },
      },
      {
        seq: 4,
        id: 'legacy-peer',
        cardId: 'peer',
        data: {
          key: 'peer',
          title: 'Legacy sibling',
          parentId: 'child',
        },
      },
    ].map(event => JSON.stringify({
      v: 1,
      type: 'card.pushed',
      at: '2026-11-17T00:00:00Z',
      actor: 'cli',
      ...event,
    })).join('\n')
    writeFileSync(
      join(
        folder,
        'events.jsonl',
      ),
      `${events}\n`,
    )
    const hydra = await pnyx.hydra({
      id,
      create: false,
    })
    const project = hydra.folder({ name: 'root-project' })
    await hydra.owner({
      args: [
        'project',
        'add',
        project,
      ],
    })
    const digest = await pnyxAxi({
      args: [
        'hydra',
        'digest',
        '--hydra',
        id,
      ],
      env: process.env,
    })
    expect(digest.status).toBe(0)
    expect(digest.stdout).toContain(`${project} · root-project · 0 / 0 / 4 / 0`)
    const otherId = 'legacy-deep-family-other'
    const otherFolder = join(
      process.env.PNYX_HOME!,
      'hydras',
      otherId,
    )
    mkdirSync(
      otherFolder,
      { recursive: true },
    )
    writeFileSync(
      join(
        otherFolder,
        'events.jsonl',
      ),
      `${events}\n`,
    )
    await pnyx.hydra({
      id: otherId,
      create: false,
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: id,
    })

    try {
      const workspace = page.locator(`[data-hydra-workspace="${id}"]`)
      const otherWorkspace = page.locator(`[data-hydra-workspace="${otherId}"]`)
      expect(await otherWorkspace.locator('[data-family="root"]').count()).toBe(0)
      await page.locator(`[data-hydra-workspace="${id}"][data-connected="true"]`).waitFor()
      const root = workspace.getByRole(
        'button',
        {
          name: 'Legacy family',
          exact: true,
        },
      )
      await root.scrollIntoViewIfNeeded()
      const bounds = await root.boundingBox()

      if (!bounds) {
        throw new Error('The legacy family is not visible')
      }

      await page.mouse.move(
        bounds.x + 12,
        bounds.y + 8,
      )
      await page.mouse.down()
      await page.mouse.move(
        bounds.x + 32,
        bounds.y + 8,
      )
      await page.locator('.physical-ghost').waitFor()
      await otherWorkspace.scrollIntoViewIfNeeded()
      await otherWorkspace.locator('[data-family="root"]').waitFor({ state: 'attached' })
      expect(await workspace.locator('[data-family="root"]').getAttribute('data-drag-slot')).toBe('true')
      expect(await otherWorkspace.locator('[data-family="root"]').getAttribute('data-drag-slot')).toBe('false')
      await page.keyboard.press('Escape')
      await page.mouse.up()
      await page.locator('.physical-ghost').waitFor({ state: 'detached' })
      await page.locator(`.topbar [data-sort-kind="hydra"][data-sort-id="${id}"]`).click()
      await workspace.getByRole(
        'button',
        {
          name: 'Sub-tasks of Legacy family',
          exact: true,
        },
      ).click()
      const children = workspace.locator('[data-family="root"] [data-child]')
      const childIds = async () => Promise.all((await children.all()).map(child => child.getAttribute('data-child')))
      expect(await otherWorkspace.locator('[data-drag-slot=true], [data-nest-armed=true]').count()).toBe(0)
      const leaf = workspace.getByRole(
        'button',
        {
          name: 'Legacy grandchild',
          exact: true,
        },
      )
      const peer = workspace.getByRole(
        'button',
        {
          name: 'Legacy sibling',
          exact: true,
        },
      )
      await leaf.scrollIntoViewIfNeeded()
      const leafBounds = await leaf.boundingBox()
      const peerBounds = await peer.boundingBox()

      if (!leafBounds || !peerBounds) {
        throw new Error('Missing legacy children')
      }

      await page.mouse.move(
        leafBounds.x + 12,
        leafBounds.y + 8,
      )
      await page.mouse.down()
      await page.mouse.move(
        peerBounds.x + 12,
        peerBounds.y + peerBounds.height - 2,
        { steps: 12 },
      )
      await until({
        what: 'the dragged legacy child previews after its sibling',
        check: async () => (await childIds()).join(',') === 'child,peer,leaf',
      })
      expect(await otherWorkspace.locator('[data-drag-slot=true], [data-nest-armed=true]').count()).toBe(0)
      await page.keyboard.down('Shift')
      await page.locator('.physical-ghost [data-drag-nest-hint][data-shift=true]').waitFor()
      await root.hover()
      await until({
        what: 'the source Hydra alone shows the nesting outline',
        check: async () => await workspace.locator('.card[data-task="root"]').getAttribute('data-nest-armed') === 'true',
      })
      expect(await otherWorkspace.locator('[data-drag-slot=true], [data-nest-armed=true]').count()).toBe(0)
      await page.keyboard.press('Escape')
      await page.keyboard.up('Shift')
      await page.mouse.up()
      await page.locator('.physical-ghost').waitFor({ state: 'detached' })
      await workspace.getByRole(
        'button',
        {
          name: 'Legacy grandchild',
          exact: true,
        },
      ).click()
      await workspace.getByRole(
        'button',
        {
          name: 'Legacy grandchild',
          exact: true,
        },
      ).locator('xpath=ancestor::article')
        .locator('.worker-chat')
        .waitFor()
      expect((await hydra.task({ key: 'leaf' })).parent).toBe('child')
      await page.locator(`.topbar [data-sort-kind="hydra"][data-sort-id="${otherId}"]`).click()
      await otherWorkspace.getByRole(
        'button',
        {
          name: 'Sub-tasks of Legacy family',
          exact: true,
        },
      ).click()
      // eslint-disable-next-line pnyx/object-params -- Playwright owns the element-list callback.
      expect(await otherWorkspace.locator('[data-family="root"] [data-child]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-child')))).toEqual([
        'child',
        'leaf',
        'peer',
      ])
      await otherWorkspace.getByRole(
        'button',
        {
          name: 'Legacy grandchild',
          exact: true,
        },
      ).click()
      await until({
        what: 'the opened duplicate task stays visible in its own Hydra',
        check: () => otherWorkspace.locator('.card.selected[data-task="leaf"]').evaluate(
          // eslint-disable-next-line pnyx/object-params -- Playwright owns the element callback.
          element => {
            const bounds = element.getBoundingClientRect()

            return bounds.right > 0 && bounds.left < innerWidth
            && element.contains(document.activeElement)
          },
        ),
      })
    } finally {
      await page.context().close()
    }
  },
)
test(
  'Oracle keeps healthy Hydra results and names the failed search',
  async () => {
    const first = await pnyx.hydra()
    const second = await pnyx.hydra()
    await first.owner({
      args: [
        'task',
        'create',
        '--key',
        'oracle-aged',
        '--title',
        'Searchable archive task',
        '--brief',
        'Resilient indexed needle',
      ],
    })
    await first.owner({
      args: [
        'push',
        '--key',
        'oracle-aged',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        title: 'Searchable archive task',
        agent: {
          provider: 'claude-code',
          sessionId: 'oracle-aged-session',
          cwd: first.folder({ name: 'oracle-aged' }),
        },
        activity: 'ended',
      }),
    })
    let failAll = false
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: first.id,
      prepare: ({ page }) => page.routeWebSocket(
        /\/ws\?/,
        // eslint-disable-next-line pnyx/object-params -- Playwright owns the socket callback.
        socket => {
          const server = socket.connectToServer()
          // eslint-disable-next-line pnyx/object-params -- Playwright owns the frame callback.
          socket.onMessage(message => {
            const frame = JSON.parse(String(message))

            if (frame.type === 'command' && frame.name === 'oracle' && (failAll || frame.scope === second.id)) {
              socket.send(JSON.stringify({
                type: 'error',
                scope: frame.scope,
                id: frame.id,
                error: 'Search disconnected',
                saved: false,
                code: 'DISCONNECTED',
              }))

              return
            }

            server.send(message)
          })
        },
      ),
    })

    try {
      await page.getByRole(
        'button',
        {
          name: 'Oracle',
          exact: true,
        },
      ).click()
      const search = page.getByRole(
        'combobox',
        {
          name: 'Oracle',
          exact: true,
        },
      )
      await search.fill('Resilient indexed needle')
      await page.getByRole('option').filter({ hasText: 'Searchable archive task' })
        .waitFor()
      await page.getByText(
        `${second.id}: Search disconnected`,
        { exact: false },
      ).waitFor()
      const preview = page.locator('.oracle-card')
      await until({
        what: 'the stopped Oracle heading has one age',
        check: async () => (await preview.locator('.agent-activity').innerText()) === 'Stopped',
      })
      expect(await preview.locator('time').count()).toBe(1)
      expect(await preview.getByRole(
        'heading',
        {
          name: 'Searchable archive task',
          exact: true,
        },
      ).count()).toBe(1)
      await first.owner({
        args: [
          'task',
          'status',
          'oracle-aged',
          'done',
          '--note',
          'Archive complete',
        ],
      })
      await until({
        what: 'the completed Oracle heading has one age',
        check: async () => (await preview.locator('.agent-activity').innerText()) === 'Done',
      })
      expect(await preview.locator('time').count()).toBe(1)
      failAll = true
      await search.fill('Entirely unavailable search')
      await page.getByText(
        'Search unavailable',
        { exact: true },
      ).waitFor()
    } finally {
      await page.context().close()
    }
  },
)

test(
  'opening an unloaded task mention preserves projects folded during its read',
  async () => {
    const hydra = await pnyx.hydra()
    const atlas = hydra.folder({ name: 'loading-atlas' })
    const boreal = hydra.folder({ name: 'loading-boreal' })
    await hydra.owner({
      args: [
        'project',
        'add',
        atlas,
      ],
    })
    await hydra.owner({
      args: [
        'project',
        'add',
        boreal,
      ],
    })
    const task = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Unloaded linked task',
        '--project',
        atlas,
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'hide',
        task.card.id,
      ],
    })
    await hydra.owner({
      args: [
        'view',
        'set',
        '--json',
        JSON.stringify({ workspace: { foldedProjects: { [atlas]: true } } }),
      ],
    })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        `Open [@Unloaded linked task](pnyx-task:${task.card.id})`,
      ],
    })
    let release: (() => void) | undefined
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      prepare: ({ page }) => page.routeWebSocket(
        /\/zero\//,
        // eslint-disable-next-line pnyx/object-params -- Playwright owns this callback.
        socket => {
          const server = socket.connectToServer()
          // eslint-disable-next-line pnyx/object-params -- Playwright owns this callback.
          socket.onMessage(message => {
            if (typeof message === 'string') {
              const frame = JSON.parse(message)
              const details = frame[1]?.desiredQueriesPatch?.some((query: {
                name?: string
                args?: unknown[]
              }) =>
                query.name === 'card.detail' && JSON.stringify(query.args).includes(task.card.id))

              if (details) {
                release = () => server.send(message)

                return
              }
            }

            server.send(message)
          })
        },
      ),
    })

    try {
      await page.locator('.hydra-chat').getByText(
        'Unloaded linked task',
        { exact: true },
      )
        .click()
      await until({
        what: 'task mention waits for its missing card',
        check: () => !!release,
      })
      const { view } = await hydra.owner({
        args: [
          'view',
          'show',
        ],
      })
      expect(view.workspace.foldedProjects).toContain(atlas)
      await page.locator(`[data-hydra-workspace="${hydra.id}"]`).getByRole(
        'navigation',
        { name: 'Projects' },
      )
        .getByRole(
          'button',
          {
            name: 'loading-boreal',
            exact: true,
          },
        )
        .click()
      await page.locator(`[data-hydra-workspace="${hydra.id}"] [data-column-heading="${boreal}"]`).click()
      await page.getByRole(
        'button',
        {
          name: 'Unfold loading-boreal',
          exact: true,
        },
      ).waitFor()
      release!()
      await page.locator(`.card[data-task="${task.card.id}"].selected .worker-chat`).waitFor()

      await until({
        what: 'opening Atlas keeps Boreal folded',
        check: async () => {
          const { view } = await hydra.owner({
            args: [
              'view',
              'show',
            ],
          })

          return view.workspace.foldedProjects.length === 1
            && view.workspace.foldedProjects[0] === boreal
        },
      })
    } finally {
      await page.context().close()
    }
  },
)

test(
  'scrolling a column advances the drop target beneath a stationary pointer',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'apply',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        version: 1,
        changes: Array.from(
          { length: 12 },
          (
            _,
            index,
          ) => ({
            op: 'task.create',
            key: `scroll-${index + 1}`,
            title: `Scroll task ${index + 1}`,
          }),
        ),
      }),
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)
    const cards = workspace.locator('[data-column="ideas"] .card-open')
    const scroller = workspace.locator('[data-column="ideas"] .column-cards')

    try {
      const source = cards.filter({ hasText: /^Scroll task 1$/ })
      const target = cards.filter({ hasText: /^Scroll task 3$/ })
      await source.waitFor()
      await target.waitFor()
      await page.locator(`[data-hydra-workspace="${hydra.id}"][data-connected="true"]`).waitFor()
      await source.hover()
      const from = await source.boundingBox()
      const to = await target.boundingBox()

      if (!from || !to) {
        throw new Error('Missing scroll drag cards')
      }

      const finishBudget = await beginUIWindow({ page })
      await page.mouse.move(
        from.x + 12,
        from.y + 8,
      )
      await page.mouse.down()
      await page.mouse.move(
        to.x + 12,
        to.y + to.height - 3,
        { steps: 12 },
      )
      await until({
        what: 'the held card moves behind the initial target',
        check: async () => (await cards.allTextContents()).indexOf('Scroll task 1') > 0,
      })
      const before = (await cards.allTextContents()).indexOf('Scroll task 1')
      // eslint-disable-next-line pnyx/object-params -- Playwright owns the element callback.
      await scroller.evaluate(element => {
        element.scrollTop += 180
      })
      await until({
        what: 'scrolling advances the stationary-pointer landing slot',
        check: async () => (await cards.allTextContents()).indexOf('Scroll task 1') > before,
      })
      const visible = (await cards.allTextContents()).map(title => title.trim())
      const sourceTitle = 'Scroll task 1'
      const next = visible[visible.indexOf(sourceTitle) + 1]
      const expected = rows<{title: string}>({
        text: "select title from cards where hydra_id = $1 and key like 'scroll-%' order by coalesce(rank, created_seq)",
        values: [hydra.id],
      }).map(card => card.title)
        .filter(title => title !== sourceTitle)
      const position = next ? expected.indexOf(next) : expected.length
      expected.splice(
        position,
        0,
        sourceTitle,
      )
      await page.mouse.up()
      await until({
        what: 'the scrolled drop reaches stored order',
        check: () => rows<{ title: string }>({
          text: "select title from cards where hydra_id = $1 and key like 'scroll-%' order by coalesce(rank, created_seq)",
          values: [hydra.id],
        }).map(card => card.title)
          .join('|') === expected.join('|'),
      })
      reportDragResponsiveness({ metrics: await finishBudget() })
      await page.reload()
      await until({
        what: 'the scrolled drop survives reload',
        check: async () => {
          const shown = (await cards.allTextContents()).map(title => title.trim())

          return shown.includes(sourceTitle) && expected.filter(title => shown.includes(title)).join('|') === shown.join('|')
        },
      })
    } finally {
      await page.context().close()
    }
  },
)
test(
  'reopening stopped Zero clears the previous installation query failure',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Recovered installation task',
      ],
    })
    const pageErrors: string[] = []
    let installationHash = ''
    let failInstallation: (() => void) | undefined
    let stopZero: (() => void) | undefined
    let connections = 0
    let holdingInitialRows = true
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      prepare: async ({ page }) => {
        page.on(
          'pageerror',
          error => pageErrors.push(error.message),
        )
        await page.addInitScript(() => {
          globalThis.WebSocket = new Proxy(
            WebSocket,
            {
              // eslint-disable-next-line pnyx/object-params -- Proxy owns the constructor trap.
              construct(
                Target,
                args,
                NewTarget,
              ) {
                if (String(args[0]).includes('/zero/') && typeof args[1] === 'string') {
                  const protocols = JSON.parse(atob(decodeURIComponent(args[1])))
                  const initial = protocols.initConnectionMessage
                  const patches = initial?.[1]?.desiredQueriesPatch ?? []
                  const installation = patches.find((patch: { name?: string }) => patch.name === 'hydras.list')

                  if (installation) {
                    sessionStorage.setItem(
                      'test-installation-query',
                      installation.hash,
                    )
                  }
                }

                return Reflect.construct(
                  Target,
                  args,
                  NewTarget,
                )
              },
            },
          )
        })
        await page.routeWebSocket(
          /\/zero\//,
          // eslint-disable-next-line pnyx/object-params -- Playwright owns this callback.
          socket => {
            connections += 1
            const server = socket.connectToServer()
            // eslint-disable-next-line pnyx/object-params -- Playwright owns this callback.
            server.onMessage(message => {
              if (typeof message !== 'string') {
                if (!holdingInitialRows) {
                  socket.send(message)
                }

                return
              }

              const frame = JSON.parse(String(message))

              if (holdingInitialRows && [
                'pokeStart',
                'pokePart',
                'pokeEnd',
              ].includes(frame[0])) {
                return
              }

              socket.send(message)
            })

            failInstallation = () => socket.send(JSON.stringify([
              'transformError',
              [
                {
                  error: 'app',
                  id: installationHash,
                  name: 'hydras.list',
                },
              ],
            ]))

            stopZero = () => {
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
      await until({
        what: 'the initial installation read starts',
        check: async () => {
          installationHash = await page.evaluate(() => sessionStorage.getItem('test-installation-query') ?? '')

          return installationHash !== '' && !!failInstallation
        },
      })
      expect(installationHash).not.toBe('')
      failInstallation!()
      await page.getByText(
        'Could not read the Hydra list or shared settings',
        { exact: false },
      ).waitFor()
      const original = connections
      holdingInitialRows = false
      stopZero!()
      await until({
        what: 'a replacement Zero connection reads normally',
        check: () => connections > original,
      })
      await page.locator(`[data-hydra-workspace="${hydra.id}"][data-connected="true"]`).waitFor()
      expect(await page.getByText(
        'Could not read the Hydra list or shared settings',
        { exact: false },
      ).count()).toBe(0)
      await page.getByRole(
        'button',
        {
          name: 'Recovered installation task',
          exact: true,
        },
      ).waitFor()
      expect(pageErrors).toEqual([])
    } finally {
      await page.context().close()
    }
  },
)

test(
  'the page loads from shared settings an older build stored without a key added since, and takes their rewrite at the same revision',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Task under older settings',
      ],
    })
    const url = `http://127.0.0.1:${pnyx.port()}/zero`
    const cookie = `${zeroCookieName({ port: pnyx.port() })}=${localToken()}`
    await zeroReady({
      url: `${url}/`,
      cookie,
    })
    const shown = await hydra.owner({
      args: [
        'settings',
        'show',
      ],
    })
    const current = shown.settings
    delete current.postgresUrl
    expect(current).toHaveProperty('hiddenHydras')
    // Stands in for the row a build older than hiddenHydras wrote, which the page can read before the starting server
    // rewrites it. The server can copy a write into this row up to a minute late, when its file watcher misses it, so
    // the stand-in sits a revision ahead where that copy cannot replace it, and the restore writes the current settings.
    const ahead = shown.revision + 1
    rows({
      text: 'update settings set revision = $1, value = ($2::jsonb - \'hiddenHydras\')::json where id = \'shared\'',
      values: [
        ahead,
        JSON.stringify({
          ...current,
          theme: 'dark',
        }),
      ],
    })
    const pageErrors: string[] = []
    let page: Page | undefined

    try {
      await until({
        what: 'zero-cache to serve the row without hiddenHydras',
        check: async () => {
          const read = await readRows<{ value: Record<string, unknown> } | undefined>({
            url,
            cookie,
            query: ({ zero }) => zero.materialize(queries.settings.shared()),
          })
          const value = read.rows?.value

          return value !== undefined && !('hiddenHydras' in value)
        },
      })
      page = await openHydra({
        port: pnyx.port(),
        hydraId: hydra.id,
        prepare: async ({ page }) => {
          page.on(
            'pageerror',
            error => pageErrors.push(error.message),
          )
        },
      })
      await page.locator(`[data-hydra-workspace="${hydra.id}"][data-connected="true"]`).waitFor()
      await page.getByRole(
        'button',
        {
          name: 'Task under older settings',
          exact: true,
        },
      ).waitFor()
      await page.locator('html[data-theme="dark"]').waitFor()
      expect(pageErrors).toEqual([])

      // Stands in for the starting server's rewrite of the row at its own revision.
      rows({
        text: 'update settings set value = $1 where id = \'shared\' and revision = $2',
        values: [
          JSON.stringify({
            ...current,
            theme: 'light',
          }),
          ahead,
        ],
      })
      await page.locator('html[data-theme="light"]').waitFor()
    } finally {
      rows({
        text: 'update settings set revision = $1, value = $2 where id = \'shared\' and revision = $3',
        values: [
          shown.revision,
          JSON.stringify(current),
          ahead,
        ],
      })
      await page?.context().close()
    }
  },
)

test(
  'the child hover action removes its parent and returns it to its own project',
  async () => {
    const hydra = await pnyx.hydra()
    const project = hydra.folder({ name: 'child-project' })
    await hydra.owner({
      args: [
        'project',
        'add',
        project,
      ],
    })
    const parent = await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'family',
        '--title',
        'Review the release',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'part',
        '--title',
        'Check the package',
        '--parent',
        'family',
        '--project',
        project,
      ],
    })
    let release: (() => void) | undefined
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      prepare: ({ page }) => page.routeWebSocket(
        /\/ws\?/,
        // eslint-disable-next-line pnyx/object-params -- Playwright owns the socket callback.
        socket => {
          const server = socket.connectToServer()
          // eslint-disable-next-line pnyx/object-params -- Playwright owns the frame callback.
          socket.onMessage(message => {
            const frame = JSON.parse(String(message))

            if (frame.name === 'task' && frame.args?.[0] === 'parent' && frame.args?.[2] === 'none') {
              release = () => server.send(message)
            } else {
              server.send(message)
            }
          })
        },
      ),
    })

    try {
      const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)
      const child = workspace.getByRole(
        'button',
        {
          name: 'Check the package',
          exact: true,
        },
      )
      const toggle = workspace.getByRole(
        'button',
        {
          name: 'Sub-tasks of Review the release',
          exact: true,
        },
      )

      if (await toggle.getAttribute('aria-expanded') === 'false') {
        await toggle.click()
      }

      await child.hover()
      const row = child.locator('xpath=ancestor::article[1]')
      await row.getByRole(
        'button',
        {
          name: 'Remove from parent',
          exact: true,
        },
      ).click()
      const ownProject = workspace.getByRole(
        'button',
        {
          name: 'Fold child-project',
          exact: true,
        },
      ).locator('xpath=ancestor::section[@data-column][1]')
      const returned = ownProject.getByRole(
        'button',
        {
          name: 'Check the package',
          exact: true,
        },
      )
      await returned.waitFor()
      expect(await returned.locator('xpath=ancestor::*[@data-child]').count()).toBe(0)
      expect((await hydra.task({ key: 'part' })).parent).toBe(parent.card.id)
      await until({
        what: 'the un-nest request is held',
        check: () => !!release,
      })
      release!()
      await until({
        what: 'the un-nest action saves the task as a root',
        check: async () => (await hydra.task({ key: 'part' })).parent === 'none',
      })
      await page.reload()
      await returned.waitFor()
      expect((await hydra.task({ key: 'part' })).project).toBe('child-project')
      expect((await hydra.task({ key: 'part' })).title).toBe('Check the package')
    } finally {
      await page.context().close()
    }
  },
)

test(
  'Shift nesting reparents a child but refuses deeper families without changing them',
  async () => {
    const hydra = await pnyx.hydra()

    for (const [
      key,
      parent,
    ] of [
        [
          'First root',
          undefined,
        ],
        [
          'Second root',
          undefined,
        ],
        [
          'Existing child',
          'First root',
        ],
        [
          'Other child',
          'Second root',
        ],
        [
          'Loose task',
          undefined,
        ],
      ]) {
      await hydra.owner({
        args: [
          'push',
          '--key',
          key!,
          '--file',
          '-',
        ],
        input: JSON.stringify({
          title: key,
          parent,
        }),
      })
    }

    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })

    try {
      const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)

      for (const title of [
        'First root',
        'Second root',
      ]) {
        const toggle = workspace.getByRole(
          'button',
          {
            name: `Sub-tasks of ${title}`,
            exact: true,
          },
        )
        await toggle.scrollIntoViewIfNeeded()
        await restingBox({ target: toggle })
        await toggle.click()
        const fold = toggle.locator('xpath=ancestor::*[@data-family][1]').locator('[data-fold-open]')
        await until({
          what: `the sub-task fold of ${title} finishes opening`,
          // eslint-disable-next-line pnyx/object-params -- Playwright supplies the matched element.
          check: () => fold.evaluate(node => node.getAttribute('data-fold-open') === 'true' && node.clientHeight >= node.scrollHeight),
        })
      }

      const card = ({ title }: { title: string }) => workspace.getByRole(
        'button',
        {
          name: title,
          exact: true,
        },
      ).locator('xpath=ancestor::article[1]')

      const drag = async ({
        source,
        target,
        reason,
        nestable = true,
        shiftBeforePickup = false,
      }: {
        source: string
        target: string
        reason?: string
        nestable?: boolean
        shiftBeforePickup?: boolean
      }) => {
        const from = card({ title: source }), to = card({ title: target })
        await from.scrollIntoViewIfNeeded()
        const held = await restingBox({ target: from })
        await page.mouse.move(
          held.x + held.width / 2,
          held.y + held.height / 2,
        )
        const handle = page.getByRole(
          'button',
          {
            name: `Move ${source}`,
            exact: true,
          },
        )
        const start = await restingBox({ target: handle })
        await page.mouse.move(
          start.x + start.width / 2,
          start.y + start.height / 2,
        )

        if (shiftBeforePickup) {
          await page.keyboard.down('Shift')
        }

        await page.mouse.down()
        await page.mouse.move(
          start.x + start.width / 2 + 12,
          start.y + start.height / 2,
          { steps: 3 },
        )
        await page.locator('.physical-ghost').waitFor()
        expect(await page.locator('.physical-ghost [data-drag-nest-hint]').count()).toBe(nestable ? 1 : 0)
        expect(await workspace.locator('[data-drag-column-hint]').count()).toBe(nestable ? 1 : 0)

        if (!shiftBeforePickup) {
          await page.keyboard.down('Shift')
        }

        // Lifting a family folds its sub-tasks into the ghost, so the target is measured where it rests after the lift.
        const end = await restingBox({ target: to })
        await page.mouse.move(
          end.x + end.width / 2,
          end.y + end.height / 2,
          { steps: 12 },
        )
        const ghost = page.locator('.physical-ghost')
        await ghost.waitFor()

        if (reason) {
          await ghost.getByText(
            reason,
            { exact: true },
          ).waitFor()
          expect(await ghost.locator('[data-drag-nest-hint]').count()).toBe(0)
          expect(await to.getAttribute('data-nest-armed')).toBe('false')

          if (source === 'Loose task') {
            // Pointer events or a Shift toggle would mask a watcher that never started.
            await card({ title: 'First root' }).evaluate(
              // eslint-disable-next-line pnyx/object-params -- Playwright supplies the element and pointer position.
              (
                node,
                y,
              ) => {
                const family = node.closest<HTMLElement>('[data-family]')

                if (!family) {
                  throw new Error('First root is missing its task family')
                }

                const box = node.getBoundingClientRect()
                family.style.translate = `0 ${y - box.y - box.height / 2}px`
              },
              end.y + end.height / 2,
            )
            await until({
              what: 'the first root is under the stationary pointer',
              check: () => card({ title: 'First root' }).evaluate(
                // eslint-disable-next-line pnyx/object-params -- Playwright supplies the element and serialized argument.
                (
                  node,
                  point,
                ) => node.contains(document.elementFromPoint(
                  point.x,
                  point.y,
                )),
                {
                  x: end.x + end.width / 2,
                  y: end.y + end.height / 2,
                },
              ),
            })
            await until({
              what: 'the first root becomes the live nesting target',
              check: async () => await card({ title: 'First root' }).getAttribute('data-nest-armed') === 'true',
            })
            expect(await ghost.locator('[data-drag-nest-refusal]').count()).toBe(0)
            // eslint-disable-next-line pnyx/object-params -- Playwright supplies the element.
            await card({ title: 'First root' }).evaluate(node => {
              node.closest<HTMLElement>('[data-family]')?.style.removeProperty('translate')
            })
          }

          await page.keyboard.up('Shift')
          expect(await ghost.locator('[data-drag-nest-refusal]').count()).toBe(0)
          await page.keyboard.down('Shift')

          await to.hover()
          await ghost.getByText(
            reason,
            { exact: true },
          ).waitFor()
        } else {
          await until({
            what: 'the root is armed',
            check: async () => await to.getAttribute('data-nest-armed') === 'true',
          })
        }

        await page.mouse.up()
        await page.keyboard.up('Shift')
        await ghost.waitFor({ state: 'detached' })
      }

      const first = (await hydra.task({ key: 'First root' })).id
      const second = (await hydra.task({ key: 'Second root' })).id
      await drag({
        source: 'Loose task',
        shiftBeforePickup: true,
        target: 'Existing child',
        reason: "Can't nest here: this task is already a sub-task",
      })
      expect((await hydra.task({ key: 'Loose task' })).parent).toBe('none')
      await drag({
        source: 'First root',
        nestable: false,
        target: 'Second root',
        reason: "Can't nest: this task has its own sub-tasks",
      })
      expect((await hydra.task({ key: 'First root' })).parent).toBe('none')
      expect((await hydra.task({ key: 'Existing child' })).parent).toBe(first)
      await drag({
        source: 'Existing child',
        target: 'Second root',
      })
      await until({
        what: 'Shift reparents within one level',
        check: async () => (await hydra.task({ key: 'Existing child' })).parent === second,
      })
      expect((await hydra.task({ key: 'Other child' })).parent).toBe(second)
      await page.reload()
      const restoredFamily = workspace.getByRole(
        'button',
        {
          name: 'Sub-tasks of Second root',
          exact: true,
        },
      )
      await restoredFamily.waitFor()
      expect(await restoredFamily.getAttribute('aria-expanded')).toBe('true')
      await card({ title: 'Existing child' }).waitFor()
      expect((await hydra.task({ key: 'Existing child' })).parent).toBe(second)
    } finally {
      await page.context().close()
    }
  },
)

test(
  'the browser tab names the Hydra and the selected task, following renames',
  async () => {
    const hydra = await pnyx.hydra()
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })

    try {
      await hydra.owner({
        args: [
          'hydra',
          'set',
          '--name',
          'Poseidon',
        ],
      })
      await until({
        what: 'Hydra tab title',
        check: async () => await page.title() === 'Poseidon · Pnyx',
      })
      await hydra.owner({
        args: [
          'task',
          'create',
          '--key',
          'export',
          '--title',
          'Ship the export',
        ],
      })
      const title = page.getByRole(
        'button',
        {
          name: 'Ship the export',
          exact: true,
        },
      )
      await title.waitFor()
      expect(await page.title()).toBe('Poseidon · Pnyx')
      await title.focus()
      await page.keyboard.press('Enter')
      await until({
        what: 'selected task tab title',
        check: async () => await page.title() === 'Ship the export · Poseidon · Pnyx',
      })
      await hydra.owner({
        args: [
          'task',
          'rename',
          'export',
          '--title',
          '0123456789 0123456789 0123456789 0123456789 0123456789 12345 extra',
        ],
      })
      await until({
        what: 'renamed task tab title shortened at a word boundary',
        check: async () => await page.title() === '0123456789 0123456789 0123456789 0123456789 0123456789 12345… · Poseidon · Pnyx',
      })
    } finally {
      await page.context().close()
    }
  },
)

test(
  'Shift-dragging a child into its project space lifts it into root order where it lands',
  async () => {
    const hydra = await pnyx.hydra()
    const project = hydra.folder({ name: 'other-project' })
    await hydra.owner({
      args: [
        'project',
        'add',
        project,
      ],
    })

    for (const [
      key,
      parent,
    ] of [
        [
          'Alpha root',
          undefined,
        ],
        [
          'Family root',
          undefined,
        ],
        [
          'Omega root',
          undefined,
        ],
        [
          'Kid one',
          'Family root',
        ],
        [
          'Kid two',
          'Family root',
        ],
      ]) {
      await hydra.owner({
        args: [
          'push',
          '--key',
          key!,
          '--file',
          '-',
        ],
        input: JSON.stringify({
          title: key,
          parent,
        }),
      })
    }

    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'Elsewhere root',
        '--title',
        'Elsewhere root',
        '--project',
        project,
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'arrange',
        'Kid two',
        '--before',
        'Kid one',
      ],
    })
    const family = (await hydra.task({ key: 'Family root' })).id
    const keys = [
      'Alpha root',
      'Family root',
      'Omega root',
      'Kid one',
      'Kid two',
    ]
    const order = ({ parent }: { parent?: string } = {}) => rows<{ key: string }>({
      text: 'select key from cards where hydra_id = $1 and parent_id is not distinct from $2::text and key = any($3::text[]) order by coalesce(rank, created_seq)',
      values: [
        hydra.id,
        parent ?? null,
        keys,
      ],
    }).map(card => card.key)
    await hydra.owner({
      args: [
        'view',
        'set',
        '--json',
        JSON.stringify({ workspace: { chatCollapsed: true } }),
      ],
    })
    const outdents: string[] = []
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      prepare: ({ page }) => page.routeWebSocket(
        /\/ws\?/,
        // eslint-disable-next-line pnyx/object-params -- Playwright owns the socket callback.
        socket => {
          const server = socket.connectToServer()
          // eslint-disable-next-line pnyx/object-params -- Playwright owns the frame callback.
          socket.onMessage(message => {
            const frame = JSON.parse(String(message))

            if (frame.name === 'task' && frame.args?.[0] === 'parent') {
              outdents.push(frame.args[frame.args.indexOf('--event-id') + 1])
            }

            server.send(message)
          })
        },
      ),
    })

    try {
      const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)
      const card = ({ title }: { title: string }) => workspace.getByRole(
        'button',
        {
          name: title,
          exact: true,
        },
      ).locator('xpath=ancestor::article[1]')
      const column = ({ id }: { id: string }) => workspace.locator(`section[data-column="${id}"]`)
      const ideas = column({ id: 'ideas' })
      const otherId = await workspace.getByRole(
        'button',
        {
          name: 'Fold other-project',
          exact: true,
        },
      ).locator('xpath=ancestor::section[@data-column][1]')
        .getAttribute('data-column')
      const other = column({ id: otherId! })

      const openFamily = async () => {
        const toggle = workspace.getByRole(
          'button',
          {
            name: 'Sub-tasks of Family root',
            exact: true,
          },
        )

        if (await toggle.getAttribute('aria-expanded') === 'false') {
          await toggle.click()
        }

        await card({ title: 'Kid one' }).waitFor()
      }

      const shiftDrag = async ({
        source,
        point,
        armed,
        reason,
      }: {
        source: string
        point(): Promise<{
          x: number
          y: number
        }>
        armed?: ReturnType<typeof column>
        reason?: string
      }) => {
        // hover() first scrolls a sub-task card it reads as clipped to the axis end, which moves the Hydra off screen.
        const held = await restingBox({ target: card({ title: source }) })
        await page.mouse.move(
          held.x + held.width / 2,
          held.y + held.height / 2,
        )
        const handle = page.getByRole(
          'button',
          {
            name: `Move ${source}`,
            exact: true,
          },
        )
        const start = await restingBox({ target: handle })
        const end = await point()
        await page.mouse.move(
          start.x + start.width / 2,
          start.y + start.height / 2,
        )
        await page.mouse.down()
        await page.mouse.move(
          start.x + start.width / 2 + 12,
          start.y + start.height / 2,
          { steps: 3 },
        )
        const ghost = page.locator('.physical-ghost')
        await ghost.waitFor()
        await page.keyboard.down('Shift')
        await page.mouse.move(
          end.x,
          end.y,
          { steps: 12 },
        )

        if (armed) {
          await until({
            what: 'the project space is armed for the child',
            check: async () => await armed.getAttribute('data-outdent-armed') === 'true',
          })
        }

        if (reason) {
          await ghost.getByText(
            reason,
            { exact: true },
          ).waitFor()
        }

        await page.mouse.up()
        await page.keyboard.up('Shift')
        await ghost.waitFor({ state: 'detached' })
      }

      const between = async ({
        first,
        second,
      }: {
        first: string
        second: string
      }) => {
        const a = (await card({ title: first }).boundingBox())!
        const b = (await card({ title: second }).boundingBox())!
        const sameRow = Math.abs(a.y - b.y) < 1

        return sameRow ? {
          x: (a.x + a.width + b.x) / 2,
          y: a.y + a.height / 2,
        } : {
          x: a.x + a.width / 2,
          y: (a.y + a.height + b.y) / 2,
        }
      }

      const below = async ({ area }: { area: ReturnType<typeof column> }) => {
        const box = (await area.locator('.project-cards').boundingBox())!
        // eslint-disable-next-line pnyx/object-params -- Playwright owns the evaluate callback.
        const cards = await area.locator('.card[data-task]').evaluateAll(nodes =>
          Math.max(...nodes.map(node => node.getBoundingClientRect().bottom)))

        return {
          x: box.x + box.width / 2,
          y: (cards + box.y + box.height) / 2,
        }
      }

      await openFamily()
      await shiftDrag({
        source: 'Kid two',
        point: () => between({
          first: 'Alpha root',
          second: 'Family root',
        }),
        armed: ideas,
      })
      await until({
        what: 'the child lands between the roots it was dropped between',
        check: () => order().join() === 'Alpha root,Kid two,Family root,Omega root',
      })
      expect(await card({ title: 'Kid two' }).locator('xpath=ancestor::*[@data-child]')
        .count()).toBe(0)
      expect(outdents).toHaveLength(1)
      await hydra.owner({
        args: [
          'undo',
          outdents[0]!,
        ],
      })
      await until({
        what: 'Undo returns the child to its parent at its old sibling position',
        check: () => order({ parent: family }).join() === 'Kid two,Kid one',
      })
      expect(order().join()).toBe('Alpha root,Family root,Omega root')

      await openFamily()
      await shiftDrag({
        source: 'Kid one',
        point: () => below({ area: other }),
        reason: "Can't move to another project",
      })
      expect(await other.getAttribute('data-outdent-armed')).toBe('false')
      expect(order({ parent: family }).join()).toBe('Kid two,Kid one')

      await shiftDrag({
        source: 'Kid one',
        point: () => below({ area: ideas }),
        armed: ideas,
      })
      await until({
        what: 'a child dropped below the last root lands at the end',
        check: () => order().join() === 'Alpha root,Family root,Omega root,Kid one',
      })
      expect(order({ parent: family }).join()).toBe('Kid two')
      // This drop's request reached the server after any the refused drop sent, so only the two real drops count.
      expect(outdents).toHaveLength(2)
    } finally {
      await page.context().close()
    }
  },
)

test(
  'a wide closed task lifts at standard card size and grows back into its row',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'wide',
        '--title',
        'A wide closed card',
      ],
    })
    await hydra.owner({
      args: [
        'view',
        'set',
        '--json',
        JSON.stringify({ workspace: { projectWidths: { ideas: 944 } } }),
      ],
    })
    const repository = hydra.folder({ name: 'grab-target' })
    await hydra.owner({
      args: [
        'project',
        'add',
        repository,
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'parent',
        '--title',
        'A nesting target',
        '--project',
        repository,
      ],
    })
    await hydra.owner({
      args: [
        'view',
        'set',
        '--json',
        JSON.stringify({ workspace: { chatCollapsed: true } }),
      ],
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })

    try {
      const wide = await hydra.task({ key: 'wide' })
      const card = page.locator(`[data-hydra-workspace="${hydra.id}"] .card[data-task="${wide.id}"]`)
      await card.hover()
      // eslint-disable-next-line pnyx/object-params -- Playwright passes the element to its page callback.
      await card.evaluate(node => {
        node.animate(
          { transform: 'translateX(24px)' },
          {
            duration: 1,
            fill: 'both',
            id: 'pickup-offset',
          },
        ).finish()
      })
      const box = await card.boundingBox()
      expect(box!.width).toBeGreaterThan(900)
      await page.mouse.move(
        box!.x + box!.width * 0.82,
        box!.y + box!.height * 0.65,
      )
      // eslint-disable-next-line pnyx/object-params -- Playwright passes the element to its page callback.
      await card.evaluate(node => {
        (node as HTMLElement).addEventListener(
          'pointerdown',
          ({
            clientX,
            clientY,
          }) => {
            const bounds = node.getBoundingClientRect()
            node.dataset.pickupX = String((clientX - bounds.left) / bounds.width)
            node.dataset.pickupY = String((clientY - bounds.top) / bounds.height)
          },
          {
            once: true,
            capture: true,
          },
        )
      })
      await page.mouse.down()
      const grab = {
        x: Number(await card.getAttribute('data-pickup-x')),
        y: Number(await card.getAttribute('data-pickup-y')),
      }
      await page.mouse.move(
        box!.x + box!.width * 0.82 + 20,
        box!.y + box!.height * 0.65,
        { steps: 4 },
      )
      const ghost = page.locator('.physical-ghost')
      await ghost.waitFor()
      // eslint-disable-next-line pnyx/object-params -- Playwright passes the element to its page callback.
      await card.evaluate(node => node.getAnimations().find(animation => animation.id === 'pickup-offset')
        ?.cancel())
      const lifted = await ghost.boundingBox()
      expect(lifted!.width).toBeCloseTo(
        box!.width,
        2,
      )
      expect(lifted!.height).toBe(96)
      const preview = ghost.locator('[data-drag-preview]')

      const anchored = async ({
        x,
        y,
      }: {
        x: number
        y: number
      }) => {
        const box = await preview.boundingBox()
        expect((x - box!.x) / box!.width).toBeCloseTo(
          grab.x,
          2,
        )
        expect((y - box!.y) / box!.height).toBeCloseTo(
          grab.y,
          2,
        )
      }

      await anchored({
        x: box!.x + box!.width * 0.82 + 20,
        y: box!.y + box!.height * 0.65,
      })
      const targetCard = page.getByRole(
        'button',
        {
          name: 'A nesting target',
          exact: true,
        },
      ).locator('xpath=ancestor::article[1]')
      await page.mouse.move(
        page.viewportSize()!.width - 2,
        box!.y + box!.height / 2,
      )
      await targetCard.waitFor()
      await until({
        what: 'edge autoscroll brings the nesting target inside the viewport',
        check: async () => {
          const box = await targetCard.boundingBox()

          return !!box && box.x >= 0 && box.x + box.width <= page.viewportSize()!.width
        },
      })
      const target = await targetCard.boundingBox()
      const point = {
        x: target!.x + target!.width / 2,
        y: target!.y + target!.height / 2,
      }
      await page.mouse.move(
        point.x,
        point.y,
      )
      await until({
        what: 'crossing another column compacts the wide lift',
        check: async () => Math.abs((await preview.boundingBox())!.width - 303.333) < 1,
      })
      await anchored(point)
      await page.keyboard.down('Shift')
      await until({
        what: 'the lifted preview shrinks at its grab point',
        check: async () => (await preview.boundingBox())!.width < 260,
      })
      await anchored(point)
      await page.keyboard.up('Shift')
      await until({
        what: 'the preview grows back around its grab point',
        check: async () => Math.abs((await preview.boundingBox())!.width - 303.333) < 1,
      })
      await anchored(point)
      const landingFrames = () => page.evaluate(async () => {
        const samples: {
          width: number
          title: number
        }[] = []

        for (let frame = 0; frame < 30; frame++) {
          await new Promise(requestAnimationFrame)
          const ghost = document.querySelector('.physical-ghost')

          if (ghost) {
            const range = document.createRange()
            range.selectNodeContents(ghost.querySelector('.card-open')!)
            samples.push({
              width: ghost.getBoundingClientRect().width,
              title: range.getBoundingClientRect().width,
            })
          }
        }

        return samples
      })
      const landing = landingFrames()
      await card.locator('xpath=ancestor::*[@data-family][1]').scrollIntoViewIfNeeded()
      const returning = await card.boundingBox()
      const returnPoint = {
        x: returning!.x + returning!.width * 0.82 + 20,
        y: returning!.y + returning!.height * 0.65,
      }
      await page.mouse.move(
        returnPoint.x,
        returnPoint.y,
        { steps: 12 },
      )
      await anchored(returnPoint)
      await page.mouse.up()
      const samples = await landing
      expect(samples.some(sample => sample.width > 300 && sample.width < 850)).toBe(true)
      const titleWidths = samples.map(sample => sample.title)
      expect(Math.max(...titleWidths) - Math.min(...titleWidths)).toBeLessThan(1)
      await ghost.waitFor({ state: 'detached' })
      expect((await card.boundingBox())!.width).toBeCloseTo(
        box!.width,
        2,
      )
      expect((await hydra.task({ key: 'wide' })).parent).toBe('none')

      await hydra.owner({
        args: [
          'task',
          'create',
          '--key',
          'neighbor',
          '--title',
          'A reorder neighbor',
        ],
      })

      await hydra.owner({
        args: [
          'task',
          'create',
          '--key',
          'standard',
          '--title',
          'A standard peer',
        ],
      })
      await card.hover()
      await until({
        what: 'three closed cards settle into standard cells',
        check: async () => Math.abs((await card.boundingBox())!.width - 303.333) < 0.005,
      })
      const standard = await card.boundingBox()
      expect(standard!.width).toBeCloseTo(
        303.333,
        1,
      )
      await page.mouse.move(
        standard!.x + standard!.width * 0.7,
        standard!.y + standard!.height * 0.6,
      )
      await page.mouse.down()
      await page.mouse.move(
        standard!.x + standard!.width * 0.7 + 12,
        standard!.y + standard!.height * 0.6,
        { steps: 4 },
      )
      await ghost.waitFor()
      await page.mouse.move(
        point.x,
        point.y,
        { steps: 12 },
      )
      expect((await ghost.boundingBox())!.width).toBeCloseTo(
        standard!.width,
        1,
      )
      expect((await ghost.boundingBox())!.height).toBeCloseTo(
        standard!.height,
        1,
      )
      await page.keyboard.press('Escape')
      await page.mouse.up()
      await ghost.waitFor({ state: 'detached' })
      await hydra.owner({
        args: [
          'task',
          'hide',
          'standard',
        ],
      })
      await card.getByRole(
        'button',
        {
          name: 'A wide closed card',
          exact: true,
        },
      ).click()
      const draft = card.getByRole(
        'textbox',
        {
          name: 'Message worker',
          exact: true,
        },
      )
      await draft.fill('Keep the open conversation while moving')
      const liveDraft = await draft.elementHandle()
      await card.hover()
      const handle = page.getByRole(
        'button',
        {
          name: 'Move A wide closed card',
          exact: true,
        },
      )
      expect(await handle.isEnabled()).toBe(true)
      const grip = await card.getByRole(
        'button',
        {
          name: 'A wide closed card',
          exact: true,
        },
      ).boundingBox()
      const opened = await card.boundingBox()
      await page.mouse.move(
        grip!.x + grip!.width / 2,
        grip!.y + grip!.height / 2,
      )
      await page.mouse.down()
      await page.mouse.move(
        grip!.x + grip!.width / 2 + 12,
        grip!.y + grip!.height / 2,
        { steps: 4 },
      )
      await ghost.waitFor()
      expect((await ghost.boundingBox())!.width).toBeCloseTo(
        opened!.width,
        0,
      )
      expect((await ghost.boundingBox())!.height).toBeCloseTo(
        opened!.height,
        0,
      )
      expect(await ghost.locator('.worker-chat').count()).toBe(1)
      const workspaceTitles = () => page.locator(`[data-hydra-workspace="${hydra.id}"] [data-column="ideas"] .card-open`).allTextContents()
      const neighbor = page.getByRole(
        'button',
        {
          name: 'A reorder neighbor',
          exact: true,
        },
      ).locator('xpath=ancestor::article[1]')
      const next = await neighbor.boundingBox()
      await page.mouse.move(
        next!.x + next!.width / 2,
        next!.y + next!.height - 4,
        { steps: 12 },
      )
      await until({
        what: 'the open task previews its new position',
        check: async () => {
          const titles = await page.locator(`[data-hydra-workspace="${hydra.id}"] [data-column="ideas"] .card-open`).allTextContents()

          return titles.join('|') === 'A reorder neighbor|A wide closed card'
        },
      })
      // The landing must start from the compacted ghost, so wait for its resize to finish, not merely approach.
      await until({
        what: 'the open task compacts after entering its next slot',
        check: async () => Math.abs((await ghost.boundingBox())!.width - 303.333) < 0.1,
      })
      // The landing's own animation is recorded as it starts, so a slow runner cannot skip past it.
      await page.evaluate(() => {
        const start = Element.prototype.animate

        // eslint-disable-next-line pnyx/object-params -- Element.animate owns this signature.
        Element.prototype.animate = function (...args: Parameters<Element['animate']>) {
          const animation = start.apply(
            this,
            args,
          )
          const [
            keyframes,
            options,
          ] = args

          if (this.classList.contains('physical-ghost') && Array.isArray(keyframes) && typeof options === 'object') {
            Element.prototype.animate = start
            Object.assign(
              window,
              {
                landing: {
                  widths: keyframes.map(keyframe => String(keyframe.width)),
                  duration: Number(options.duration),
                  animation,
                },
              },
            )
          }

          return animation
        }
      })
      const released = (await ghost.boundingBox())!.width
      const dropping = landingFrames()
      await page.mouse.up()
      const dropFrames = await dropping
      const dropTitleWidths = dropFrames.map(sample => sample.title)
      expect(Math.max(...dropTitleWidths) - Math.min(...dropTitleWidths)).toBeLessThan(1)
      await ghost.waitFor({ state: 'detached' })
      const drop = await page.evaluate(async () => {
        const { landing } = window as unknown as {
          landing?: {
            widths: string[]
            duration: number
            animation: Animation
          }
        }
        await landing?.animation.finished

        return landing && {
          widths: landing.widths.map(parseFloat),
          duration: landing.duration,
          played: landing.animation.playState,
        }
      })
      expect(
        drop,
        'the drop lands through its own animation',
      ).toBeTruthy()
      expect(drop!.duration).toBe(MOTION_DURATIONS.base)
      expect(drop!.played).toBe('finished')
      expect(drop!.widths[0]).toBeCloseTo(
        released,
        0,
      )
      expect(drop!.widths[1]).toBeCloseTo(
        (await card.boundingBox())!.width,
        0,
      )
      await until({
        what: 'the opened task reorders without losing its conversation',
        check: async () => {
          const titles = await page.locator(`[data-hydra-workspace="${hydra.id}"] [data-column="ideas"] .card-open`).allTextContents()

          return titles.join('|') === 'A reorder neighbor|A wide closed card'
        },
      })
      await until({
        what: 'the opened task order is saved',
        check: () => rows<{ key: string }>({
          text: "select key from cards where hydra_id = $1 and key in ('wide', 'neighbor') order by coalesce(rank, created_seq)",
          values: [hydra.id],
        }).map(card => card.key)
          .join('|') === 'neighbor|wide',
      })
      expect(await liveDraft!.evaluate(({ isConnected }) => isConnected)).toBe(true)
      expect(await draft.inputValue()).toBe('Keep the open conversation while moving')

      await card.locator('.agent-activity').first()
        .hover()
      const tooltip = card.getByRole('tooltip').first()
      await tooltip.hover()
      const tooltipBox = await tooltip.boundingBox()
      await page.mouse.down()
      await page.mouse.move(
        tooltipBox!.x + tooltipBox!.width / 2 + 12,
        tooltipBox!.y + tooltipBox!.height / 2,
        { steps: 4 },
      )
      expect(await ghost.count()).toBe(0)
      await page.mouse.up()
      expect(await draft.isVisible()).toBe(true)
      await page.evaluate(() => getSelection()?.removeAllRanges())

      const tab = card.getByRole(
        'tab',
        {
          name: 'Context',
          exact: true,
        },
      )
      await tab.hover()
      const tabBox = await tab.boundingBox()
      await page.mouse.down()
      await page.mouse.move(
        tabBox!.x + 12,
        tabBox!.y + tabBox!.height / 2,
        { steps: 4 },
      )
      expect(await ghost.count()).toBe(0)
      await page.mouse.up()
      const options = card.getByRole(
        'tablist',
        {
          name: 'Card sections',
          exact: true,
        },
      ).locator('..')
      await options.hover()
      const optionsBox = await options.boundingBox()
      await page.mouse.down()
      await page.mouse.move(
        optionsBox!.x + optionsBox!.width / 2 + 12,
        optionsBox!.y + optionsBox!.height / 2,
        { steps: 4 },
      )
      await ghost.waitFor()
      const before = await neighbor.boundingBox()
      await page.mouse.move(
        before!.x + before!.width / 2,
        before!.y + 4,
        { steps: 12 },
      )
      await until({
        what: 'the options row picks up and reorders the open task',
        check: async () => (await workspaceTitles()).join('|') === 'A wide closed card|A reorder neighbor',
      })
      await page.mouse.up()
      await ghost.waitFor({ state: 'detached' })
      await until({
        what: 'options-row dragging persists the new order',
        check: () => rows<{ key: string }>({
          text: "select key from cards where hydra_id = $1 and key in ('wide', 'neighbor') order by coalesce(rank, created_seq)",
          values: [hydra.id],
        }).map(card => card.key)
          .join('|') === 'wide|neighbor',
      })
      expect(await liveDraft!.evaluate(({ isConnected }) => isConnected)).toBe(true)
      expect(await draft.inputValue()).toBe('Keep the open conversation while moving')

      await hydra.owner({
        args: [
          'task',
          'create',
          '--key',
          'part',
          '--title',
          'A retained part',
          '--parent',
          'wide',
        ],
      })
      const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)
      const family = workspace.locator(`[data-family="${(await hydra.task({ key: 'wide' })).id}"]`)
      await family.getByRole(
        'button',
        {
          name: 'A retained part',
          exact: true,
        },
      ).waitFor()
      const child = family.getByRole(
        'button',
        {
          name: 'A retained part',
          exact: true,
        },
      )

      const expand = async ({
        close,
        open,
        body,
        surface,
        axis,
        instant = false,
      }: {
        close: string
        open: string
        body: string
        surface: string
        axis: 'width' | 'height'
        instant?: boolean
      }) => {
        await workspace.getByRole(
          'button',
          {
            name: close,
            exact: true,
          },
        ).click({ scroll: 'none' })
        const content = workspace.locator(body)
        await until({
          what: `${close} finishes`,
          check: async () => await content.getAttribute('hidden') !== null,
        })
        const frames = page.evaluate(
          async ({
            body,
            surface,
            hydra,
            axis,
          }) => {
            const workspace = document.querySelector(`[data-hydra-workspace="${hydra}"]`)!
            const content = workspace.querySelector<HTMLElement>(body)!
            const target = surface === ':scope' ? workspace : workspace.querySelector<HTMLElement>(surface)!
            await new Promise<void>((
              resolve,
              reject,
            ) => {
              const timeout = setTimeout(
                () => {
                  observer.disconnect(); reject(new Error('The fold never opened'))
                },
                10000,
              )
              const observer = new MutationObserver(() => {
                if (content.dataset.foldOpen === 'true') {
                  clearTimeout(timeout); observer.disconnect(); resolve()
                }
              })
              observer.observe(
                content,
                {
                  attributes: true,
                  attributeFilter: ['data-fold-open'],
                },
              )
            })
            // The fold's own animation and starting size, read as it opens, so a slow runner cannot skip past them.
            const start = target.getBoundingClientRect()[axis]
            const fades = content.getAnimations().map(animation => {
              const effect = animation.effect as KeyframeEffect

              return {
                duration: Number(effect.getTiming().duration),
                opacity: effect.getKeyframes().map(keyframe => keyframe.opacity),
              }
            })
            const samples: {
              dimension: number
              opacity: number
            }[] = []

            for (let frame = 0; frame < 24; frame++) {
              await new Promise(requestAnimationFrame)
              samples.push({
                dimension: target.getBoundingClientRect()[axis],
                opacity: Number(getComputedStyle(content).opacity),
              })
            }

            await Promise.all(content.getAnimations().map(animation => animation.finished))
            await new Promise(requestAnimationFrame)

            return {
              start,
              end: target.getBoundingClientRect()[axis],
              fades,
              samples,
            }
          },
          {
            body,
            surface,
            hydra: hydra.id,
            axis,
          },
        )
        const [
          {
            start,
            end,
            fades,
            samples,
          },
        ] = await Promise.all([
          frames,
          workspace.getByRole(
            'button',
            {
              name: open,
              exact: true,
            },
          ).click({ scroll: 'none' }),
        ])

        const dimensions = samples.map(sample => sample.dimension)
        const change = Math.max(...dimensions) - Math.min(...dimensions)

        if (instant) {
          expect(samples.every(sample => sample.opacity === 1)).toBe(true)
          expect(change).toBeLessThan(1)
        } else {
          expect(
            fades,
            JSON.stringify(fades),
          ).toContainEqual({
            duration: MOTION_DURATIONS.base,
            opacity: [
              '0',
              '1',
            ],
          })
          expect(end - start).toBeGreaterThan(4)
          expect(samples.at(-1)!.dimension).toBeCloseTo(
            end,
            0,
          )
        }
      }

      const familyId = (await hydra.task({ key: 'wide' })).id
      const group = `[data-family="${familyId}"] > [data-fold-open]`
      await expand({
        close: 'Sub-tasks of A wide closed card',
        open: 'Sub-tasks of A wide closed card',
        body: group,
        surface: group,
        axis: 'height',
      })
      await child.waitFor()
      await expand({
        close: 'Fold Ideas',
        open: 'Unfold Ideas',
        body: '[data-column="ideas"] .column-cards',
        surface: '[data-column="ideas"]',
        axis: 'width',
      })
      await expand({
        close: 'Fold all projects',
        open: 'Unfold all projects',
        body: '[data-column="ideas"] .column-cards',
        surface: '[data-column="ideas"]',
        axis: 'width',
      })
      await expand({
        close: 'Fold Hydra',
        open: 'Unfold Hydra',
        body: '.shell',
        surface: ':scope',
        axis: 'width',
      })
      const unfoldChat = workspace.getByRole(
        'button',
        {
          name: 'Unfold chat',
          exact: true,
        },
      )
      // eslint-disable-next-line pnyx/object-params -- Playwright owns browser callbacks.
      const chatTargets = unfoldChat.evaluate(async button => {
        await new Promise<void>(resolve => button.addEventListener(
          'click',
          () => resolve(),
          { once: true },
        ))
        const targets: string[] = []

        for (let frame = 0; frame < 24; frame++) {
          await new Promise(requestAnimationFrame)
          const box = button.getBoundingClientRect()
          const hit = document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2,
          )
          targets.push(hit?.closest('button')?.getAttribute('aria-label') ?? 'none')
        }

        return targets
      })
      await unfoldChat.click({ scroll: 'none' })
      expect([...new Set(await chatTargets)]).toEqual(['Fold chat'])
      await expand({
        close: 'Fold chat',
        open: 'Unfold chat',
        body: '.chat-content',
        surface: '.workspace-chat',
        axis: 'width',
      })
      await page.evaluate(() => {
        document.documentElement.dataset.motion = 'off'
      })
      await expand({
        close: 'Fold all projects',
        open: 'Unfold all projects',
        body: '[data-column="ideas"] .column-cards',
        surface: '[data-column="ideas"]',
        axis: 'width',
        instant: true,
      })
      await page.evaluate(() => {
        document.documentElement.dataset.motion = 'normal'
      })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await expand({
        close: 'Sub-tasks of A wide closed card',
        open: 'Sub-tasks of A wide closed card',
        body: group,
        surface: group,
        axis: 'height',
        instant: true,
      })
      expect(await draft.inputValue()).toBe('Keep the open conversation while moving')
    } finally {
      await page.context().close()
    }
  },
)

test(
  'two tabs fold different projects without replacing each other’s view edit',
  async () => {
    const hydra = await pnyx.hydra()
    const projects = [
      hydra.folder({ name: 'fold-a' }),
      hydra.folder({ name: 'fold-b' }),
    ]

    for (const project of projects) {
      mkdirSync(
        join(
          project,
          '.git',
        ),
        { recursive: true },
      )
      await hydra.owner({
        args: [
          'project',
          'add',
          project,
        ],
      })
    }

    await hydra.owner({
      args: [
        'view',
        'set',
        '--json',
        JSON.stringify({
          workspace: {
            chatCollapsed: true,
            projectWidths: Object.fromEntries(projects.map(project => [
              project,
              280,
            ])),
          },
        }),
      ],
    })
    const held: (() => void)[] = []
    const holdFolds = async ({ page }: { page: Page }) => page.routeWebSocket(
      /\/ws\?/,
      // eslint-disable-next-line pnyx/object-params -- Playwright owns the socket callback.
      socket => {
        const server = socket.connectToServer()
        socket.onMessage(
          // eslint-disable-next-line pnyx/object-params -- Playwright owns the frame callback.
          message => {
            const frame = JSON.parse(String(message))
            const json = frame.args?.[frame.args.indexOf('--json') + 1]
            const fold = frame.name === 'view' && json && JSON.parse(json).workspace?.foldedProjects

            if (fold) {
              held.push(() => server.send(message))
            } else {
              server.send(message)
            }
          },
        )
      },
    )
    const first = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      prepare: holdFolds,
    })
    const second = await first.context().newPage()
    await holdFolds({ page: second })
    await second.goto(first.url())
    const inHydra = `[data-hydra-workspace="${hydra.id}"]`
    await first.locator(inHydra).getByRole(
      'button',
      {
        name: 'Fold fold-a',
        exact: true,
      },
    )
      .click()
    await second.locator(inHydra).getByRole(
      'button',
      {
        name: 'Fold fold-b',
        exact: true,
      },
    )
      .click()
    await until({
      what: 'both fold writes are held',
      check: () => held.length === 2,
    })
    expect(await first.locator(inHydra).getByRole(
      'button',
      {
        name: 'Unfold fold-a',
        exact: true,
      },
    )
      .isVisible()).toBe(true)
    expect(await second.locator(inHydra).getByRole(
      'button',
      {
        name: 'Unfold fold-b',
        exact: true,
      },
    )
      .isVisible()).toBe(true)
    held.toReversed().forEach(release => release())
    await until({
      what: 'both independent folds survive on both tabs',
      check: async () => {
        for (const page of [
          first,
          second,
        ]) {
          for (const project of [
            'fold-a',
            'fold-b',
          ]) {
            if (await page.locator(inHydra).getByRole(
              'button',
              {
                name: `Unfold ${project}`,
                exact: true,
              },
            )
              .count() !== 1) {
              return false
            }
          }
        }

        return true
      },
    })
    const { view } = await hydra.owner({
      args: [
        'view',
        'show',
      ],
    })
    expect(view.workspace.foldedProjects.toSorted()).toEqual(projects.toSorted())
  },
)

test(
  'fold all anchors a Hydra throughout an arriving wheel gesture',
  async () => {
    const hydra = await pnyx.hydra()
    await pnyx.hydra()

    for (let index = 0; index < 4; index++) {
      const project = hydra.folder({ name: `shrinking-project-${index}` })
      await hydra.owner({
        args: [
          'project',
          'add',
          project,
        ],
      })
    }

    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)
    await until({
      what: 'the project workspace is wider than the viewport',
      check: async () => (await workspace.boundingBox())!.width > 2500,
    })
    const fold = workspace.getByRole(
      'button',
      {
        name: 'Fold all projects',
        exact: true,
      },
    )
    await page.mouse.move(
      1000,
      400,
    )

    for (let index = 0; index < 12; index++) {
      await page.mouse.wheel(
        60,
        0,
      )

      if (index === 3) {
        expect((await workspace.boundingBox())!.x).toBeLessThan(0)
        await fold.click({ scroll: 'none' })
      }

      await delay(25)
    }

    await until({
      what: 'the project shrink finishes',
      check: async () => {
        const box = await workspace.boundingBox()

        return !!box && box.width < page.viewportSize()!.width
      },
    })
    expect(page.url()).toContain(`/hydra/${hydra.id}/`)
    await workspace.getByRole(
      'button',
      {
        name:'Unfold all projects',
        exact:true,
      },
    ).waitFor()

    const offsets = await workspace.evaluate(
      // eslint-disable-next-line pnyx/object-params -- Playwright owns the page callback signature.
      async (
        element,
        restMs,
      ) => {
        const positions = []
        const started = performance.now()

        while (performance.now() - started < restMs) {
          await new Promise(requestAnimationFrame)
          positions.push(element.getBoundingClientRect().x)
        }

        return positions
      },
      WHEEL_REST_MS,
    )
    expect(Math.max(...offsets.map(x => Math.abs(x - 12)))).toBeLessThan(1)
    await page.mouse.move(
      1000,
      400,
    )
    await page.mouse.wheel(
      60,
      0,
    )
    await until({
      what: 'a new wheel gesture can scroll after folding settles',
      check: async () => (await workspace.boundingBox())!.x < 0,
    })
  },
)

test(
  'phone projects fit one viewport and snap to their own start in both themes',
  async () => {
    const hydra = await pnyx.hydra()
    const project = hydra.folder({ name: 'phone-project' })
    mkdirSync(
      join(
        project,
        '.git',
      ),
      { recursive: true },
    )
    await hydra.owner({
      args: [
        'project',
        'add',
        project,
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
        changes: [
          {
            op: 'task.create',
            key: 'phone-idea',
            title: 'A phone idea',
          },
          {
            op: 'task.create',
            key: 'phone-task',
            title: 'A phone project task',
            project,
          },
        ],
      }),
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    await page.setViewportSize({
      width: 390,
      height: 844,
    })
    const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)

    for (const theme of [
      'light',
      'dark',
    ]) {
      await hydra.owner({
        args: [
          'settings',
          'set',
          '--json',
          JSON.stringify({ theme }),
        ],
      })
      await workspace.getByRole(
        'button',
        {
          name: 'phone-project',
          exact: true,
        },
      ).click()
      const column = workspace.locator(`[data-column="${project}"]`)
      await until({
        what: 'the project fills the phone frame',
        check: async () => {
          const box = await column.boundingBox()

          return !!box && Math.abs(box.x - 6) < 2 && Math.abs(box.width - 378) < 1
        },
      })
      await column.getByRole(
        'button',
        {
          name: 'A phone project task',
          exact: true,
        },
      ).click()
      const card = column.locator('.card.selected')
      await card.locator('.worker-chat').waitFor()
      expect((await card.boundingBox())!.width).toBeLessThanOrEqual(360)
      // eslint-disable-next-line pnyx/object-params -- Playwright owns the element callback.
      expect(await column.evaluate(element =>
        element.scrollWidth <= element.clientWidth)).toBe(true)
      await column.getByRole(
        'button',
        {
          name: 'A phone project task',
          exact: true,
        },
      ).click()
      await workspace.getByRole(
        'button',
        {
          name: 'Ideas',
          exact: true,
        },
      ).click()
      const ideas = workspace.locator('[data-column="ideas"]')
      await until({
        what: 'Ideas aligns with the phone frame',
        check: async () => {
          const box = await ideas.boundingBox()

          return !!box && Math.abs(box.x - 6) < 2
        },
      })
      await page.mouse.move(
        180,
        140,
      )
      await page.mouse.wheel(
        378,
        0,
      )
      await until({
        what: 'a horizontal wheel snaps to the next project',
        check: async () => {
          const box = await column.boundingBox()

          return !!box && Math.abs(box.x - 6) < 2
        },
      })
    }
  },
)

test(
  'project dragging starts on its heading and leaves its body available',
  async () => {
    const hydra = await pnyx.hydra()
    const alpha = hydra.folder({ name: 'Alpha' }), beta = hydra.folder({ name: 'Beta' })
    await hydra.owner({
      args: [
        'project',
        'add',
        alpha,
      ],
    })
    await hydra.owner({
      args: [
        'project',
        'add',
        beta,
      ],
    })
    await hydra.owner({
      args: [
        'view',
        'set',
        '--json',
        JSON.stringify({
          workspace: {
            chatCollapsed: true,
            projectWidths: {
              ideas: 280,
              [alpha]: 280,
              [beta]: 280,
            },
          },
        }),
      ],
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)
    const first = workspace.locator('.project-column[aria-label="Alpha"]')
    const second = workspace.locator('.project-column[aria-label="Beta"]')

    try {
      // The view's project widths can land after the page opens, sliding the columns into place.
      const body = await restingBox({ target: first.locator('.column-cards') })
      await page.mouse.move(
        body.x + body.width / 2,
        body.y + 80,
      )
      await page.mouse.down()
      await page.mouse.move(
        body.x + body.width + 70,
        body.y + 80,
        { steps: 16 },
      )
      const bodyPickedUp = await page.locator('.physical-ghost').count()
      await page.keyboard.press('Escape')
      await page.mouse.up()
      expect(bodyPickedUp).toBe(0)
      const heading = await restingBox({ target: first.locator('.project-column-heading') })
      const destination = await restingBox({ target: second.locator('.project-column-heading') })
      const x = heading.x + heading.width * 0.6, y = heading.y + heading.height / 2
      expect(await page.evaluate(
        ({
          x,
          y,
        }) => !!document.elementFromPoint(
          x,
          y,
        )?.closest('button'),
        {
          x,
          y,
        },
      )).toBe(false)
      await page.mouse.move(
        x,
        y,
      )
      await page.mouse.down()
      await page.mouse.move(
        x + 12,
        y,
        { steps: 3 },
      )
      await page.locator('.physical-ghost').waitFor()
      await page.mouse.move(
        destination.x + destination.width * 0.6,
        y,
        { steps: 20 },
      )
      await page.mouse.up()
      const order = () => workspace.locator('.project-column').evaluateAll(
        // eslint-disable-next-line pnyx/object-params -- Playwright owns the element callback.
        elements => elements.map(element => element.getAttribute('aria-label')),
      )
      await until({
        what: 'heading drag saves project order',
        check: async () => (await order()).join('|') === 'Ideas|Beta|Alpha',
      })
      await page.reload()
      await until({
        what: 'heading order survives reload',
        check: async () => (await order()).join('|') === 'Ideas|Beta|Alpha',
      })
    } finally {
      await page.mouse.up()
      await page.context().close()
    }
  },
)

test(
  'shrinking an earlier Hydra preserves alignment and the owner’s horizontal scroll',
  async () => {
    const before = await pnyx.hydra()
    const hydra = await pnyx.hydra()
    await before.owner({
      args: [
        'view',
        'set',
        '--json',
        JSON.stringify({ workspace: { projectWidths: { ideas: 1600 } } }),
      ],
    })
    await before.owner({
      args: [
        'task',
        'create',
        '--title',
        'Earlier task',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Resize target',
      ],
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: before.id,
      prepare: async ({ page }) => {
        await page.addInitScript(() => {
          // Native scrolling can clamp before ResizeObserver delivers the new dimensions.
          const NativeResizeObserver = ResizeObserver
          let held = false
          const pending: (() => void)[] = []
          window.ResizeObserver = class extends NativeResizeObserver {
            // eslint-disable-next-line pnyx/object-params -- ResizeObserver owns the constructor.
            constructor(callback: ResizeObserverCallback) {
              // eslint-disable-next-line pnyx/object-params -- ResizeObserver owns the callback.
              super((
                entries,
                observer,
              ) => {
                const axis = entries.some(entry => entry.target.matches(
                  '.workspace-axis, .workspace-track, [data-hydra-workspace]',
                ))

                if (held && axis) {
                  pending.push(() => callback(
                    entries,
                    observer,
                  ))
                } else {
                  callback(
                    entries,
                    observer,
                  )
                }
              })
            }
          }
          window.addEventListener(
            'hold-axis-resize',
            () => {
              held = true
            },
          )
          window.addEventListener(
            'release-axis-resize',
            () => {
              held = false
              pending.splice(0).forEach(deliver => deliver())
            },
          )
        })
      },
    })

    try {
      await page.getByRole(
        'button',
        {
          name: 'Earlier task',
          exact: true,
        },
      ).waitFor()
      const earlier = page.locator(`[data-hydra-workspace="${before.id}"]`)
      await until({
        what: 'earlier Hydra starts wide',
        check: async () => {
          const box = await earlier.boundingBox()

          return box !== null && box.width > 2000
        },
      })
      await page.locator(`.topbar [data-sort-kind="hydra"][data-sort-id="${hydra.id}"]`).click()
      const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)
      await workspace.getByRole(
        'button',
        {
          name: 'Resize target',
          exact: true,
        },
      ).waitFor()
      await until({
        what: 'addressed Hydra starts aligned',
        check: async () => {
          const box = await workspace.boundingBox()

          return box !== null && Math.abs(box.x - 12) < 1
        },
      })
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
      ).fill('Projects')
      const projects = page.getByRole(
        'group',
        {
          name: 'Settings and actions',
          exact: true,
        },
      )
        .getByRole('option')
        .filter({ hasText: 'Projects' })
        .first()
      await projects.waitFor()
      await page.evaluate(() => window.dispatchEvent(new Event('hold-axis-resize')))
      await before.owner({
        args: [
          'view',
          'set',
          '--json',
          JSON.stringify({ workspace: { projectWidths: { ideas: 280 } } }),
        ],
      })
      await until({
        what: 'earlier Hydra shrinks',
        check: async () => {
          const box = await earlier.boundingBox()

          return box !== null && box.width < 1500
        },
      })
      await page.evaluate(() => window.dispatchEvent(new Event('release-axis-resize')))
      await until({
        what: 'addressed Hydra remains aligned',
        check: async () => {
          const box = await workspace.boundingBox()

          return box !== null && Math.abs(box.x - 12) < 1
        },
      })
      await projects.click()
      await page.mouse.click(
        12,
        450,
      )
      await page.getByRole(
        'dialog',
        {
          name: 'Oracle',
          exact: true,
        },
      ).waitFor({ state: 'hidden' })
      await workspace.getByRole(
        'button',
        {
          name: 'Resize target',
          exact: true,
        },
      ).waitFor()

      await before.owner({
        args: [
          'view',
          'set',
          '--json',
          JSON.stringify({ workspace: { projectWidths: { ideas: 1600 } } }),
        ],
      })
      await hydra.owner({
        args: [
          'view',
          'set',
          '--json',
          JSON.stringify({ workspace: { projectWidths: { ideas: 1600 } } }),
        ],
      })
      await until({
        what: 'both Hydras are wide',
        check: async () => {
          const first = await earlier.boundingBox()
          const second = await workspace.boundingBox()

          return first !== null && second !== null && first.width > 2000 && second.width > 2000
        },
      })
      await until({
        what: 'the addressed project finishes growing',
        check: async () => {
          const column = await workspace.locator('section[data-column="ideas"]').boundingBox()

          return !!column && column.width > 1599
        },
      })
      await until({
        what: 'the wide Hydra remains aligned before panning',
        check: async () => {
          const box = await workspace.boundingBox()

          return box !== null && Math.abs(box.x - 12) < 1
        },
      })
      await restingBox({ target: workspace })
      const axis = page.getByLabel(
        'Hydras',
        { exact: true },
      )
      await axis.evaluate(
        // eslint-disable-next-line pnyx/object-params -- Playwright owns the element callback.
        axis => {
          Reflect.set(
            window,
            'ownerAxisScrolled',
            false,
          )
          axis.addEventListener(
            'scroll',
            () => Reflect.set(
              window,
              'ownerAxisScrolled',
              true,
            ),
            { once: true },
          )
          axis.scrollTo({
            left: axis.scrollLeft + 200,
            behavior: 'instant',
          })
        },
      )
      await page.waitForFunction(() => Reflect.get(
        window,
        'ownerAxisScrolled',
      ))
      await until({
        what: 'the owner pans within the addressed Hydra',
        check: async () => {
          const box = await workspace.boundingBox()

          return box !== null && Math.abs(box.x + 188) < 1
        },
      })
      // eslint-disable-next-line pnyx/object-params -- Playwright owns the element callback.
      const scrollBeforeShrink = await axis.evaluate(element => element.scrollLeft)
      await page.evaluate(() => window.dispatchEvent(new Event('hold-axis-resize')))
      await before.owner({
        args: [
          'view',
          'set',
          '--json',
          JSON.stringify({ workspace: { projectWidths: { ideas: 280 } } }),
        ],
      })
      await until({
        what: 'earlier Hydra shrinks again',
        check: async () => {
          const box = await earlier.boundingBox()

          return box !== null && box.width < 1500
        },
      })
      await until({
        what: 'the shrink puts the old horizontal position beyond the native scroll range',
        check: async () => axis.evaluate(
          // eslint-disable-next-line pnyx/object-params -- Playwright owns the element callback.
          (
            element,
            previousScroll,
          ) => {
            const end = element.scrollWidth - element.clientWidth

            return previousScroll > end
          },
          scrollBeforeShrink,
        ),
      })
      await page.evaluate(() => window.dispatchEvent(new Event('release-axis-resize')))
      await until({
        what: 'the owner’s horizontal position survives clamping',
        check: async () => {
          const box = await workspace.boundingBox()

          return box !== null && Math.abs(box.x + 188) < 1
        },
      })
    } finally {
      await page.context().close()
    }
  },
)
