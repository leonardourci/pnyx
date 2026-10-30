import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import WebSocket from 'ws'
import { fixtureApplication } from '#agent-host/fixtures/application-harness.ts'
import { until } from '#agent-host/fixtures/harness.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'

const journalText = ({ root }: { root: string }) => readdirSync(join(
  root,
  'journal',
))
  .map(name => readFileSync(
    join(
      root,
      'journal',
      name,
    ),
    'utf8',
  ))
  .join('\n')

test(
  'native host loss reaches the existing browser socket without a reconnect',
  async t => {
    const app = await fixtureApplication({ t })
    const server = await app.start()
    const token = readFileSync(
      join(
        app.home,
        'token',
      ),
      'utf8',
    ).trim()
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/hydra/default/ws?token=${token}`)
    t.after(() => ws.terminate())
    const statuses: string[] = []
    let connections = 0
    ws.on(
      'open',
      () => connections++,
    )
    ws.on(
      'message',
      raw => {
        const frame = JSON.parse(String(raw))

        if (frame.type === 'native-status') {
          statuses.push(frame.native.state)
        }
      },
    )
    await until({ check: () => statuses.includes('ready') })
    app.host.child.kill('SIGKILL')
    await app.host.exited
    await until({ check: () => statuses.includes('unavailable') })
    assert.equal(
      connections,
      1,
    )
    const response = await fetch(`http://127.0.0.1:${server.port}/health`)
    assert.equal(
      (await response.json()).native.state,
      'unavailable',
    )
  },
)

for (const provider of [
  'claude',
  'codex',
]) {
  test(
    `${provider} secret re-entry follows NOT_RECEIVED after an application SIGKILL`,
    async t => {
      const app = await fixtureApplication({ t })
      const first = await app.start()
      await app.cli({
        args: [
          'rule',
          'set',
          'hydra',
          '--harness',
          provider,
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
          'Ask for a fixture secret',
        ],
      })
      await until({ check: () => !!app.state().cards[HYDRA_CARD]?.agent })
      const nativeId = app.state().cards[HYDRA_CARD]!.agent!.sessionId
      await until({
        check: async () => {
          const states = await app.host.stats()

          return !!states.find(state => state.id === nativeId)?.input.length
        },
      })
      await first.control({ kind: 'hold-answer' })
      const secret = 'synthetic-native-secret-1793307'
      const asking = app.host.control({
        kind: 'ask-secret',
        nativeId,
        expected: secret,
      })
      asking.catch(() => {})
      await until({ check: () => !!app.state().cards[HYDRA_CARD]!.permissions?.some(request => request.status === 'pending') })
      const request = app.state().cards[HYDRA_CARD]!.permissions!.find(request => request.status === 'pending')!
      const answer = () => app.cli({
        args: [
          'task',
          'permission',
          HYDRA_CARD,
          request.id,
          'allow',
          '--answer',
          JSON.stringify({ answers: [{ text: secret }] }),
        ],
      })
      await answer()
      await until({
        check: async () => {
          const metrics = await first.control({ kind: 'metrics' }) as { heldAnswers: number }

          return metrics.heldAnswers === 1
        },
      })
      assert.equal(
        (await app.host.stats()).find(state => state.id === nativeId)!.answers,
        0,
      )
      first.child.kill('SIGKILL')
      await first.exited
      await app.start()
      await until({
        check: () => {
          const permissions = app.state().cards[HYDRA_CARD]!.permissions ?? []

          return permissions.some(current =>
            current.id === request.id && current.delivery === 'needs_reentry')
        },
      })
      const reentry = app.state().cards[HYDRA_CARD]!.permissions!.find(current =>
        current.id === request.id)!
      assert.equal(
        reentry.status,
        'allow',
      )
      await answer()
      await asking
      await until({ check: () => app.state().cards[HYDRA_CARD]!.permissions?.some(current => current.id === request.id && current.delivery === 'submitted') === true })
      const stats = (await app.host.stats()).find(state => state.id === nativeId)!
      assert.equal(
        stats.answers,
        1,
      )
      assert.equal(
        stats.valueMatched,
        true,
      )
      const journals = journalText({ root: app.root })
      assert.equal(
        journals.includes('"answers":'),
        false,
      )
      assert.equal(
        journals.includes(secret),
        false,
      )
      assert.equal(
        readFileSync(
          join(
            app.home,
            'hydras/default/events.jsonl',
          ),
          'utf8',
        ).includes(secret),
        false,
      )
      assert.equal(
        app.errors().includes(secret),
        false,
      )
    },
  )
}

