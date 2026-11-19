import { expect, inject, onTestFinished, test } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openHydra } from '../setup/browser.ts'
import { startPnyx, until } from '../setup/pnyx.ts'
import { beginUIWindow, reportDragResponsiveness } from '../setup/ui-metrics.ts'

const IDEA_TASKS = 4
const EXPECTED_MOUNTED_TASKS = 129
const PROJECT_TASKS = [
  32,
  82,
  11,
  0,
]
const LOAD_FRAME_BUDGET_MS = 1000
const FIRST_CARD_BUDGET_MS = 2000
const SCROLL_FRAME_BUDGET_MS = 250
const PROJECT_APPEAR_TIMEOUT_MS = 5000
const ANCHOR_SETTLE_FRAMES = 40
const EARLIER_PROJECTS = 3
const WHEEL_DELTA = 900
const MAX_TASK_COMMITS = 4
const MAX_DOM_ELEMENTS = 6000
const DISCOVERY_READ_BUDGETS = {
  models: 10,
  project: 6,
  catalog: 5,
  rule: 10,
}

interface WorkspaceMeasurement {
  firstCard: number
  readFrames({ since }: { since: number }): number[]
}

test(
  'one task update stays local and a full column drags and scrolls within its budget',
  async () => {
    const pnyx = await startPnyx({ zeroCache: true })
    const hydras = []

    for (let index = 0; index < 4; index++) {
      hydras.push(await pnyx.hydra())
    }

    const first = hydras.at(-1)!
    const second = hydras[0]!
    const projects = []

    for (let index = 0; index < EARLIER_PROJECTS; index++) {
      const path = second.folder({ name: `earlier-project-${index}` })
      mkdirSync(
        join(
          path,
          '.git',
        ),
        { recursive: true },
      )
      await second.owner({
        args: [
          'project',
          'add',
          path,
        ],
      })
    }

    for (let index = 0; index < PROJECT_TASKS.length; index++) {
      const path = first.folder({ name: `project-${index}` })
      mkdirSync(
        join(
          path,
          '.git',
        ),
        { recursive: true },
      )
      await first.owner({
        args: [
          'project',
          'add',
          path,
        ],
      })
      projects.push(path)
    }

    const changes = [
      ...Array.from(
        { length: IDEA_TASKS },
        (
          _,
          index,
        ) => ({
          op: 'task.create',
          key: `task-${index}`,
          title: `Task ${index + 1}`,
        }),
      ),
      ...projects.flatMap((
        project,
        group,
      ) => Array.from(
        { length: PROJECT_TASKS[group]! },
        (
          _,
          index,
        ) => ({
          op: 'task.create',
          key: `project-${group}-${index}`,
          title: `Project ${group} task ${index}`,
          project,
        }),
      )),
    ]
    await first.owner({
      args: [
        'apply',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        version: 1,
        changes,
      }),
    })

    for (const hydra of hydras.slice(
      0,
      -1,
    )) {
      await hydra.owner({
        args: [
          'task',
          'create',
          '--title',
          'Other Hydra task',
        ],
      })
    }

    await first.owner({
      args: [
        'view',
        'set',
        '--json',
        JSON.stringify({ workspace: { projectWidths: { ideas: 836 } } }),
      ],
    })
    const targetTask = await first.task({ key: 'project-1-80' })
    const stream = pnyx.claude.plan({
      hydra: first.id,
      text: 'Summarize the active work',
      partial: 'The active work is moving through the Hydra.',
      reply: `The active work is moving through the Hydra. The questions are waiting for a choice.\n\n[@Project 1 task 80](pnyx-task:${targetTask.id})`,
      hold: true,
    })
    await first.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'Summarize the active work',
      ],
    })
    const reads: string[] = []
    const errors: Error[] = []
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: first.id,
      prepare: async ({ page }) => {
        page.on(
          'pageerror',
          error => errors.push(error),
        )
        await page.setViewportSize({
          width: 1512,
          height: 900,
        })
        await page.addInitScript(
          ({ hydra }) => {
            if (!PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) {
              throw new Error('The browser cannot measure long animation frames')
            }

            const frames: PerformanceEntry[] = []
            // eslint-disable-next-line pnyx/object-params -- The browser owns this callback signature.
            const frameObserver = new PerformanceObserver(list => {
              frames.push(...list.getEntries())
            })
            frameObserver.observe({
              type: 'long-animation-frame',
              buffered: true,
            })
            const measurement: WorkspaceMeasurement = {
              firstCard: 0,
              readFrames({ since }) {
                frames.push(...frameObserver.takeRecords())

                return frames.filter(frame => frame.startTime >= since).map(frame => frame.duration)
              },
            }
            Object.assign(
              window,
              { workspaceMeasurement: measurement },
            )
            new MutationObserver((
              _,
              observer,
            ) => {
              if (document.querySelector(`[data-hydra-workspace="${hydra}"] [data-card]`)) {
                measurement.firstCard = performance.now()
                observer.disconnect()
              }
            }).observe(
              document,
              {
                childList: true,
                subtree: true,
              },
            )
          },
          { hydra: first.id },
        )
        page.on(
          'websocket',
          socket => socket.on(
            'framesent',
            ({ payload }) => {
              const frame: unknown = JSON.parse(String(payload))

              if (frame && typeof frame === 'object' && 'type' in frame && frame.type === 'command'
                && 'name' in frame && typeof frame.name === 'string') {
                reads.push(frame.name)
              }
            },
          ),
        )
      },
    })
    onTestFinished(async () => {
      await page.context().close()
    })
    const workspace = page.locator(`[data-hydra-workspace="${first.id}"]`)
    const other = page.locator(`[data-hydra-workspace="${second.id}"]`)
    await workspace.getByRole(
      'button',
      {
        name: 'Task 1',
        exact: true,
      },
    ).waitFor()
    await until({
      what: 'the non-first Hydra stays selected after all five load',
      check: async () => await page.locator('[data-hydra-workspace][data-connected=true]').count() === 5,
    })
    await expect.poll(() => workspace.locator('.card-open').count()).toBe(EXPECTED_MOUNTED_TASKS)
    await expect.poll(() => workspace.locator('.project-column').count()).toBe(5)
    await expect.poll(() => other.locator('.card-open').count()).toBe(1)
    await expect.poll(() => page.locator('.hydra-page').count()).toBe(5)
    expect(await page.locator('*').count()).toBeLessThan(MAX_DOM_ELEMENTS)
    const load = await page.evaluate(async () => {
      const measurement = (window as Window & {
        workspaceMeasurement?: WorkspaceMeasurement
      }).workspaceMeasurement

      if (!measurement) {
        throw new Error('Workspace load measurement was not installed')
      }

      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

      return {
        firstCard: measurement.firstCard,
        frames: measurement.readFrames({ since: 0 }),
      }
    })
    expect(load.firstCard).toBeGreaterThan(0)
    expect(load.firstCard).toBeLessThan(FIRST_CARD_BUDGET_MS)
    expect(Math.max(
      0,
      ...load.frames,
    )).toBeLessThan(LOAD_FRAME_BUDGET_MS)
    console.info({
      check: 'owner-sized load',
      ...load,
    })
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    const visibleCard = await workspace.getByRole(
      'button',
      {
        name: 'Task 1',
        exact: true,
      },
    ).elementHandle()
    const originalBox = await visibleCard.boundingBox()

    if (!originalBox) {
      throw new Error('The directly addressed Hydra has no visible task to track')
    }

    const earlierProject = second.folder({ name: 'later-project' })
    const earlierWidth = await other.evaluate(({ clientWidth }) => clientWidth)
    mkdirSync(
      join(
        earlierProject,
        '.git',
      ),
      { recursive: true },
    )

    const anchorSample = await visibleCard.evaluateHandle(
      // eslint-disable-next-line pnyx/object-params -- Playwright owns browser callback signatures.
      (
        element,
        {
          hydra,
          project,
          timeoutMs,
          settleFrames,
        },
      ) => {
        const positions = [element.getBoundingClientRect().x]
        const selector = `[data-hydra-workspace="${CSS.escape(hydra)}"] .project-column[data-column="${CSS.escape(project)}"]`
        const deadline = performance.now() + timeoutMs

        const sample = async () => {
          while (performance.now() < deadline && !document.querySelector(selector)) {
            await new Promise(requestAnimationFrame)
            positions.push(element.getBoundingClientRect().x)
          }

          if (!document.querySelector(selector)) {
            return null
          }

          for (let frame = 0; frame < settleFrames; frame++) {
            await new Promise(requestAnimationFrame)
            positions.push(element.getBoundingClientRect().x)
          }

          return positions
        }

        return { positions: sample() }
      },
      {
        hydra: second.id,
        project: earlierProject,
        timeoutMs: PROJECT_APPEAR_TIMEOUT_MS,
        settleFrames: ANCHOR_SETTLE_FRAMES,
      },
    )
    let positions: number[] | null

    try {
      await second.owner({
        args: [
          'project',
          'add',
          earlierProject,
        ],
      })
      positions = await anchorSample.evaluate(({ positions }) => positions)
    } finally {
      await anchorSample.dispose()
    }

    if (!positions) {
      throw new Error('The earlier Hydra did not render the new project column')
    }

    expect(
      positions.every(x => Math.abs(x - originalBox.x) < 0.5),
      JSON.stringify(positions),
    ).toBe(true)
    expect(await other.evaluate(({ clientWidth }) => clientWidth)).toBeGreaterThan(earlierWidth)
    await until({
      what: 'an earlier Hydra changes width without stealing the direct address',
      check: async () => {
        const rect = await workspace.boundingBox()

        return !!rect && Math.abs(rect.x - 12) < 2
      },
    })
    expect(page.url()).toContain(`/hydra/${first.id}/`)
    // eslint-disable-next-line pnyx/object-params -- Playwright owns the element callback.
    expect(await visibleCard.evaluate(element => element.isConnected)).toBe(true)
    const anchoredBox = await visibleCard.boundingBox()
    expect(anchoredBox?.y).toBeCloseTo(
      originalBox.y,
      0,
    )

    expect(reads).toContain('catalog')

    for (const [
      name,
      budget,
    ] of Object.entries(DISCOVERY_READ_BUDGETS)) {
      expect(
        reads.filter(read => read === name).length,
        `${name} discovery is bounded across mounted Hydras`,
      ).toBeLessThanOrEqual(budget)
    }

    await page.evaluate(async () => {
      await document.fonts.ready
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    const finishStream = await beginUIWindow({ page })
    stream.release()
    await workspace.getByLabel(
      'Hydra conversation',
      { exact: true },
    ).getByText(
      'The active work is moving through the Hydra. The questions are waiting for a choice.',
      { exact: true },
    )
      .waitFor()
    await finishStream()
    await until({
      what: 'the streamed turn finishes before measuring a separate card update',
      check: async () => await workspace.getByRole(
        'button',
        {
          name: 'Stop Hydra',
          exact: true,
        },
      ).count() === 0,
    })

    const finishUpdate = await beginUIWindow({ page })
    await first.owner({
      args: [
        'task',
        'rename',
        'task-0',
        '--title',
        'Changed task',
      ],
    })
    await workspace.getByRole(
      'button',
      {
        name: 'Changed task',
        exact: true,
      },
    ).waitFor()
    const update = await finishUpdate()
    const renders = update.filter(line => line.operation === 'page.react-commit' && line.surface === 'task')

    if (inject('uiProfile')) {
      expect(
        renders.length,
        'this journey requires the profiling build',
      ).toBeGreaterThan(0)
      expect(renders.reduce(
        (
          count,
          line,
        ) => count + line.count,
        0,
      )).toBeLessThanOrEqual(MAX_TASK_COMMITS)
      expect(renders.filter(line => line.hydraId !== first.id)).toEqual([])
    }

    const fourth = workspace.getByRole(
      'button',
      {
        name: 'Task 4',
        exact: true,
      },
    )
    await fourth.hover()
    const keyboardMove = workspace.getByRole(
      'button',
      {
        name: 'Move Task 4',
        exact: true,
      },
    )
    await keyboardMove.focus()
    await page.keyboard.press('Space')
    await page.locator('.physical-ghost').waitFor()
    await page.evaluate(() => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    }))
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Escape')
    await until({
      what: 'keyboard cancellation removes the lifted card without a render error',
      check: async () => {
        expect(errors.map(error => error.message)).toEqual([])

        return await page.locator('.physical-ghost').count() === 0
      },
    })
    expect(errors.map(error => error.message)).toEqual([])
    // eslint-disable-next-line pnyx/object-params -- The library owns this callback signature.
    expect(await keyboardMove.evaluate(element => element === document.activeElement)).toBe(true)

    const source = workspace.getByRole(
      'button',
      {
        name: 'Changed task',
        exact: true,
      },
    )
    const target = workspace.getByRole(
      'button',
      {
        name: 'Task 3',
        exact: true,
      },
    )
    await source.hover()
    const finishDrag = await beginUIWindow({ page })
    const from = (await source.boundingBox())!
    const to = (await target.boundingBox())!
    await page.mouse.move(
      from.x + from.width / 2,
      from.y + from.height / 2,
    )
    await page.mouse.down()
    await page.mouse.move(
      from.x + from.width / 2 + 12,
      from.y + from.height / 2,
      { steps: 4 },
    )
    await page.locator('.physical-ghost').waitFor()
    const targetX = Math.min(
      to.x + to.width - 4,
      page.viewportSize()!.width - 40,
    )
    expect(targetX).toBeGreaterThan(to.x)
    await page.mouse.move(
      targetX,
      to.y + to.height / 2,
      { steps: 24 },
    )
    await until({
      what: 'the drag moves its live reorder slot',
      check: async () => (await workspace.locator('.card-open').allTextContents()).indexOf('Changed task') > 0,
    })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await page.locator('.physical-ghost').waitFor({ state: 'detached' })
    const drag = await finishDrag()

    if (!inject('uiProfile')) {
      reportDragResponsiveness({ metrics: drag })
    }

    const axis = page.locator('.workspace-axis')
    const otherColumn = workspace.locator(`[data-column="${projects[0]}"] .column-cards`)
    // eslint-disable-next-line pnyx/object-params -- Playwright owns the element callback.
    const otherScroll = await otherColumn.evaluate(element => {
      element.scrollTo({
        top: element.scrollHeight,
        behavior: 'instant',
      })

      return element.scrollTop
    })
    expect(otherScroll).toBeGreaterThan(0)
    const project = workspace.locator(`[data-column="${projects[1]}"]`)
    await workspace.getByRole(
      'navigation',
      {
        name: 'Projects',
        exact: true,
      },
    ).getByText(
      'project-1',
      { exact: true },
    )
      .click()
    await until({
      what: 'the project chip aligns its column with the workspace axis',
      check: async () => {
        const columnBounds = await project.boundingBox()
        const axisBounds = await axis.boundingBox()

        return !!columnBounds && !!axisBounds && Math.abs(columnBounds.x - axisBounds.x - 12) < 2
      },
    })
    expect(await otherColumn.evaluate(({ scrollTop }) => scrollTop)).toBe(otherScroll)
    const scroller = project.locator('.column-cards')
    await scroller.hover()
    const finishScroll = await beginUIWindow({ page })
    const scrollStart = await page.evaluate(() => performance.now())
    await page.mouse.wheel(
      0,
      WHEEL_DELTA,
    )
    await until({
      what: 'the wheel reaches its destination before task navigation',
      check: () => scroller.evaluate(
        // eslint-disable-next-line pnyx/object-params -- Playwright owns the element callback.
        (
          element,
          delta,
        ) => element.scrollTop >= delta,
        WHEEL_DELTA,
      ),
    })
    const scroll = await finishScroll()

    if (!inject('uiProfile')) {
      const frames = await page.evaluate(
        async ({ since }) => {
          const measurement = (window as Window & {
            workspaceMeasurement?: WorkspaceMeasurement
          }).workspaceMeasurement

          if (!measurement) {
            throw new Error('Workspace scroll measurement was not installed')
          }

          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

          return measurement.readFrames({ since })
        },
        { since: scrollStart },
      )
      expect(Math.max(
        0,
        ...frames,
      )).toBeLessThan(SCROLL_FRAME_BUDGET_MS)
      console.info({
        check: 'owner-sized scroll',
        frames,
        metrics: scroll,
      })
    }

    expect(await workspace.locator('.card-open').count()).toBe(EXPECTED_MOUNTED_TASKS)
    const axisBeforeReveal = await axis.evaluate(({ scrollLeft }) => scrollLeft)
    const targetCard = scroller.locator(`.card[data-task="${targetTask.id}"]`)
    const selectedCard = targetCard.and(scroller.locator('.card.selected'))
    const initialCardBox = await targetCard.boundingBox()
    const initialColumnBox = await scroller.boundingBox()

    if (!initialCardBox || !initialColumnBox) {
      throw new Error('The reveal fixture needs a rendered target and column')
    }

    expect(initialCardBox.y).toBeGreaterThanOrEqual(initialColumnBox.y + initialColumnBox.height)

    const reference = workspace.locator('.hydra-chat .task-reference-title').filter({ hasText: 'Project 1 task 80' })

    const expectOtherScrollPositions = async () => {
      expect(await axis.evaluate(({ scrollLeft }) => scrollLeft)).toBeCloseTo(
        axisBeforeReveal,
        0,
      )
      expect(await otherColumn.evaluate(({ scrollTop }) => scrollTop)).toBe(otherScroll)
    }

    const expectTargetInColumnViewport = async ({ what }: { what: string }) => {
      await until({
        what,
        check: async () => {
          const card = await selectedCard.boundingBox()
          const column = await scroller.boundingBox()

          return !!card && !!column && card.y >= column.y && card.y < column.y + column.height
        },
      })
    }

    // Playwright's click would scroll the conversation into view before testing the reference.
    await reference.dispatchEvent('click')
    await expectTargetInColumnViewport({ what: 'the selected task enters its column viewport' })
    await selectedCard.locator('.card-panel:focus').waitFor()
    await expectOtherScrollPositions()

    await selectedCard.locator('.card-panel:focus').blur()
    // eslint-disable-next-line pnyx/object-params -- Playwright owns the element callback.
    await scroller.evaluate(element => element.scrollTo({
      top: 0,
      behavior: 'instant',
    }))
    const displacedCard = await selectedCard.boundingBox()
    expect(displacedCard?.y).toBeGreaterThanOrEqual(initialColumnBox.y + initialColumnBox.height)
    await reference.dispatchEvent('click')
    await expectTargetInColumnViewport({ what: 'a repeated reveal keeps the selected task in its column viewport' })
    await selectedCard.locator('.card-panel:focus').waitFor()
    await expectOtherScrollPositions()
    expect(errors.map(error => error.message)).toEqual([])
  },
)
