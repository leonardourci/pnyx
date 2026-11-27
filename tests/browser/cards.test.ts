import { loadTitan } from '#app/store.ts'
import { MAX_BRIEF_LENGTH } from '#tasks/model.ts'
import { beforeAll, expect, onTestFinished, test } from 'vitest'
import { openTitan } from './page.ts'
import { chrome, fillComposer } from './chrome.ts'
import { startOthrys, until, type Titan, type Othrys } from '../setup/othrys.ts'

const COLUMN_TASKS = 61
const PROJECTS = 8
const HISTORY_EDITS = 65
const REVEAL_PROJECTS = 4
const REVEAL_FRAMES = 120
const SCROLL_INPUT_FRAMES = 90

let othrys: Othrys

beforeAll(async () => {
  othrys = await startOthrys()
})

async function addRevealProjects({ titan }: { titan: Titan }) {
  const projects: string[] = []

  for (let index = 0; index < REVEAL_PROJECTS; index++) {
    const folder = titan.folder({ name: `Reveal-${index}` })
    await titan.owner({
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
    const titan = await othrys.titan()
    await addRevealProjects({ titan })
    const arriving = titan.folder({ name: 'Arriving project' })
    const page = await openTitan({
      port: othrys.port(),
      titanId: titan.id,
    })
    const workspace = page.locator(`[data-titan-workspace="${titan.id}"]`)
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
          'othrys:workspace-target',
          { detail },
        ))
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      },
      {
        titan: titan.id,
        path: arriving,
      },
    )
    await titan.owner({
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
  'an inactive Titan cannot finish a project reveal over the selected Titan',
  async () => {
    const titan = await othrys.titan()
    const projects = await addRevealProjects({ titan })
    const other = await othrys.titan()
    const project = projects.at(-1)!
    const page = await openTitan({
      port: othrys.port(),
      titanId: titan.id,
    })
    const workspace = page.locator(`[data-titan-workspace="${titan.id}"]`)
    const column = workspace.locator(`[data-column="${project}"]`)
    await column.waitFor()
    await page.locator(`[data-titan-workspace="${other.id}"]`).waitFor()
    const expandedWidth = await column.evaluate(element => element.getBoundingClientRect().width)
    await titan.owner({
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
          `[data-titan-workspace="${CSS.escape(detail.other)}"]`,
        )!
        const chip = document.querySelector<HTMLButtonElement>(
          `button[data-sort-kind="titan"][data-sort-id="${CSS.escape(detail.other)}"]`,
        )!
        dispatchEvent(new CustomEvent(
          'othrys:workspace-target',
          {
            detail: {
              titan: detail.titan,
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
        titan: titan.id,
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
    const titan = await othrys.titan()
    await titan.owner({
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
      const folder = titan.folder({ name: `Project-${project}` })
      projectPaths.push(folder)
      await titan.owner({
        args: [
          'project',
          'add',
          folder,
        ],
      })
      await titan.owner({
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

    const referenced = await titan.task({ key: 'project-6' })
    const referring = await titan.task({ key: 'project-7' })
    await titan.owner({
      args: [
        'task',
        'brief',
        referring.id,
        '--brief',
        `Open [@Project task 6](othrys-task:${referenced.id})`,
      ],
    })

    const page = await openTitan({
      port: othrys.port(),
      titanId: titan.id,
    })
    const workspace = page.locator(`[data-titan-workspace="${titan.id}"]`)
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

    await page.setViewportSize({
      width: 1440,
      height: 900,
    })
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

    for (const item of [
      'Fold all projects',
      'Fold Titan',
    ]) {
      await page.locator('.active-titan .titan-chip').click()
      await page.getByRole(
        'menuitem',
        {
          name: item,
          exact: true,
        },
      ).click()
    }

    await page.getByRole(
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
        titan,
        project,
        task,
        frames,
      }) => {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }

        const workspace = document.querySelector<HTMLElement>(
          `[data-titan-workspace="${CSS.escape(titan)}"]`,
        )!
        const column = workspace.querySelector<HTMLElement>(`[data-column="${CSS.escape(project)}"]`)!
        const axis = workspace.closest<HTMLElement>('.workspace-axis')!
        const pastColumn = column.getBoundingClientRect().right
          - axis.getBoundingClientRect().left + 1
        axis.scrollTo({
          left: axis.scrollLeft + pastColumn,
          behavior: 'instant',
        })
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        const foldedWidth = column.getBoundingClientRect().width
        dispatchEvent(new CustomEvent(
          'othrys:workspace-target',
          {
            detail: {
              titan,
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
              'othrys:workspace-target',
              {
                detail: {
                  titan,
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
        titan: titan.id,
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
    const titan = await othrys.titan()
    const { card } = await titan.owner({
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
    const applyHistory = ({ label }: { label: string }) => titan.owner({
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
    const page = await openTitan({
      port: othrys.port(),
      titanId: titan.id,
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
    await titan.owner({
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
    const titan = await othrys.titan()
    const created = await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Read the worker chat',
      ],
    })
    await titan.owner({
      args: [
        'view',
        'set',
        '--json',
        JSON.stringify({ cardHeights: { [created.card.id]: 440 } }),
      ],
    })
    const page = await openTitan({
      port: othrys.port(),
      titanId: titan.id,
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
    const titan = await othrys.titan()
    const folder = titan.folder({ name: 'single-task' })
    const created = await titan.owner({
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
    const page = await openTitan({
      port: othrys.port(),
      titanId: titan.id,
    })
    const taskCard = page.locator(`[data-task="${task}"]`)
    const card = await taskCard.elementHandle()
    await titan.owner({
      args: [
        'task',
        'start',
        task,
        '--harness',
        'codex',
      ],
    })
    const worker = await titan.agent({ cwd: folder })
    await until({
      what: 'the worker first turn',
      check: () => worker.answered > 0,
    })
    expect(Object.values(loadTitan({
      titanId: titan.id,
    }).state.cards).filter(card => card.title === 'One task, one card')
      .map(card => ({ id: card.id }))).toEqual([{ id: task }])
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
    const titan = await othrys.titan()
    await titan.owner({
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
    const task = (await titan.task({ key: 'notice-card' })).id
    const page = await openTitan({
      port: othrys.port(),
      titanId: titan.id,
    })
    const taskCard = page.locator(`[data-task="${task}"]`)
    await taskCard.locator('.card-open').click()
    const held = await titan.owner({
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
    await titan.owner({
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
    const titan = await othrys.titan()
    await addRevealProjects({ titan })
    await titan.owner({
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
    await page.open(${JSON.stringify(`http://127.0.0.1:${othrys.port()}/titan/${titan.id}/`)});
    await page.wait('[data-titan-workspace="${titan.id}"] .card-open');
    await page.click('[data-titan-workspace="${titan.id}"] .card-open');
    await page.wait('[data-titan-workspace="${titan.id}"] .card.selected');
  `,
    })
    const result = await chrome({
      script: `
    console.log(await page.eval(async () => {
      const card = document.querySelector('[data-titan-workspace="${titan.id}"] .card.selected');
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
  'Titan names and chat drafts keep pasted text readable in a narrow workspace',
  async () => {
    const titan = await othrys.titan()
    await chrome({ script: `await page.open(${JSON.stringify(`http://127.0.0.1:${othrys.port()}/titan/${titan.id}/`)});` })
    await chrome({
      args: [
        'emulate',
        '--viewport',
        '390x844',
      ],
    })
    onTestFinished(async () => {
      await chrome({ args: ['emulate'] })
    })
    const name = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    const prose = [
      '--no-start',
      ...Array(32).fill('Every line remains readable in its field.'),
    ].join('\n')
    const result = JSON.parse(await chrome({
      script: `
    await page.wait('[data-titan-workspace="${titan.id}"] [aria-label="Reply to Titan"]');
    await page.click('[data-titan-workspace="${titan.id}"] .titan-title');
    const renameAtEmojiBoundary = await page.eval(() => {
      const field = document.querySelector('[data-titan-workspace="${titan.id}"] [aria-label="Titan name"]');
      field.select();
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', ${JSON.stringify(`${name.slice(1)}\n🐉`)});
      field.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
      return field.value;
    });
    await page.eval(() => {
      const field = document.querySelector('[data-titan-workspace="${titan.id}"] [aria-label="Titan name"]');
      field.select();
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', ${JSON.stringify(name.split('').join('\n'))});
      field.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    });
    const renameFits = await page.eval(() => { const field = document.querySelector('[data-titan-workspace="${titan.id}"] [aria-label="Titan name"]'); return field.scrollWidth <= field.clientWidth + 1 && field.scrollHeight <= field.clientHeight + 1; });
    await page.press('Enter');
    await page.wait('[data-titan-workspace="${titan.id}"] .titan-title[aria-label="Edit ${name}"]');
    ${fillComposer({
      selector: `[data-titan-workspace="${titan.id}"] [aria-label="Reply to Titan"]`,
      text: prose,
    })}
    await page.press('Shift+Enter');
    const chatDraft = await page.eval(() => {
      const field = document.querySelector('[data-titan-workspace="${titan.id}"] [aria-label="Reply to Titan"]');
      return {
        bounded: field.scrollHeight > field.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(field).overflowY) && field.getBoundingClientRect().height <= Math.min(innerHeight / 2, 480),
        text: field.textContent,
      };
    });
    ${fillComposer({
      selector: `[data-titan-workspace="${titan.id}"] [aria-label="Reply to Titan"]`,
      text: '',
    })}
    console.log(JSON.stringify({ renameAtEmojiBoundary, renameFits, chatDraft }));
  `,
    }))
    expect(result).toMatchObject({
      renameAtEmojiBoundary: name.slice(1),
      renameFits: true,
    })
    expect(result.chatDraft).toEqual({
      bounded: true,
      text: `${prose}\n\n`,
    })
  },
)

test(
  'saving a task leaves its card closed and its writing fields readable',
  async () => {
    const titan = await othrys.titan()
    await chrome({ script: `await page.open(${JSON.stringify(`http://127.0.0.1:${othrys.port()}/titan/${titan.id}/`)});` })
    await chrome({
      args: [
        'emulate',
        '--viewport',
        '390x844',
      ],
    })
    onTestFinished(async () => {
      await chrome({ args: ['emulate'] })
    })
    const title = 'Keep this task closed while its complete title wraps and stays readable throughout the narrow project column'
    const prose = [
      '--no-start',
      ...Array(32).fill('Every line remains readable in its field.'),
    ].join('\n')
    const result = JSON.parse(await chrome({
      script: `
    await page.wait('[data-titan-workspace="${titan.id}"] [aria-label="New task in Ideas"]');
    await page.click('[data-titan-workspace="${titan.id}"] [aria-label="New task in Ideas"]');
    const titleHeight = await page.eval(() => document.querySelector('[data-titan-workspace="${titan.id}"] [aria-label="Task title"]').getBoundingClientRect().height);
    await page.fill('[data-titan-workspace="${titan.id}"] [aria-label="Task title"]', ${JSON.stringify(title.slice('Keep'.length))});
    await page.eval(() => {
      const field = document.querySelector('[data-titan-workspace="${titan.id}"] [aria-label="Task title"]');
      field.setSelectionRange(0, 0);
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'Ke\\nep');
      field.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    });
    await page.press('Shift+Enter');
    ${fillComposer({
      selector: `[data-titan-workspace="${titan.id}"] [aria-label="Description"]`,
      text: 'A'.repeat(MAX_BRIEF_LENGTH + 1),
    })}
    await page.wait('[data-titan-workspace="${titan.id}"] .task-create button:disabled');
    const canSaveOversizedDescription = await page.eval(() => {
      const form = document.querySelector('[data-titan-workspace="${titan.id}"] .task-create');
      return Array.from(form.querySelectorAll('button')).some(button => button.textContent.trim() === 'Save task' && !button.disabled);
    });
    if (canSaveOversizedDescription) throw new Error('Save task accepts an oversized description');
    ${fillComposer({
      selector: `[data-titan-workspace="${titan.id}"] [aria-label="Description"]`,
      text: prose,
    })}
    await page.press('Shift+Enter');
    const fields = await page.eval(() => {
      const title = document.querySelector('[data-titan-workspace="${titan.id}"] [aria-label="Task title"]');
      const description = document.querySelector('[data-titan-workspace="${titan.id}"] [aria-label="Description"]');
      return { titleHeight: title.getBoundingClientRect().height, titleFits: title.scrollWidth <= title.clientWidth + 1 && title.scrollHeight <= title.clientHeight + 1, titleAfterShiftEnter: title.value, pasteCaret: title.selectionStart, askGrows: description.scrollHeight <= description.clientHeight + 1 && description.getBoundingClientRect().height > innerHeight / 2, multiLine: description.textContent.endsWith('\\n') };
    });
    const reachability = await page.eval(async () => {
      const form = document.querySelector('[data-titan-workspace="${titan.id}"] .task-create');
      const surface = form.closest('.project-cards');
      surface.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      surface.scrollTo({ top: surface.scrollHeight, behavior: 'instant' });
      await new Promise(resolve => requestAnimationFrame(resolve));
      const bounds = surface.getBoundingClientRect();
      const top = Math.max(bounds.top, 0);
      const bottom = Math.min(bounds.bottom, innerHeight);
      const ask = form.querySelector('[aria-label="Description"]');
      const askBounds = ask.getBoundingClientRect();
      const style = getComputedStyle(ask);
      const lineHeight = parseFloat(style.lineHeight);
      const lineBottom = askBounds.bottom - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth);
      const askHit = document.elementFromPoint(askBounds.left + askBounds.width / 2, lineBottom - lineHeight / 2);
      const save = [...form.querySelectorAll('button')].find(button => button.textContent === 'Save task');
      const button = save.getBoundingClientRect();
      const saveHit = document.elementFromPoint(button.left + button.width / 2, button.top + button.height / 2);
      return {
        askEndVisible: lineBottom <= bottom && lineBottom - lineHeight >= top && askHit === ask,
        saveReachable: getComputedStyle(surface).overflowY === 'auto' && surface.scrollHeight > surface.clientHeight && button.top >= top && button.bottom <= bottom && save.contains(saveHit),
      };
    });
    await page.eval(() => {
      const save = [...document.querySelectorAll('[data-titan-workspace="${titan.id}"] .task-create button')].find(button => button.textContent === 'Save task');
      if (!save || save.disabled) throw new Error('Save task is unavailable');
      save.click();
    });
    await page.wait('[data-titan-workspace="${titan.id}"]:not(:has(.task-create)) .card-open');
    const card = await page.eval(() => {
      const card = document.querySelector('[data-titan-workspace="${titan.id}"] .card-open');
      const form = document.querySelector('[data-titan-workspace="${titan.id}"] .task-create');
      return { id: card.closest('[data-task]').dataset.task, expanded: card.getAttribute('aria-expanded'), column: card.closest('[data-column]').dataset.column, title: card.textContent, formClosed: form === null, focusLabel: document.activeElement?.getAttribute('aria-label') };
    });
    console.log(JSON.stringify({ fields: { ...fields, ...reachability, titleGrows: fields.titleHeight > titleHeight }, card }));
  `,
    }))
    expect(result.fields).toMatchObject({
      titleFits: true,
      titleGrows: true,
      pasteCaret: 'Keep'.length,
      titleAfterShiftEnter: title,
      askGrows: true,
      askEndVisible: true,
      saveReachable: true,
      multiLine: true,
    })
    expect(result.card).toEqual({
      id: expect.any(String),
      expanded: 'false',
      column: 'ideas',
      title,
      formClosed: true,
      focusLabel: 'Fold Ideas',
    })
    const saved = await titan.task({
      key: result.card.id,
    })
    const initialDescription = await chrome({
      script: `
    await page.click('[data-titan-workspace="${titan.id}"] .card-open');
    await page.wait('dialog.task-modal .card.selected');
    await page.click('dialog.task-modal .card.selected [role="tab"][id$="-tab-activity"]');
    await page.click('dialog.task-modal .card.selected [role="tab"][id$="-tab-chat"]');
    await page.eval(() => document.querySelector('dialog.task-modal .card.selected').dispatchEvent(new PointerEvent('pointerover', { bubbles: true })));
    await page.wait('dialog.task-modal [aria-label="Edit task"]');
    await page.click('dialog.task-modal [aria-label="Edit task"]');
    await page.wait('.task-editor [aria-label="Description"]');
    console.log(await page.eval(() => JSON.stringify(document.querySelector('.task-editor [aria-label="Description"]').textContent)));
  `,
    })
    expect(JSON.parse(initialDescription)).toBe(`${prose}\n\n`)
    const editedDescription = `${prose}\nExplain the empty state and its next action.\n`
    await chrome({
      script: `
    ${fillComposer({
      selector: '.task-editor [aria-label="Description"]',
      text: 'A'.repeat(MAX_BRIEF_LENGTH + 1),
    })}
    await page.wait('.task-editor button[type="submit"]:disabled');
    ${fillComposer({
      selector: '.task-editor [aria-label="Description"]',
      text: editedDescription,
    })}
    const reachable = await page.eval(async () => {
      const form = document.querySelector('.task-editor');
      const panel = form.closest('.card-panel');
      panel.scrollTo({ top: panel.scrollHeight, behavior: 'instant' });
      await new Promise(requestAnimationFrame);
      const button = form.querySelector('button[type="submit"]');
      const bounds = button.getBoundingClientRect();
      const surface = panel.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      // A scroller's whole-pixel scroll range can leave its last fraction of a pixel below the fold.
      return bounds.top >= Math.max(0, Math.floor(surface.top)) && bounds.bottom <= Math.min(innerHeight, Math.ceil(surface.bottom) + 1) && button.contains(hit);
    });
    if (!reachable) throw new Error('The description Save button is outside the scrolling card panel');
    await page.click('dialog.task-modal .card.selected .task-editor button[type="submit"]');
    await page.wait('dialog.task-modal .card.selected .card-panel');
  `,
    })
    await until({
      what: 'the saved description edit',
      check: async () => (await titan.owner({
        args: [
          'task',
          'show',
          saved.id,
          '--full',
        ],
      })).task.brief === editedDescription,
    })
    expect(await chrome({
      script: `
    await page.click('dialog.task-modal [role="tab"][id$="-tab-context"]');
    console.log(await page.eval(() => document.querySelector('dialog.task-modal [aria-label="Description"].card-section')?.textContent));
    await page.click('dialog.task-modal [aria-label="Close"]');
  `,
    })).toContain('Explain the empty state and its next action.')
    const repositories = await addRevealProjects({ titan })
    await titan.owner({
      args: [
        'project',
        'group',
        'Export',
        ...repositories,
      ],
    })
    const existing = await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Existing export',
        '--project',
        repositories[0]!,
      ],
    })
    const group = loadTitan({ titanId: titan.id }).state.projects![0]!.group!.id
    await chrome({
      script: `
    await page.click('[data-titan-workspace="${titan.id}"] [aria-label="New task in Export"]');
    await page.fill('.task-create [aria-label="Task title"]', 'An idea without a repository');
    await page.eval(() => [...document.querySelectorAll('.task-create button')].find(button => button.textContent === 'Save task').click());
    await page.wait('[data-column="ideas"] [data-task]:not([data-task="${saved.id}"]) .card-open');
    await page.click('[data-titan-workspace="${titan.id}"] [aria-label="New task in Export"]');
    await page.fill('.task-create [aria-label="Task title"]', 'First grouped export');
    await page.click('.task-create [aria-label="Repository"]');
    await page.click('.task-create [role="option"][aria-label="Reveal-1"]');
    await page.eval(() => [...document.querySelectorAll('.task-create button')].find(button => button.textContent === 'Save task').click());
    await page.wait('[data-column="${group}"] [data-task]:not([data-task="${existing.card.id}"]) .card-open');
    console.log(await page.eval(() => JSON.stringify([...document.querySelectorAll('[data-column="${group}"] [data-task]')].map(card => card.dataset.task))));
  `,
    }).then(ordered => {
      expect(JSON.parse(ordered).at(-1)).toBe(existing.card.id)
    })
  },
)

test.each([
  { viewport: '1440x900' },
  { viewport: '390x844' },
])(
  'a folded Titan keeps one upright strip that unfolds it, and folded project columns keep their marks aligned at $viewport',
  async ({ viewport }) => {
    const titan = await othrys.titan()
    const projects = await addRevealProjects({ titan })

    for (const key of [
      'fold-asks',
      'fold-running',
    ]) {
      await titan.owner({
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

    await titan.owner({
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
    const turn = othrys.claude.plan({
      titan: titan.id,
      hold: true,
    })

    onTestFinished(async () => {
      turn.release()
      await chrome({ args: ['emulate'] })
    })
    await titan.owner({
      args: [
        'task',
        'start',
        'fold-running',
        '--in-place',
      ],
    })
    await chrome({ script: `await page.open(${JSON.stringify(`http://127.0.0.1:${othrys.port()}/titan/${titan.id}/`)});` })
    await chrome({
      args: [
        'emulate',
        '--viewport',
        viewport,
      ],
    })
    const wide = viewport === '1440x900'
    const workspace = `[data-titan-workspace="${titan.id}"]`
    const uprightCounts = `({ roots }) => ['.waiting-count', '.running-count > span'].every(selector => {
        const counts = roots.flatMap(root => [...root.querySelectorAll(selector)]);
        return counts.length > 0 && counts.every(count =>
          count.getBoundingClientRect().width > 0 && getComputedStyle(count).writingMode === 'horizontal-tb'
        );
      })`

    const fold = async ({
      item,
      patch,
    }: {
      item: string
      patch: object
    }) => {
      if (wide) {
        await chrome({
          script: `
    await page.click('.active-titan .titan-chip');
    await page.wait('[role="menu"] [role="menuitem"]');
    await page.eval(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(item => item.textContent === ${JSON.stringify(item)}).click());
  `,
        })

        return
      }

      await titan.owner({
        args: [
          'view',
          'set',
          '--json',
          JSON.stringify({ workspace: patch }),
        ],
      })
    }

    const expandedWorkspaceWidth = Number(await chrome({
      script: `
    await page.wait('${workspace} [data-column] .running-count');
    await page.wait('${workspace} [data-column] .waiting-count');
    console.log(await page.eval(() => document.querySelector('${workspace}').getBoundingClientRect().width));
  `,
    }))
    await fold({
      item: 'Fold Titan',
      patch: { collapsed: true },
    })
    const strip = JSON.parse(await chrome({
      script: `
    await page.wait('${workspace} [aria-label="Unfold Titan"]');
    console.log(await page.eval(async () => {
      const workspace = document.querySelector('${workspace}');
      const strip = workspace.querySelector('[aria-label="Unfold Titan"]');
      const box = workspace.getBoundingClientRect();
      const marks = [...strip.querySelectorAll('.titan-label, .waiting-count, .running-count > *')].map(mark => mark.getBoundingClientRect());
      const center = (box.left + box.right) / 2;
      return JSON.stringify({
        thin: box.width <= 60,
        bodyHidden: workspace.querySelector('main').getClientRects().length === 0,
        upright: (${uprightCounts})({ roots: [strip] }),
        aligned: marks.length === 4 && marks.every(mark => Math.abs((mark.left + mark.right) / 2 - center) <= 1),
        contained: marks.every(mark => mark.left >= box.left && mark.right <= box.right),
      });
    }));
  `,
    }))
    expect(strip).toEqual({
      thin: true,
      bodyHidden: true,
      upright: true,
      aligned: true,
      contained: true,
    })
    const columns = JSON.parse(await chrome({
      script: `
    await page.click('${workspace} [aria-label="Unfold Titan"]');
    await page.wait('${workspace} main .project-column');
    console.log(await page.eval(async () => {
      const workspace = document.querySelector('${workspace}');
      await new Promise(requestAnimationFrame);
      return JSON.stringify({ unfolded: workspace.getBoundingClientRect().width === ${expandedWorkspaceWidth} });
    }));
  `,
    }))
    expect(columns).toEqual({ unfolded: true })
    await fold({
      item: 'Fold all projects',
      patch: {
        foldedProjects: Object.fromEntries([
          'ideas',
          ...projects,
        ].map(id => [
          id,
          true,
        ])),
      },
    })
    const folded = JSON.parse(await chrome({
      script: `
    await page.wait('${workspace} [aria-label="Unfold Ideas"]');
    console.log(await page.eval(async () => {
      await new Promise(requestAnimationFrame);
      const workspace = document.querySelector('${workspace}');
      const columns = [...workspace.querySelectorAll('.project-column')];
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
      return JSON.stringify({ folded, upright: (${uprightCounts})({ roots: columns }) });
    }));
  `,
    }))
    expect(folded).toEqual({
      folded: true,
      upright: true,
    })
  },
)
