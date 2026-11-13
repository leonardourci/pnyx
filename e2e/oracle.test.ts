import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { hydraDir } from '#app/home-migration.ts'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Hit } from '#oracle/model.ts'
import { observeSearchWorkers } from '#oracle/fixtures/search-workers.ts'
import { openPage, until } from '#test-harness/harness.ts'
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
  'Oracle catches up new tasks on query without background indexing',
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
      'the first query builds its derived cache',
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
    const observer = observeSearchWorkers({
      hydraId: s.hydraId,
      folder: hydraDir({ hydraId: s.hydraId }),
    })
    t.after(() => observer.close())
    const gate = observer.gateNext()
    const superseded = page.refusal(oracle({ words: 'billing' }))
    await gate.ready()
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

    const otherPage = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    t.after(() => otherPage.close())
    const clearGate = observer.gateNext()
    const clearing = page.refusal(oracle({ words: 'billing' }))
    await clearGate.ready()
    const otherSearch = otherPage.command(oracle({ words: 'audit' }))
    const cleared = await page.command({
      name: 'oracle',
      args: [],
    })
    assert.equal(
      cleared.cancelled,
      true,
    )
    assert.equal(
      (await clearing).code,
      'CANCELLED',
    )
    assert.deepEqual(
      ((await otherSearch).hits as Hit[]).map(hit => hit.card),
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
        'oracle.db',
      )),
      true,
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

test(
  'a hosted worker\'s finished turn copies nothing into the log and wakes no hydra check, whose conversations hold the owner\'s queued reply',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'archive' })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Archive the turn',
        '--key',
        'archive',
        '--folder',
        folder,
        '--brief',
        'Polish the quillwort ledger.',
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'archive',
      ],
    })
    await s.agent({ cwd: folder })
    await until({
      what: 'the worker turn to finish',
      check: () => s.task({ key: 'archive' }).sessionActivity === 'finished',
    })
    assert.deepEqual(
      s.events().filter(event => event.type === 'chat.message'),
      [],
      'no transcript message is copied into the log',
    )
    const finished = String(s.state().seq)
    const check = () => s.owner({
      args: [
        'hydra',
        'check',
        '--after',
        finished,
      ],
    })
    const quiet = await check()
    assert.match(
      quiet,
      new RegExp(`changes: "none: nothing Hydra tracks changed after seq ${finished}"`),
    )
    assert.doesNotMatch(
      quiet,
      /conversations/,
    )
    await s.owner({
      args: [
        'reply',
        'archive',
        '--text',
        'Keep the ledger sorted',
      ],
    })
    assert.match(
      await check(),
      /conversations\[1\]:\n.*\n +messages\[1\]\{seq,role,text\}:\n +\d+,user,Keep the ledger sorted\n/,
    )
  },
)
