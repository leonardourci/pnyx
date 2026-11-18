import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { fireReminders } from '#tasks/fire-reminders.ts'
import { openHydra } from '../setup/browser.ts'
import { startPnyx, until, type Pnyx } from '../setup/pnyx.ts'

let pnyx: Pnyx

beforeAll(async () => {
  process.env.PNYX_FAKE_GITHUB = join(
    process.env.TMPDIR!,
    'github',
  )
  process.env.PNYX_GH_AXI = join(
    import.meta.dirname,
    '../setup/fixtures/gh-axi.mjs',
  )
  mkdirSync(
    join(
      process.env.PNYX_FAKE_GITHUB,
      'sample',
      'exports',
    ),
    { recursive: true },
  )
  writeFileSync(
    join(
      process.env.PNYX_FAKE_GITHUB,
      'sample',
      'exports',
      '1.json',
    ),
    JSON.stringify({
      state: 'open',
      title: 'CSV export',
      head: 'a'.repeat(40),
      checks: '1 passed, 0 failed, 1 total',
    }),
  )
  pnyx = await startPnyx({ zeroCache: true })
})

test(
  'Waiting on you groups a batch, keeps updates separate and answers shared choices together',
  async () => {
    const hydra = await pnyx.hydra()
    const parent = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Export batch',
        '--key',
        'batch',
      ],
    })

    for (const key of [
      'Invoices',
      'Payments',
    ]) {
      await hydra.owner({
        args: [
          'task',
          'create',
          '--title',
          key,
          '--key',
          key,
          '--parent',
          parent.card.id,
        ],
      })
    }

    const session = await hydra.chat({ text: 'Coordinate the export batch' })

    for (const key of [
      'Invoices',
      'Payments',
    ]) {
      const task = await hydra.task({ key })
      await hydra.as({ session }).run({
        args: [
          'task',
          'ask',
          key,
          '--to',
          'owner',
          '--question',
          `Include archived ${key.toLowerCase()}?`,
          '--context',
          `Archived records change totals. I will build this export after your choice. [${key}](pnyx-task:${task.id})`,
          '--choice',
          'Open only',
          '--choice',
          'Include archived',
          '--recommend',
          '1',
          '--reason',
          'Accounting scope',
        ],
      })
    }

    const { worker } = await hydra.startTask({
      key: 'research',
      harness: 'codex',
    })
    await hydra.owner({
      args: [
        'task',
        'rename',
        'research',
        '--title',
        'Research ready',
      ],
    })
    await hydra.as({ session: worker }).run({
      args: [
        'task',
        'status',
        'research',
        'needs_you',
        '--note',
        'Research is ready. The export supports CSV and JSON.',
      ],
    })
    const reminder = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Check export totals',
      ],
    })
    const due = new Date(Date.now() + 60_000).toISOString()
    await hydra.owner({
      args: [
        'task',
        'remind',
        reminder.card.id,
        due,
      ],
    })
    fireReminders({
      hydraId: hydra.id,
      at: new Date(Date.parse(due) + 1).toISOString(),
    })
    const project = hydra.folder({ name: 'exports' })
    await hydra.owner({
      args: [
        'project',
        'add',
        project,
        '--merge',
        'hydra',
      ],
    })
    const review = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Export pull request',
        '--project',
        project,
      ],
    })
    await hydra.owner({
      args: [
        'link',
        review.card.id,
        '--url',
        'https://github.com/sample/exports/pull/1',
      ],
    })
    await until({
      what: 'ready PR metadata',
      check: async () => (await hydra.owner({
        args: [
          'task',
          'show',
          review.card.id,
          '--full',
        ],
      })).task.links?.some((link: { draft?: boolean }) => link.draft === false),
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      reducedMotion: true,
    })
    const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)
    await workspace.getByRole(
      'button',
      {
        name: 'Research ready',
        exact: true,
      },
    ).click()
    const research = await hydra.task({ key: 'research' })
    const update = workspace.locator(`article[data-task="${research.id}"] .card-current-state`)
    await update.getByText(
      'Research is ready.',
      { exact: false },
    ).waitFor()
    const waiting = workspace.getByRole(
      'button',
      {
        name: 'Waiting on you',
        exact: true,
      },
    )
    await waiting.click()
    const group = page.locator('.waiting-question-group')

    await group.locator('summary').click()

    if (process.env.PNYX_KEEP_TEST_FILES) {
      mkdirSync(
        process.env.PNYX_KEEP_TEST_FILES,
        { recursive: true },
      )

      for (const theme of [
        'light',
        'dark',
      ]) {
        await page.evaluate(
          ({ theme }) => {
            document.documentElement.dataset.theme = theme
          },
          { theme },
        )
        await page.screenshot({
          path: join(
            process.env.PNYX_KEEP_TEST_FILES,
            `questions-${theme}.png`,
          ),
        })
      }
    }

    await waiting.click()
    await workspace.getByRole(
      'button',
      {
        name: 'Export pull request',
        exact: true,
      },
    ).click()
    const reviewCard = workspace.locator(`article[data-task="${review.card.id}"]`)
    await reviewCard.locator('.card-link').first()
      .waitFor()

    if (process.env.PNYX_KEEP_TEST_FILES) {
      for (const theme of [
        'light',
        'dark',
      ]) {
        await page.evaluate(
          ({ theme }) => {
            document.documentElement.dataset.theme = theme
          },
          { theme },
        )
        await page.screenshot({
          path: join(
            process.env.PNYX_KEEP_TEST_FILES,
            `updates-${theme}.png`,
          ),
        })
      }
    }

    expect(await reviewCard.locator('.card-current-state').count()).toBe(1)
    expect(await reviewCard.locator('.card-current-state').textContent()).toContain('CSV export is ready for review.')
    await waiting.click()

    if (await group.count() && await group.locator('details').getAttribute('open') === null) {
      await group.locator('summary').click()
    }

    expect(await waiting.textContent()).toContain('Waiting on you · 1')
    expect(await group.count()).toBe(1)
    expect(await group.locator('summary').textContent()).toContain('Export batch · 2')
    expect(await update.textContent()).toContain('Latest update')
    await page.getByRole(
      'button',
      {
        name: 'Answer all 2: Open only',
        exact: true,
      },
    ).click()
    await until({
      what: 'both answers leave Waiting on you',
      check: async () => await workspace.locator('.waiting-decisions').count() === 0,
    })

    for (const key of [
      'Invoices',
      'Payments',
    ]) {
      const card = await hydra.owner({
        args: [
          'task',
          'show',
          key,
          '--full',
        ],
      })
      expect(card.task.asks[0].choice).toBe('Open only')
    }

    if (process.env.PNYX_KEEP_TEST_FILES) {
      await workspace.locator('.hydra-chat').scrollIntoViewIfNeeded()
      await page.screenshot({
        path: join(
          process.env.PNYX_KEEP_TEST_FILES,
          'answered.png',
        ),
      })
    }

    await page.reload()
    await workspace.getByRole(
      'button',
      {
        name: 'Export pull request',
        exact: true,
      },
    ).waitFor()
    expect(await workspace.locator('.waiting-decisions').count()).toBe(0)
    await page.context().close()
  },
)
