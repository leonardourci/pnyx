import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
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
    const neighbours = [
      await pnyx.hydra(),
      await pnyx.hydra(),
      await pnyx.hydra(),
    ]
    const folder = hydra.folder({ name: 'Atlas' })
    await hydra.owner({
      args: [
        'project',
        'add',
        folder,
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
    const workspaces = page.locator('[data-hydra-workspace]')
    const initialHydras = [
      hydra,
      ...neighbours,
    ]
    await Promise.all(initialHydras.map(({ id }) => page.locator(`[data-hydra-workspace="${id}"]`).waitFor()))
    const workspaceOrder = await workspaces.evaluateAll(
      // eslint-disable-next-line pnyx/object-params -- Playwright owns the callback.
      nodes => nodes.map(node => node.getAttribute('data-hydra-workspace')),
    )
    const middleIds = workspaceOrder.slice(
      1,
      -1,
    )
    const personal = neighbours.find(candidate => middleIds.includes(candidate.id))

    if (!personal) {
      throw new Error('Expected a Hydra between two shared workspaces')
    }

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
    const navigation = page.getByRole(
      'navigation',
      { name: 'Hydra navigation' },
    ).first()
    await navigation.getByRole(
      'button',
      { name: 'Filter polis personal' },
    ).waitFor()
    const hydraChips = navigation.locator('[data-sort-kind="hydra"]')
    await expect.poll(() => hydraChips.evaluateAll(
      // eslint-disable-next-line pnyx/object-params -- Playwright owns the callback.
      nodes => nodes.map(node => node.getAttribute('data-sort-id')),
    )).toEqual(workspaceOrder)
    const sharedFilters = navigation.getByRole(
      'button',
      {
        name: 'Filter polis shared',
        exact: true,
      },
    )
    expect(await sharedFilters.count()).toBe(2)
    const secondSharedFilter = sharedFilters.nth(1)
    await secondSharedFilter.press('Enter')
    const personalWorkspace = page.locator(`[data-hydra-workspace="${personal.id}"]`)
    await personalWorkspace.waitFor({ state: 'hidden' })
    await navigation.getByRole(
      'button',
      {
        name: 'Filter polis shared',
        pressed: true,
        exact: true,
      },
    ).first()
      .click()
    await personalWorkspace.waitFor()
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
    await settings.getByRole(
      'textbox',
      { name: 'New polis name' },
    ).waitFor({ state: 'hidden' })
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
    await expect.poll(async () => (await hydra.owner({
      args: [
        'settings',
        'show',
      ],
    })).settings.poleis.studio.readers).toEqual([hydra.id])
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
    const atlasColumn = page.locator(`[data-hydra-workspace="${hydra.id}"] .project-column[aria-label="Atlas"]`)
    const atlasBadge = atlasColumn.locator('[data-project-polis]')
    await atlasColumn.locator('[data-project-polis="shared"]').waitFor({ state: 'attached' })
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
    await page.getByRole(
      'group',
      {
        name: 'Settings and actions',
        exact: true,
      },
    ).getByRole('option')
      .filter({ hasText: 'Projects' })
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
    const projectRow = page.getByRole('listitem').filter({ has: projectPolis })
    const originalRow = await projectRow.elementHandle()
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
    expect(await projectRow.evaluate(
      // eslint-disable-next-line pnyx/object-params -- Playwright owns the callback.
      (
        node,
        original,
      ) => node === original && node.checkVisibility(),
      originalRow,
    )).toBe(true)
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
    await projectRow.getByRole('status').waitFor({ state: 'hidden' })
    expect(await projectRow.evaluate(
      // eslint-disable-next-line pnyx/object-params -- Playwright owns the callback.
      (
        node,
        original,
      ) => node === original && node.checkVisibility(),
      originalRow,
    )).toBe(true)
    await originalRow.dispose()
    const oracleSearch = page.getByRole(
      'combobox',
      {
        name: 'Oracle',
        exact: true,
      },
    )
    const oracleDialog = page.getByRole(
      'dialog',
      {
        name: 'Oracle',
        exact: true,
      },
    )
    await oracleSearch.press('Escape')
    await expect.poll(() => oracleSearch.inputValue()).toBe('')
    expect(await oracleDialog.isVisible()).toBe(true)
    await oracleSearch.press('Escape')
    await oracleDialog.waitFor({ state: 'hidden' })
    await atlasBadge.waitFor({ state: 'detached' })
    expect(await atlasColumn.count()).toBe(1)
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

test(
  'polis saves reject stale edits, preserve newer drafts, and survive a conflicting width save',
  async () => {
    const hydra = await pnyx.hydra()
    const other = await pnyx.hydra()
    const third = await pnyx.hydra()
    await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({
          poleis: {
            guarded: {
              readers: [
                hydra.id,
                other.id,
                third.id,
              ],
            },
          },
        }),
      ],
    })
    await hydra.owner({
      args: [
        'hydra',
        'resize',
        '--width',
        '600',
      ],
    })
    const held: (() => string)[] = []
    const replies = new Map<string, string | undefined>()

    function releaseNextSave() {
      const release = held.shift()

      if (!release) {
        throw new Error('Expected a held settings or view save')
      }

      return release()
    }

    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      reducedMotion: true,
      prepare: async ({ page }) => page.routeWebSocket(
        /\/ws\?/,
        // eslint-disable-next-line pnyx/object-params -- Playwright owns the socket callback.
        socket => {
          const server = socket.connectToServer()
          server.onMessage(
            // eslint-disable-next-line pnyx/object-params -- Playwright owns the frame callback.
            message => {
              const frame: unknown = JSON.parse(String(message))
              socket.send(message)

              if (!frame || typeof frame !== 'object') {
                return
              }

              if (!('id' in frame) || typeof frame.id !== 'string' || !('type' in frame)) {
                return
              }

              const id = frame.id

              if (!replies.has(id)) {
                return
              }

              if (frame.type === 'receipt') {
                replies.set(
                  id,
                  'receipt',
                )
              }

              if (frame.type === 'error' && 'code' in frame && typeof frame.code === 'string') {
                replies.set(
                  id,
                  frame.code,
                )
              }
            },
          )
          socket.onMessage(
            // eslint-disable-next-line pnyx/object-params -- Playwright owns the frame callback.
            message => {
              const frame: unknown = JSON.parse(String(message))
              const settingsCommand = frame && typeof frame === 'object' && 'name' in frame
                && (frame.name === 'settings' || frame.name === 'view')
              const settingsWrite = settingsCommand && 'args' in frame && Array.isArray(frame.args)
                && frame.args[0] === 'set'

              if (!settingsWrite || !('id' in frame) || typeof frame.id !== 'string') {
                server.send(message)

                return
              }

              const id = frame.id
              replies.set(
                id,
                undefined,
              )
              held.push(() => {
                server.send(message)

                return id
              })
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
    await page.getByRole(
      'button',
      {
        name: '+ New polis',
        exact: true,
      },
    ).click()
    const draft = page.getByRole(
      'textbox',
      { name: 'New polis name' },
    )
    const createPolis = page.getByRole(
      'button',
      {
        name: 'Create polis',
        exact: true,
      },
    )
    await draft.fill('alpha')
    await createPolis.click()
    await expect.poll(() => held.length).toBe(1)
    await page.getByRole(
      'button',
      {
        name: 'Cancel new polis',
        exact: true,
      },
    ).click()
    await page.getByRole(
      'button',
      {
        name: '+ New polis',
        exact: true,
      },
    ).click()
    await draft.fill('beta')
    const alphaSaveId = releaseNextSave()
    await expect.poll(() => replies.get(alphaSaveId)).toBe('receipt')
    await expect.poll(async () => (await hydra.owner({
      args: [
        'settings',
        'show',
      ],
    })).settings.poleis.alpha?.readers).toEqual([])
    await page.getByRole(
      'button',
      {
        name: `Remove ${hydra.id} from guarded`,
        exact: true,
      },
    ).click()
    await expect.poll(() => held.length).toBe(1)
    await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({
          poleis: {
            guarded: { readers: [] },
            pushed: { readers: [] },
          },
        }),
      ],
    })
    await page.locator('[aria-label="Polis pushed"]').waitFor()
    await page.getByRole(
      'button',
      {
        name: `Remove ${third.id} from guarded`,
        exact: true,
      },
    ).click()
    const remainingReader = page.getByRole(
      'button',
      {
        name: `Remove ${other.id} from guarded`,
        exact: true,
      },
    )
    expect(await remainingReader.isVisible()).toBe(true)
    const removalId = releaseNextSave()
    await expect.poll(() => replies.get(removalId)).toBe('REVISION_CONFLICT')
    await page.getByText(/revision/i).waitFor()
    await expect.poll(() => held.length).toBe(1)
    const queuedRemovalId = releaseNextSave()
    await expect.poll(() => replies.get(queuedRemovalId)).toBeDefined()
    await remainingReader.waitFor({ state: 'hidden' })
    expect((await hydra.owner({
      args: [
        'settings',
        'show',
      ],
    })).settings.poleis.guarded.readers)
      .toEqual([])
    expect(await draft.inputValue()).toBe('beta')

    await draft.fill('concurrent')
    await createPolis.click()
    await expect.poll(() => held.length).toBe(1)
    await other.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({ poleis: { concurrent: { readers: [other.id] } } }),
      ],
    })
    const concurrentCreationId = releaseNextSave()
    await expect.poll(() => replies.get(concurrentCreationId)).toBe('REVISION_CONFLICT')
    const concurrentReader = page.getByRole(
      'button',
      {
        name: `Remove ${other.id} from concurrent`,
        exact: true,
      },
    )
    await concurrentReader.waitFor()
    expect((await hydra.owner({
      args: [
        'settings',
        'show',
      ],
    })).settings.poleis.concurrent.readers).toEqual([other.id])
    expect(await draft.inputValue()).toBe('concurrent')

    const beforeResize = await hydra.owner({
      args: [
        'view',
        'show',
      ],
    })
    expect(beforeResize.revision).not.toBe(beforeResize.settingsRevision)
    const chatWidth = page.getByRole(
      'textbox',
      {
        name: 'Hydra chat width value',
        exact: true,
      },
    )
    await expect.poll(() => chatWidth.inputValue()).toBe('600')
    await chatWidth.fill('640')
    await chatWidth.press('Enter')
    await expect.poll(() => held.length).toBe(1)
    await concurrentReader.click()
    await concurrentReader.waitFor({ state: 'hidden' })
    expect(held).toHaveLength(1)

    // A resize from another client invalidates only the Hydra view revision.
    await hydra.owner({
      args: [
        'hydra',
        'resize',
        '--width',
        '560',
      ],
    })
    const widthSaveId = releaseNextSave()
    await expect.poll(() => replies.get(widthSaveId)).toBe('REVISION_CONFLICT')
    await expect.poll(() => held.length).toBe(1)
    const readerSaveId = releaseNextSave()
    await expect.poll(() => replies.get(readerSaveId)).toBe('receipt')
    expect((await hydra.owner({
      args: [
        'settings',
        'show',
      ],
    })).settings.poleis.concurrent.readers).toEqual([])
    await expect.poll(() => chatWidth.inputValue()).toBe('560')
  },
)

test(
  'Firstmate projects keep their polis read-only',
  async () => {
    const hydra = await pnyx.hydra()
    const home = hydra.folder({ name: 'Firstmate' })
    mkdirSync(
      join(
        home,
        'projects',
        'ReadOnly',
      ),
      { recursive: true },
    )
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--firstmate',
        home,
      ],
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      reducedMotion: true,
    })
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
    await page.getByRole(
      'group',
      {
        name: 'Settings and actions',
        exact: true,
      },
    ).getByRole('option')
      .filter({ hasText: 'Projects' })
      .first()
      .click()
    const project = page.getByRole('listitem').filter({
      has: page.getByText(
        'ReadOnly',
        { exact: true },
      ),
    })
    await project.waitFor()
    expect(await project.getByRole(
      'combobox',
      {
        name: 'Polis for ReadOnly',
        exact: true,
      },
    ).count()).toBe(0)
  },
)
