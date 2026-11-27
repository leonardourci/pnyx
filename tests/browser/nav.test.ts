import type { Page } from 'playwright-core'
import { beforeAll, expect, test } from 'vitest'
import { startOthrys, until, type Othrys, type Titan } from '../setup/othrys.ts'
import { openTitan } from './page.ts'

const PHONE = {
  width: 390,
  height: 844,
}
const WIDE = {
  width: 1440,
  height: 900,
}

let othrys: Othrys

beforeAll(async () => {
  othrys = await startOthrys()
})

async function titanWithProjects({
  name,
  polis,
  projects,
}: {
  name: string
  polis?: string
  projects: string[]
}) {
  const titan = await othrys.titan()
  await titan.owner({
    args: [
      'titan',
      'set',
      '--name',
      name,
    ],
  })

  if (polis) {
    await titan.owner({
      args: [
        'titan',
        'set',
        '--polis',
        polis,
      ],
    })
  }

  const folders: string[] = []

  for (const project of projects) {
    const folder = titan.folder({ name: project })
    await titan.owner({
      args: [
        'project',
        'add',
        folder,
      ],
    })
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        project,
        '--title',
        `${project} task`,
        '--project',
        folder,
      ],
    })
    folders.push(folder)
  }

  return {
    titan,
    folders,
  }
}

async function ask({
  titan,
  key,
}: {
  titan: Titan
  key: string
}) {
  await titan.owner({
    args: [
      'task',
      'ask',
      key,
      '--to',
      'owner',
      '--question',
      'Rebase before the preview?',
    ],
  })
}

const topBar = ({ page }: { page: Page }) => page.locator('header[aria-label="Othrys navigation"]')

const inView = ({
  page,
  selector,
}: {
  page: Page
  selector: string
}) => page.locator(selector).evaluate(element => {
  const box = element.getBoundingClientRect()

  return box.width > 0 && box.left >= 0 && box.right <= innerWidth
})

test(
  'the top bar keeps poleis in order with a gap, holds the active Titan’s projects and menu, and drops down another Titan’s projects',
  async () => {
    const poseidon = await titanWithProjects({
      name: 'Poseidon',
      projects: [
        'papelzinho',
        'deslop',
      ],
    })
    await ask({
      titan: poseidon.titan,
      key: 'deslop',
    })
    const hades = await titanWithProjects({
      name: 'Hades',
      polis: 'work',
      projects: [
        'medbillai',
        'portal',
        'crawler',
        'ledger',
        'claims',
      ],
    })
    const page = await openTitan({
      port: othrys.port(),
      titanId: poseidon.titan.id,
    })
    const bar = topBar({ page })
    const active = bar.locator('.active-titan')
    await active.locator('.project-chips').getByRole(
      'button',
      { name: /^deslop/ },
    )
      .locator('.waiting-count')
      .waitFor()

    const order = await page.evaluate(() => [...document.querySelectorAll('header .titan-chip, header .polis-gap')]
      .map(element => element.classList.contains('polis-gap') ? 'gap' : element.textContent!.trim()))
    const [
      first,
      last,
    ] = [
      order.indexOf('Poseidon1'),
      order.indexOf('Hades'),
    ].sort((
      a,
      b,
    ) => a - b)
    expect(order.slice(
      first,
      last,
    )).toContain('gap')
    await expect(page.evaluate(() => [...document.querySelectorAll('.active-titan .titan-chip, .active-titan .project-chips .button')]
      .map(element => element.getAttribute('aria-label') ?? element.textContent!.trim()))).resolves.toEqual([
      'Poseidon1',
      'Ideas',
      'papelzinho',
      'deslop1',
      'Add project',
    ])
    await expect(bar.getByRole(
      'button',
      { name: /Filter polis/ },
    ).count()).resolves.toBe(0)

    await active.locator('.titan-chip').click()
    const menu = page.getByRole(
      'menu',
      { name: 'Poseidon menu' },
    )
    await expect(menu.getByRole('menuitem').allTextContents()).resolves.toEqual([
      'Fold Titan',
      'Fold all projects',
      'Add project',
      expect.stringMatching(/^Hide the nav/),
    ])
    await menu.getByRole(
      'menuitem',
      { name: 'Add project' },
    ).click()
    const composer = page.locator(`[data-titan-workspace="${poseidon.titan.id}"] .titan-chat .composer .composer-text`)
    await until({
      what: 'Add project to write its request into the composer',
      check: async () => (await composer.textContent())?.includes(' to this Titan')
        && await composer.evaluate(element => element === document.activeElement),
    })

    await bar.locator('.titan-chip').filter({ hasText: 'Hades' })
      .hover()
    const projects = page.getByRole(
      'menu',
      { name: 'Hades projects' },
    )
    await projects.waitFor()
    await expect(projects.getByRole('menuitem').allTextContents()).resolves.toEqual([
      'claims',
      'crawler',
      'ledger',
      'medbillai',
      'portal',
      'Add project',
    ])
    await projects.getByRole(
      'menuitem',
      { name: 'claims' },
    ).click()
    await until({
      what: 'Hades to open on its chosen project',
      check: async () => await bar.locator('.titan-chip[aria-current="page"]').textContent() === 'Hades'
        && await inView({
          page,
          selector: `[data-titan-workspace="${hades.titan.id}"] [data-column="${hades.folders.at(-1)}"]`,
        }),
    })
  },
)

