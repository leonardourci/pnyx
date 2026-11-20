import { beforeAll, expect, test } from 'vitest'
import { openHydra } from './page.ts'
import { rows, startPnyx, until, type Pnyx } from '../setup/pnyx.ts'

const COLUMN_TASKS = 61
const PROJECTS = 8
const HISTORY_EDITS = 65

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx({ zeroCache: true })
})

test(
  'scrolling across projects and a full column keeps every column and task mounted without gaps',
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
          { length: COLUMN_TASKS },
          (
            _,
            index,
          ) => ({
            op: 'task.create',
            key: `scroll-${index}`,
            title: `Scroll task ${index}`,
          }),
        ),
      }),
    })

    for (let project = 0; project < PROJECTS; project++) {
      const folder = hydra.folder({ name: `Project-${project}` })
      await hydra.owner({
        args: [
          'project',
          'add',
          folder,
        ],
      })
      await hydra.owner({
        args: [
          'task',
          'create',
          '--no-start',
          '--title',
          `Project task ${project}`,
          '--folder',
          folder,
        ],
      })
    }

    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)
    const column = workspace.locator('[data-column="ideas"] .column-cards')
    await column.getByRole(
      'button',
      {
        name: 'Scroll task 0',
        exact: true,
      },
    ).waitFor()
    await page.evaluate(() => document.fonts.ready.then(() => undefined))

    for (const width of [
      1440,
      390,
    ]) {
      await page.setViewportSize({
        width,
        height: 900,
      })
      const stability = await workspace.evaluate(async workspace => {
        const axis = workspace.closest<HTMLElement>('.workspace-axis')!
        const column = workspace.querySelector<HTMLElement>('[data-column="ideas"] .column-cards')!
        const columns = [...workspace.querySelectorAll<HTMLElement>('[data-column]')]
        const cards = [...workspace.querySelectorAll<HTMLElement>('[data-task]')]
        const original = [
          ...columns,
          ...cards,
        ]
        const failures: string[] = []
        let frames = 0

        const sample = () => {
          frames++
          const current = [...workspace.querySelectorAll('[data-column], [data-task]')]

          const replaced = original.some(node => !node.isConnected || !current.includes(node))

          if (current.length !== original.length || replaced) {
            failures.push('A column or card was removed or replaced')
          }

          for (const element of [
            ...columns,
            ...cards,
          ]) {
            const box = element.getBoundingClientRect()
            const parent = element.closest('.column-cards')?.getBoundingClientRect()
            const top = Math.max(
              box.top,
              parent?.top ?? 0,
              0,
            )
            const bottom = Math.min(
              box.bottom,
              parent?.bottom ?? innerHeight,
              innerHeight,
            )
            const left = Math.max(
              box.left,
              0,
            )
            const right = Math.min(
              box.right,
              innerWidth,
            )

            if (bottom - top < 4 || right - left < 4) {
              continue
            }

            const painted = document.elementsFromPoint(
              (left + right) / 2,
              (top + bottom) / 2,
            )

            if (!painted.some(node => element === node || element.contains(node))) {
              failures.push(`Missing visible content: ${element.dataset.task ?? element.dataset.column}`)
            }
          }
        }

        const observer = new MutationObserver(sample)
        observer.observe(
          axis,
          {
            childList: true,
            subtree: true,
          },
        )
        const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => {
          sample()
          resolve()
        }))

        const travel = async ({
          element,
          horizontal,
        }: {
          element: HTMLElement
          horizontal: boolean
        }) => {
          const maximum = horizontal ? element.scrollWidth - element.clientWidth
            : element.scrollHeight - element.clientHeight
          const step = (horizontal ? element.clientWidth : element.clientHeight) / 2

          for (const direction of [
            1,
            -1,
          ]) {
            for (let distance = 0; distance <= maximum + step; distance += step) {
              const offset = Math.min(
                distance,
                maximum,
              )
              const position = direction === 1 ? offset : maximum - offset
              element.scrollTo({
                left: horizontal ? position : element.scrollLeft,
                top: horizontal ? element.scrollTop : position,
                behavior: 'instant',
              })
              await frame()
            }
          }

          return maximum
        }

        const sideways = await travel({
          element: axis,
          horizontal: true,
        })
        column.closest<HTMLElement>('[data-column]')!.scrollIntoView({
          inline: 'start',
          behavior: 'instant',
        })
        await frame()
        const down = await travel({
          element: column,
          horizontal: false,
        })
        observer.disconnect()

        return {
          failures: [...new Set(failures)],
          frames,
          columns: columns.length,
          cards: cards.length,
          sideways,
          down,
        }
      })
      expect(stability.columns).toBe(9)
      expect(stability.cards).toBe(69)
      expect(stability.failures).toEqual([])
      expect(stability.frames).toBeGreaterThan(10)
      expect(stability.sideways).toBeGreaterThan(width)
      expect(stability.down).toBeGreaterThan(0)
    }

    await page.getByRole(
      'button',
      {
        name: 'Project-7',
        exact: true,
      },
    ).click()
    await until({
      what: 'the requested project to be in view',
      check: () => workspace.locator('[data-column]').last()
        .evaluate(element => {
          const box = element.getBoundingClientRect()

          return box.left >= 0 && box.right <= innerWidth
        }),
    })
    await workspace.getByRole(
      'button',
      {
        name: 'Fold all projects',
        exact: true,
      },
    ).click()
    await workspace.getByRole(
      'button',
      {
        name: 'Fold Hydra',
        exact: true,
      },
    ).click()
    await workspace.getByRole(
      'button',
      {
        name: 'Project-7',
        exact: true,
      },
    ).click()
    await until({
      what: 'the folded final project to unfold fully in view',
      check: () => workspace.locator('[data-column]').last()
        .evaluate(element => {
          const box = element.getBoundingClientRect()

          return box.width > 300 && box.left >= 0 && box.right <= innerWidth
        }),
    })
  },
)

