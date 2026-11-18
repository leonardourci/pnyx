import { expect, test } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openHydra } from '../setup/browser.ts'
import { startPnyx, until } from '../setup/pnyx.ts'
import { beginUIWindow, expectResponsiveUI } from '../setup/ui-metrics.ts'

const IDEA_TASKS = 100
const PROJECTS = 12
const PROJECT_TASKS = 44
const MAX_MOUNTED_CARDS = 70
const MAX_TASK_COMMITS = 4

test(
  'one task update stays local and a full column drags and scrolls within its budget',
  async () => {
    const pnyx = await startPnyx({ zeroCache: true })
    const hydras = []

    for (let index = 0; index < 5; index++) {
      hydras.push(await pnyx.hydra())
    }

    const first = hydras.at(-1)!
    const second = hydras[0]!
    const projects = []

    for (let index = 0; index < PROJECTS; index++) {
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
        { length: PROJECT_TASKS },
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
    expect(changes).toHaveLength(628)
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
    const stream = pnyx.claude.plan({
      hydra: first.id,
      text: 'Summarize the active work',
      partial: 'The active work is moving through the Hydra.',
      reply: 'The active work is moving through the Hydra. The questions are waiting for a choice.',
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
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: first.id,

    })
    const workspace = page.locator(`[data-hydra-workspace="${first.id}"]`)
    const other = page.locator(`[data-hydra-workspace="${second.id}"]`)
    const errors: Error[] = []
    page.on(
      'pageerror',
      error => errors.push(error),
    )
    await workspace.getByRole(
      'button',
      {
        name: 'Task 1',
        exact: true,
      },
    ).waitFor()
    await until({
      what: 'the non-first Hydra stays selected after all six load',
      check: async () => await page.locator('[data-hydra-workspace][data-connected=true]').count() === 6,
    })
    expect(await workspace.locator('.card-open').count()).toBeLessThanOrEqual(MAX_MOUNTED_CARDS)
    expect(await workspace.locator('.project-column').count()).toBeLessThanOrEqual(4)
    expect(await other.locator('.card-open').count()).toBe(0)
    expect(await page.locator('*').count()).toBeLessThan(6000)
    const earlierProject = second.folder({ name: 'later-project' })
    mkdirSync(
      join(
        earlierProject,
        '.git',
      ),
      { recursive: true },
    )
    await second.owner({
      args: [
        'project',
        'add',
        earlierProject,
      ],
    })
    await until({
      what: 'an earlier Hydra changes width without stealing the direct address',
      check: async () => {
        const rect = await workspace.boundingBox()

        return !!rect && Math.abs(rect.x - 12) < 2
      },
    })
    expect(page.url()).toContain(`/hydra/${first.id}/`)

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
    expect(renders.filter(line => line.hydraId === second.id)).toEqual([])

    const fourth = workspace.getByRole(
      'button',
      {
        name: 'Task 4',
        exact: true,
      },
    )
    await fourth.hover()
    const keyboardMove = page.getByRole(
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
    expectResponsiveUI({ metrics: drag })

    const scroller = workspace.locator('[data-column="ideas"] .column-cards')
    await scroller.hover()
    const finishScroll = await beginUIWindow({ page })
    await page.mouse.wheel(
      0,
      900,
    )
    await until({
      what: 'the real wheel scroll advances the column',
      // eslint-disable-next-line pnyx/object-params -- Playwright owns the element callback.
      check: () => scroller.evaluate(element => element.scrollTop > 850),
    })
    const scroll = await finishScroll()
    expectResponsiveUI({ metrics: scroll })
    expect(await workspace.locator('.card-open').count()).toBeLessThanOrEqual(MAX_MOUNTED_CARDS)
    expect(errors.map(error => error.message)).toEqual([])
  },
)
