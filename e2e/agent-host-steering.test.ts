import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixtureApplication } from '#agent-host/fixtures/application-harness.ts'
import { fixtureHost, until } from '#agent-host/fixtures/harness.ts'

const FIRST_BOOT = '11111111-1111-4111-8111-111111111111'
const NEXT_BOOT = '22222222-2222-4222-8222-222222222222'

for (const harness of [
  'claude',
  'codex',
] as const) {
  test(
    `${harness} recovery rings an unacknowledged inbox once without repeating its instruction`,
    async t => {
      const app = await fixtureApplication({
        t,
        boot: FIRST_BOOT,
      })
      const first = await app.start()
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
          'task',
          'create',
          '--key',
          'steering-worker',
          '--title',
          'Steering worker',
          '--folder',
          app.folder,
          '--brief',
          'Original worker input.',
        ],
      })
      await app.cli({
        args: [
          'task',
          'start',
          'steering-worker',
          '--via',
          'pnyx',
          '--harness',
          harness,
          '--model',
          'fixture',
          '--folder',
          app.folder,
        ],
      })
      const task = app.state().keys['steering-worker']!
      const workerId = app.state().cards[task]!.agent!.sessionId
      await until({
        check: async () => {
          const worker = (await app.host.stats()).find(state => state.id === workerId)

          return worker?.input.length === 1
        },
      })
      const original = (await app.host.stats()).find(state => state.id === workerId)!.input[0]!
      await app.cli({
        args: [
          'reply',
          task,
          '--text',
          'Durable owner instruction.',
        ],
      })
      await until({
        check: async () => {
          const worker = (await app.host.stats()).find(state => state.id === workerId)

          return !!worker?.input.some(input => input.id.startsWith('steering:'))
        },
      })
      const before = (await app.host.stats()).find(state => state.id === workerId)!
      const notice = before.input.find(input => input.id.startsWith('steering:'))!
      const instruction = app.state().cards[task]!.steering!.find(message => message.text === 'Durable owner instruction.')!
      assert.ok(notice.text.includes(instruction.id))
      assert.ok(notice.text.includes('A repeated notice is not a new instruction.'))
      assert.equal(
        instruction.ack,
        undefined,
      )
      first.child.kill('SIGKILL')
      await first.exited
      app.host.child.kill('SIGKILL')
      await app.host.exited
      const replacement = await fixtureHost({
        t,
        directory: app.root,
        boot: NEXT_BOOT,
      })
      const second = await app.start()
      await until({
        check: async () => {
          const worker = (await replacement.stats()).find(state => state.id === workerId)

          return !!worker?.input.some(input => input.id === notice.id)
        },
      })
      const recovered = (await replacement.stats()).find(state => state.id === workerId)!
      assert.equal(
        recovered.input.filter(input => input.id === notice.id).length,
        1,
      )
      assert.equal(
        recovered.input.some(input => input.id === original.id),
        false,
      )
      assert.ok(recovered.input.find(input => input.id === notice.id)!.text.includes('A repeated notice is not a new instruction.'))
      assert.equal(
        app.state().cards[task]!.steering!.find(message => message.id === instruction.id)!.ack,
        undefined,
      )
      second.child.kill('SIGKILL')
      await second.exited
      await app.start()
      await app.cli({
        args: [
          'reply',
          task,
          '--text',
          'Follow-up owner instruction.',
        ],
      })
      const followup = app.state().cards[task]!.steering!.find(message => message.text === 'Follow-up owner instruction.')!
      await until({
        check: async () => {
          const worker = (await replacement.stats()).find(state => state.id === workerId)

          return !!worker?.input.some(input => input.text.includes(followup.id))
        },
      })
      const current = (await replacement.stats()).find(state => state.id === workerId)!
      assert.equal(
        current.input.filter(input => input.id === notice.id).length,
        1,
      )
      assert.equal(
        current.input.some(input => input.id === original.id),
        false,
      )
      assert.equal(
        app.state().cards[task]!.steering!.find(message => message.id === instruction.id)!.text,
        'Durable owner instruction.',
      )
      assert.equal(
        app.state().cards[task]!.steering!.find(message => message.id === instruction.id)!.ack,
        undefined,
      )
    },
  )
}
