import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { commands } from '#app/cli.ts'
import { createHost } from '#app/host.ts'
import { loadHydra } from '#app/store.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { QueryFn } from '#workers/claude.ts'
import { claudeNative } from '#workers/fixtures/claude-native.ts'
import { claudeRecording } from '#test-harness/fake-agents.ts'
import { settle } from '#test-harness/child-fixture.ts'

const QUIET_MS = 3600000
const result = claudeRecording.turn.find(message => message.type === 'result')

async function rejectedSetting({ work }: { work: 'queued' | 'background' | 'unknown' }) {
  assert.ok(result?.type === 'result' && result.subtype === 'success')
  const native = claudeNative()

  const query: QueryFn = ({ ...options }) => {
    const active = native.query(options)

    active.applyFlagSettings = async () => {
      throw new Error('live setting rejected')
    }

    return active
  }

  const hydraId = `settings-${work}`
  commands.hydra([
    'create',
    hydraId,
  ])
  const host = createHost({
    hydraId,
    query,
    changed: () => {},
    wakeDelay: QUIET_MS,
    stallDelay: QUIET_MS,
    busyDelay: QUIET_MS,
  })

  const background = ({ running }: { running: boolean }) => {
    const tasks = running ? [
      {
        task_id: 'job',
        task_type: 'shell' as const,
        description: 'Running',
      },
    ] : []
    native.send({
      message: {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks,
        uuid: randomUUID(),
        session_id: 'native',
      },
    })
  }

  try {
    await host.hydra({
      id: 'first',
      text: 'First',
      actor: 'cli',
    })
    await settle({
      what: 'fixture did not settle',
      check: () => native.incoming.length === 1,
    })

    if (work === 'queued') {
      await host.hydra({
        id: 'second',
        text: 'Second',
        actor: 'cli',
      })
      await settle({
        what: 'fixture did not settle',
        check: () => native.incoming.length === 2,
      })
    }

    if (work === 'background') {
      background({ running: true })
    }

    let queued: number | undefined = 0

    if (work === 'queued') {
      queued = 1
    }

    if (work === 'unknown') {
      queued = undefined
    }

    const completed = {
      ...result,
      uuid: randomUUID(),
      user_message_uuid: native.incoming[0]!.uuid,
      queued_turn_count: queued,
    }

    native.send({ message: completed })
    await settle({
      what: 'fixture did not settle',
      check: () => loadHydra({ hydraId }).state.cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    assert.equal(
      native.closed(),
      false,
    )
    await host.set({
      card: HYDRA_CARD,
      setting: 'effort',
      value: 'high',
      actor: 'cli',
    })
    assert.equal(
      native.closed(),
      false,
      `${work} work must survive a rejected live setting`,
    )

    if (work === 'background') {
      background({ running: false })
    } else {
      native.send({
        message: {
          ...result,
          uuid: randomUUID(),
          user_message_uuid: native.incoming.at(-1)!.uuid,
          queued_turn_count: 0,
        },
      })
    }

    await settle({
      what: 'fixture did not settle',
      check: () => native.closed(),
    })
  } finally {
    host.close()
  }
}

await rejectedSetting({ work: 'background' })
await rejectedSetting({ work: 'queued' })
await rejectedSetting({ work: 'unknown' })
console.log('Rejected live settings retained background, queued and unknown native work until settled')