test(
  'Activity loads every update before scrolling and retains its rows while scrolling and receiving changes',
  async () => {
    const hydra = await pnyx.hydra()
    const { card } = await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'history',
        '--title',
        'Persistent history',
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
          { length: HISTORY_EDITS },
          (
            _,
            index,
          ) => ({
            op: 'task.brief',
            task: 'history',
            brief: `History revision ${index}`,
          }),
        ),
      }),
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      beforeLoad: async ({ page }) => {
        let refusedOlder = false
        await page.routeWebSocket(
          /\/ws(\?|$)/,
          socket => {
            const server = socket.connectToServer()
            socket.onMessage(message => {
              const sent = JSON.parse(String(message))
              const older = sent.name === 'task' && sent.args?.[0] === 'updates'
              && sent.args.includes('--before')

              if (older && !refusedOlder) {
                refusedOlder = true
                socket.send(JSON.stringify({
                  type: 'error',
                  scope: sent.scope,
                  id: sent.id,
                  code: 'UPDATES_UNAVAILABLE',
                  error: 'The updates are unavailable',
                }))

                return
              }

              server.send(message)
            })
          },
        )
      },
    })
    await page.getByRole(
      'button',
      {
        name: 'Persistent history',
        exact: true,
      },
    ).click()
    await page.getByRole(
      'tab',
      {
        name: 'Activity',
        exact: true,
      },
    ).click()
    const updates = page.locator(`[data-task="${card.id}"] .update-row`)
    const region = page.getByRole(
      'region',
      {
        name: 'Task updates',
        exact: true,
      },
    )
    await region.getByRole('alert').waitFor()
    expect(await updates.count()).toBe(50)
    const beforeRetry = await updates.elementHandles()
    await region.getByRole(
      'button',
      {
        name: 'Try again',
        exact: true,
      },
    ).click()
    await until({
      what: 'every update loaded without scrolling',
      check: async () => await updates.count() === 66,
    })
    expect(await page.evaluate(
      nodes => nodes.every(node => node.isConnected),
      beforeRetry,
    )).toBe(true)
    const originals = await updates.elementHandles()
    const retained = await page.locator(`[data-task="${card.id}"] [role="tabpanel"]:visible`).evaluate(async element => {
      const rows = [...element.querySelectorAll('.update-row')]
      const removed: Node[] = []
      const observer = new MutationObserver(records => {
        for (const record of records) {
          removed.push(...record.removedNodes)
        }
      })
      observer.observe(
        element,
        {
          subtree: true,
          childList: true,
        },
      )

      for (const top of [
        element.scrollHeight,
        0,
      ]) {
        element.scrollTo({
          top,
          behavior: 'instant',
        })
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      }

      const maximum = element.scrollHeight - element.clientHeight
      element.scrollTop = maximum
      const bottom = element.scrollTop
      observer.disconnect()

      return {
        retained: rows.every(row => row.isConnected) && !rows.some(row => removed.includes(row)),
        bottom,
      }
    })
    expect(retained.retained).toBe(true)
    expect(retained.bottom).toBeGreaterThan(0)
    await hydra.owner({
      args: [
        'task',
        'brief',
        'history',
        '--brief',
        'History updated live',
      ],
    })
    await until({
      what: 'the live update',
      check: async () => await updates.count() === 67,
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
          { length: HISTORY_EDITS },
          (
            _,
            index,
          ) => ({
            op: 'task.brief',
            task: 'history',
            brief: `Live burst ${index}`,
          }),
        ),
      }),
    })
    await until({
      what: 'every burst update without replacing history',
      check: async () => await updates.count() === 132,
    })
    expect(await page.evaluate(
      nodes => nodes.every(node => node.isConnected),
      originals,
    )).toBe(true)
  },
)

