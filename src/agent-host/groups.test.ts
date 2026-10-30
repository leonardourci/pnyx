import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { test, type TestContext } from 'node:test'
import { endGroup } from './groups.ts'

const START = 'Thu Jan 1 00:00:01 2026'
const CUTOFF = Date.parse('2026-01-01T00:00:10.900Z')
const GROUP = {
  id: 80,
  start: START,
}
const SELF = `${process.pid} 7 S ${START}\n`

function operatingSystem({
  t,
  read,
  leader = START,
  signal = () => {},
}: {
  t: TestContext
  read(): string
  leader?: string
  signal?({ pid }: { pid: number }): void
}) {
  const signals: [number, NodeJS.Signals | number | undefined][] = []
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  t.mock.method(
    childProcess,
    'execFileSync',
    // eslint-disable-next-line pnyx/object-params -- preserves the child_process API signature.
    (
      _file: string,
      args: string[],
    ) => args.includes('-p') ? leader : SELF + read(),
  )
  t.mock.method(
    process,
    'kill',
    // eslint-disable-next-line pnyx/object-params -- preserves the process signal API signature.
    (
      pid: number,
      kind?: NodeJS.Signals | number,
    ) => {
      signals.push([
        pid,
        kind,
      ])
      signal({ pid })

      return true
    },
  )
  syncBuiltinESMExports()

  return signals
}

test(
  'a missing leader start never authorizes a signal',
  async t => {
    const signals = operatingSystem({
      t,
      leader: '',
      read: () => `80 80 S\n81 80 S ${START}`,
    })
    await endGroup({
      group: GROUP,
      lastAliveAt: CUTOFF,
    })
    assert.deepEqual(
      signals,
      [],
    )
  },
)

test(
  'an unreadable process list leaves cleanup without signalling',
  async t => {
    const signals = operatingSystem({
      t,
      read: () => {
        throw new Error('ps is unreadable')
      },
    })
    await endGroup({
      group: GROUP,
      lastAliveAt: CUTOFF,
    })
    assert.deepEqual(
      signals,
      [],
    )
  },
)

test(
  'a missing last-alive cutoff never authorizes a signal',
  async t => {
    const signals = operatingSystem({
      t,
      read: () => `80 80 S ${START}`,
    })
    await endGroup({ group: GROUP })
    assert.deepEqual(
      signals,
      [],
    )
  },
)

test(
  'a group member started after the old host bound is left running',
  async t => {
    let parent = true
    const signals = operatingSystem({
      t,
      read: () => `${parent ? `80 80 S ${START}\n` : ''}81 80 S Thu Jan 1 00:00:11 2026`,
      signal: () => {
        parent = false
      },
    })
    await endGroup({
      group: GROUP,
      lastAliveAt: CUTOFF,
    })
    assert.deepEqual(
      signals,
      [
        [
          80,
          'SIGTERM',
        ],
      ],
    )
  },
)

test(
  'same-second and unreadable member starts are left running',
  async t => {
    let parent = true
    const signals = operatingSystem({
      t,
      read: () => `${parent ? `80 80 S ${START}\n` : ''}81 80 S Thu Jan 1 00:00:10 2026\n82 80 S`,
      signal: () => {
        parent = false
      },
    })
    await endGroup({
      group: GROUP,
      lastAliveAt: CUTOFF,
    })
    assert.deepEqual(
      signals,
      [
        [
          80,
          'SIGTERM',
        ],
      ],
    )
  },
)

test(
  'an old member with a gone leader is signalled by its own verified PID',
  async t => {
    let running = true
    const signals = operatingSystem({
      t,
      leader: '',
      read: () => running ? `81 80 S ${START}` : '',
      signal: () => {
        running = false
      },
    })
    await endGroup({
      group: GROUP,
      lastAliveAt: CUTOFF,
    })
    assert.deepEqual(
      signals,
      [
        [
          81,
          'SIGTERM',
        ],
      ],
    )
  },
)

test(
  'a replacement group observed before signalling is left alone',
  async t => {
    let reads = 0
    const signals = operatingSystem({
      t,
      read: () => ++reads === 1 ? `80 80 S ${START}` : '80 80 S Thu Jan 1 00:00:11 2026',
    })
    await endGroup({
      group: GROUP,
      lastAliveAt: CUTOFF,
    })
    assert.deepEqual(
      signals,
      [],
    )
  },
)
