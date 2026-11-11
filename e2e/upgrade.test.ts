import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hydraConfig } from '#hydra/config.ts'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { localToken } from '#app/server-state.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import { building, git } from '#test-harness/upgrade-fixture.ts'
import { openPage, pnyxAxi, until } from '#test-harness/harness.ts'
import { pnyx, type Scenario } from '#test-harness/pnyx.ts'

// The flows share one Pnyx folder, so each publishes what it needs on top of the last.
const repo = pnyx.upgrade
// Writes the new build, then hangs until stopped.
const HANGING_BUILD = 'echo two > built.txt\nexec sleep 30\n'
// Long enough for a built upgrade to look twice for a moment no agent is mid-turn.
const STILL_WAITING_MS = 2000

// A build that waits for its gate file, for a minute at most.
const gatedBuild = ({
  gate,
  version,
}: {
  gate: string
  version: string
}) => `n=0\nwhile [ ! -f '${gate}' ] && [ "$n" -lt 600 ]; do n=$((n+1)); sleep 0.1; done\ntest -f '${gate}' || exit 1\n${building({ version })}`

const openGate = ({ gate }: { gate: string }) => writeFileSync(
  gate,
  '',
)

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

// The scenario's latest upgrade: the one /upgrade or `pnyx-axi upgrade` asked for last.
const upgrade = ({ s }: { s: Scenario }) => s.state().upgrades?.at(-1)
// The installed commit as git abbreviates it, which the milestone line and the command's answer show.
const installed = () => git({
  cwd: repo.install,
  args: [
    'rev-parse',
    '--short=7',
    'HEAD',
  ],
})
// The chat's dividers, selected as the chat selects its messages: by the Hydra it shows.
const dividers = ({ s }: { s: Scenario }) => (s.state().hydraMessages ?? [])
  .filter(message => message.hydra === hydraConfig({ state: s.state() }).hydra.id && message.kind === 'divider')
  .map(message => message.text)

// The operations that stopped Hydra.
const operations = ({ s }: { s: Scenario }) => s.events().filter(event => event.type === 'hydra.operation')

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

// Every message Hydra was handed, in any of its sessions.
const hydraReceived = ({ s }: { s: Scenario }) => s.received({
  cwd: join(
    process.env.PNYX_HOME!,
    'hydras',
    s.hydraId,
    'agent',
  ),
})

// Whether Hydra was handed this text, in any of its sessions.
const heard = ({
  s,
  text,
}: {
  s: Scenario
  text: string
}) => hydraReceived({ s }).some(received => received.includes(text))

const stop = ({ s }: { s: Scenario }) => s.owner({
  args: [
    'hydra',
    'stop',
  ],
})

const restartNow = async ({ s }: { s: Scenario }) => {
  const page = await openPage({
    port: pnyx.port(),
    hydraId: s.hydraId,
  })

  try {
    await page.command({
      name: 'compact',
      args: [
        HYDRA_CARD,
        'up',
      ],
    })
  } finally {
    page.close()
  }
}

test(
  '/restart restarts without sending a turn to Hydra, and a message sent meanwhile reaches it in one recap after',
  async () => {
    const s = await pnyx.scenario()
    const restarts = pnyx.restarts()
    const during = `Sent during the restart. ${'Keep every word of this message. '.repeat(12)}\n[image: /tmp/during-restart.png]`
    await send({
      s,
      text: '/restart',
      id: 'up',
    })
    await waitFor({
      s,
      state: 'restarting',
    })
    await send({
      s,
      text: during,
      id: 'during',
    })
    assert.equal(
      s.state().hydraOperation?.kind,
      'restart',
    )
    assert.equal(
      pnyx.restarts(),
      restarts + 1,
    )
    assert.equal(
      heard({
        s,
        text: '/restart',
      }),
      false,
    )
    await pnyx.restart()
    await waitFor({
      s,
      state: 'done',
    })
    assert.deepEqual(
      upgrade({ s })!.steps.map(step => `${step.step}:${step.state}`),
      ['restart:done'],
    )
    await until({
      what: 'Hydra to hear the whole message in its recap on the new server',
      check: () => heard({
        s,
        text: during,
      }),
    })
    assert.equal(
      hydraReceived({ s }).filter(text => text.includes('back after a stop (Restarted)')).length,
      1,
    )
    assert.deepEqual(
      dividers({ s }),
      ['Restarted'],
    )
  },
)

