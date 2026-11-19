import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, onTestFinished, test } from 'vitest'
import { readEvents } from '#app/event-log.ts'
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
      title: 'CSV [export] ]',
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
    const attempts: string[] = []
    let lostReceipt: string | undefined
    let dropped = false
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      reducedMotion: true,
      prepare: ({ page }) => page.routeWebSocket(
        /\/ws\?/,
        // eslint-disable-next-line pnyx/object-params -- Playwright owns socket callbacks.
        socket => {
          const server = socket.connectToServer()
          // eslint-disable-next-line pnyx/object-params -- Playwright owns socket callbacks.
          socket.onMessage(message => {
            const sent = JSON.parse(String(message)) as {
              id?: string
              type?: string
              name?: string
              args?: string[]
            }

            if (sent.type === 'command' && sent.name === 'task'
              && sent.args?.[0] === 'answer-group') {
              attempts.push(sent.args[sent.args.indexOf('--event-id') + 1])

              if (!lostReceipt) {
                lostReceipt = sent.id
              }
            }

            server.send(message)
          })
          // eslint-disable-next-line pnyx/object-params -- Playwright owns socket callbacks.
          server.onMessage(message => {
            const received = JSON.parse(String(message)) as { id?: string }

            if (!dropped && lostReceipt && received.id === lostReceipt) {
              dropped = true

              return
            }

            socket.send(message)
          })
        },
      ),
    })
    onTestFinished(async () => {
      await page.context().close()
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
    await waiting.press('Enter')
    const group = page.locator('.waiting-question-group')

    const groupSummary = group.locator('summary')

    // eslint-disable-next-line pnyx/object-params -- Playwright owns evaluate callbacks.
    expect(await groupSummary.evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Space')
    await page.keyboard.press('ArrowDown')
    const firstQuestion = group.getByRole(
      'button',
      { name: /Include archived/ },
    ).first()
    // eslint-disable-next-line pnyx/object-params -- Playwright owns evaluate callbacks.
    expect(await firstQuestion.evaluate(element => element === document.activeElement)).toBe(true)

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

    const reviewUpdate = reviewCard.locator('.card-current-state')
    await reviewUpdate.filter({ hasText: 'CSV [export] ] is ready for review.' }).waitFor()
    expect(await reviewUpdate.count()).toBe(1)
    await hydra.owner({
      args: [
        'task',
        'landing',
        review.card.id,
        '--landing',
        'pr',
        '--merge',
        'owner',
      ],
    })
    await until({
      what: 'the owner merge question appears in Waiting on you',
      check: async () => (await waiting.textContent())?.includes('Waiting on you · 2') === true,
    })
    await hydra.owner({
      args: [
        'task',
        'landing',
        review.card.id,
        '--landing',
        'pr',
        '--merge',
        'hydra',
      ],
    })
    await until({
      what: 'the merge question leaves Waiting on you',
      check: async () => (await waiting.textContent())?.includes('Waiting on you · 1') === true,
    })
    const latestUpdate = reviewUpdate.filter({ hasText: 'Latest update' })
    const reviewLink = latestUpdate.getByRole(
      'link',
      {
        name: 'CSV [export] ]',
        exact: true,
      },
    )
    await reviewLink.waitFor()
    expect(await latestUpdate.textContent()).toContain('CSV [export] ] is ready for review.')
    expect(await reviewLink.getAttribute('href')).toBe('https://github.com/sample/exports/pull/1')

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

    await page.reload()
    await workspace.getByRole(
      'button',
      {
        name: 'Export pull request',
        exact: true,
      },
    ).waitFor()
    const retry = workspace.getByRole(
      'button',
      { name: 'Retry group answer: Export batch' },
    )
    await retry.waitFor()
    // Reload can render Zero's cached questions before the fresh answer rows arrive.
    await workspace.locator('.waiting-decisions').waitFor({ state: 'detached' })
    expect(await workspace.locator('.waiting-decisions').count()).toBe(0)
    expect(dropped).toBe(true)

    await retry.click()
    await until({
      what: 'the retained group receipt reconciles after reload',
      check: async () => await workspace.locator('.group-answer-delivery').count() === 0,
    })
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toBe(attempts[0])
    const events = readEvents({ hydraId: hydra.id })

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
      expect(card.task.asks).toHaveLength(1)
      const [question] = card.task.asks
      expect(question.choice).toBe('Open only')
      const answers = events.filter(event => event.type === 'hydra.message'
        && event.data.task === card.task.id && event.data.answers === question.id)
      expect(answers).toHaveLength(1)
    }
  },
)