test(
  'hiding the nav is kept for each layout, and the chip, the top edge and the shortcut bring it back',
  async () => {
    const { titan } = await titanWithProjects({
      name: 'Selene',
      projects: ['notes'],
    })
    const page = await openTitan({
      port: othrys.port(),
      titanId: titan.id,
    })
    const bar = topBar({ page })
    const chip = page.getByRole(
      'button',
      { name: 'Show the nav' },
    )
    const titanChips = bar.getByRole(
      'navigation',
      { name: 'Titan navigation' },
    )
    await bar.locator('.active-titan .titan-chip').click()
    await page.getByRole(
      'menuitem',
      { name: /^Hide the nav/ },
    ).click()
    await chip.waitFor()
    await expect(titanChips.count()).resolves.toBe(0)

    await page.mouse.move(
      600,
      1,
    )
    await titanChips.waitFor()
    await page.mouse.move(
      600,
      500,
    )
    await chip.waitFor()

    await page.reload()
    await chip.waitFor()
    await page.keyboard.press('ControlOrMeta+.')
    await titanChips.waitFor()
    await page.keyboard.press('ControlOrMeta+.')
    await chip.waitFor()
    await chip.click()
    await titanChips.waitFor()

    await page.setViewportSize(PHONE)
    const phoneNav = page.getByRole(
      'button',
      { name: 'Open navigation' },
    )
    await phoneNav.waitFor()
    await phoneNav.click()
    const sheet = page.getByRole(
      'dialog',
      { name: 'Navigation' },
    )
    await sheet.waitFor()
    await page.setViewportSize(WIDE)
    await sheet.waitFor({ state: 'detached' })
    await page.setViewportSize(PHONE)
    await phoneNav.waitFor()
    await expect(phoneNav.getAttribute('aria-expanded')).resolves.toBe('false')
    await page.keyboard.press('ControlOrMeta+.')
    await titanChips.waitFor()
    await page.setViewportSize(WIDE)
    await titanChips.waitFor()
    await bar.locator('.active-titan .titan-chip').click()
    await page.getByRole(
      'menuitem',
      { name: /^Hide the nav/ },
    ).click()
    await chip.waitFor()
    await page.setViewportSize(PHONE)
    await titanChips.waitFor()
    await expect(phoneNav.count()).resolves.toBe(0)
  },
)