test(
  'a failed /upgrade goes back without restarting or stopping Hydra',
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
    assert.deepEqual(
      operations({ s }),
      [],
    )
    assert.deepEqual(
      dividers({ s }),
      ['Upgrade failed'],
    )
  },
)

test(
  'Stop goes back like a failed step without stopping Hydra',
  async () => {
    const s = await pnyx.scenario()
    const from = repo.head()
    const built = repo.built()
    const restarts = pnyx.restarts()
    repo.publish({
      files: { 'build.sh': HANGING_BUILD },
      message: 'slow build',
    })

    await send({
      s,
      text: '/upgrade',
      id: 'up',
    })
    await buildRunning({ s })
    assert.deepEqual(
      dividers({ s }),
      ['Upgrade started'],
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
      built,
    )
    assert.equal(
      pnyx.restarts(),
      restarts,
    )
    assert.deepEqual(
      operations({ s }),
      [],
    )
    assert.deepEqual(
      dividers({ s }),
      ['Upgrade stopped'],
    )
  },
)

test(
  '/upgrade builds at once while Hydra\'s turn runs, and a message sent during the build reaches Hydra without waiting for it',
  async () => {
    const s = await pnyx.scenario()
    const gate = join(
      process.env.PNYX_HOME!,
      `build-gate-${s.hydraId}`,
    )
    repo.publish({
      files: {
        'build.sh': gatedBuild({
          gate,
          version: 'gated',
        }),
      },
      message: 'gated',
    })
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
      await buildRunning({ s })
      assert.equal(
        s.state().hydraOperation,
        undefined,
      )

      held.release()
      await send({
        s,
        text: 'Sent during the build',
        id: 'during',
      })
      await until({
        what: 'Hydra to hear the message sent during the build',
        check: () => heard({
          s,
          text: 'Sent during the build',
        }),
      })
      assert.equal(
        upgrade({ s })!.state,
        'running',
      )
      assert.equal(
        heard({
          s,
          text: '/upgrade',
        }),
        false,
      )

      openGate({ gate })
      await waitFor({
        s,
        state: 'restarting',
      })
      await pnyx.restart()
      await waitFor({
        s,
        state: 'done',
      })
    } finally {
      held.release()
      openGate({ gate })
    }
  },
)

