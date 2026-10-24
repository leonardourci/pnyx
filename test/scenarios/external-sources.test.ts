import assert from 'node:assert/strict'
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Card } from '../../src/core/model.ts'
import { emptyHydra, replay } from '../../src/core/reducer.ts'
import { captureResult, registerSource, commandIdentity, appendSource } from '../../src/external-sources/sources.ts'
import { steeringClaim } from '../../src/task-inbox/state.ts'
import { hydraDir, withWriter } from '../../src/store/hydra-store.ts'
import { scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()
const LISTENER_TIMEOUT_MS = 100
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
  await worker.run({
    args: [
      'task',
      'inbox',
      'ack',
      'work',
      result.message,
      ...claim,
    ],
  })
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

test(
  'capture before announcement is replayed while a held task stays held, with one actionable outcome',
  async () => {
    const s = await pnyx.scenario()
    const {
      worker,
      folder,
    } = await workerTask({ s })
    await worker.run({
      args: [
        'task',
        'status',
        'work',
        'paused',
        '--hold',
        '--note',
        'Wait for approval',
      ],
    })
    const command = fixture({
      s,
      name: 'held',
    })
    await worker.run({
      args: registration({
        id: 'held',
        command,
      }),
    })
    withWriter({
      hydraId: s.hydraId,
      fn: ({ writer }) => {
        const card = writer.state.cards[writer.state.keys.work!]!
        const registered = card.externalSources![0]!
        captureResult({
          writer,
          card,
          source: registered,
          run: 'captured-before-crash',
          outcome: 'completed',
          stdout: 'durable feedback',
          detail: 'The child completed',
          meta: {
            actor: 'pnyx',
            at: new Date().toISOString(),
          },
        })
      },
    })
    assert.equal(
      s.task({ key: 'work' }).steering,
      undefined,
    )
    await pnyx.restart()
    const result = await captured({
      s,
      id: 'held',
    })
    assert.equal(
      result.stdout,
      'durable feedback',
    )
    assert.equal(
      s.task({ key: 'work' }).status?.hold,
      true,
    )
    assert.equal(
      s.received({ cwd: folder }).some(text => text.includes(result.message)),
      false,
    )
    await until({
      what: 'one persisted held-result alert',
      check: () =>
        s.events().filter(event => event.type === 'task.source.alerted').length === 1,
    })
    await pnyx.restart()
    await s.owner({
      args: [
        'task',
        'source',
        'read',
        'work',
        'held',
      ],
    })
    assert.equal(
      s.events().filter(event => event.type === 'task.source.alerted').length,
      1,
    )
    assert.equal(
      existsSync(join(
        command.folder,
        'launches',
      )),
      false,
    )
    await handle({
      s,
      worker: s.as({ agent: await s.agent({ cwd: folder }) }),
      id: 'held',
    })
    assert.equal(
      s.task({ key: 'work' }).status?.hold,
      true,
    )
    assert.equal(
      source({
        s,
        id: 'held',
      }).state,
      'retired',
    )
  },
)

test(
  'confirmed failures restart only after explicit handling and stop at their durable run budget',
  async () => {
    const s = await pnyx.scenario()
    const { worker } = await workerTask({ s })
    const command = fixture({
      s,
      name: 'fails',
      mode: 'fail',
    })
    await worker.run({
      args: registration({
        id: 'fails',
        command,
        flags: [
          '--restart',
          'on-failure',
          '--max-runs',
          '2',
        ],
      }),
    })
    const first = await captured({
      s,
      id: 'fails',
    })
    assert.equal(
      first.outcome,
      'failed',
    )
    assert.equal(
      first.terminal,
      false,
    )
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
        id: 'fails',
      }).runs,
      1,
    )
    await handle({
      s,
      worker,
      id: 'fails',
    })
    const second = await captured({
      s,
      id: 'fails',
      count: 2,
    })
    assert.equal(
      second.outcome,
      'failed',
    )
    assert.equal(
      second.terminal,
      true,
    )
    await handle({
      s,
      worker,
      id: 'fails',
      sequence: 2,
    })
    await pnyx.restart()
    assert.equal(
      source({
        s,
        id: 'fails',
      }).state,
      'retired',
    )
    assert.equal(
      source({
        s,
        id: 'fails',
      }).runs,
      2,
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
      2,
    )
  },
)

