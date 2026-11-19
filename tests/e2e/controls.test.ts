import { beforeAll, expect, test } from 'vitest'
import type { Locator } from 'playwright-core'
import { openHydra } from '../setup/browser.ts'
import { appendToolCalls } from '../setup/transcripts.ts'
import { startPnyx, until, type Pnyx } from '../setup/pnyx.ts'

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
    await summary.waitFor()
    await summary.scrollIntoViewIfNeeded()
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

test(
  'a remembered chat progress fold follows its native open state',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({ focusMode: false }),
      ],
    })
    const turn = pnyx.claude.plan({
      hydra: hydra.id,
      text: 'Inspect the release',
      partial: 'Checking',
      reply: 'Checks complete.',
      hold: true,
    })
    const session = await hydra.chat({ text: 'Inspect the release' })
    await appendToolCalls({
      session,
      tools: 1,
    })
    turn.release()
    await until({
      what: 'the completed check',
      check: () => session.answered === 1,
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    const summary = page.locator('[data-active=true] .turn-actions > details > summary').first()
    await summary.waitFor()
    expect(await chevronDirection({ control: summary })).toBe('down')
    await summary.click()
    await expect.poll(() => chevronDirection({ control: summary })).toBe('up')
    await summary.click()
    await expect.poll(() => chevronDirection({ control: summary })).toBe('down')
  },
)

test(
  'Settings reveals removal confirmation in folded chat, blocks duplicate requests and ignores a late receipt',
  async () => {
    const caller = await pnyx.hydra()
    const target = await pnyx.hydra()
    await caller.owner({
      args: [
        'hydra',
        'set',
        '--name',
        'Removal caller',
      ],
    })
    await target.owner({
      args: [
        'hydra',
        'set',
        '--name',
        'Removal target',
      ],
    })
    let hold = false
    const held: (() => void)[] = []
    let heldId: string | undefined
    let receiptForwarded = false
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: caller.id,
      reducedMotion: true,
      prepare: async ({ page }) => page.routeWebSocket(
        /\/ws\?/,
        // eslint-disable-next-line pnyx/object-params -- Playwright supplies the socket.
        socket => {
          const server = socket.connectToServer()
          // eslint-disable-next-line pnyx/object-params -- Playwright supplies the frame.
          server.onMessage(message => {
            socket.send(message)

            if (heldId && JSON.parse(String(message)).id === heldId) {
              receiptForwarded = true
            }
          })
          // eslint-disable-next-line pnyx/object-params -- Playwright supplies the frame.
          socket.onMessage(message => {
            const frame = JSON.parse(String(message))

            if (hold && frame.name === 'hydra' && frame.args?.[0] === 'remove') {
              heldId = frame.id
              held.push(() => server.send(message))
            } else {
              server.send(message)
            }
          })
        },
      ),
    })
    const workspace = page.locator(`[data-hydra-workspace="${caller.id}"]`)
    await workspace.getByRole(
      'button',
      {
        name: 'Fold chat',
        exact: true,
      },
    ).click()
    await workspace.locator('.workspace-chat.collapsed').waitFor()
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
        name: 'Remove Removal target',
        exact: true,
      },
    ).click()
    await page.waitForURL(`**/hydra/${caller.id}/`)
    const question = workspace.getByRole(
      'region',
      { name: 'Pending owner question' },
    )
    await question.getByRole(
      'button',
      {
        name: 'Confirm',
        exact: true,
      },
    ).waitFor()
    expect(await workspace.locator('.workspace-chat.collapsed').count()).toBe(0)
    expect((await caller.owner({
      args: [
        'hydra',
        'list',
      ],
    })).hydras.some((hydra: { id: string }) => hydra.id === target.id)).toBe(true)
    await question.getByRole(
      'button',
      {
        name: 'Dismiss',
        exact: true,
      },
    ).click()
    await question.waitFor({ state: 'hidden' })
    await page.getByRole(
      'button',
      {
        name: 'Settings',
        exact: true,
      },
    ).click()
    hold = true
    const remove = settings.getByRole(
      'button',
      {
        name: 'Remove Removal target',
        exact: true,
      },
    )
    await remove.click()
    await expect.poll(() => held.length).toBe(1)
    expect(await remove.isEnabled()).toBe(false)
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
        name: 'Settings',
        exact: true,
      },
    ).click()
    hold = false
    const [release] = held

    if (!release) {
      throw new Error('The removal request was not intercepted')
    }

    release()
    await expect.poll(() => receiptForwarded).toBe(true)
    expect(page.url()).toContain(`/hydra/${caller.id}/settings/`)
    await settings.getByRole(
      'button',
      {
        name: 'Remove Removal caller',
        exact: true,
      },
    ).click()
    await settings.getByRole('alert').filter({ hasText: 'own Hydra' })
      .waitFor()
    expect(page.url()).toContain(`/hydra/${caller.id}/settings/`)
    expect(await settings.getByRole(
      'button',
      {
        name: 'Remove Removal caller',
        exact: true,
      },
    ).isEnabled()).toBe(true)
  },
)
