import { beforeAll, expect, onTestFinished, test } from 'vitest'
import { openTitan } from './page.ts'
import { startOthrys, type Othrys } from '../setup/othrys.ts'

let app: Othrys
beforeAll(async () => {
  app = await startOthrys()
  const defaultTitan = await app.hydra({
    id: 'default',
    create: false,
  })
  await defaultTitan.owner({
    args: [
      'hydra',
      'set',
      '--name',
      'Rebrand default fixture',
    ],
  })
})

test(
  'an existing task presentation preference survives the rebrand and remains editable',
  async () => {
    const hydra = await app.hydra()
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--name',
        'Saved preference fixture',
      ],
    })
    onTestFinished(async () => {
      await hydra.owner({
        args: [
          'hydra',
          'remove',
          hydra.id,
        ],
      })
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Saved presentation',
        '--key',
        'saved-presentation',
      ],
    })
    const task = await hydra.task({ key: 'saved-presentation' })
    const page = await openTitan({
      port: app.port(),
      hydraId: hydra.id,
      beforeLoad: async ({ page }) => {
        await page.addInitScript(() => {
          localStorage.setItem(
            'pnyx:task-presentation',
            JSON.stringify({ chatOnly: true }),
          )
        })
      },
    })
    await page.locator(`[data-card="${task.id}"]`).click()
    const summary = page.getByRole(
      'button',
      { name: /^(Show task summary|Focus on chat)$/ },
    )
    await summary.waitFor()
    expect(await summary.getAttribute('aria-label')).toBe('Show task summary')
    expect(await summary.getAttribute('aria-pressed')).toBe('true')
    await summary.click()
    await page.getByRole(
      'button',
      {
        name: 'Focus on chat',
        exact: true,
      },
    ).waitFor()
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pnyx:task-presentation')!).chatOnly)).toBe(false)
    expect(await page.evaluate(() => localStorage.getItem('othrys:task-presentation'))).toBeNull()
  },
)
