import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { HYDRA_CARD } from '../../src/core/hydra.ts'
import { localToken } from '../../src/server/state.ts'
import type { UpgradeStatus } from '../../src/upgrade/model.ts'
import { building } from '../../src/test-harness/upgrade-fixture.ts'
import { openPage, until } from '../../src/test-harness/harness.ts'
import { pnyx, type Scenario } from '../../src/test-harness/pnyx.ts'

// The flows share one Pnyx folder, so each publishes what it needs on top of the last.
const repo = pnyx.upgrade
// Writes the new build, then hangs until stopped.
const HANGING_BUILD = 'echo two > built.txt\nexec sleep 30\n'

const send = ({
  s,
  text,
  id,
}: {
  s: Scenario
  text: string
  id: string
}) => s.owner({
  args: [
    'hydra',
    'send',
    '--text',
    text,
    '--event-id',
    id,
  ],
})

const upgrade = ({ s }: { s: Scenario }) => s.state().upgrades?.find(operation => operation.id === 'up')

const waitFor = ({
  s,
  state,
}: {
  s: Scenario
  state: string
}) => until({
  what: `the upgrade to be ${state}`,
  check: () => upgrade({ s })?.state === state,
})

const buildRunning = ({ s }: { s: Scenario }) => until({
  what: 'the build to run',
  check: () => upgrade({ s })?.steps.some(step => step.step === 'build' && step.state === 'running'),
})

// Whether Hydra was handed this text, in any of its sessions.
const heard = ({
  s,
  text,
}: {
  s: Scenario
  text: string
}) => s.received({
  cwd: join(
    process.env.PNYX_HOME!,
    'hydras',
    s.hydraId,
    'agent',
  ),
}).some(received => received.includes(text))

const stop = ({ s }: { s: Scenario }) => s.owner({
  args: [
    'hydra',
    'stop',
  ],
})

test(
  '/upgrade waits behind Hydra\'s running turn, later messages wait behind it, and Hydra never sees it',
  async () => {
    const s = await pnyx.scenario()
    const held = pnyx.claude.plan({
      text: 'Look at the board',
      hold: true,
    })
    pnyx.claude.plan({ text: 'After the upgrade' })

    try {
      await send({
        s,
        text: 'Look at the board',
        id: 'look',
      })
      await until({
        what: 'Hydra to hear the first message',
        check: () => heard({
          s,
          text: 'Look at the board',
        }),
      })
      await send({
        s,
        text: '/upgrade',
        id: 'up',
      })
      await waitFor({
        s,
        state: 'queued',
      })
      assert.ok('up:hosted' in s.state().eventIds)

      await send({
        s,
        text: 'After the upgrade',
        id: 'after',
      })
      const released = new Date().toISOString()
      held.release()
      await until({
        what: 'Hydra to hear the message sent after /upgrade',
        check: () => heard({
          s,
          text: 'After the upgrade',
        }),
      })

      assert.equal(
        upgrade({ s })!.state,
        'current',
      )
      assert.ok(upgrade({ s })!.startedAt! >= released)
      assert.equal(
        heard({
          s,
          text: '/upgrade',
        }),
        false,
      )
    } finally {
      held.release()
    }
  },
)

test(
  'Send now runs a queued /upgrade without waiting for Hydra\'s turn',
  async () => {
    const s = await pnyx.scenario()
    const held = pnyx.claude.plan({
      text: 'Look at the board',
      hold: true,
    })

    try {
      await send({
        s,
        text: 'Look at the board',
        id: 'look',
      })
      await until({
        what: 'Hydra to start its turn',
        check: () => heard({
          s,
          text: 'Look at the board',
        }),
      })
      await send({
        s,
        text: '/upgrade',
        id: 'up',
      })
      await waitFor({
        s,
        state: 'queued',
      })

      const page = await openPage({
        port: pnyx.port(),
        hydraId: s.hydraId,
      })
      await page.command({
        name: 'compact',
        args: [
          HYDRA_CARD,
          'up',
        ],
      })
      page.close()
      await waitFor({
        s,
        state: 'current',
      })

      assert.equal(
        s.state().cards[HYDRA_CARD]?.sessionActivity,
        'working',
      )
    } finally {
      held.release()
    }
  },
)

test(
  'a /upgrade still queued when the server stops runs on the next server',
  async () => {
    const s = await pnyx.scenario()
    const held = pnyx.claude.plan({
      text: 'Look at the board',
      hold: true,
    })

    try {
      await send({
        s,
        text: 'Look at the board',
        id: 'look',
      })
      await until({
        what: 'Hydra to start its turn',
        check: () => heard({
          s,
          text: 'Look at the board',
        }),
      })
      await send({
        s,
        text: '/upgrade',
        id: 'up',
      })
      await waitFor({
        s,
        state: 'queued',
      })

      await pnyx.restart()
      await waitFor({
        s,
        state: 'current',
      })
    } finally {
      held.release()
    }
  },
)

