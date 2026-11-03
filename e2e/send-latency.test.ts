import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { openPage, until } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

// Opt-in: PNYX_LATENCY=1 node scripts/verification/test.ts e2e/send-latency.test.ts
const SENDS = 20
const TIMEOUT_MS = 10_000

const percentile = ({
  values,
  at,
}: {
  values: number[]
  at: number
}) => [...values].sort((
  a,
  b,
) => a - b)[Math.min(
  values.length - 1,
  Math.floor(values.length * at),
)]!

// From the page sending the command to the fake agent holding the message, on one clock; the fakes start at once,
// so this is Pnyx's own share of a send.
async function timed({
  received,
  send,
}: {
  received(): number
  send(): Promise<unknown>
}): Promise<number> {
  const before = received()
  const start = performance.now()
  void send()

  for (const end = Date.now() + TIMEOUT_MS; received() === before;) {
    assert.ok(
      Date.now() < end,
      'the agent never received the message',
    )
    await delay(1)
  }

  return performance.now() - start
}

test(
  'send latency: page to agent for Hydra chat and worker replies',
  { skip: process.env.PNYX_LATENCY !== '1' },
  async t => {
    const s = await pnyx.scenario()
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    t.after(() => page.close())
    const hydra = await s.chat({ text: 'Warm up' })
    const folder = s.folder({ name: 'latency' })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Latency',
        '--key',
        'latency',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'latency',
        '--harness',
        'claude',
      ],
    })
    const worker = await s.agent({ cwd: folder })
    const card = s.task({ key: 'latency' }).id
    const idle = ({ id }: { id: string }) => until({
      what: `${id} to finish its turn`,
      check: () => (id === 'hydra' ? s.state().cards.$hydra : s.task({ key: 'latency' }))?.sessionActivity === 'finished',
    })
    const chat: number[] = []
    const replies: number[] = []

    for (let i = 0; i < SENDS; i++) {
      await idle({ id: 'hydra' })
      chat.push(await timed({
        received: () => hydra.received.length,
        send: () => page.command({
          name: 'hydra',
          args: [
            'send',
            `--text=Chat ${i}`,
          ],
        }),
      }))
      await idle({ id: 'worker' })
      replies.push(await timed({
        received: () => worker.received.length,
        send: () => page.command({
          name: 'reply',
          args: [
            card,
            `Reply ${i}`,
            `latency-${i}`,
          ],
        }),
      }))
    }

    const line = ({
      name,
      values,
    }: {
      name: string
      values: number[]
    }) => `${name}: p50 ${percentile({
      values,
      at: 0.5,
    }).toFixed(1)} ms, p95 ${percentile({
      values,
      at: 0.95,
    }).toFixed(1)} ms`
    t.diagnostic(line({
      name: 'Hydra chat',
      values: chat,
    }))
    t.diagnostic(line({
      name: 'worker reply',
      values: replies,
    }))
  },
)
