import type { Locator, Page } from 'playwright-core'
import { beforeAll, expect, test } from 'vitest'
import { startOthrys, until, type Othrys } from '../setup/othrys.ts'
import { openTitan } from './page.ts'

const PHONE = {
  width: 390,
  height: 844,
}
const ENGINES = [
  'chromium',
  'webkit',
] as const

let othrys: Othrys

beforeAll(async () => {
  othrys = await startOthrys()
})

async function titanWithTasks({ project }: { project: string }) {
  const titan = await othrys.titan()
  const folder = titan.folder({ name: project })
  await titan.owner({
    args: [
      'project',
      'add',
      folder,
    ],
  })

  for (const key of [
    `${project}-first`,
    `${project}-second`,
  ]) {
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        key,
        '--title',
        key,
        '--project',
        folder,
      ],
    })
  }

  return {
    titan,
    folder,
  }
}

const box = ({ target }: { target: Locator }) => target.evaluate(element => {
  const {
    left,
    top,
    width,
    height,
  } = element.getBoundingClientRect()

  return {
    left,
    top,
    width,
    height,
  }
})

const sideways = ({ page }: { page: Page }) => page.evaluate(() => ({
  page: document.documentElement.scrollWidth - innerWidth,
  scrollers: [...document.querySelectorAll('*')].filter(element => {
    const overflow = getComputedStyle(element).overflowX

    return (overflow === 'auto' || overflow === 'scroll') && element.scrollWidth > element.clientWidth + 1
  }).length,
}))

for (const engine of ENGINES) {
  test(
    `${engine} phone: the chat fills the screen under the top bar, nothing scrolls sideways, and the sheet reaches each project full screen, even with folds saved on a wide screen`,
    async () => {
      const {
        titan,
        folder,
      } = await titanWithTasks({ project: 'orbit' })
      await titan.owner({
        args: [
          'view',
          'set',
          '--json',
          JSON.stringify({
            workspace: {
              collapsed: true,
              chatCollapsed: true,
              foldedProjects: { [folder]: true },
            },
          }),
        ],
      })
      const page = await openTitan({
        port: othrys.port(),
        titanId: titan.id,
        engine,
        viewport: PHONE,
        touch: true,
      })
      const workspace = page.locator(`[data-titan-workspace="${titan.id}"]`)
      const header = page.locator('header[aria-label="Othrys navigation"]')
      const messages = workspace.locator('.chat-messages')
      await messages.waitFor()
      const bar = await box({ target: header })

      await until({
        what: 'the message list to start under the top bar and span the screen',
        check: async () => {
          const list = await box({ target: messages })

          return list.top === bar.top + bar.height && list.left === 0 && list.width === PHONE.width
        },
      })
      await expect(workspace.locator('.titan-head').isVisible()).resolves.toBe(false)
      await expect(sideways({ page })).resolves.toEqual({
        page: 0,
        scrollers: 0,
      })

      await header.getByRole(
        'button',
        { name: 'Open navigation' },
      ).tap()
      const sheet = page.getByRole(
        'dialog',
        { name: 'Navigation' },
      )
      await sheet.getByRole(
        'button',
        { name: /^orbit/ },
      ).tap()
      const column = workspace.locator(`[data-column="${folder}"]`)
      await until({
        what: 'the project to fill the screen',
        check: async () => {
          const shown = await box({ target: column })

          return shown.left === 0 && shown.width === PHONE.width
        },
      })
      await expect(sideways({ page })).resolves.toEqual({
        page: 0,
        scrollers: 0,
      })
      await expect(column.getByRole(
        'heading',
        {
          name: 'orbit',
          exact: true,
        },
      ).isVisible()).resolves.toBe(true)

      await header.getByRole(
        'button',
        { name: 'Open navigation' },
      ).tap()
      await sheet.getByRole(
        'button',
        { name: 'Chat' },
      ).tap()
      await until({
        what: 'the chat to come back',
        check: async () => (await box({ target: messages })).left === 0,
      })
    },
  )

  test(
    `${engine} phone: dragging a card does not pick it up`,
    async () => {
      const {
        titan,
        folder,
      } = await titanWithTasks({ project: 'tide' })
      const page = await openTitan({
        port: othrys.port(),
        titanId: titan.id,
        engine,
        viewport: PHONE,
      })
      const header = page.locator('header[aria-label="Othrys navigation"]')
      await header.getByRole(
        'button',
        { name: 'Open navigation' },
      ).click()
      await page.getByRole(
        'dialog',
        { name: 'Navigation' },
      ).getByRole(
        'button',
        { name: /^tide/ },
      )
        .click()
      const column = page.locator(`[data-titan-workspace="${titan.id}"] [data-column="${folder}"]`)
      await until({
        what: 'the project on screen',
        check: async () => {
          const shown = await box({ target: column })

          return shown.left >= 0 && shown.left + shown.width <= PHONE.width
        },
      })
      const cards = column.locator('[data-task]')
      const titles = () => cards.locator('.card-open').allTextContents()
      await until({
        what: 'both cards',
        check: async () => (await titles()).length === 2,
      })
      const order = await titles()
      const from = await box({ target: cards.first() })
      const to = await box({ target: cards.last() })
      await page.mouse.move(
        from.left + 4,
        from.top + 4,
      )
      await page.mouse.down()
      await page.mouse.move(
        to.left + to.width / 2,
        to.top + to.height,
        { steps: 12 },
      )
      await expect(page.locator('.workspace-axis[data-dragging]').count()).resolves.toBe(0)
      await page.mouse.up()
      await expect(titles()).resolves.toEqual(order)
    },
  )

  test(
    `${engine} phone: the composer starts roomier and its expand button grows it to most of the screen and back`,
    async () => {
      const titan = await othrys.titan()
      const page = await openTitan({
        port: othrys.port(),
        titanId: titan.id,
        engine,
        viewport: PHONE,
        touch: true,
      })
      const workspace = page.locator(`[data-titan-workspace="${titan.id}"]`)
      const composer = workspace.locator('.titan-chat .composer')
      const field = composer.getByRole(
        'textbox',
        { name: 'Reply to Titan' },
      )
      await field.waitFor()
      expect((await box({ target: field })).height).toBeGreaterThanOrEqual(96)

      await composer.getByRole(
        'button',
        { name: 'Expand the composer' },
      ).tap()
      await until({
        what: 'the composer to fill most of the screen',
        check: async () => (await box({ target: composer })).height > PHONE.height / 2,
      })

      await composer.getByRole(
        'button',
        { name: 'Shrink the composer' },
      ).tap()
      await until({
        what: 'the composer to shrink back',
        check: async () => (await box({ target: composer })).height < PHONE.height / 4,
      })
    },
  )
}
