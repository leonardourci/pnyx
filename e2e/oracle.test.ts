import assert from 'node:assert/strict'
import { chmodSync, existsSync } from 'node:fs'
import { test } from 'node:test'
import { searchPath, type Hit } from '#oracle/index.ts'
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
  'the Oracle answers from an index the server builds and keeps current outside its own process',
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
      'a first query waits for the first build',
    )
    assert.ok(existsSync(searchPath({ hydraId: s.hydraId })))

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
      'a query on an index behind the log waits for it to catch up',
    )
  },
)

test(
  'a query whose index cannot catch up gets an error instead of stale results',
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
    await ask({
      page,
      words: 'billing',
    })
    chmodSync(
      searchPath({ hydraId: s.hydraId }),
      0o400,
    )

    await createTask({
      s,
      title: 'Audit the payment logs',
      key: 'audit',
    })
    await page.shows({
      what: 'the new task on the page',
      check: ({ state }) => !!state.cards[s.task({ key: 'audit' }).id],
    })
    const refusal = await page.refusal(oracle({ words: 'audit' }))
    assert.deepEqual(
      {
        error: refusal.error,
        code: refusal.code,
      },
      {
        error: 'Oracle index could not catch up: attempt to write a readonly database',
        code: 'UNKNOWN',
      },
    )
  },
)
