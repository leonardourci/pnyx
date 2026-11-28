import { beforeAll, expect, test } from 'vitest'
import { startOthrys, until, type Othrys } from '../setup/othrys.ts'
import { openTitan } from './page.ts'

let othrys: Othrys

beforeAll(async () => {
  othrys = await startOthrys()
})

test(
  'choosing Development under Upgrade channel saves the shared upgradeChannel setting',
  async () => {
    const titan = await othrys.titan()
    const page = await openTitan({
      port: othrys.port(),
      titanId: titan.id,
    })
    await page.goto(`http://127.0.0.1:${othrys.port()}/titan/${titan.id}/settings/`)
    const channel = page.getByRole(
      'radiogroup',
      { name: 'Upgrade channel' },
    )
    expect(othrys.home().settings.settings.upgradeChannel).toBe('stable')

    await channel.getByRole(
      'radio',
      { name: 'Development' },
    ).click()

    await until({
      what: 'upgradeChannel to save as development',
      check: () => othrys.home().settings.settings.upgradeChannel === 'development',
    })
    await expect.poll(() => channel.getByRole(
      'radio',
      { name: 'Development' },
    ).getAttribute('aria-checked')).toBe('true')
  },
)