test(
  'an open task fills its column height and follows a viewport resize',
  async () => {
    const hydra = await pnyx.hydra()
    const created = await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Read the worker chat',
      ],
    })
    await hydra.owner({
      args: [
        'view',
        'set',
        '--json',
        JSON.stringify({ cardHeights: { [created.card.id]: 440 } }),
      ],
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    await page.getByRole(
      'button',
      {
        name: 'Read the worker chat',
        exact: true,
      },
    ).click()
    const card = page.locator('[data-task].selected')
    await card.waitFor()

    const fillsColumn = () => card.evaluate(element => {
      const column = element.closest<HTMLElement>('.column-cards')

      if (!column) {
        throw new Error('The open card is outside its project column')
      }

      const spacing = getComputedStyle(column)
      const padding = parseFloat(spacing.paddingTop) + parseFloat(spacing.paddingBottom)
      const available = column.clientHeight - padding

      return {
        available,
        height: element.getBoundingClientRect().height,
      }
    })
    const columnHeight = await until({
      what: 'the open card to fill its column',
      check: async () => {
        const {
          available,
          height,
        } = await fillsColumn()

        return Math.abs(height - available) <= 1 ? available : false
      },
    })
    await page.setViewportSize({
      width: 1440,
      height: 1100,
    })
    await until({
      what: 'the open card to fill the resized column',
      check: async () => {
        const {
          available,
          height,
        } = await fillsColumn()

        return height > columnHeight + 1 && available > columnHeight
          && Math.abs(height - available) <= 1
      },
    })
  },
)

test(
  'starting a task attaches its worker without creating a second card',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'single-task' })
    const created = await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'One task, one card',
        '--folder',
        folder,
      ],
    })
    const task = created.card.id as string
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    const taskCard = page.locator(`[data-task="${task}"]`)
    const card = await taskCard.elementHandle()
    await hydra.owner({
      args: [
        'task',
        'start',
        task,
        '--harness',
        'codex',
      ],
    })
    const worker = await hydra.agent({ cwd: folder })
    await until({
      what: 'the worker first turn',
      check: () => worker.answered > 0,
    })
    expect(rows({
      text: 'select id from cards where hydra_id = $1 and title = $2',
      values: [
        hydra.id,
        'One task, one card',
      ],
    })).toEqual([{ id: task }])
    await taskCard.locator('.card-agent[aria-label="Codex"]').waitFor()

    expect(await taskCard.evaluate(
      (
        element,
        original,
      ) => element === original,
      card,
    )).toBe(true)
  },
)
