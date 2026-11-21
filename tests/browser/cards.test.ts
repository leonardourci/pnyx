import { beforeAll, expect, onTestFinished, test } from 'vitest'
import { openHydra } from './page.ts'
import { chrome } from './chrome.ts'
import { rows, startPnyx, until, type Hydra, type Pnyx } from '../setup/pnyx.ts'

const COLUMN_TASKS = 61
const PROJECTS = 8
const HISTORY_EDITS = 65
const REVEAL_PROJECTS = 4
const REVEAL_FRAMES = 120
const SCROLL_INPUT_FRAMES = 90

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx({ zeroCache: true })
})

async function addRevealProjects({ hydra }: { hydra: Hydra }) {
  const projects: string[] = []

  for (let index = 0; index < REVEAL_PROJECTS; index++) {
    const folder = hydra.folder({ name: `Reveal-${index}` })
    await hydra.owner({
      args: [
        'project',
        'add',
        folder,
      ],
    })
    projects.push(folder)
  }

  return projects
}

test(
  'a pending project reveal resumes when its column arrives',
  async () => {
    const hydra = await pnyx.hydra()
    await addRevealProjects({ hydra })
    const arriving = hydra.folder({ name: 'Arriving project' })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)
    await until({
      what: 'the initial project columns',
      check: async () => await workspace.locator('[data-column]').count() === REVEAL_PROJECTS + 1,
    })
    await workspace.evaluate(
      async (
        element,
        detail,
      ) => {
        element.closest<HTMLElement>('.workspace-axis')!.scrollLeft = 0
        dispatchEvent(new CustomEvent(
          'pnyx:workspace-target',
          { detail },
        ))
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      },
      {
        hydra: hydra.id,
        path: arriving,
      },
    )
    await hydra.owner({
      args: [
        'project',
        'add',
        arriving,
      ],
    })
    const column = workspace.locator(`[data-column="${arriving}"]`)
    await column.waitFor()
    await until({
      what: 'the arriving project to reveal itself',
      check: () => column.evaluate(element => {
        const bounds = element.getBoundingClientRect()

        return bounds.left >= 0 && bounds.right <= innerWidth
      }),
    })
  },
)

