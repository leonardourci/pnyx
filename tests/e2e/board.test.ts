import { beforeAll, expect, test } from 'vitest'
import { openHydra } from '../setup/browser.ts'
import { startPnyx, until, type Pnyx } from '../setup/pnyx.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx({ zeroCache: true })
})

test(
  'the open board follows a task live from Queued to In progress to Done as the CLI and its worker change it',
  async () => {
    const hydra = await pnyx.hydra()
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    await page.locator('[aria-label="Work columns"]').waitFor()
    const column = ({ title }: { title: string }) => page.locator(`[aria-label="Work columns"] [aria-label="${title}"]`)
    const folder = hydra.folder({ name: 'export' })

    const { card } = await hydra.owner({
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
    const shown = `.card[data-task="${card.id}"]`
    await column({ title: 'Queued' }).locator(shown)
      .waitFor()

    await hydra.owner({
      args: [
        'task',
        'start',
        'export',
      ],
    })
    await column({ title: 'In progress' }).locator(shown)
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
    await column({ title: 'Done' }).locator(shown)
      .waitFor()
    expect(await page.locator(shown).count()).toBe(1)
  },
)

test(
  'a card\'s Activity opens on its newest updates and loads the older ones as the owner scrolls down to its creation',
  async () => {
    const hydra = await pnyx.hydra()
    const { card } = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Long history',
        '--key',
        'long',
      ],
    })

    // More updates than the 50 one read brings back, in one document.
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
    const shown = page.locator(`.card[data-task="${card.id}"]`)
    await shown.locator('.card-open').click()
    await shown.getByRole(
      'tab',
      { name: 'Activity' },
    ).click()
    const updates = shown.locator('[aria-label="Task updates"]')
    await updates.getByText('Brief updated').first()
      .waitFor()
    expect(await updates.getByText('Created').count()).toBe(0)

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
