import { beforeAll, expect, test } from 'vitest'
import { startOthrys, until, type Othrys } from '../setup/othrys.ts'
import { openTitan } from './page.ts'

let othrys: Othrys

beforeAll(async () => {
  othrys = await startOthrys()
})

test(
  'changing the upgrade channel saves the selection and includes it under Changed',
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

    const search = page.getByRole(
      'textbox',
      { name: 'Search settings' },
    )
    await search.fill('release tag')
    await channel.getByRole(
      'radio',
      { name: 'Development' },
    ).click()

    await until({
      what: 'upgrade channel to save as development',
      check: () => othrys.home().settings.settings.upgradeChannel === 'development',
    })
    await search.clear()
    const changed = page.getByRole(
      'navigation',
      { name: 'Settings sections' },
    )
      .getByRole(
        'button',
        { name: /^Changed/ },
      )
    await changed.click()
    await channel.getByRole(
      'radio',
      { name: 'Stable' },
    ).click()
    await until({
      what: 'upgrade channel to save as stable',
      check: () => othrys.home().settings.settings.upgradeChannel === 'stable',
    })
    await channel.waitFor({ state: 'hidden' })
  },
)
