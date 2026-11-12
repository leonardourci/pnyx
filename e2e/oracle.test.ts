import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { hydraDir } from '#app/home-migration.ts'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Hit } from '#oracle/model.ts'
import { openPage } from '#test-harness/harness.ts'
import { pnyx, type Scenario } from '#test-harness/pnyx.ts'

type Page = Awaited<ReturnType<typeof openPage>>

const oracle = ({ words }: { words: string }) => ({
  name: 'oracle',
  args: [
    words,
    '',
    'hydra',
  ],
})

const ask = async ({
  page,
  words,
}: {
  page: Page
  words: string
}) => (await page.command(oracle({ words }))).hits as Hit[]

const createTask = ({
  s,
  title,
  key,
}: {
  s: Scenario
  title: string
  key: string
}) => s.owner({
  args: [
    'task',
    'create',
    '--title',
    title,
    '--key',
    key,
  ],
})

test(
  'Oracle reads new tasks directly and creates no index',
  async t => {
    const s = await pnyx.scenario()
    await createTask({
      s,
      title: 'Deploy the billing service',
      key: 'billing',
    })
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    t.after(() => page.close())

    assert.deepEqual(
      (await ask({
        page,
        words: 'billing',
      })).map(hit => hit.card),
      [s.task({ key: 'billing' }).id],
      'the first query reads the task directly',
    )

    await createTask({
      s,
      title: 'Refund annual billing plans',
      key: 'refunds',
    })
    await page.shows({
      what: 'the new task on the page',
      check: ({ state }) => !!state.cards[s.task({ key: 'refunds' }).id],
    })
    assert.deepEqual(
      (await ask({
        page,
        words: 'refund',
      })).map(hit => hit.card),
      [s.task({ key: 'refunds' }).id],
      'a query sees the newest durable event',
    )

    await createTask({
      s,
      title: 'Rotate the invoice signing keys',
      key: 'keys',
    })
    await createTask({
      s,
      title: 'Audit the payment logs',
      key: 'audit',
    })
    await page.shows({
      what: 'the new task on the page',
      check: ({ state }) => !!state.cards[s.task({ key: 'audit' }).id],
    })
    assert.deepEqual(
      (await ask({
        page,
        words: 'audit',
      })).map(hit => hit.card),
      [s.task({ key: 'audit' }).id],
    )
    const superseded = page.refusal(oracle({ words: 'billing' }))
    const latest = page.command(oracle({ words: 'audit' }))
    const [
      cancelled,
      found,
    ] = await Promise.all([
      superseded,
      latest,
    ])
    assert.equal(
      cancelled.code,
      'CANCELLED',
    )
    assert.deepEqual(
      (found.hits as Hit[]).map(hit => hit.card),
      [s.task({ key: 'audit' }).id],
    )

    const invalid = await page.refusal(oracle({ words: '!!!' }))
    assert.equal(
      invalid.code,
      'VALIDATION_ERROR',
    )
    assert.equal(
      existsSync(join(
        hydraDir({ hydraId: s.hydraId }),
        'search.db',
      )),
      false,
    )
  },
)

test(
  'Oracle column, project and date filters narrow searches from the page and the CLI, and a bad filter is refused',
  async t => {
    const s = await pnyx.scenario()
    await s.project({ name: 'billing' })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Deploy the billing service',
        '--key',
        'deploy',
        '--project',
        'billing',
      ],
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Billing report',
        '--key',
        'report',
        '--column',
        'in_progress',
      ],
    })
    const deploy = s.task({ key: 'deploy' }).id
    const report = s.task({ key: 'report' }).id
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    t.after(() => page.close())

    const inProgress = (await page.command({
      name: 'oracle',
      args: [
        'billing',
        '',
        'hydra',
        JSON.stringify({ columns: [s.column({ role: 'in_progress' })] }),
      ],
    })).hits as Hit[]
    assert.deepEqual(
      inProgress.map(hit => hit.card),
      [report],
    )
    assert.deepEqual(
      inProgress[0]!.snippets[0]!.parts,
      [
        {
          text: 'Billing',
          matched: true,
        },
        {
          text: ' report',
          matched: false,
        },
      ],
    )
    const refused = await page.refusal({
      name: 'oracle',
      args: [
        'billing',
        '',
        'hydra',
        '{"limit":1}',
      ],
    })
    assert.deepEqual(
      {
        code: refused.code,
        error: refused.error,
      },
      {
        code: 'VALIDATION_ERROR',
        error: 'invalid Oracle filter: limit',
      },
    )

    const byProject = await s.owner({
      args: [
        'oracle',
        'billing',
        '--project',
        'billing',
      ],
    })
    assert.match(
      byProject,
      new RegExp(deploy),
    )
    assert.doesNotMatch(
      byProject,
      new RegExp(report),
    )
    assert.match(
      await s.owner({
        args: [
          'oracle',
          'billing',
          '--column',
          s.column({ role: 'in_progress' })!,
          '--since',
          '2999-01-01',
        ],
      }),
      /results: "none: no matches for \\"billing\\""/,
    )
  },
)
