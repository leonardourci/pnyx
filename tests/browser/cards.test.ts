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

    const projectPaths: string[] = []

    for (let project = 0; project < PROJECTS; project++) {
      const folder = hydra.folder({ name: `Project-${project}` })
      projectPaths.push(folder)
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
          '--key',
          `project-${project}`,
          '--title',
          `Project task ${project}`,
          '--project',
          folder,
        ],
      })
    }

    const referenced = await hydra.task({ key: 'project-6' })
    const referring = await hydra.task({ key: 'project-7' })
    await hydra.owner({
      args: [
        'task',
        'brief',
        referring.id,
        '--brief',
        `Open [@Project task 6](pnyx-task:${referenced.id})`,
      ],
    })

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
        const columnTop = column.getBoundingClientRect().top
        const taskOffsets = new Map(cards.filter(card => column.contains(card)).map(card => [
          card,
          card.getBoundingClientRect().top - columnTop + column.scrollTop,
        ]))

        const sample = () => {
          const current = [...workspace.querySelectorAll('[data-column], [data-task]')]

          const replaced = original.some(node => !node.isConnected || !current.includes(node))

          if (current.length !== original.length || replaced) {
            failures.push('A column or card was removed or replaced')
          }

          const currentColumnTop = column.getBoundingClientRect().top

          for (const [
            card,
            offset,
          ] of taskOffsets) {
            const currentTop = card.getBoundingClientRect().top
            const currentOffset = currentTop - currentColumnTop + column.scrollTop

            if (Math.abs(currentOffset - offset) > 1) {
              failures.push(`Card moved inside its column: ${card.dataset.task}`)
            }
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

            let opacity = 1

            for (
              let ancestor: HTMLElement | null = element;
              ancestor;
              ancestor = ancestor.parentElement
            ) {
              opacity *= Number(getComputedStyle(ancestor).opacity)
            }

            if (opacity === 0) {
              const identity = element.dataset.task ?? element.dataset.column
              failures.push(`Transparent visible content: ${identity}`)
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

        const observer = new MutationObserver(records => {
          for (const record of records) {
            for (const removed of record.removedNodes) {
              if (original.some(node => removed.contains(node))) {
                failures.push('A column or card was detached during scrolling')
              }
            }
          }
        })
        observer.observe(
          workspace,
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

          if (step === 0) {
            throw new Error('The scroller has no visible area')
          }

          const sweeps: {
            offset: number
            maximum: number
          }[][] = []

          for (const direction of [
            1,
            -1,
          ]) {
            const positions: {
              offset: number
              maximum: number
            }[] = []

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
              positions.push({
                offset: horizontal ? element.scrollLeft : element.scrollTop,
                maximum: horizontal ? element.scrollWidth - element.clientWidth
                  : element.scrollHeight - element.clientHeight,
              })
            }

            sweeps.push(positions)
          }

          return {
            maximum,
            sweeps,
          }
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
          columns: columns.length,
          cards: cards.length,
          sideways,
          down,
        }
      })
      expect(stability.columns).toBe(9)
      expect(stability.cards).toBe(69)
      expect(stability.failures).toEqual([])
      expect(stability.sideways.maximum).toBeGreaterThan(width)
      expect(stability.down.maximum).toBeGreaterThan(0)

      for (const travel of [
        stability.sideways,
        stability.down,
      ]) {
        expect(travel.sweeps[0]?.[0]?.offset).toBe(0)
        const forward = travel.sweeps[0]!.at(-1)!
        const backward = travel.sweeps[1]![0]!
        expect(forward.offset).toBeCloseTo(
          forward.maximum,
          0,
        )
        expect(backward.offset).toBeCloseTo(
          backward.maximum,
          0,
        )
        expect(travel.sweeps[1]?.at(-1)?.offset).toBe(0)
      }
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
    const finalColumn = workspace.locator('[data-column]').last()
    await finalColumn.evaluate(column => {
      const axis = column.closest<HTMLElement>('.workspace-axis')

      if (!axis) {
        throw new Error('The project column has no horizontal scroller')
      }

      axis.style.width = `${column.getBoundingClientRect().width}px`
      axis.scrollLeft = 0
    })
    await page.getByRole(
      'button',
      {
        name: 'Project-7',
        exact: true,
      },
    ).click()
    await until({
      what: 'the requested project to fit when it fills the scroller',
      check: () => finalColumn.evaluate(column => {
        const axis = column.closest<HTMLElement>('.workspace-axis')

        if (!axis) {
          return false
        }

        const left = axis.getBoundingClientRect().left + axis.clientLeft
        const bounds = column.getBoundingClientRect()

        return Math.abs(bounds.left - left) <= 1
          && Math.abs(bounds.right - left - axis.clientWidth) <= 1
      }),
    })
    await finalColumn.evaluate(column => {
      column.closest<HTMLElement>('.workspace-axis')?.style.removeProperty('width')
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
    const sourceCard = workspace.locator(`[data-task="${referring.id}"]`)
    await sourceCard.getByRole(
      'button',
      {
        name: 'Project task 7',
        exact: true,
      },
    ).click()
    await sourceCard.getByRole(
      'button',
      { name: /^Open task Project task 6;/ },
    ).click()
    const requested = workspace.locator(`[data-task="${referenced.id}"]`)

    const assertRequestedTaskVisible = async () => {
      await until({
        what: 'the referenced task to receive focus',
        check: () => requested.evaluate(element => element.contains(document.activeElement)),
      })
      const hiddenFrames = await requested.evaluate(async element => {
        const frames: {
          left: number
          right: number
          visibleLeft: number
          visibleRight: number
        }[] = []
        const axis = element.closest<HTMLElement>('.workspace-axis')

        if (!axis) {
          throw new Error('The requested task has no horizontal scroller')
        }

        for (let frame = 0; frame < 10; frame++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
          const bounds = element.getBoundingClientRect()
          const scrollerLeft = axis.getBoundingClientRect().left + axis.clientLeft
          frames.push({
            left: bounds.left,
            right: bounds.right,
            visibleLeft: Math.max(
              0,
              scrollerLeft,
            ),
            visibleRight: Math.min(
              innerWidth,
              scrollerLeft + axis.clientWidth,
            ),
          })
        }

        return frames.filter(frame =>
          frame.left < frame.visibleLeft || frame.right > frame.visibleRight)
      })
      expect(hiddenFrames).toEqual([])
    }

    await assertRequestedTaskVisible()
    await page.evaluate(
      ({
        hydra,
        project,
        task,
      }) => {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }

        dispatchEvent(new CustomEvent(
          'pnyx:workspace-target',
          {
            detail: {
              hydra,
              path: project,
            },
          },
        ))
        dispatchEvent(new CustomEvent(
          'pnyx:workspace-target',
          {
            detail: {
              hydra,
              id: task,
            },
          },
        ))
      },
      {
        hydra: hydra.id,
        project: projectPaths[0],
        task: referenced.id,
      },
    )
    await assertRequestedTaskVisible()
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
    const applyHistory = ({ label }: { label: string }) => hydra.owner({
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
            brief: `${label} ${index}`,
          }),
        ),
      }),
    })
    await applyHistory({ label: 'Initial history' })
    await applyHistory({ label: 'Recent history' })
    let refuseOlder = true
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      beforeLoad: async ({ page }) => {
        await page.routeWebSocket(
          /\/ws(\?|$)/,
          socket => {
            const server = socket.connectToServer()
            socket.onMessage(message => {
              const sent = JSON.parse(String(message))
              const older = sent.name === 'task' && sent.args?.[0] === 'updates'
              && sent.args.includes('--before')

              if (older && refuseOlder) {
                refuseOlder = false
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
    expect(await region.getAttribute('aria-busy')).toBe('false')
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
      check: async () => await updates.count() === 131,
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

      element.scrollTo({
        top: element.scrollHeight,
        behavior: 'instant',
      })
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      const bottom = element.scrollTop
      element.scrollTo({
        top: 0,
        behavior: 'instant',
      })
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      observer.disconnect()

      return {
        retained: rows.every(row => row.isConnected) && !rows.some(row => removed.includes(row)),
        bottom,
        top: element.scrollTop,
      }
    })
    expect(retained.retained).toBe(true)
    expect(retained.bottom).toBeGreaterThan(0)
    expect(retained.top).toBe(0)
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
      check: async () => await updates.count() === 132,
    })
    refuseOlder = true
    await applyHistory({ label: 'Live burst' })
    await region.getByRole('alert').waitFor()
    expect(await updates.count()).toBe(132)
    await region.getByRole(
      'button',
      {
        name: 'Try again',
        exact: true,
      },
    ).click()
    await until({
      what: 'every burst update without replacing history',
      check: async () => await updates.count() === 197
        && await region.getAttribute('aria-busy') === 'false',
    })
    const updateIds = await region.evaluate(element => [...element.querySelectorAll('.update-row')]
      .map(row => row.getAttribute('data-update')))
    expect(updateIds).not.toContain(null)
    expect(new Set(updateIds).size).toBe(197)
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
