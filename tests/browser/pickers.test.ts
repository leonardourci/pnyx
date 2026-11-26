import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import type { Page } from 'playwright-core'
import { startOthrys, until, type Othrys, type Titan } from '../setup/othrys.ts'
import { createProject } from '../setup/projects.ts'
import { openTitan } from './page.ts'

let othrys: Othrys

beforeAll(async () => {
  othrys = await startOthrys()
})

const RELEASE_TASKS = 60

const composerOf = ({ page }: { page: Page }) => page.locator('[data-titan-workspace][data-active=true]').getByRole(
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

async function createTasks({ titan }: { titan: Titan }) {
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
  await titan.owner({
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
    const titan = await othrys.titan()
    const other = await othrys.titan()
    await other.owner({
      args: [
        'titan',
        'set',
        '--name',
        'Atlas Prime',
      ],
    })
    await createTasks({ titan })
    const page = await openTitan({
      port: othrys.port(),
      titanId: titan.id,
    })
    const composer = composerOf({ page })
    const options = mentionOptions({ page })
    const report = options.filter({ hasText: 'Ship the report for João Silva' })
    const nothingMatches = page.getByText(
      'Nothing in this Titan matches.',
      { exact: true },
    )

    for (const query of [
      '@joaosilva',
      '@SILVA joão',
      '@report silva',
      '@quarter numbers',
    ]) {
      await composer.fill('@jsr')
      await nothingMatches.waitFor()
      await composer.fill(query)
      await report.waitFor()
    }

    await composer.fill('@atlasprime')
    await options.filter({ hasText: 'Atlas Prime' }).filter({ hasText: 'Titan' })
      .waitFor()

    await composer.fill('@release note')
    await options.first().filter({ hasText: 'Release note' })
      .waitFor()
    expect(await options.count()).toBeLessThan(RELEASE_TASKS)

    await options.first().evaluate(row => {
      row.dataset.seen = 'kept'
    })
    await titan.owner({
      args: [
        'task',
        'rename',
        'plants',
        '--title',
        'Water the garden plants',
      ],
    })
    await page.locator('[data-titan-workspace][data-active=true]').getByText(
      'Water the garden plants',
      { exact: true },
    )
      .first()
      .waitFor()
    expect(await options.first().getAttribute('data-seen')).toBe('kept')

    for (let step = 1; step < RELEASE_TASKS; step++) {
      await composer.press('ArrowDown')
    }

    await until({
      what: 'the last release note selected',
      check: async () => await options.count() === RELEASE_TASKS
        && await options.last().getAttribute('aria-selected') === 'true',
    })
  },
)

test(
  '/ matches commands only and shows descriptions without highlights',
  async () => {
    const titan = await othrys.titan()
    const page = await openTitan({
      port: othrys.port(),
      titanId: titan.id,
    })
    const composer = composerOf({ page })
    await composer.fill('/addproj')
    const list = page.getByRole(
      'listbox',
      { name: 'Skills and commands' },
    )
    const addProject = list.getByRole('option').filter({ hasText: '/add-project' })
    await until({
      what: 'only the command letters of /add-project marked',
      check: async () => (await addProject.locator('mark').allTextContents()).join('') === 'addproj',
    })
  },
)

test(
  'the model step shows its list at once when reopened, and Reload changes only the rows that changed',
  async () => {
    const titan = await othrys.titan()
    const page = await openTitan({
      port: othrys.port(),
      titanId: titan.id,
    })
    const workspace = page.locator('[data-titan-workspace][data-active=true]')
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
      new MutationObserver(() => {
        if (document.body.textContent.includes('Loading models…')) {
          document.body.dataset.loadingSeen = 'true'
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
    expect(await page.locator('body').getAttribute('data-loading-seen')).toBeNull()

    await option({ name: 'Sonnet 5.5' }).evaluate(row => {
      row.dataset.seen = 'kept'
    })
    const recorded = othrys.claude.models.list

    try {
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
    } finally {
      othrys.claude.models.failure = undefined
      othrys.claude.models.list = recorded
    }
  },
)

test(
  '@ offers project files, a typed path shows its folder\'s contents filtered as the name is typed, and the rows shown stay while the next folder loads',
  async () => {
    const titan = await othrys.titan()
    const path = await createProject({
      titan,
      landing: 'branch',
    })
    mkdirSync(join(
      path,
      'src',
    ))
    writeFileSync(
      join(
        path,
        'src',
        'report-builder.ts',
      ),
      'export {}\n',
    )
    const page = await openTitan({
      port: othrys.port(),
      titanId: titan.id,
    })
    const listings: string[] = []
    page.on(
      'request',
      request => {
        if (new URL(request.url()).pathname.endsWith('/folders')) {
          listings.push(request.url())
        }
      },
    )
    const composer = composerOf({ page })
    const options = mentionOptions({ page })

    await composer.fill('@reportbuilder')
    await options.filter({ hasText: 'report-builder.ts' }).filter({ hasText: 'src/report-builder.ts' })
      .waitFor()

    await composer.fill(`@${path}/`)
    await options.filter({ hasText: 'README.md' }).waitFor()
    await options.filter({ hasText: /^src/ }).first()
      .waitFor()
    const asked = listings.length

    await composer.fill(`@${path}/R`)
    await options.filter({ hasText: /^src/ }).first()
      .waitFor({ state: 'detached' })
    await composer.fill(`@${path}/RE`)
    await options.filter({ hasText: 'README.md' }).waitFor()
    expect(listings.length).toBe(asked)

    await composer.fill(`@${path}/src`)
    await options.filter({ hasText: 'README.md' }).waitFor({ state: 'detached' })
    await page.evaluate(() => {
      new MutationObserver(() => {
        if (document.body.textContent.includes('README.md')) {
          document.body.dataset.parentListed = 'true'
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
    await composer.fill(`@${path}/src/`)
    await options.filter({ hasText: 'report-builder.ts' }).waitFor()
    expect(await page.locator('body').getAttribute('data-parent-listed')).toBeNull()
  },
)
