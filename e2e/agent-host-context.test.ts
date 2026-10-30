import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixtureApplication } from '#agent-host/fixtures/application-harness.ts'
import { until } from '#agent-host/fixtures/harness.ts'

for (const harness of [
  'claude',
  'codex',
] as const) {
  test(
    `${harness} application reattachment publishes memory changed during its outage`,
    async t => {
      const app = await fixtureApplication({ t })
      const first = await app.start()
      await app.cli({
        args: [
          'rule',
          'set',
          'hydra',
          '--harness',
          harness,
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
          'Keep this original native turn running.',
        ],
      })
      await until({
        check: async () => (await app.host.stats()).some(session => session.input.length === 1),
      })
      const native = (await app.host.stats())[0]!
      first.child.kill('SIGKILL')
      await first.exited
      const memory = 'The context after this outage includes the new memory.'
      await app.cli({
        args: [
          'hydra',
          'memory',
          'set',
          '--key',
          'resume-check',
          '--text',
          memory,
        ],
      })
      assert.equal(
        (await app.host.stats())[0]!.context?.includes(memory),
        false,
      )
      await app.start()
      await until({
        check: async () => (await app.host.stats())[0]!.context?.includes(memory) === true,
      })
      const restored = await app.host.stats()
      assert.equal(
        restored.length,
        1,
      )
      assert.equal(
        restored[0]!.id,
        native.id,
      )
      const original = restored[0]!.input.filter(input =>
        input.text.includes('Keep this original native turn running.'))
      assert.equal(
        original.length,
        1,
      )
    },
  )
}
