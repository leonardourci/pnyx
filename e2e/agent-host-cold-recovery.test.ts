import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fixtureApplication } from '#agent-host/fixtures/application-harness.ts'
import { fixtureHost, snapshot, until } from '#agent-host/fixtures/harness.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'

const FIRST_BOOT = '11111111-1111-4111-8111-111111111111'
const NEXT_BOOT = '22222222-2222-4222-8222-222222222222'

for (const harness of [
  'claude',
  'codex',
] as const) {
  for (const recovery of [
    'reboot',
    'process groups',
  ]) {
    test(
      `${harness} verified ${recovery} applies retained work and resumes saved sessions without replaying old input`,
      async t => {
        const app = await fixtureApplication({
          t,
          boot: FIRST_BOOT,
          groups: recovery === 'process groups',
        })
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
            'Original uncertain Hydra input.',
          ],
        })
        await app.cli({
          args: [
            'task',
            'create',
            '--title',
            'Cold worker',
            '--key',
            'cold-worker',
            '--folder',
            app.folder,
            '--brief',
            'Original uncertain worker input.',
          ],
        })
        await app.cli({
          args: [
            'task',
            'start',
            'cold-worker',
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
        await until({
          check: async () => {
            const states = await app.host.stats()

            return states.length === 2 && states.every(state => state.input.length === 1)
          },
        })
        const task = app.state().keys['cold-worker']!
        const hydraId = app.state().cards[HYDRA_CARD]!.agent!.sessionId
        const workerId = app.state().cards[task]!.agent!.sessionId
        const original = await app.host.stats()
        const worker = original.find(state => state.id === workerId)!
        first.child.kill('SIGKILL')
        await first.exited
        await app.host.control({
          kind: 'event',
          nativeId: workerId,
          event: {
            type: 'text',
            id: 'saved-reply',
            text: 'Saved worker result before the reboot.',
          },
        })
        await app.host.control({
          kind: 'event',
          nativeId: workerId,
          event: {
            type: 'result',
            turn: worker.turn!,
            inputIds: worker.input.map(input => input.id),
            status: 'completed',
            queued: 0,
          },
        })
        const observer = await app.host.connect()
        const old = observer.ready.sessions.find(session => session.nativeId === workerId)!
        const retained = await snapshot({
          client: observer,
          ref: old.ref,
        })
        const outcome = retained.pendingFacts.find(fact => fact.event.type === 'turn-ended')
        assert.ok(outcome)
        const completionId = `native:${old.ref.epoch}:${outcome.seq}:finished`
        const claim = await observer.call({
          id: randomUUID(),
          operation: {
            kind: 'attach',
            scope: { kind: 'host' },
            expectedRevision: observer.ready.hostControllerRevision,
          },
        })
        assert.ok(claim.kind === 'attached')

        for (const epoch of [
          'middle',
          'latest',
        ]) {
          const opened = await observer.call({
            id: randomUUID(),
            operation: {
              kind: 'open',
              controller: claim.control.generation,
              options: {
                provider: old.provider,
                cwd: app.folder,
                settings: {},
                environment: {},
                resume: { nativeId: workerId },
              },
            },
          })
          assert.ok(
            opened.kind === 'opened',
            epoch,
          )
          const attached = await observer.call({
            id: randomUUID(),
            operation: {
              kind: 'attach',
              scope: {
                kind: 'session',
                ref: opened.session.ref,
              },
              expectedRevision: 0,
            },
          })
          assert.ok(attached.kind === 'attached')
          await observer.call({
            id: randomUUID(),
            operation: {
              kind: 'close',
              ref: opened.session.ref,
              controller: attached.control.generation,
              expectedIdle: false,
            },
          })
          const closed = await snapshot({
            client: observer,
            ref: opened.session.ref,
          })
          assert.deepEqual(
            closed.pendingFacts.map(fact => fact.event.type),
            ['ended'],
          )
        }

        app.host.child.kill('SIGKILL')
        await app.host.exited
        const replacement = await fixtureHost({
          t,
          directory: app.root,
          boot: recovery === 'reboot' ? NEXT_BOOT : FIRST_BOOT,
          groups: recovery === 'process groups',
        })
        const second = await app.start()
        await until({
          check: async () => {
            const states = await replacement.stats()

            return states.some(state => state.id === hydraId && state.input.length === 1)
          },
        })
        const resumedHydra = (await replacement.stats()).find(state => state.id === hydraId)!
        assert.equal(
          resumedHydra.input[0]!.text.includes('Original uncertain Hydra input.'),
          false,
        )
        assert.equal(
          resumedHydra.input[0]!.id === original.find(state => state.id === hydraId)!.input[0]!.id,
          false,
        )
        assert.equal(
          (await replacement.stats()).some(state => state.id === workerId),
          false,
        )
        const completions = () => readFileSync(
          join(
            app.home,
            'hydras/default/events.jsonl',
          ),
          'utf8',
        )
          .trim()
          .split('\n')
          .map(line => JSON.parse(line))
          .filter(event => event.id === completionId)
        assert.equal(
          completions().length,
          1,
        )
        assert.equal(
          app.state().cards[task]!.sessionActivity,
          'finished',
        )
        await app.cli({
          args: [
            'reply',
            task,
            '--text',
            'Fresh worker input after reboot.',
          ],
        })
        await until({
          check: async () => {
            const states = await replacement.stats()

            return states.some(state => state.id === workerId && state.input.length === 1)
          },
        })
        const resumedWorker = (await replacement.stats()).find(state => state.id === workerId)!
        assert.equal(
          app.state().cards[task]!.steering?.some(message => message.text === 'Fresh worker input after reboot.'),
          true,
        )
        assert.equal(
          resumedWorker.input[0]!.text.includes('Original uncertain worker input.'),
          false,
        )
        assert.notEqual(
          resumedWorker.input[0]!.id,
          worker.input[0]!.id,
        )
        second.child.kill('SIGKILL')
        await second.exited
        await app.start()
        assert.equal(
          completions().length,
          1,
        )
        assert.equal(
          (await replacement.stats()).find(state => state.id === hydraId)!.input.length,
          1,
        )
        assert.equal(
          (await replacement.stats()).find(state => state.id === workerId)!.input.length,
          1,
        )
      },
    )
  }
}
