import { beforeAll, expect, test } from 'vitest'
import { openHydra } from '../setup/browser.ts'
import { startPnyx, type Pnyx } from '../setup/pnyx.ts'

let pnyx: Pnyx
beforeAll(async () => {
  pnyx = await startPnyx({ zeroCache: true })
})

test(
  'the owner creates a polis, assigns its Hydra and project, and filters the workspace',
  async () => {
    const hydra = await pnyx.hydra()
    const personal = await pnyx.hydra()
    const folder = hydra.folder({ name: 'Atlas' })
    await hydra.owner({
      args: [
        'project',
        'add',
        folder,
      ],
    })
    await personal.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({ poleis: { personal: { readers: [personal.id] } } }),
      ],
    })
    await personal.owner({
      args: [
        'hydra',
        'set',
        '--polis',
        'personal',
        '--read-poleis',
        'shared,personal',
      ],
    })
    const held: (() => void)[] = []
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      reducedMotion: true,
      prepare: async ({ page }) => page.routeWebSocket(
        /\/ws\?/,
        // eslint-disable-next-line pnyx/object-params -- Playwright owns the socket callback.
        socket => {
          const server = socket.connectToServer()
          socket.onMessage(
          // eslint-disable-next-line pnyx/object-params -- Playwright owns the frame callback.
            message => {
              const frame = JSON.parse(String(message))
              const home = frame.name === 'hydra' && frame.args?.includes('--polis')
              const move = frame.name === 'project' && frame.args?.[0] === 'move'

              if (home || move) {
                held.push(() => server.send(message))
              } else {
                server.send(message)
              }
            },
          )
        },
      ),
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
        name: '+ New polis',
        exact: true,
      },
    ).click()
    await settings.getByRole(
      'textbox',
      { name: 'New polis name' },
    ).fill('studio')
    await settings.getByRole(
      'button',
      {
        name: 'Create polis',
        exact: true,
      },
    ).click()
    const polis = settings.locator('[aria-label="Polis studio"]')
    await polis.getByRole(
      'combobox',
      { name: 'Add reader to studio' },
    ).click()
    const config = await hydra.owner({
      args: [
        'hydra',
        'show',
      ],
    })
    await page.getByRole(
      'option',
      {
        name: config.hydra.name,
        exact: true,
      },
    ).click()
    await settings.getByRole(
      'switch',
      {
        name: 'Also reads studio',
        exact: true,
      },
    ).click()
    await expect.poll(async () => (await hydra.owner({
      args: [
        'hydra',
        'show',
      ],
    })).hydra.readPoleis).toEqual([
      'shared',
      'studio',
    ])
    await settings.getByRole(
      'combobox',
      {
        name: 'Lives in',
        exact: true,
      },
    ).click()
    await page.getByRole(
      'option',
      {
        name: 'studio',
        exact: true,
      },
    ).click()
    await expect.poll(() => held.length).toBe(1)
    expect(await settings.getByRole(
      'combobox',
      {
        name: 'Lives in',
        exact: true,
      },
    ).innerText()).toContain('studio')
    expect((await hydra.owner({
      args: [
        'hydra',
        'show',
      ],
    })).hydra.polis).toBe('shared')
    const saveHome = held.shift()

    if (!saveHome) {
      throw new Error('Expected a pending Hydra home change')
    }

    saveHome()
    await expect.poll(async () => (await hydra.owner({
      args: [
        'hydra',
        'show',
      ],
    })).hydra.polis).toBe('studio')
    await page.getByRole(
      'button',
      {
        name: 'Close Settings',
        exact: true,
      },
    ).click()
    await page.getByRole(
      'button',
      {
        name: 'Oracle',
        exact: true,
      },
    ).click()
    await page.getByRole(
      'combobox',
      {
        name: 'Oracle',
        exact: true,
      },
    ).fill('Projects')
    await page.getByRole('option').filter({ hasText: 'Projects' })
      .first()
      .click()
    const projectPolis = page.getByRole(
      'combobox',
      {
        name: 'Polis for Atlas',
        exact: true,
      },
    )
    await projectPolis.click()
    const studioOption = page.getByRole(
      'option',
      {
        name: 'studio',
        exact: true,
      },
    )
    await studioOption.waitFor()
    expect(await page.getByRole(
      'option',
      {
        name: 'personal',
        exact: true,
      },
    ).count()).toBe(0)
    await studioOption.click()
    await expect.poll(() => held.length).toBe(1)
    expect(await projectPolis.innerText()).toContain('studio')
    expect((await hydra.owner({
      args: [
        'project',
        'list',
      ],
    })).projects[0].polis).toBe('shared')
    const saveProject = held.shift()

    if (!saveProject) {
      throw new Error('Expected a pending project move')
    }

    saveProject()
    await expect.poll(async () => (await hydra.owner({
      args: [
        'project',
        'list',
      ],
    })).projects[0].polis).toBe('studio')
    await page.getByRole(
      'combobox',
      {
        name: 'Oracle',
        exact: true,
      },
    ).press('Escape')
    await page.locator('[data-project-polis="studio"]').first()
      .waitFor()
    await page.getByRole(
      'button',
      {
        name: 'Filter polis studio',
        exact: true,
      },
    ).click()
    await expect.poll(() => page.getByRole(
      'button',
      {
        name: 'Filter polis studio',
        exact: true,
      },
    ).getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => page.locator(`[data-hydra-workspace="${personal.id}"]`).count()).toBe(0)
    expect(await page.locator(`[data-hydra-workspace="${hydra.id}"]`).count()).toBe(1)
    await page.getByRole(
      'button',
      {
        name: 'Filter polis studio',
        exact: true,
      },
    ).click()
    await page.locator(`[data-hydra-workspace="${personal.id}"]`).waitFor()
    await page.getByRole(
      'button',
      {
        name: 'Filter polis personal',
        exact: true,
      },
    ).click()
    await expect.poll(() => page.url()).toContain(`/hydra/${personal.id}/`)
    await page.getByRole(
      'button',
      {
        name: 'Filter polis studio',
        exact: true,
      },
    ).click()
    await expect.poll(() => page.url()).toContain(`/hydra/${hydra.id}/`)
    await page.getByRole(
      'button',
      {
        name: 'Filter polis studio',
        exact: true,
      },
    ).click()
    await page.reload()
    await page.getByRole(
      'button',
      {
        name: 'Settings',
        exact: true,
      },
    ).click()
    await page.getByRole(
      'combobox',
      {
        name: 'Lives in',
        exact: true,
      },
    ).waitFor()
    await expect.poll(() => page.getByRole(
      'combobox',
      {
        name: 'Lives in',
        exact: true,
      },
    ).innerText()).toContain('studio')
    await settings.getByRole(
      'button',
      {
        name: `Remove ${hydra.id} from studio`,
        exact: true,
      },
    ).click()
    await expect.poll(async () => (await hydra.owner({
      args: [
        'settings',
        'show',
      ],
    })).settings.poleis.studio.readers).toEqual([])
    await expect.poll(async () => (await hydra.owner({
      args: [
        'project',
        'list',
      ],
    })).projects).toBe('none: no projects attached')
  },
)
