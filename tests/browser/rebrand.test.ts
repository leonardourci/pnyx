import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import { openTitan } from './page.ts'
import { startOthrys, until } from '../setup/othrys.ts'

const media = resolve(
  import.meta.dirname,
  '../../.vitest/rebrand-media',
)

test(
  'the Titan picker renders added icons and preserves a custom name',
  async () => {
    const app = await startOthrys()
    const hydra = await app.hydra()
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--name',
        'Poseidon',
        '--icon',
        'poseidon',
      ],
    })
    const page = await openTitan({
      port: app.port(),
      hydraId: hydra.id,
    })
    await page.getByRole(
      'button',
      {
        name: 'Edit Poseidon',
        exact: true,
      },
    ).waitFor()
    expect(await page.title()).toContain('Othrys')
    mkdirSync(
      media,
      { recursive: true },
    )

    for (const width of [
      1440,
      390,
    ]) {
      await page.setViewportSize({
        width,
        height: 900,
      })

      for (const theme of [
        'light',
        'dark',
      ]) {
        await page.evaluate(
          theme => {
            document.documentElement.dataset.theme = theme
          },
          theme,
        )
        await page.screenshot({
          path: resolve(
            media,
            `after-${width}-${theme}.png`,
          ),
        })
        const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)
        await workspace.getByRole(
          'button',
          {
            name: 'Change icon',
            exact: true,
          },
        ).click()

        for (const icon of [
          'cronus',
          'rhea',
          'hyperion',
          'mnemosyne',
          'atlas',
          'prometheus',
          'themis',
        ]) {
          const option = page.getByRole(
            'option',
            {
              name: icon,
              exact: true,
            },
          )
          await option.waitFor()
          expect(await option.locator('svg path').getAttribute('d')).toBeTruthy()
        }

        await page.screenshot({
          path: resolve(
            media,
            `after-picker-${width}-${theme}.png`,
          ),
        })
        await page.keyboard.press('Escape')
      }
    }

    await page.locator(`[data-hydra-workspace="${hydra.id}"]`).getByRole(
      'button',
      {
        name: 'Change icon',
        exact: true,
      },
    )
      .click()
    await page.getByRole(
      'option',
      {
        name: 'cronus',
        exact: true,
      },
    ).click()
    await page.getByRole(
      'button',
      {
        name: 'Edit Poseidon',
        exact: true,
      },
    ).waitFor()
    await until({
      what: 'the chosen Titan icon to save without changing the custom name',
      check: async () => {
        const view = await hydra.owner({
          args: [
            'hydra',
            'show',
          ],
        })
        const identity = view.hydra as {
          name: string
          icon: string
        }

        return identity.name === 'Poseidon' && identity.icon === 'cronus'
      },
    })
    await app.restart()
    expect((await hydra.owner({
      args: [
        'hydra',
        'show',
      ],
    })).hydra).toMatchObject({
      name: 'Poseidon',
      icon: 'cronus',
    })
  },
)
