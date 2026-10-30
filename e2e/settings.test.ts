import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openPage, until } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

test(
  'a setting changed from one Hydra reaches the open page of another, and its board layout stays its own',
  async () => {
    const first = await pnyx.scenario()
    const second = await pnyx.scenario()
    const before = await first.owner({
      args: [
        'settings',
        'show',
      ],
    })
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
      await first.owner({
        args: [
          'view',
          'set',
          '--json',
          '{"keyboard":{"bindings":{"palette":["Mod+j"]}}}',
        ],
      })
      await until({
        what: 'the rebound Oracle shortcut pushed to the other Hydra\'s page',
        check: () => page.settings.at(-1)?.keyboard.bindings.palette?.[0] === 'Mod+j',
      })
      assert.match(
        await first.owner({
          args: [
            'view',
            'show',
          ],
        }),
        /hydraWidth: 600/,
      )

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
      // Every flow shares one Pnyx home, so the values this flow found are put back.
      await first.owner({
        args: [
          'settings',
          'set',
          '--json',
          JSON.stringify({
            theme: /theme: (\w+)/.exec(before)![1],
            fontSize: Number(/fontSize: (\d+)/.exec(before)![1]),
            keyboard: { bindings: { palette: null } },
          }),
        ],
      })
    }
  },
)
