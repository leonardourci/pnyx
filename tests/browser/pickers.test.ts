import { beforeAll, expect, test } from 'vitest'
import type { Page } from 'playwright-core'
import { startOthrys, until, type Othrys, type Titan } from '../setup/othrys.ts'
import { openTitan } from './page.ts'

let othrys: Othrys

beforeAll(async () => {
  othrys = await startOthrys()
})

const RELEASE_TASKS = 60

interface LoadingSeen {
  loadingSeen: string[]
}

const composerOf = ({ page }: { page: Page }) => page.locator('[data-hydra-workspace][data-active=true]').getByRole(
  'textbox',
  {
    name: 'Reply to Titan',
    exact: true,
  },
)

const mentionOptions = ({ page }: { page: Page }) => page.getByRole(
  'listbox',
  { name: 'Mention' },
).getByRole('option')

async function createTasks({ hydra }: { hydra: Titan }) {
  const releases = Array.from(
    { length: RELEASE_TASKS },
    (
      _,
      index,
    ) => ({
      op: 'task.create',
      key: `release-${index + 1}`,
      title: `Release note ${index + 1}`,
    }),
  )
  await hydra.owner({
    args: [
      'apply',
      '--file',
      '-',
    ],
    input: JSON.stringify({
      version: 1,
      changes: [
        ...releases,
        {
          op: 'task.create',
          key: 'report',
          title: 'Ship the report for João Silva',
          brief: 'Collect the quarter numbers first',
        },
        {
          op: 'task.create',
          key: 'plants',
          title: 'Water the plants',
        },
      ],
    }),
  })
}

test(
  '@ matches every typed word ignoring case, accents and spaces, offers other Titans and reaches every row',
  async () => {
    const hydra = await othrys.hydra()
    const other = await othrys.hydra()
    await other.owner({
      args: [
        'hydra',
        'set',
        '--name',
        'Atlas Prime',
      ],
    })
    await createTasks({ hydra })
    const page = await openTitan({
      port: othrys.port(),
      hydraId: hydra.id,
    })
    const composer = composerOf({ page })
    const options = mentionOptions({ page })
    const report = options.filter({ hasText: 'Ship the report for João Silva' })

    for (const query of [
      '@joaosilva',
      '@SILVA joão',
      '@report silva',
      '@quarter numbers',
    ]) {
      await composer.fill(query)
      await report.waitFor()
    }

    await composer.fill('@jsr')
    await page.getByText(
      'Nothing in this Titan matches.',
      { exact: true },
    ).waitFor()

    await composer.fill('@atlasprime')
    await options.filter({ hasText: 'Atlas Prime' }).filter({ hasText: 'Titan' })
      .waitFor()

    await composer.fill('@release note')
    await options.first().waitFor()
    const rendered = await options.count()
    expect(rendered).toBeLessThan(RELEASE_TASKS)

    // An unrelated task changing keeps the open list's rows in place.
    const first = await options.first().elementHandle()
    await first!.evaluate(row => {
      row.dataset.seen = 'kept'
    })
    await hydra.owner({
      args: [
        'task',
        'rename',
        'plants',
        '--title',
        'Water the garden plants',
      ],
    })
    await page.locator('[data-hydra-workspace][data-active=true]').getByText(
      'Water the garden plants',
      { exact: true },
    )
      .first()
      .waitFor()
    expect(await options.first().getAttribute('data-seen')).toBe('kept')

    for (let step = 1; step < RELEASE_TASKS; step++) {
      await composer.press('ArrowDown')
    }

    const selected = page.getByRole(
      'listbox',
      { name: 'Mention' },
    ).locator('[role=option][aria-selected=true]')
    await until({
      what: 'the last release note selected',
      check: async () => await selected.getAttribute('id') === `${await options.last().getAttribute('id')}`
        && await options.count() >= RELEASE_TASKS,
    })
  },
)

test(
  '/ matches commands only and shows descriptions without highlights',
  async () => {
    const hydra = await othrys.hydra()
    const page = await openTitan({
      port: othrys.port(),
      hydraId: hydra.id,
    })
    const composer = composerOf({ page })
    await composer.fill('/addproj')
    const list = page.getByRole(
      'listbox',
      { name: 'Skills and commands' },
    )
    await list.getByRole('option').filter({ hasText: '/add-project' })
      .waitFor()
    expect(await list.locator('.mention-excerpt mark').count()).toBe(0)
  },
)

test(
  'the model step shows its list at once when reopened, and Reload changes only the rows that changed',
  async () => {
    const hydra = await othrys.hydra()
    const page = await openTitan({
      port: othrys.port(),
      hydraId: hydra.id,
    })
    const workspace = page.locator('[data-hydra-workspace][data-active=true]')
    await workspace.getByRole(
      'button',
      { name: /^Titan agent settings/ },
    ).click()
    await page.getByRole(
      'button',
      { name: /^Model / },
    ).click()

    const openModels = async () => {
      await page.getByRole(
        'listbox',
        { name: 'Providers' },
      ).getByRole(
        'button',
        { name: 'Claude Code' },
      )
        .click()
      await page.getByRole(
        'listbox',
        { name: 'Claude Code accounts' },
      ).getByRole(
        'button',
        { name: 'claude:test' },
      )
        .click()
    }

    const models = page.getByRole(
      'listbox',
      { name: 'Models' },
    )
    const option = ({ name }: { name: string }) => models.getByRole(
      'option',
      {
        name,
        exact: true,
      },
    )
    await openModels()
    await option({ name: 'Haiku 5.5' }).waitFor()

    await page.getByRole(
      'button',
      { name: 'Back' },
    ).click()
    await page.getByRole(
      'button',
      { name: 'Back' },
    ).click()
    await page.evaluate(() => {
      const seen: string[] = []
      Object.assign(
        window,
        { loadingSeen: seen },
      )
      new MutationObserver(() => {
        if (document.body.textContent.includes('Loading models…')) {
          seen.push('loading')
        }
      }).observe(
        document.body,
        {
          subtree: true,
          childList: true,
          characterData: true,
        },
      )
    })
    await openModels()
    await option({ name: 'Haiku 5.5' }).waitFor()
    const loadingSeen = await page.evaluate(() => (window as unknown as LoadingSeen).loadingSeen)
    expect(loadingSeen).toEqual([])

    await option({ name: 'Sonnet 5.5' }).evaluate(row => {
      row.dataset.seen = 'kept'
    })
    const recorded = othrys.claude.models.list
    othrys.claude.models.list = [
      ...recorded.filter(model => model.value !== 'haiku'),
      {
        value: 'claude-lyra-1',
        displayName: 'Lyra',
        description: 'A model the harness started listing',
      },
    ]
    await page.getByRole(
      'button',
      { name: 'Reload models' },
    ).click()
    await option({ name: 'Lyra' }).waitFor()
    await option({ name: 'Haiku 5.5' }).waitFor({ state: 'detached' })
    expect(await option({ name: 'Sonnet 5.5' }).getAttribute('data-seen')).toBe('kept')

    othrys.claude.models.failure = 'Claude Code could not list its models'
    await page.getByRole(
      'button',
      { name: 'Reload models' },
    ).click()
    await models.getByRole('alert').waitFor()
    expect(await option({ name: 'Lyra' }).count()).toBe(1)
    othrys.claude.models.failure = undefined
    othrys.claude.models.list = recorded
  },
)