test(
  'a failed /upgrade goes back without restarting',
  async () => {
    const s = await pnyx.scenario()
    const from = repo.head()
    const restarts = pnyx.restarts()
    repo.publish({
      files: { 'build.sh': 'echo "error TS2322: Type string is not assignable" >&2\nexit 2\n' },
      message: 'broken',
    })

    await send({
      s,
      text: '/upgrade',
      id: 'up',
    })
    await waitFor({
      s,
      state: 'failed',
    })

    assert.equal(
      upgrade({ s })!.failed,
      'build',
    )
    assert.match(
      upgrade({ s })!.error!,
      /TS2322/,
    )
    assert.equal(
      repo.head(),
      from,
    )
    assert.equal(
      pnyx.restarts(),
      restarts,
    )
  },
)

test(
  'Stop goes back like a failed step, and a message sent during the upgrade reaches Hydra after it',
  async () => {
    const s = await pnyx.scenario()
    const from = repo.head()
    const restarts = pnyx.restarts()
    repo.publish({
      files: { 'build.sh': HANGING_BUILD },
      message: 'slow build',
    })
    pnyx.claude.plan({ text: 'Sent during the upgrade' })

    await send({
      s,
      text: '/upgrade',
      id: 'up',
    })
    await buildRunning({ s })
    await send({
      s,
      text: 'Sent during the upgrade',
      id: 'during',
    })
    await until({
      what: 'the upgrade to hold the message',
      check: () => upgrade({ s })?.held?.some(message => message.id === 'during'),
    })

    assert.equal(
      heard({
        s,
        text: 'Sent during the upgrade',
      }),
      false,
    )
    assert.match(
      await stop({ s }),
      /stopped: upgrade/,
    )
    await waitFor({
      s,
      state: 'stopped',
    })

    assert.equal(
      upgrade({ s })!.rolledBack,
      true,
    )
    assert.equal(
      repo.head(),
      from,
    )
    assert.equal(
      repo.built(),
      'one',
    )
    assert.equal(
      pnyx.restarts(),
      restarts,
    )
    await until({
      what: 'Hydra to hear the held message',
      check: () => heard({
        s,
        text: 'Sent during the upgrade',
      }),
    })
    assert.deepEqual(
      upgrade({ s })!.held,
      [],
    )
  },
)

test(
  'an upgrade restarts only after the build passes, Stop cannot cut the restart, and a held message reaches the new server',
  async () => {
    const s = await pnyx.scenario()
    const restarts = pnyx.restarts()
    const to = repo.publish({
      files: { 'build.sh': `sleep 1\n${building({ version: 'two' })}` },
      message: 'two',
    })
    pnyx.claude.plan({ text: 'Sent during the upgrade' })

    await send({
      s,
      text: '/upgrade',
      id: 'up',
    })
    await buildRunning({ s })
    await send({
      s,
      text: 'Sent during the upgrade',
      id: 'during',
    })
    await waitFor({
      s,
      state: 'restarting',
    })

    assert.equal(
      pnyx.restarts(),
      restarts + 1,
    )
    assert.equal(
      repo.built(),
      'two',
    )
    assert.match(
      await stop({ s }),
      /Pnyx is restarting after the upgrade/,
    )
    assert.equal(
      heard({
        s,
        text: 'Sent during the upgrade',
      }),
      false,
    )

    await pnyx.restart()
    await waitFor({
      s,
      state: 'done',
    })
    await until({
      what: 'Hydra to hear the held message on the new server',
      check: () => heard({
        s,
        text: 'Sent during the upgrade',
      }),
    })

    assert.equal(
      upgrade({ s })!.to,
      to,
    )
    assert.deepEqual(
      upgrade({ s })!.steps.map(step => `${step.step}:${step.state}`),
      [
        'pull:done',
        'install:done',
        'build:done',
        'restart:done',
      ],
    )
  },
)

// The upgrade status the server sends a page that connects.
const hint = async ({ s }: { s: Scenario }) => {
  const ws = new WebSocket(`ws://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/ws?token=${localToken()}`)

  try {
    return await until({
      what: 'the upgrade status',
      check: (() => {
        let status: UpgradeStatus | undefined
        ws.on(
          'message',
          data => {
            const message = JSON.parse(String(data)) as {
              type: string
              upgrade?: UpgradeStatus
            }

            if (message.type === 'upgrade') {
              status = message.upgrade
            }
          },
        )

        return () => status
      })(),
    })
  } finally {
    ws.terminate()
  }
}

test(
  'the page hears of an upgrade only when origin main is ahead',
  async () => {
    const s = await pnyx.scenario()
    await pnyx.restart()
    assert.equal(
      (await hint({ s })).available,
      false,
    )

    repo.publish({
      files: { 'build.sh': building({ version: 'three' }) },
      message: 'three',
    })
    await pnyx.restart()
    assert.equal(
      (await hint({ s })).available,
      true,
    )
  },
)