test(
  'an inactive Hydra cannot finish a project reveal over the selected Hydra',
  async () => {
    const hydra = await pnyx.hydra()
    const projects = await addRevealProjects({ hydra })
    const other = await pnyx.hydra()
    const project = projects.at(-1)!
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)
    const column = workspace.locator(`[data-column="${project}"]`)
    await column.waitFor()
    await page.locator(`[data-hydra-workspace="${other.id}"]`).waitFor()
    const expandedWidth = await column.evaluate(element => element.getBoundingClientRect().width)
    await hydra.owner({
      args: [
        'view',
        'set',
        '--json',
        JSON.stringify({
          workspace: {
            foldedProjects: { [project]: true },
          },
        }),
      ],
    })
    await until({
      what: 'the project to finish folding',
      check: () => column.evaluate(element => element.getBoundingClientRect().width <= 49),
    })
    const switched = await column.evaluate(
      async (
        element,
        detail,
      ) => {
        const foldedWidth = element.getBoundingClientRect().width
        const destination = document.querySelector<HTMLElement>(
          `[data-hydra-workspace="${CSS.escape(detail.other)}"]`,
        )!
        const chip = document.querySelector<HTMLButtonElement>(
          `button[data-sort-kind="hydra"][data-sort-id="${CSS.escape(detail.other)}"]`,
        )!
        dispatchEvent(new CustomEvent(
          'pnyx:workspace-target',
          {
            detail: {
              hydra: detail.hydra,
              path: detail.project,
            },
          },
        ))
        let selected = false
        let seen = false
        let settled = 0
        const missing: number[] = []

        for (let frame = 0; frame < detail.frames; frame++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
          const projectBounds = element.getBoundingClientRect()
          const width = projectBounds.width
          const opened = width > foldedWidth + 1
          const outside = projectBounds.left < 0 || projectBounds.right > innerWidth

          if (!selected && opened && outside) {
            chip.click()
            selected = true
          }

          if (!selected || destination.dataset.active !== 'true') {
            continue
          }

          const bounds = destination.getBoundingClientRect()
          const visible = bounds.left >= -1 && bounds.right <= innerWidth + 1

          if (visible) {
            seen = true
          }

          if (seen && !visible) {
            missing.push(bounds.left)
          }

          settled = Math.abs(width - detail.expandedWidth) <= 1 ? settled + 1 : 0

          if (seen && settled >= 10) {
            break
          }
        }

        return {
          selected,
          seen,
          settled,
          missing,
          active: destination.dataset.active,
        }
      },
      {
        hydra: hydra.id,
        project,
        other: other.id,
        expandedWidth,
        frames: REVEAL_FRAMES,
      },
    )
    expect(switched.selected).toBe(true)
    expect(switched.active).toBe('true')
    expect(switched.seen).toBe(true)
    expect(switched.settled).toBeGreaterThanOrEqual(10)
    expect(switched.missing).toEqual([])
  },
)

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
    const unfoldingProject = workspace.locator(`[data-column="${projectPaths[0]}"]`)
    const expandedProjectWidth = await unfoldingProject.evaluate(element =>
      element.getBoundingClientRect().width)
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
      async ({
        hydra,
        project,
        task,
        frames,
      }) => {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }

        const workspace = document.querySelector<HTMLElement>(
          `[data-hydra-workspace="${CSS.escape(hydra)}"]`,
        )!
        const column = workspace.querySelector<HTMLElement>(`[data-column="${CSS.escape(project)}"]`)!
        const foldedWidth = column.getBoundingClientRect().width
        dispatchEvent(new CustomEvent(
          'pnyx:workspace-target',
          {
            detail: {
              hydra,
              path: project,
            },
          },
        ))

        for (let frame = 0; frame < frames; frame++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
          const bounds = column.getBoundingClientRect()
          const width = bounds.width
          const outside = bounds.left < 0 || bounds.right > innerWidth

          if (width > foldedWidth + 1 && outside) {
            dispatchEvent(new CustomEvent(
              'pnyx:workspace-target',
              {
                detail: {
                  hydra,
                  id: task,
                },
              },
            ))

            return
          }
        }

        throw new Error('The project did not begin unfolding before the task request')
      },
      {
        hydra: hydra.id,
        project: projectPaths[0],
        task: referenced.id,
        frames: REVEAL_FRAMES,
      },
    )
    await until({
      what: 'the interrupted project to finish unfolding',
      check: () => unfoldingProject.evaluate(
        (
          element,
          width,
        ) =>
          Math.abs(element.getBoundingClientRect().width - width) <= 1,
        expandedProjectWidth,
      ),
    })
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
    let failOlder: (() => void) | undefined
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
                failOlder = () => socket.send(JSON.stringify({
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

    const failPendingRead = async () => {
      const fail = await until({
        what: 'the older-page response to be pending',
        check: () => failOlder,
      })
      expect(await region.getAttribute('aria-busy')).toBe('true')
      await region.getByRole('status').waitFor()
      failOlder = undefined
      fail()
    }

    await failPendingRead()
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
        retained: rows.every(row => row.isConnected)
          && !rows.some(row => removed.some(node => node.contains(row))),
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
    await failPendingRead()
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

test(
  'command notices remain visible after reload and clear after a clean write',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'notice-card',
        '--title',
        'Command notices',
      ],
    })
    const task = (await hydra.task({ key: 'notice-card' })).id
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    const taskCard = page.locator(`[data-task="${task}"]`)
    await taskCard.locator('.card-open').click()
    const held = await hydra.owner({
      args: [
        'task',
        'hold',
        task,
        '--actor',
        `worker:${task}`,
      ],
    })
    expect(held.notices).toBeDefined()
    const notice = 'Discussion hold changed by an agent'
    await taskCard.getByText(
      notice,
      { exact: false },
    ).waitFor()
    await page.reload()
    await page.locator(`[data-task="${task}"]`).getByText(
      notice,
      { exact: false },
    )
      .waitFor()
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
            op: 'task.brief',
            task,
            brief: 'Updated instructions',
          },
        ],
      }),
    })
    await page.locator(`[data-task="${task}"]`).getByText(
      notice,
      { exact: false },
    )
      .waitFor({ state: 'detached' })
  },
)

