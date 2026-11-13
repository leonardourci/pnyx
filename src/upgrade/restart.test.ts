import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { serverEnvironment, waitFor } from './restart.ts'

const saved = { ...process.env }

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in saved)) {
      delete process.env[name]
    }
  }

  Object.assign(
    process.env,
    saved,
  )
})

// What a server started from this environment would pass on to its agents.
const started = ({ env }: { env: NodeJS.ProcessEnv }) => {
  // The test itself may run inside an agent.
  delete process.env.PNYX_HOSTED
  delete process.env.PNYX_TASK
  Object.assign(
    process.env,
    env,
  )
  const result = serverEnvironment()

  return {
    login: result.CLAUDE_CONFIG_DIR,
    actor: result.PNYX_ACTOR,
    pane: result.TMUX_PANE,
    home: result.PNYX_HOME,
  }
}

test(
  'a server a worker starts does not pass on that worker\'s login, identity or terminal',
  () => {
    assert.deepEqual(
      started({
        env: {
          PNYX_ACTOR: 'worker:task-1',
          CLAUDE_CONFIG_DIR: '/accounts/other',
          TMUX_PANE: '%3',
          PNYX_HOME: '/pnyx',
        },
      }),
      {
        login: undefined,
        actor: undefined,
        pane: undefined,
        home: '/pnyx',
      },
    )
  },
)

test(
  'a server the owner starts keeps the owner\'s own login',
  () => {
    assert.equal(
      started({
        env: {
          PNYX_ACTOR: 'cli',
          CLAUDE_CONFIG_DIR: '/accounts/owner',
        },
      }).login,
      '/accounts/owner',
    )
  },
)

test(
  'restart waits while verified import progress advances, then stops waiting if it stalls',
  async t => {
    let now = 0
    t.mock.method(
      Date,
      'now',
      () => now,
    )
    let checks = 0
    const ready = await waitFor({
      timeout: 3,
      check: () => {
        now += 2

        return ++checks === 6
      },
      progress: () => String(checks),
    })
    assert.equal(
      ready,
      true,
    )
    assert.equal(
      checks,
      6,
    )
    checks = 0
    const stalled = await waitFor({
      timeout: 3,
      check: () => {
        now += 2; checks++

        return false
      },
      progress: () => 'unchanged',
    })
    assert.equal(
      stalled,
      false,
    )
    assert.equal(
      checks,
      3,
    )
  },
)
