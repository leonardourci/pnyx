import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import WebSocket from 'ws'
import { deferred } from '#agent-host/deferred.ts'
import { fixtureApplication } from '#agent-host/fixtures/application-harness.ts'
import { until } from '#agent-host/fixtures/harness.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'

const SAMPLES = 40
const REQUEST_MS = 10000
const IMAGE_BYTES = 1024 * 1024
const CALL_P95_MS = 5
const CALL_P99_MS = 10
const VISIBLE_P95_ALLOWANCE_MS = 10
const percentile = ({
  samples,
  percent,
}: {
  samples: number[]
  percent: number
}) => [...samples].sort((
  a,
  b,
) => a - b)[Math.ceil(samples.length * percent) - 1]!
const distribution = ({ samples }: { samples: number[] }) => ({
  count: samples.length,
  p50: percentile({
    samples,
    percent: .5,
  }),
  p95: percentile({
    samples,
    percent: .95,
  }),
  p99: percentile({
    samples,
    percent: .99,
  }),
})

test(
  'full application native transport performance at one and ten active fixture sessions',
  { skip: process.env.PNYX_NATIVE_BENCHMARK !== '1' },
  async t => {
    const rows: {
      local: boolean
      concurrency: number
      page: ReturnType<typeof distribution>
      ipc: ReturnType<typeof distribution>
      receipts: Record<string, ReturnType<typeof distribution>>
      handling?: ReturnType<typeof distribution>
      permissionMs: number
      imageMs: number
      startupMs: number
    }[] = []

    for (const concurrency of [
      1,
      10,
    ]) {
      for (const local of [
        true,
        false,
      ]) {
        const app = await fixtureApplication({
          t,
          local,
          measureNative: !local,
        })
        const started = performance.now()
        const server = await app.start()
        const startupMs = performance.now() - started
        await app.cli({
          args: [
            'rule',
            'set',
            'hydra',
            '--harness',
            'codex',
            '--model',
            'fixture',
          ],
        })
        await app.cli({
          args: [
            'hydra',
            'set',
            '--helper',
            'off',
          ],
        })
        await app.cli({
          args: [
            'hydra',
            'send',
            '--text',
            'benchmark warmup',
          ],
        })
        const tasks = [HYDRA_CARD]

        for (let index = 1; index < concurrency; index++) {
          const key = `bench-${index}`
          await app.cli({
            args: [
              'task',
              'create',
              '--key',
              key,
              '--title',
              key,
              '--brief',
              'Benchmark',
              '--folder',
              app.folder,
            ],
          })
          await app.cli({
            args: [
              'task',
              'start',
              key,
              '--harness',
              'codex',
              '--model',
              'fixture',
              '--folder',
              app.folder,
            ],
          })
          tasks.push(Object.values(app.state().cards).find(card => card.key === key)!.id)
        }

        await until({ check: () => !!app.state().cards[HYDRA_CARD]?.agent })
        const nativeId = app.state().cards[HYDRA_CARD]!.agent!.sessionId
        const token = readFileSync(
          join(
            app.home,
            'token',
          ),
          'utf8',
        ).trim()
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/hydra/default/ws?token=${token}`)
        t.after(() => ws.terminate())
        const pending = new Map<string, ReturnType<typeof deferred<Record<string, unknown>>>>()
        const threads: string[] = []
        ws.on(
          'message',
          raw => {
            const message = JSON.parse(String(raw))

            if (message.id) {
              pending.get(message.id)?.resolve(message)
            }

            if (message.type === 'thread') {
              threads.push(JSON.stringify(message))
            }
          },
        )
        await new Promise<void>((
          resolve,
          reject,
        ) => {
          ws.once(
            'open',
            resolve,
          ); ws.once(
            'error',
            reject,
          )
        })

        const receipts: Record<string, number[]> = {
          hydra: [],
          'task-message': [],
          agent: [],
        }
        let measuringReceipts = false

        const command = async ({
          name,
          args,
        }: {
          name: string
          args: string[]
        }) => {
          const sent = performance.now()
          const id = randomUUID(), response = deferred<Record<string, unknown>>()
          pending.set(
            id,
            response,
          )
          const timer = setTimeout(
            () => response.reject(new Error(`Benchmark command ${name} timed out`)),
            REQUEST_MS,
          )
          ws.send(JSON.stringify({
            type: 'command',
            id,
            name,
            args,
          }))

          try {
            const result = await response.promise; assert.equal(
              result.type,
              'receipt',
              JSON.stringify(result),
            )

            if (measuringReceipts) {
              receipts[name]?.push(performance.now() - sent)
            }

            return result
          } finally {
            clearTimeout(timer); pending.delete(id)
          }
        }

        await command({
          name: 'thread',
          args: [HYDRA_CARD],
        })
        const page: number[] = []

        const input = async ({ text }: { text: string }) => {
          await command({
            name: 'hydra',
            args: [
              'send',
              `--text=${text}`,
            ],
          })
          await Promise.all(tasks.slice(1).map(async task => command({
            name: 'task-message',
            args: [
              task,
              text,
              randomUUID(),
            ],
          })))
        }

        measuringReceipts = true

        for (let sample = 0; sample < SAMPLES; sample++) {
          await input({ text: `${sample} ${'x'.repeat(1024)}` })
          await command({
            name: 'agent',
            args: [
              HYDRA_CARD,
              'effort',
              sample % 2 ? 'medium' : 'high',
              randomUUID(),
            ],
          })
          const marker = `native-delta-${sample}`
          const sent = performance.now()

          if (local) {
            await server.control({
              kind: 'emit',
              nativeId,
              text: marker,
            })
          } else {
            await app.host.control({
              kind: 'event',
              nativeId,
              event: {
                type: 'text',
                id: 'bench',
                text: marker,
              },
            })
          }

          await until({ check: () => threads.some(thread => thread.includes(marker)) })
          page.push(performance.now() - sent)
          threads.length = 0
        }

        measuringReceipts = false

        const attachments = join(
          app.home,
          'hydras/default/attachments',
        )
        mkdirSync(
          attachments,
          { recursive: true },
        )
        const image = join(
          attachments,
          `${randomUUID()}.png`,
        )
        writeFileSync(
          image,
          Buffer.alloc(
            IMAGE_BYTES,
            1,
          ),
        )
        const imageStarted = performance.now()
        await input({ text: `[image: ${image}]` })
        await until({
          check: async () => {
            const stats = local ? (await server.control({ kind: 'stats' }) as { states: { input: { images: unknown[] }[] }[] }).states : await app.host.stats()

            return stats.some(state => state.input.some(input => input.images.length > 0))
          },
        })
        const imageMs = performance.now() - imageStarted
        const asking = local ? server.control({
          kind: 'ask',
          nativeId,
        }) : app.host.control({
          kind: 'ask',
          nativeId,
        })
        await until({ check: () => !!app.state().cards[HYDRA_CARD]!.permissions?.some(request => request.status === 'pending') })
        const request = app.state().cards[HYDRA_CARD]!.permissions!.find(request => request.status === 'pending')!
        const answerStarted = performance.now()
        await command({
          name: 'task',
          args: [
            'permission',
            HYDRA_CARD,
            request.id,
            'allow',
            '--reason=Benchmark',
          ],
        })
        await asking
        const permissionMs = performance.now() - answerStarted
        const measured = await server.control({ kind: 'metrics' }) as {
          measurements: {
            operation: string
            ms: number
          }[]
        }
        const native = measured.measurements.filter(sample => sample.operation === 'input' || sample.operation === 'set').map(sample => sample.ms)

        if (!native.length) {
          native.push(0)
        }

        let handling: ReturnType<typeof distribution> | undefined

        if (!local) {
          const timings = await app.host.timings()
          const calls = timings.filter(sample => sample.operation === 'input' || sample.operation === 'set')
          assert.equal(
            calls.length,
            native.length,
          )
          handling = distribution({ samples: calls.map(sample => sample.ms) })
        }

        rows.push({
          local,
          concurrency,
          page: distribution({ samples: page }),
          ipc: distribution({ samples: native }),
          receipts: Object.fromEntries(Object.entries(receipts).filter(([
            , samples,
          ]) => samples.length > 0)
            .map(([
              name,
              samples,
            ]) => [
              name,
              distribution({ samples }),
            ])),
          handling,
          permissionMs,
          imageMs,
          startupMs,
        })
        ws.terminate()
        server.child.kill('SIGKILL')
        await server.exited
      }
    }

    t.diagnostic(JSON.stringify(rows))

    for (const concurrency of [
      1,
      10,
    ]) {
      const baseline = rows.find(row => row.local && row.concurrency === concurrency)!
      const remote = rows.find(row => !row.local && row.concurrency === concurrency)!
      const calls = concurrency === 1 ? remote.ipc : remote.handling
      assert.ok(calls)
      const boundary = concurrency === 1 ? 'RPC' : 'host handling'
      assert.ok(
        calls.p95 < CALL_P95_MS,
        `Warm native ${boundary} p95 ${calls.p95} ms at ${concurrency}`,
      )
      assert.ok(
        calls.p99 < CALL_P99_MS,
        `Warm native ${boundary} p99 ${calls.p99} ms at ${concurrency}`,
      )
      assert.ok(
        remote.page.p95 - baseline.page.p95 <= VISIBLE_P95_ALLOWANCE_MS,
        `Page p95 regression ${remote.page.p95 - baseline.page.p95} ms at ${concurrency}`,
      )

      const commands = concurrency === 1 ? [
        'hydra',
        'agent',
      ] : [
        'hydra',
        'task-message',
        'agent',
      ]

      for (const name of commands) {
        const receipts = remote.receipts[name]
        const previous = baseline.receipts[name]
        assert.ok(receipts && previous)
        assert.ok(
          receipts.p95 - previous.p95 <= VISIBLE_P95_ALLOWANCE_MS,
          `${name} receipt p95 regression ${receipts.p95 - previous.p95} ms at ${concurrency}`,
        )
      }
    }
  },
)