test(
  'stopping the source or server kills its owned child and preserves a terminal unread outcome',
  async () => {
    const s = await pnyx.scenario()
    const {
      worker,
      folder,
    } = await workerTask({ s })

    for (const id of [
      'explicit-stop',
      'server-stop',
    ]) {
      const command = fixture({
        s,
        name: id,
        mode: 'wait',
      })
      await worker.run({
        args: registration({
          id,
          command,
          flags: [
            '--restart',
            'on-failure',
            '--max-runs',
            '2',
          ],
        }),
      })
      const pid = await until({
        what: 'the fixture child listening',
        check: () =>
          existsSync(join(
            command.folder,
            'ready',
          )) && Number(readFileSync(
            join(
              command.folder,
              'ready',
            ),
            'utf8',
          )),
      })

      if (id === 'explicit-stop') {
        await worker.run({
          args: [
            'task',
            'source',
            'stop',
            'work',
            id,
          ],
        })
      } else {
        await pnyx.restart()
      }

      const result = await captured({
        s,
        id,
      })
      assert.equal(
        result.outcome,
        id === 'explicit-stop' ? 'stopped' : 'interrupted',
      )
      assert.equal(
        result.terminal,
        true,
      )
      await until({
        what: 'the owned child to exit',
        check: () => {
          try {
            process.kill(
              pid,
              0,
            )

            return false
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ESRCH'
          }
        },
      })
      await handle({
        s,
        worker: s.as({ agent: await s.agent({ cwd: folder }) }),
        id,
      })
      assert.equal(
        source({
          s,
          id,
        }).runs,
        1,
      )
    }
  },
)

test(
  'invalid commands are refused and a changed executable, bounded output and lost run become explicit results',
  async () => {
    const s = await pnyx.scenario()
    const { worker } = await workerTask({ s })
    const command = fixture({
      s,
      name: 'bounds',
      mode: 'overflow',
    })
    const invalid = [
      [
        '--executable',
        '/no/such/executable',
        '--argv',
        '[]',
        '--cwd',
        command.folder,
      ],
      [
        '--executable',
        process.execPath,
        '--argv',
        '[3]',
        '--cwd',
        command.folder,
      ],
      [
        '--executable',
        process.execPath,
        '--argv',
        '"shell command"',
        '--cwd',
        command.folder,
      ],
      [
        '--executable',
        process.execPath,
        '--argv',
        '[]',
        '--cwd',
        command.folder,
        '--max-bytes',
        '1048577',
      ],
    ]

    for (const flags of invalid) {
      assert.equal(
        await worker.refused({
          args: [
            'task',
            'source',
            'register',
            'work',
            'bad',
            ...flags,
          ],
        }),
        'VALIDATION_ERROR',
      )
    }

    assert.equal(
      s.task({ key: 'work' }).externalSources,
      undefined,
    )
    await worker.run({
      args: registration({
        id: 'bounds',
        command,
        flags: [
          '--max-bytes',
          '128',
        ],
      }),
    })
    const result = await captured({
      s,
      id: 'bounds',
    })
    assert.equal(
      result.outcome,
      'overflow',
    )
    assert.equal(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
      128,
    )
    await handle({
      s,
      worker,
      id: 'bounds',
    })

    await worker.run({
      args: [
        'task',
        'status',
        'work',
        'paused',
        '--hold',
        '--note',
        'Bind first',
      ],
    })
    const executable = join(
      command.folder,
      'executable',
    )
    writeFileSync(
      executable,
      '#!/bin/sh\nprintf original',
      { mode: 0o755 },
    )
    const changedArgs = registration({
      id: 'changed',
      command,
    })
    changedArgs[changedArgs.indexOf('--executable') + 1] = executable
    await worker.run({ args: changedArgs })
    writeFileSync(
      executable,
      '#!/bin/sh\nprintf replaced',
    )
    await worker.run({
      args: [
        'task',
        'status',
        'work',
        'working',
        '--note',
        'Run bound source',
      ],
    })
    const changed = await captured({
      s,
      id: 'changed',
    })
    assert.equal(
      changed.outcome,
      'failed',
    )
    assert.equal(
      changed.stdout,
      '',
    )
    assert.match(
      changed.detail,
      /executable changed/,
    )
    await handle({
      s,
      worker,
      id: 'changed',
    })

    await worker.run({
      args: [
        'task',
        'status',
        'work',
        'paused',
        '--hold',
        '--note',
        'Recovery boundary',
      ],
    })
    await worker.run({
      args: registration({
        id: 'lost',
        command,
      }),
    })
    withWriter({
      hydraId: s.hydraId,
      fn: ({ writer }) => {
        const card = writer.state.cards[writer.state.keys.work!]!
        appendSource({
          writer,
          card,
          meta: {
            actor: 'pnyx',
            at: new Date().toISOString(),
          },
          change: {
            type: 'task.source.started',
            data: {
              source: 'lost',
              run: {
                id: 'lost-run',
                server: 'old-server',
                at: new Date().toISOString(),
              },
            },
          },
        })
      },
    })
    await pnyx.restart()
    const lost = await captured({
      s,
      id: 'lost',
    })
    assert.equal(
      lost.outcome,
      'interrupted',
    )
    assert.equal(
      lost.terminal,
      true,
    )
    assert.match(
      lost.detail,
      /verify the external job/,
    )
    assert.equal(
      source({
        s,
        id: 'lost',
      }).runs,
      1,
    )
  },
)