test(
  'a built upgrade waits while a worker on another Hydra is mid-turn, then restarts when its turn ends',
  async () => {
    const s = await pnyx.scenario()
    const restarts = pnyx.restarts()
    const to = repo.publish({
      files: { 'build.sh': building({ version: 'two' }) },
      message: 'two',
    })
    // Another Hydra of the same server, with a worker mid-turn.
    const other = await pnyx.scenario()
    const folder = other.folder({ name: 'busy' })
    const job = pnyx.claude.plan({
      text: 'Run the busy job',
      hold: true,
    })

    try {
      await other.owner({
        args: [
          'task',
          'create',
          '--title',
          'Busy job',
          '--key',
          'busy',
          '--folder',
          folder,
        ],
      })
      await other.owner({
        args: [
          'task',
          'start',
          'busy',
          '--harness',
          'claude',
          '--prompt',
          'Run the busy job',
        ],
      })
      await until({
        what: 'the worker to be mid-turn',
        check: () => other.task({ key: 'busy' }).sessionActivity === 'working',
      })

      await send({
        s,
        text: '/upgrade',
        id: 'up',
      })
      await waitFor({
        s,
        state: 'waiting',
      })
      assert.ok(upgrade({ s })!.restartBy)
      await send({
        s: other,
        text: '/upgrade',
        id: 'second',
      })
      assert.deepEqual(
        upgrade({ s: other })!.reasons,
        ['Another upgrade is already running.'],
      )
      assert.equal(
        upgrade({ s })!.state,
        'waiting',
      )
      const watchedUntil = Date.now() + STILL_WAITING_MS
      await until({
        what: 'the upgrade to keep waiting while the worker is mid-turn',
        check: () => {
          assert.equal(
            upgrade({ s })!.state,
            'waiting',
          )

          return Date.now() >= watchedUntil
        },
      })
      assert.equal(
        pnyx.restarts(),
        restarts,
      )

      job.release()
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

      await pnyx.restart()
      await waitFor({
        s,
        state: 'done',
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
      assert.deepEqual(
        dividers({ s }),
        [`Upgraded to ${installed()}`],
      )
    } finally {
      job.release()
    }
  },
)

test(
  'a failed upgrade restart records the error, and a message sent during the restart reaches Hydra after it',
  async () => {
    const s = await pnyx.scenario()
    const restarts = pnyx.restarts()
    repo.publish({
      files: { 'build.sh': building({ version: 'restart-failure' }) },
      message: 'restart failure',
    })
    let refuse = () => {}
    pnyx.failRestart({
      message: 'restart refused by fixture',
      after: new Promise<void>(resolve => {
        refuse = resolve
      }),
    })

    try {
      await send({
        s,
        text: '/upgrade',
        id: 'up',
      })
      await waitFor({
        s,
        state: 'restarting',
      })
      await send({
        s,
        text: 'Sent during failed restart',
        id: 'during',
      })
      assert.equal(
        s.state().hydraOperation?.kind,
        'upgrade',
      )
      assert.equal(
        heard({
          s,
          text: 'Sent during failed restart',
        }),
        false,
      )

      refuse()
      await waitFor({
        s,
        state: 'failed',
      })
      assert.equal(
        upgrade({ s })!.failed,
        'restart',
      )
      assert.match(
        upgrade({ s })!.error!,
        /restart refused by fixture/,
      )
      assert.equal(
        pnyx.restarts(),
        restarts + 1,
      )
      await until({
        what: 'Hydra to hear the message sent during the restart',
        check: () => heard({
          s,
          text: 'Sent during failed restart',
        }),
      })
      assert.deepEqual(
        dividers({ s }),
        ['Upgrade failed'],
      )
    } finally {
      refuse()
    }
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

test(
  'Restart now restarts a built upgrade while Hydra is mid-turn, and after it Hydra resumes the cut turn once, naming the message that joined it',
  async () => {
    const s = await pnyx.scenario()
    const restarts = pnyx.restarts()
    const held = pnyx.claude.plan({
      text: 'Look first',
      hold: true,
    })
    repo.publish({
      files: { 'build.sh': building({ version: 'now' }) },
      message: 'now',
    })

    try {
      await send({
        s,
        text: 'Look first',
        id: 'look',
      })
      await until({
        what: 'Hydra to hear the first message',
        check: () => heard({
          s,
          text: 'Look first',
        }),
      })
      await send({
        s,
        text: '/upgrade',
        id: 'up',
      })
      await waitFor({
        s,
        state: 'waiting',
      })
      await send({
        s,
        text: 'Joins the running turn',
        id: 'joins',
      })
      await until({
        what: 'the message to join Hydra\'s running turn',
        check: () => 'joins:hosted' in s.state().eventIds,
      })

      await restartNow({ s })
      await waitFor({
        s,
        state: 'restarting',
      })
      assert.equal(
        pnyx.restarts(),
        restarts + 1,
      )

      await pnyx.restart()
      await waitFor({
        s,
        state: 'done',
      })
      const resume = `A Pnyx server restart cut your last turn before you answered messages seq ${s.state().eventIds.look} to ${s.state().eventIds.joins}.`
      await until({
        what: 'Hydra to resume the cut turn, naming the message that joined it',
        check: () => heard({
          s,
          text: resume,
        }),
      })
      assert.equal(
        hydraReceived({ s }).filter(text => text.includes(resume)).length,
        1,
      )
      assert.deepEqual(
        dividers({ s }),
        [`Upgraded to ${installed()}`],
      )
    } finally {
      held.release()
    }
  },
)

// `pnyx-axi upgrade` as the owner's terminal runs it; it answers once the upgrade ended.
const fromTerminal = ({
  s,
  args = [],
}: {
  s: Scenario
  args?: string[]
}) => s.owner({
  args: [
    'upgrade',
    ...args,
  ],
})

test(
  'pnyx-axi upgrade hands the upgrade to the server, whose chat shows it, and answers once the server restarted',
  async () => {
    const s = await pnyx.scenario()
    const restarts = pnyx.restarts()
    const gate = join(
      process.env.PNYX_HOME!,
      `build-gate-${s.hydraId}`,
    )
    repo.publish({
      files: {
        'build.sh': gatedBuild({
          gate,
          version: 'handed',
        }),
      },
      message: 'handed',
    })
    const answer = fromTerminal({ s })

    try {
      await buildRunning({ s })
      assert.deepEqual(
        dividers({ s }),
        ['Upgrade started'],
      )
      assert.equal(
        heard({
          s,
          text: '/upgrade',
        }),
        false,
      )

      openGate({ gate })
      await waitFor({
        s,
        state: 'restarting',
      })
      assert.equal(
        pnyx.restarts(),
        restarts + 1,
      )
      await pnyx.restart()

      const printed = await answer
      assert.match(
        printed,
        /result: Upgraded/,
      )
      assert.match(
        printed,
        new RegExp(`commit: "?${installed()}`),
      )
      assert.equal(
        upgrade({ s })!.state,
        'done',
      )
      assert.equal(
        repo.built(),
        'handed',
      )
      assert.deepEqual(
        dividers({ s }),
        [`Upgraded to ${installed()}`],
      )
    } finally {
      openGate({ gate })
      // A failed assertion above is the failure to report; the command only has to end before the next flow.
      await answer.catch(() => {})
    }
  },
)

test(
  'pnyx-axi upgrade --stop stops the server\'s upgrade, the previous build stays, and the next upgrade finishes',
  async () => {
    const s = await pnyx.scenario()
    const from = repo.head()
    const built = repo.built()
    const restarts = pnyx.restarts()
    repo.publish({
      files: { 'build.sh': HANGING_BUILD },
      message: 'slow build again',
    })
    const stopped = fromTerminal({ s })

    await buildRunning({ s })
    assert.match(
      await fromTerminal({
        s,
        args: ['--stop'],
      }),
      /stopped: upgrade/,
    )
    assert.match(
      await stopped,
      /Upgrade stopped; nothing changed/,
    )
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
      built,
    )
    assert.equal(
      pnyx.restarts(),
      restarts,
    )
    assert.deepEqual(
      dividers({ s }),
      ['Upgrade stopped'],
    )
    assert.match(
      await fromTerminal({
        s,
        args: ['--stop'],
      }),
      /stopped: "?none/,
    )

    const to = repo.publish({
      files: { 'build.sh': building({ version: 'after-stop' }) },
      message: 'after stop',
    })
    const next = fromTerminal({
      s,
      args: ['--now'],
    })

    try {
      await waitFor({
        s,
        state: 'restarting',
      })
      await pnyx.restart()
      assert.match(
        await next,
        /result: Upgraded/,
      )
      assert.equal(
        repo.head(),
        to,
      )
      assert.equal(
        repo.built(),
        'after-stop',
      )
      assert.deepEqual(
        dividers({ s }),
        [
          'Upgrade stopped',
          `Upgraded to ${installed()}`,
        ],
      )
    } finally {
      // A failed assertion above is the failure to report; the command only has to end before the next flow.
      await next.catch(() => {})
    }
  },
)

test(
  'pnyx-axi upgrade for a Hydra the server does not run is refused, and nothing is upgraded in the terminal',
  async () => {
    const from = repo.head()
    repo.publish({
      files: { 'build.sh': building({ version: 'unserved' }) },
      message: 'unserved',
    })
    const env = { ...process.env }
    delete env.PNYX_ACTOR
    const run = await pnyxAxi({
      args: [
        'upgrade',
        '--hydra',
        'no-such-hydra',
      ],
      env,
    })

    assert.match(
      run.stdout,
      /code: NOT_FOUND/,
    )
    assert.match(
      run.stdout,
      /The Pnyx server runs no Hydra no-such-hydra/,
    )
    assert.equal(
      run.status,
      1,
    )
    assert.equal(
      repo.head(),
      from,
    )
  },
)
