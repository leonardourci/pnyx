import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { PAGE_LINES_MAX } from '#app/log-line.ts'
import { MAX_MESSAGE_BYTES } from '#app/server-protocol.ts'
import { batchSize, firstTextShown, forgetSend, log, markSend, startPageLog } from './log.ts'

test(
  'page log batches stay within the server’s message limit and line count, even when every character takes three bytes in UTF-8',
  () => {
    const lines = Array.from(
      { length: 250 },
      (
        _,
        index,
      ) => JSON.stringify({
        operation: 'page.update',
        name: '日'.repeat(400),
        index,
      }),
    )
    const batches: string[][] = []
    let rest = lines

    while (rest.length) {
      const count = batchSize({ lines: rest })
      batches.push(rest.slice(
        0,
        count,
      ))
      rest = rest.slice(count)
    }

    assert.equal(
      batches.flat().length,
      250,
    )
    assert.ok(batches.every(batch => batch.length <= PAGE_LINES_MAX))
    assert.ok(batches.every(batch => Buffer.byteLength(`{"type":"log","lines":[${batch.join(',')}]}`) <= MAX_MESSAGE_BYTES))
  },
)

// The page APIs Node lacks: window events, which the test keeps by type.
const browser = ({ t }: { t: TestContext }) => {
  const handlers = new Map<string, () => void>()
  const page = globalThis as unknown as Record<string, unknown>
  // eslint-disable-next-line pnyx/object-params -- addEventListener owns its signature.
  page.addEventListener = (
    type: string,
    handler: () => void,
  ) => handlers.set(
    type,
    handler,
  )
  page.removeEventListener = () => {}
  t.after(() => {
    delete page.addEventListener
    delete page.removeEventListener
  })

  return handlers
}

test(
  'lines queued while the socket is down go out once it is back, each with its age, keeping the newest 1000',
  t => {
    const handlers = browser({ t })
    let now = 1000
    t.mock.method(
      performance,
      'now',
      () => now,
    )
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let open = false
    const sent: Record<string, unknown>[] = []
    const stop = startPageLog({
      send: ({ lines }) => {
        if (open) {
          sent.push(...lines.map(line => JSON.parse(line) as Record<string, unknown>))
        }

        return open
      },
      hydra: () => 'lab',
    })

    for (let index = 0; index < 1005; index += 1) {
      log({
        operation: 'page.queued',
        count: index,
      })
      now += 10
    }

    t.mock.timers.tick(2000)
    assert.equal(
      sent.length,
      0,
    )
    open = true
    now += 5000
    handlers.get('pagehide')?.()
    stop()
    assert.equal(
      sent.length,
      1000,
      'a page leaving sends what it queued',
    )
    assert.deepEqual(
      [
        sent[0]?.count,
        sent[0]?.ageMs,
        sent.at(-1)?.count,
        sent.at(-1)?.ageMs,
        sent[0]?.hydraId,
      ],
      [
        5,
        // Queued at 1050 of the mocked clock, sent at 11050 + 5000.
        15_000,
        1004,
        5010,
        'lab',
      ],
    )
  },
)

test(
  'the first text of a reply is timed from the send, and a send past the bound or forgotten is not',
  t => {
    browser({ t })
    let now = 0
    t.mock.method(
      performance,
      'now',
      () => now,
    )
    const sent: Record<string, unknown>[] = []
    const stop = startPageLog({
      send: ({ lines }) => {
        sent.push(...lines.map(line => JSON.parse(line) as Record<string, unknown>))

        return true
      },
      hydra: () => 'lab',
    })
    markSend({ hydraId: 'lab' })
    markSend({ hydraId: 'other' })
    now = 1200
    firstTextShown({ hydraId: 'lab' })
    markSend({ hydraId: 'lab' })
    now += 6 * 60_000
    firstTextShown({ hydraId: 'lab' })
    forgetSend({ hydraId: 'other' })
    firstTextShown({ hydraId: 'other' })
    stop()
    assert.deepEqual(
      sent.filter(line => line.operation === 'page.first-text').map(line => [
        line.hydraId,
        line.ms,
      ]),
      [
        [
          'lab',
          1200,
        ],
      ],
    )
  },
)
