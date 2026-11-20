import { beforeAll, expect, test } from 'vitest'
import { openHydra } from './setup.ts'
import { rows, startPnyx, until, type Pnyx } from '../setup/pnyx.ts'

const COLUMN_TASKS = 61

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx({ zeroCache: true })
})

test(
  'scrolling a full column keeps every task mounted once in the same place',
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
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    const column = page.locator('[data-column="ideas"] .column-cards')
    await column.getByRole(
      'button',
      {
        name: 'Scroll task 0',
        exact: true,
      },
    ).waitFor()
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    expect(await column.locator('[data-task]').count()).toBe(COLUMN_TASKS)

    // eslint-disable-next-line pnyx/object-params -- Playwright owns the browser callback signature.
    const stability = await column.evaluate(async element => {
      const tasks = [...element.querySelectorAll<HTMLElement>('[data-task]')]
      const positions = new Map(tasks.map(task => [
        task,
        task.getBoundingClientRect().top + element.scrollTop,
      ]))

      const scroll = async ({ top }: { top: number }) => {
        element.scrollTo({
          top,
          behavior: 'instant',
        })
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      }

      const sample = () => {
        const current = [...element.querySelectorAll<HTMLElement>('[data-task]')]

        return {
          count: current.length,
          retained: current.every((
            task,
            index,
          ) => task === tasks[index])
            && tasks.every(task => task.isConnected),
          shifts: current.flatMap(task => {
            const position = positions.get(task)
            const shift = task.getBoundingClientRect().top + element.scrollTop - (position ?? 0)

            return position !== undefined && Math.abs(shift) > 1 ? [
              {
                task: task.dataset.task,
                shift,
              },
            ] : []
          }),
          unique: new Set(current.map(task => task.dataset.task)).size,
        }
      }

      await scroll({ top: element.scrollHeight - element.clientHeight })
      const bottom = sample()
      const bottomOffset = element.scrollTop
      await scroll({ top: 0 })

      return {
        bottom,
        bottomOffset,
        top: sample(),
      }
    })
    expect(stability.bottomOffset).toBeGreaterThan(0)
    expect(stability).toMatchObject({
      bottom: {
        count: COLUMN_TASKS,
        retained: true,
        shifts: [],
        unique: COLUMN_TASKS,
      },
      top: {
        count: COLUMN_TASKS,
        retained: true,
        shifts: [],
        unique: COLUMN_TASKS,
      },
    })
  },
)

test(
  'an open task fills its column height and follows a viewport resize',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Read the worker chat',
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
    // eslint-disable-next-line pnyx/object-params -- Playwright owns the browser callback signature.
    const fillsColumn = () => card.evaluate(element => {
      const column = element.closest<HTMLElement>('.column-cards')!
      const spacing = getComputedStyle(column)
      const padding = parseFloat(spacing.paddingTop) + parseFloat(spacing.paddingBottom)
      const available = column.clientHeight - padding

      return Math.abs(element.getBoundingClientRect().height - available) <= 1
    })
    await until({
      what: 'the open card to fill its column',
      check: fillsColumn,
    })
    await page.setViewportSize({
      width: 1440,
      height: 1100,
    })
    await until({
      what: 'the open card to fill the resized column',
      check: fillsColumn,
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
    const card = await page.locator(`[data-task="${task}"]`).elementHandle()
    expect(card).not.toBeNull()
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
    await page.locator(`[data-task="${task}"] .card-agent[aria-label="Codex"]`).waitFor()
    // eslint-disable-next-line pnyx/object-params -- Playwright owns the browser callback signature.
    expect(await card!.evaluate(element => element.isConnected)).toBe(true)
    expect(await page.locator(`[data-task="${task}"]`).count()).toBe(1)
  },
)