for (const provider of [
  'claude',
  'codex',
]) {
  for (const decision of [
    'allow',
    'deny',
    'secret',
  ] as const) {
    test(
      `${provider} saved-decision crash recovers ${decision}`,
      async t => {
        const app = await fixtureApplication({ t })
        const first = await app.start()
        await app.cli({
          args: [
            'rule',
            'set',
            'hydra',
            '--harness',
            provider,
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
            'Exercise decision receipt recovery',
          ],
        })
        await until({ check: () => !!app.state().cards[HYDRA_CARD]?.agent })
        const nativeId = app.state().cards[HYDRA_CARD]!.agent!.sessionId
        await until({
          check: async () => {
            const states = await app.host.stats()

            return !!states.find(state => state.id === nativeId)?.input.length
          },
        })
        await first.control({ kind: 'hold-decision' })
        const secret = 'synthetic-pre-journal-secret'
        const asking = app.host.control({
          kind: decision === 'secret' ? 'ask-secret' : 'ask',
          nativeId,
          expected: decision === 'secret' ? secret : undefined,
        })
        asking.catch(() => {})
        await until({ check: () => app.state().cards[HYDRA_CARD]!.permissions?.some(request => request.status === 'pending') === true })
        const request = app.state().cards[HYDRA_CARD]!.permissions!.find(request => request.status === 'pending')!
        const choice = decision === 'deny' ? 'deny' : 'allow'
        const args = [
          'task',
          'permission',
          HYDRA_CARD,
          request.id,
          choice,
        ]

        if (decision === 'secret') {
          args.push(
            '--answer',
            JSON.stringify({ answers: [{ text: secret }] }),
          )
        }

        await app.cli({ args })
        await until({
          check: async () => {
            const metrics = await first.control({ kind: 'metrics' }) as { heldDecisions: number }

            return metrics.heldDecisions === 1
          },
        })
        const journalsBefore = readdirSync(join(
          app.root,
          'journal',
        )).map(name =>
          JSON.parse(readFileSync(
            join(
              app.root,
              'journal',
              name,
            ),
            'utf8',
          )) as Record<string, unknown>)
        assert.ok(journalsBefore.every(binding => !('answers' in binding)))
        assert.equal(
          (await app.host.stats()).find(state => state.id === nativeId)!.answers,
          0,
        )
        first.child.kill('SIGKILL')
        await first.exited
        const recovered = await app.start()

        if (decision === 'secret') {
          await until({
            check: () => app.state().cards[HYDRA_CARD]!.permissions?.some(current =>
              current.id === request.id && current.delivery === 'needs_reentry') === true,
          })
          await app.cli({ args })
        }

        await asking
        await until({
          check: () => app.state().cards[HYDRA_CARD]!.permissions?.some(current =>
            current.id === request.id && current.delivery === 'submitted') === true,
        })
        assert.equal(
          (await app.host.stats()).find(state => state.id === nativeId)!.answers,
          1,
        )
        const after = journalText({ root: app.root })
        assert.equal(
          after.includes(secret),
          false,
        )
        assert.equal(
          readFileSync(
            join(
              app.home,
              'hydras/default/events.jsonl',
            ),
            'utf8',
          ).includes(secret),
          false,
        )
        assert.equal(
          app.errors().includes(secret),
          false,
        )
        recovered.child.kill('SIGKILL')
        await recovered.exited
        await app.start()
        assert.equal(
          (await app.host.stats()).find(state => state.id === nativeId)!.answers,
          1,
        )
      },
    )
  }
}