test(
  'closing a task keeps workspace wheel scrolling available',
  async () => {
    const hydra = await pnyx.hydra()
    await addRevealProjects({ hydra })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Scroll after closing',
      ],
    })
    await chrome({
      script: `
    await page.open(${JSON.stringify(`http://127.0.0.1:${pnyx.port()}/hydra/${hydra.id}/`)});
    await page.wait('[data-hydra-workspace="${hydra.id}"] .card-open');
    await page.click('[data-hydra-workspace="${hydra.id}"] .card-open');
    await page.wait('[data-hydra-workspace="${hydra.id}"] .card.selected');
  `,
    })
    const result = await chrome({
      script: `
    console.log(await page.eval(async () => {
      const card = document.querySelector('[data-hydra-workspace="${hydra.id}"] .card.selected');
      const axis = card.closest('.workspace-axis');
      const column = card.closest('[data-column]');
      const expandedWidth = column.getBoundingClientRect().width;
      card.querySelector('.card-open').click();
      let previousWidth = expandedWidth;
      let scrollBeforeWheel;
      for (let frame = 0; frame < ${SCROLL_INPUT_FRAMES}; frame++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (scrollBeforeWheel === undefined) {
          const width = column.getBoundingClientRect().width;
          const shrankAndSettled = width < expandedWidth && width === previousWidth;
          previousWidth = width;
          if (!shrankAndSettled) continue;
          scrollBeforeWheel = axis.scrollLeft;
        }
        if (axis.scrollLeft > scrollBeforeWheel + 10) return true;
        column.dispatchEvent(new WheelEvent('wheel', { deltaX: 40, bubbles: true, cancelable: true }));
      }
      return false;
    }));
  `,
    })
    expect(JSON.parse(result)).toBe(true)
  },
)

test(
  'saving a task leaves its card closed and its writing fields readable',
  async () => {
    const hydra = await pnyx.hydra()
    const name = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    const title = 'Keep this task closed while its complete title wraps and stays readable throughout the narrow project column'
    const prose = Array(32).fill('Every line remains readable in its field.')
      .join('\n')
    const result = JSON.parse(await chrome({
      script: `
    await page.open(${JSON.stringify(`http://127.0.0.1:${pnyx.port()}/hydra/${hydra.id}/`)});
    await page.wait('[data-hydra-workspace="${hydra.id}"] [aria-label="Reply to Hydra"]');
    await page.click('[data-hydra-workspace="${hydra.id}"] .hydra-title');
    await page.eval(() => {
      const field = document.querySelector('[data-hydra-workspace="${hydra.id}"] [aria-label="Hydra name"]');
      field.select();
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', ${JSON.stringify(name.split('').join('\n'))});
      field.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    });
    const renameFits = await page.eval(() => { const field = document.querySelector('[data-hydra-workspace="${hydra.id}"] [aria-label="Hydra name"]'); return field.scrollWidth <= field.clientWidth + 1 && field.scrollHeight <= field.clientHeight + 1; });
    await page.press('Enter');
    await page.wait('[data-hydra-workspace="${hydra.id}"] .hydra-title[aria-label="Edit ${name}"]');
    await page.fill('[data-hydra-workspace="${hydra.id}"] [aria-label="Reply to Hydra"]', ${JSON.stringify(prose)});
    const chatBounded = await page.eval(() => {
      const field = document.querySelector('[data-hydra-workspace="${hydra.id}"] [aria-label="Reply to Hydra"]');
      return field.scrollHeight > field.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(field).overflowY) && field.getBoundingClientRect().height <= Math.min(innerHeight / 2, 480);
    });
    await page.fill('[data-hydra-workspace="${hydra.id}"] [aria-label="Reply to Hydra"]', '');
    await page.wait('[data-hydra-workspace="${hydra.id}"] [aria-label="New task in Ideas"]');
    await page.click('[data-hydra-workspace="${hydra.id}"] [aria-label="New task in Ideas"]');
    const titleHeight = await page.eval(() => document.querySelector('[data-hydra-workspace="${hydra.id}"] [aria-label="Task title"]').getBoundingClientRect().height);
    await page.fill('[data-hydra-workspace="${hydra.id}"] [aria-label="Task title"]', ${JSON.stringify(title.slice('Keep'.length))});
    await page.eval(() => {
      const field = document.querySelector('[data-hydra-workspace="${hydra.id}"] [aria-label="Task title"]');
      field.setSelectionRange(0, 0);
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'Ke\\nep');
      field.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    });
    await page.press('Shift+Enter');
    await page.fill('[data-hydra-workspace="${hydra.id}"] [aria-label="Your ask"]', ${JSON.stringify(prose)});
    await page.press('Shift+Enter');
    const fields = await page.eval(() => {
      const title = document.querySelector('[data-hydra-workspace="${hydra.id}"] [aria-label="Task title"]');
      const ask = document.querySelector('[data-hydra-workspace="${hydra.id}"] [aria-label="Your ask"]');
      return { titleHeight: title.getBoundingClientRect().height, titleFits: title.scrollWidth <= title.clientWidth + 1 && title.scrollHeight <= title.clientHeight + 1, titleAfterShiftEnter: title.value, pasteCaret: title.selectionStart, askGrows: ask.scrollHeight <= ask.clientHeight + 1 && ask.getBoundingClientRect().height > innerHeight / 2, multiLine: ask.value.endsWith('\\n') };
    });
    await page.eval(() => [...document.querySelectorAll('.task-create button')].find(button => button.textContent === 'Save task').click());
    await page.wait('[data-hydra-workspace="${hydra.id}"] .card-open');
    const card = await page.eval(() => {
      const card = document.querySelector('[data-hydra-workspace="${hydra.id}"] .card-open');
      const form = document.querySelector('[data-hydra-workspace="${hydra.id}"] .task-create');
      return { expanded: card.getAttribute('aria-expanded'), column: card.closest('[data-column]').dataset.column, title: card.textContent, formClosed: form === null, focusLabel: document.activeElement?.getAttribute('aria-label') };
    });
    console.log(JSON.stringify({ fields: { ...fields, renameFits, titleGrows: fields.titleHeight > titleHeight, chatBounded }, card }));
  `,
    }))
    await until({
      what: 'the saved task',
      check: () => rows({
        text: 'select id from cards where hydra_id = $1 and title = $2',
        values: [
          hydra.id,
          title,
        ],
      }).length === 1,
    })
    expect(result.fields).toMatchObject({
      renameFits: true,
      titleFits: true,
      titleGrows: true,
      pasteCaret: 'Keep'.length,
      titleAfterShiftEnter: title,
      askGrows: true,
      multiLine: true,
      chatBounded: true,
    })
    expect(result.card).toEqual({
      expanded: 'false',
      column: 'ideas',
      title,
      formClosed: true,
      focusLabel: 'Fold Ideas',
    })
  },
)

test.each([
  { viewport: '1440x900' },
  { viewport: '390x844' },
])(
  'folded Hydras and project columns keep one aligned vertical strip at $viewport',
  async ({ viewport }) => {
    const hydra = await pnyx.hydra()
    const projects = await addRevealProjects({ hydra })

    for (const key of [
      'fold-asks',
      'fold-running',
    ]) {
      await hydra.owner({
        args: [
          'task',
          'create',
          '--no-start',
          '--key',
          key,
          '--title',
          key,
          '--project',
          projects[0],
          '--folder',
          projects[0],
        ],
      })
    }

    await hydra.owner({
      args: [
        'task',
        'ask',
        'fold-asks',
        '--to',
        'owner',
        '--question',
        'Which option?',
      ],
    })
    const turn = pnyx.claude.plan({
      hydra: hydra.id,
      hold: true,
    })

    onTestFinished(async () => {
      turn.release()
      await chrome({ args: ['emulate'] })
    })
    await hydra.owner({
      args: [
        'task',
        'start',
        'fold-running',
        '--in-place',
      ],
    })
    await chrome({ script: `await page.open(${JSON.stringify(`http://127.0.0.1:${pnyx.port()}/hydra/${hydra.id}/`)});` })
    await chrome({
      args: [
        'emulate',
        '--viewport',
        viewport,
      ],
    })
    const geometry = await chrome({
      script: `
    await page.wait('[data-hydra-workspace="${hydra.id}"] .project-chips .running-count');
    await page.wait('[data-hydra-workspace="${hydra.id}"] .project-chips .waiting-count');
    console.log(await page.eval(async () => {
      const workspace = document.querySelector('[data-hydra-workspace="${hydra.id}"]');
      const uprightCounts = ({ roots }) => ['.waiting-count', '.running-count > span'].every(selector => {
        const counts = roots.flatMap(root => [...root.querySelectorAll(selector)]);
        return counts.length > 0 && counts.every(count =>
          count.getBoundingClientRect().width > 0 && getComputedStyle(count).writingMode === 'horizontal-tb'
        );
      });
      const projects = workspace.querySelector('.project-chips');
      const bar = workspace.querySelector('.hydra-workspace-bar');
      const add = bar.querySelector('[aria-label="Add project"]');
      const controls = [bar.querySelector('[aria-label="Fold Hydra"]'), bar.querySelector('[aria-label="Fold all projects"]'), bar.querySelector('.hydra-drag-name'), add].filter(Boolean);
      const naturalPositions = controls.map(control => control.getBoundingClientRect());
      const naturalProjectsLeft = projects.getBoundingClientRect().left;
      projects.style.maxWidth = '100px';
      await new Promise(requestAnimationFrame);
      const positions = controls.map(control => control.getBoundingClientRect());
      projects.scrollLeft = projects.scrollWidth;
      await new Promise(requestAnimationFrame);
      const topbar = {
        visible: naturalPositions.every(box => box.left >= 0 && box.right <= innerWidth),
        controlOrder: controls.length === 4
          && naturalPositions.every((box, index) => index === 0 || box.left >= naturalPositions[index - 1].right)
          && naturalProjectsLeft >= naturalPositions[3].right,
        scrolled: projects.scrollLeft > 0,
        pinned: controls.every((control, index) => control.getBoundingClientRect().left === positions[index].left),
        singleEntry: workspace.querySelectorAll('[aria-label="Add project"]').length === 1
          && ![...workspace.querySelectorAll('button')].some(button => button.textContent.trim() === 'Project'),
      };
      projects.style.removeProperty('max-width');
      projects.scrollLeft = 0;
      const expandedWorkspaceWidth = workspace.getBoundingClientRect().width;
      workspace.querySelector('[aria-label="Fold Hydra"]').click();
      await new Promise(requestAnimationFrame);
      projects.style.maxHeight = '100px';
      const box = workspace.getBoundingClientRect();
      const chips = [...projects.querySelectorAll('button')].map(chip => chip.getBoundingClientRect());
      const marks = [...workspace.querySelectorAll('.hydra-drag-name > svg, .hydra-drag-name > .hydra-label, .hydra-workspace-bar .waiting-count, .hydra-workspace-bar .running-count > *')].map(mark => mark.getBoundingClientRect());
      const center = (box.left + box.right) / 2;
      const strip = {
        thin: box.width <= 60,
        bodyHidden: workspace.querySelector('main').getClientRects().length === 0,
        scrollable: projects.scrollHeight > projects.clientHeight,
        upright: uprightCounts({ roots: [projects] }),
        aligned: [...chips, ...marks].every(mark => Math.abs((mark.left + mark.right) / 2 - center) <= 1),
        contained: [...chips, ...marks].every(mark => mark.left >= box.left && mark.right <= box.right),
        stacked: chips.length === 5 && chips.every((chip, index) => !index || chip.top >= chips[index - 1].bottom),
      };
      projects.style.removeProperty('max-height');
      workspace.querySelector('[aria-label="Unfold Hydra"]').click();
      await new Promise(requestAnimationFrame);
      const workspaceUnfolded = workspace.getBoundingClientRect().width === expandedWorkspaceWidth
        && workspace.querySelector('main').getClientRects().length > 0;
      const columns = [...workspace.querySelectorAll('.project-column')];
      const expandedWidths = columns.map(column => column.getBoundingClientRect().width);
      workspace.querySelector('[aria-label="Fold all projects"]').click();
      await new Promise(requestAnimationFrame);
      const columnCountsUpright = uprightCounts({ roots: columns });
      const folded = columns.length === 5 && columns.every(column => {
        const box = column.getBoundingClientRect();
        const center = (box.left + box.right) / 2;
        const marks = [...column.querySelectorAll('.project-column-heading button > svg, .project-column-heading button > strong, .waiting-count, .running-count > *')];
        const cards = column.querySelector('.column-cards');
        return box.width > 0 && box.width <= 49 && cards.getClientRects().length === 0 && marks.length > 0 && marks.every(mark => {
          const bounds = mark.getBoundingClientRect();
          return bounds.left >= box.left && bounds.right <= box.right && Math.abs((bounds.left + bounds.right) / 2 - center) <= 1;
        });
      });
      workspace.querySelector('[aria-label="Unfold all projects"]').click();
      await new Promise(requestAnimationFrame);
      const unfolded = columns.every((column, index) =>
        column.getBoundingClientRect().width === expandedWidths[index]
        && column.querySelector('.column-cards').getClientRects().length > 0
      );
      workspace.querySelector('[aria-label="Fold chat"]').click();
      await new Promise(requestAnimationFrame);
      add?.click();
      await new Promise(requestAnimationFrame);
      const composer = workspace.querySelector('.hydra-chat .composer textarea');
      const attachRequested = composer?.value.includes(' to this Hydra') && document.activeElement === composer;
      return JSON.stringify({ topbar, strip, workspaceUnfolded, folded, columnCountsUpright, unfolded, attachRequested: !!attachRequested });
    }));
    `,
    })
    expect(JSON.parse(geometry)).toEqual({
      topbar: {
        visible: true,
        controlOrder: true,
        scrolled: true,
        pinned: true,
        singleEntry: true,
      },
      strip: {
        thin: true,
        bodyHidden: true,
        scrollable: true,
        upright: true,
        aligned: true,
        contained: true,
        stacked: true,
      },
      workspaceUnfolded: true,
      folded: true,
      columnCountsUpright: true,
      unfolded: true,
      attachRequested: true,
    })
  },
)
