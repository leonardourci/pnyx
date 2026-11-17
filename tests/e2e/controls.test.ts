import { beforeAll, expect, test } from 'vitest'
import type { Locator } from 'playwright-core'
import { openHydra } from '../setup/browser.ts'
import { startPnyx, type Pnyx } from '../setup/pnyx.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx({ zeroCache: true })
})

const chevronDirection = ({ control }: { control: Locator }) => control.locator('svg:visible').last()
  .locator('path')
  .evaluate(
  // eslint-disable-next-line pnyx/object-params -- Playwright passes the SVG element.
    element => {
      const path = element as SVGPathElement
      const length = path.getTotalLength()
      const matrix = path.getScreenCTM()!
      const start = path.getPointAtLength(0).matrixTransform(matrix)
      const tip = path.getPointAtLength(length / 2).matrixTransform(matrix)
      const end = path.getPointAtLength(length).matrixTransform(matrix)

      if (tip.y < start.y && tip.y < end.y) {
        return 'up'
      }

      if (tip.y > start.y && tip.y > end.y) {
        return 'down'
      }

      return 'sideways'
    },
  )

test(
  'a Select points down when closed and up while its choices are open by mouse or keyboard',
  async () => {
    const hydra = await pnyx.hydra()
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    await page.getByRole(
      'button',
      {
        name: 'Settings',
        exact: true,
      },
    ).click()
    const settings = page.getByRole(
      'region',
      {
        name: 'Settings',
        exact: true,
      },
    )
    await settings.getByRole(
      'button',
      {
        name: 'Add account',
        exact: true,
      },
    ).click()
    const provider = settings.getByRole(
      'combobox',
      { name: 'Account provider' },
    )
    expect(await provider.getAttribute('aria-expanded')).toBe('false')
    expect(await chevronDirection({ control: provider })).toBe('down')

    await provider.click()
    expect(await provider.getAttribute('aria-expanded')).toBe('true')
    expect(await chevronDirection({ control: provider })).toBe('up')

    await provider.press('Escape')
    expect(await provider.getAttribute('aria-expanded')).toBe('false')
    expect(await chevronDirection({ control: provider })).toBe('down')

    await provider.press('ArrowDown')
    expect(await provider.getAttribute('aria-expanded')).toBe('true')
    expect(await chevronDirection({ control: provider })).toBe('up')

    await provider.press('Enter')
    expect(await provider.getAttribute('aria-expanded')).toBe('false')
    expect(await chevronDirection({ control: provider })).toBe('down')
  },
)

test(
  'a shared disclosure points down to open its content and up to close it',
  async () => {
    const hydra = await pnyx.hydra()
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    await page.getByRole(
      'button',
      {
        name: 'Settings',
        exact: true,
      },
    ).click()
    const summary = page.getByRole(
      'region',
      {
        name: 'Settings',
        exact: true,
      },
    )
      .locator('summary')
      .filter({ hasText: 'License notices' })
    await expect.poll(() => chevronDirection({ control: summary })).toBe('down')
    await summary.click()
    await expect.poll(() => chevronDirection({ control: summary })).toBe('up')
    await summary.click()
    await expect.poll(() => chevronDirection({ control: summary })).toBe('down')

    const columns = page.getByRole(
      'region',
      {
        name: 'Settings',
        exact: true,
      },
    )
      .locator('summary')
      .filter({ hasText: 'Per column' })
    await expect.poll(() => chevronDirection({ control: columns })).toBe('down')
    await columns.click()
    await expect.poll(() => chevronDirection({ control: columns })).toBe('up')
    await columns.click()
    await expect.poll(() => chevronDirection({ control: columns })).toBe('down')
  },
)

test(
  'a settings popover points up while open and down after it closes',
  async () => {
    const hydra = await pnyx.hydra()
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    const trigger = page.locator('[data-active=true]').getByRole(
      'button',
      { name: /^Hydra agent settings:/ },
    )
    expect(await chevronDirection({ control: trigger })).toBe('down')
    await trigger.click()
    expect(await chevronDirection({ control: trigger })).toBe('up')
    await trigger.press('Escape')
    expect(await chevronDirection({ control: trigger })).toBe('down')
  },
)
