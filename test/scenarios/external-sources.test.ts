import assert from 'node:assert/strict'
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Card } from '../../src/core/model.ts'
import { emptyHydra, replay } from '../../src/core/reducer.ts'
import { steeringClaim } from '../../src/task-inbox/state.ts'
import { hydraDir } from '../../src/store/hydra-store.ts'
import { scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()
type Scenario = Awaited<ReturnType<typeof pnyx.scenario>>

const claimFlags = ({ card }: { card: Card }) => {
  const claim = steeringClaim({ card })!

  return [
    '--session',
    claim.session,
    '--generation',
    String(claim.generation),
  ]
}

async function workerTask({ s }: { s: Scenario }) {
  const folder = s.folder({ name: 'worker' })
  await s.owner({
    args: [
      'task',
      'create',
      '--key',
      'work',
      '--title',
      'Watch a job',
      '--folder',
      folder,
    ],
  })
  await s.owner({
    args: [
      'task',
      'start',
      'work',
    ],
  })
  const agent = await s.agent({ cwd: folder })
  await until({
    what: 'the opening turn to finish',
    check: () => s.task({ key: 'work' }).sessionActivity === 'finished',
  })

  return {
    folder,
    worker: s.as({ agent }),
    agent,
  }
}

function fixture({
  s,
  name,
  mode = 'output',
  payload = 'job result',
}: {
  s: Scenario
  name: string
  mode?: string
  payload?: string
}) {
  const folder = s.folder({ name })
  const script = join(
    folder,
    'source.mjs',
  )
  copyFileSync(
    join(
      import.meta.dirname,
      '../fixtures/external-sources/source.mjs',
    ),
    script,
  )

  return {
    folder,
    argv: [
      script,
      mode,
      folder,
      payload,
    ],
  }
}

function registration({
  id,
  command,
  flags = [],
}: {
  id: string
  command: ReturnType<typeof fixture>
  flags?: string[]
}) {
  return [
    'task',
    'source',
    'register',
    'work',
    id,
    '--executable',
    process.execPath,
    '--argv',
    JSON.stringify(command.argv),
    '--cwd',
    command.folder,
    ...flags,
  ]
}

const source = ({
  s,
  id,
}: {
  s: Scenario
  id: string
}) =>
  s.task({ key: 'work' }).externalSources!.find(source => source.id === id)!

async function captured({
  s,
  id,
  count = 1,
}: {
  s: Scenario
  id: string
  count?: number
}) {
  return until({
    what: `${id} result ${count} captured and queued`,
    check: () => {
      const registered = source({
        s,
        id,
      })
      const result = registered.results[count - 1]

      return result && s.task({ key: 'work' }).steering?.some(message => message.id === result.message)
      && result
    },
  })
}

async function handle({
  s,
  worker,
  id,
  sequence = 1,
}: {
  s: Scenario
  worker: ReturnType<Scenario['as']>
  id: string
  sequence?: number
}) {
  const result = source({
    s,
    id,
  }).results[sequence - 1]!
  const claim = claimFlags({ card: s.task({ key: 'work' }) })
  await worker.run({
    args: [
      'task',
      'inbox',
      'read',
      'work',
    ],
  })
  await worker.run({
    args: [
      'task',
      'source',
      'read',
      'work',
      id,
    ],
  })

  for (const message of s.task({ key: 'work' }).steering ?? []) {
    if (!message.ack) {
      await worker.run({
        args: [
          'task',
          'inbox',
          'ack',
          'work',
          message.id,
          ...claim,
        ],
      })
    }

    if (message.id === result.message) {
      break
    }
  }

  await worker.run({
    args: [
      'task',
      'source',
      'handled',
      'work',
      id,
      String(sequence),
      ...claim,
    ],
  })
}

test(
  'exact argv results survive restart, duplicate notification and replay until the worker handles them',
  async () => {
    const s = await pnyx.scenario()
    const {
      worker,
      folder,
    } = await workerTask({ s })
    const payload = 'Olá 🌊\n第二行; $(touch should-not-exist) `echo shell`\n'
    const command = fixture({
      s,
      name: 'literal',
      payload,
    })
    const args = registration({
      id: 'job',
      command,
    })
    await worker.run({ args })
    await worker.run({ args })
    const result = await captured({
      s,
      id: 'job',
    })
    assert.equal(
      result.stdout,
      payload,
    )
    assert.equal(
      result.stderr,
      'fixture diagnostic',
    )
    assert.equal(
      result.outcome,
      'completed',
    )
    assert.equal(
      source({
        s,
        id: 'job',
      }).state,
      'ended',
    )
    assert.equal(
      existsSync(join(
        command.folder,
        'should-not-exist',
      )),
      false,
    )
    await until({
      what: 'worker notified',
      check: () => s.received({ cwd: folder })
        .some(text => text.includes(result.message)),
    })
    const claim = claimFlags({ card: s.task({ key: 'work' }) })
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'source',
          'handled',
          'work',
          'job',
          '1',
          ...claim,
        ],
      }),
      'VALIDATION_ERROR',
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'task',
          'source',
          'handled',
          'work',
          'job',
          '1',
          ...claim,
        ],
      }),
      'NOT_ALLOWED',
    )
    await pnyx.restart()
    await s.owner({
      args: [
        'task',
        'source',
        'list',
        'work',
      ],
    })
    assert.equal(
      source({
        s,
        id: 'job',
      }).results.length,
      1,
    )
    assert.equal(
      source({
        s,
        id: 'job',
      }).results[0]!.handled,
      undefined,
    )
    assert.equal(
      s.task({ key: 'work' }).steering!.filter(message => message.id === result.message).length,
      1,
    )
    const resumed = s.as({ agent: await s.agent({ cwd: folder }) })
    // A pending instruction may be announced again after restart; its inbox payload stays unique.
    assert.ok(s.received({ cwd: folder }).some(text => text.includes(result.message)))
    await resumed.run({
      args: [
        'task',
        'inbox',
        'ack',
        'work',
        result.message,
        ...claimFlags({ card: s.task({ key: 'work' }) }),
      ],
    })
    await pnyx.restart()
    await until({
      what: 'acknowledged but unfinished result surfaced to Hydra',
      check: () =>
        source({
          s,
          id: 'job',
        }).results[0]!.alerted,
    })
    assert.equal(
      source({
        s,
        id: 'job',
      }).results[0]!.handled,
      undefined,
    )
    await handle({
      s,
      worker: resumed,
      id: 'job',
    })
    await handle({
      s,
      worker: resumed,
      id: 'job',
    })
    assert.equal(
      source({
        s,
        id: 'job',
      }).state,
      'retired',
    )
    assert.match(
      await resumed.run({
        args: [
          'task',
          'source',
          'read',
          'work',
          'job',
        ],
      }),
      /none: no unread/,
    )
    assert.equal(
      readFileSync(
        join(
          command.folder,
          'launches',
        ),
        'utf8',
      ).trim()
        .split('\n').length,
      1,
    )
    const events = s.events()
    rmSync(join(
      hydraDir({ hydraId: s.hydraId }),
      'snapshot.json',
    ))
    const restored = replay({
      state: emptyHydra(),
      events,
    })
    assert.deepEqual(
      restored.cards[s.task({ key: 'work' }).id]!.externalSources,
      s.task({ key: 'work' }).externalSources,
    )
  },
)