test(
  'below the switch point the phone header opens a nav sheet and tasks open full screen; at it the wide bar and inline tasks stay',
  async () => {
    const {
      titan,
      folders,
    } = await titanWithProjects({
      name: 'Artemis',
      projects: [
        'alpha',
        'beta',
        'gamma',
      ],
    })
    await ask({
      titan,
      key: 'gamma',
    })
    const page = await openTitan({
      port: othrys.port(),
      titanId: titan.id,
      viewport: {
        width: 899,
        height: 800,
      },
    })
    const workspace = page.locator(`[data-titan-workspace="${titan.id}"]`)
    const header = topBar({ page })
    await header.getByRole(
      'button',
      { name: 'Waiting on you' },
    ).click()
    await page.getByRole(
      'list',
      { name: 'Items waiting on you' },
    ).waitFor()
    await page.keyboard.press('Escape')

    await header.getByRole(
      'button',
      { name: 'Open navigation' },
    ).click()
    const sheet = page.getByRole(
      'dialog',
      { name: 'Navigation' },
    )
    await sheet.getByRole(
      'button',
      { name: /^gamma/ },
    ).click()
    await until({
      what: 'the chosen project to fill the screen',
      check: () => inView({
        page,
        selector: `[data-titan-workspace="${titan.id}"] [data-column="${folders[2]}"]`,
      }),
    })
    await expect(sheet.count()).resolves.toBe(0)

    await workspace.locator(`[data-column="${folders[2]}"] .card-open`).click()
    const task = page.locator('dialog.task-modal')
    await task.getByRole(
      'tab',
      { name: 'Chat' },
    ).click()
    await until({
      what: 'the task to fill the screen on its chat',
      check: () => task.evaluate(element => {
        const box = element.getBoundingClientRect()
        const details = element.querySelector('.card-details')
        const composer = element.querySelector('.task-chat .composer-text')

        return box.width === innerWidth && box.height === innerHeight
          && details?.getClientRects().length === 0 && composer?.getClientRects().length === 1
      }),
    })
    await expect(task.getByRole('tab').allTextContents()).resolves.toEqual([
      'Context',
      'Chat',
      'Activity',
    ])
    await page.setViewportSize({
      width: 900,
      height: 800,
    })
    await task.getByRole(
      'tab',
      {
        name: 'Context',
        selected: true,
      },
    ).waitFor()
    await task.getByRole(
      'button',
      {
        name: 'Close',
        exact: true,
      },
    ).click()
    await task.waitFor({ state: 'detached' })

    await header.getByRole(
      'navigation',
      { name: 'Titan navigation' },
    ).waitFor()
    await workspace.locator(`[data-column="${folders[0]}"] .card-open`).click()
    await workspace.locator(`[data-column="${folders[0]}"] [role="tabpanel"]`).first()
      .waitFor()
    await expect(page.locator('dialog.task-modal').count()).resolves.toBe(0)
    await expect(workspace.getByRole(
      'button',
      { name: 'Card actions' },
    ).first()
      .isVisible()).resolves.toBe(false)
  },
)

test(
  'on a touch screen a tap opens a card and its ⋯ opens the card’s actions',
  async () => {
    const {
      titan,
      folders,
    } = await titanWithProjects({
      name: 'Eos',
      projects: ['dawn'],
    })
    const page = await openTitan({
      port: othrys.port(),
      titanId: titan.id,
      viewport: PHONE,
      touch: true,
    })
    const card = page.locator(`[data-titan-workspace="${titan.id}"] [data-column="${folders[0]}"] [data-task]`)
    const actions = card.locator('.card-menu')
    await card.getByRole(
      'button',
      { name: 'Card actions' },
    ).tap()
    await actions.getByRole(
      'button',
      { name: 'Edit task' },
    ).waitFor()
    await card.getByRole(
      'button',
      { name: 'Card actions' },
    ).tap()
    await until({
      what: 'the second tap to close the actions',
      check: () => actions.evaluate(element => !element.matches(':popover-open')),
    })

    await card.locator('.card-open').tap()
    await page.locator('dialog.task-modal').waitFor()
    await expect(page.locator('.card-menu:popover-open').count()).resolves.toBe(0)
  },
)