test(
  'an expired registration never launches and stale worker generations cannot handle its result',
  async () => {
    const s = await pnyx.scenario()
    const {
      worker,
      folder,
    } = await workerTask({ s })
    const command = fixture({
      s,
      name: 'expired',
    })
    const oldClaim = claimFlags({ card: s.task({ key: 'work' }) })
    withWriter({
      hydraId: s.hydraId,
      fn: ({ writer }) => {
        registerSource({
          writer,
          ref: 'work',
          id: 'expired',
          command: commandIdentity({
            executable: process.execPath,
            argv: command.argv,
            cwd: command.folder,
          }),
          timeoutMs: 1000,
          maxBytes: 1024,
          maxRuns: 1,
          restart: 'never',
          expiresAt: '2020-01-02T00:00:00.000Z',
          meta: {
            actor: 'cli',
            at: '2020-01-01T00:00:00.000Z',
          },
        })
      },
    })
    const result = await captured({
      s,
      id: 'expired',
    })
    assert.equal(
      result.outcome,
      'expired',
    )
    assert.equal(
      existsSync(join(
        command.folder,
        'launches',
      )),
      false,
    )
    await s.owner({
      args: [
        'task',
        'detach',
        'work',
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'work',
      ],
    })
    const replacement = s.as({ agent: await s.agent({ cwd: folder }) })
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'source',
          'read',
          'work',
          'expired',
        ],
      }),
      'STALE_CLAIM',
    )
    assert.equal(
      await replacement.refused({
        args: [
          'task',
          'source',
          'handled',
          'work',
          'expired',
          '1',
          ...oldClaim,
        ],
      }),
      'STALE_CLAIM',
    )
    await handle({
      s,
      worker: replacement,
      id: 'expired',
    })
    assert.equal(
      source({
        s,
        id: 'expired',
      }).state,
      'retired',
    )
  },
)

test(
  'an active listener is fenced by replacement and an acknowledged result can be concluded by its new worker',
  async () => {
    const s = await pnyx.scenario()
    const {
      worker,
      folder,
      agent,
    } = await workerTask({ s })
    const command = fixture({
      s,
      name: 'replace-listener',
      mode: 'wait',
    })
    await worker.run({
      args: registration({
        id: 'replace',
        command,
      }),
    })
    await until({
      what: 'the old listener running',
      check: () => existsSync(join(
        command.folder,
        'ready',
      )),
    })
    await s.owner({
      args: [
        'task',
        'detach',
        'work',
      ],
    })
    const result = await captured({
      s,
      id: 'replace',
    })
    assert.equal(
      result.outcome,
      'stale',
    )
    assert.equal(
      result.terminal,
      true,
    )
    await s.owner({
      args: [
        'task',
        'start',
        'work',
      ],
    })
    const replacementAgent = await until({
      what: 'the replacement worker',
      check: () => {
        const current = s.task({ key: 'work' })

        return current.agent?.sessionId !== agent.id && current.agent?.sessionId
      },
    })
    assert.ok(replacementAgent)
    const replacement = s.as({ agent: await s.agent({ cwd: folder }) })
    await replacement.run({
      args: [
        'task',
        'inbox',
        'ack',
        'work',
        result.message,
        ...claimFlags({ card: s.task({ key: 'work' }) }),
        '--outcome',
        'blocked',
        '--note',
        'Waiting for job confirmation',
      ],
    })
    assert.equal(
      source({
        s,
        id: 'replace',
      }).results[0]!.handled,
      undefined,
    )
    await s.owner({
      args: [
        'task',
        'detach',
        'work',
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'work',
      ],
    })
    const finalWorker = s.as({ agent: await s.agent({ cwd: folder }) })
    await finalWorker.run({
      args: [
        'task',
        'source',
        'read',
        'work',
        'replace',
      ],
    })
    await finalWorker.run({
      args: [
        'task',
        'source',
        'handled',
        'work',
        'replace',
        '1',
        ...claimFlags({ card: s.task({ key: 'work' }) }),
      ],
    })
    assert.equal(
      source({
        s,
        id: 'replace',
      }).state,
      'retired',
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
  },
)

test(
  'a listener timeout ends the source with a retained actionable result',
  async () => {
    const s = await pnyx.scenario()
    const { worker } = await workerTask({ s })
    const command = fixture({
      s,
      name: 'timeout',
      mode: 'wait',
    })
    await worker.run({
      args: registration({
        id: 'timeout',
        command,
        flags: [
          '--timeout-ms',
          String(LISTENER_TIMEOUT_MS),
        ],
      }),
    })
    const result = await captured({
      s,
      id: 'timeout',
    })
    assert.equal(
      result.outcome,
      'expired',
    )
    assert.equal(
      result.terminal,
      true,
    )
    assert.equal(
      source({
        s,
        id: 'timeout',
      }).runs,
      1,
    )
    await until({
      what: 'the timeout alert persisted',
      check: () =>
        source({
          s,
          id: 'timeout',
        }).results[0]!.alerted,
    })
    await handle({
      s,
      worker,
      id: 'timeout',
    })
    assert.equal(
      source({
        s,
        id: 'timeout',
      }).state,
      'retired',
    )
  },
)
