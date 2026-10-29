import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openPage, until } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

test(
  'a setting changed from one Hydra reaches the open page of another, and its board layout stays its own',
  async () => {
    const first = await pnyx.scenario()
    const second = await pnyx.scenario()
    const page = await openPage({
      port: pnyx.port(),
      hydraId: second.hydraId,
    })

    try {
      await until({
        what: 'the settings the page gets on connect',
        check: () => page.settings.length > 0,
      })
      await first.owner({
        args: [
          'view',
          'set',
          '--json',
          '{"theme":"dark","hydraWidth":600}',
        ],
      })
      await until({
        what: 'the dark theme pushed to the other Hydra\'s page',
        check: () => page.settings.at(-1)?.theme === 'dark',
      })
      await page.shows({
        what: 'the other board keeping its own chat width',
        check: ({ state }) => state.view?.hydraWidth === undefined,
      })

      await page.command({
        name: 'settings',
        args: [
          'set',
          '--json',
          '{"fontSize":17}',
        ],
      })
      assert.match(
        await first.owner({
          args: [
            'view',
            'show',
          ],
        }),
        /fontSize: 17/,
      )
    } finally {
      page.close()
      // Every flow shares one Pnyx home, so the next flow starts from the defaults again.
      await first.owner({
        args: [
          'settings',
          'set',
          '--json',
          '{"theme":"system","fontSize":14}',
        ],
      })
    }
  },
)
