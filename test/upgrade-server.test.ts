import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { WebSocket } from 'ws'
import { commands } from '../src/cli/commands.ts'
import { HYDRA_CARD } from '../src/core/hydra.ts'
import type { RunningServer } from '../src/server/server.ts'
import { askHost, localToken } from '../src/server/state.ts'
import { loadHydra } from '../src/store/hydra-store.ts'
import { upgrade as upgradeCli } from '../src/upgrade/cli.ts'
import type { UpgradeStatus } from '../src/upgrade/model.ts'
import { hostObserver } from './host-observer.ts'
import { hydraSdk } from './hydra-host-fixture.ts'
import { building, upgradeRepo } from './upgrade-fixture.ts'

let server: RunningServer | undefined
let home = ''
let repo: ReturnType<typeof upgradeRepo>
let restarts = 0

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-upgrade-server-',
  )))
  process.env.PNYX_HOME = join(
    home,
    'pnyx',
  )
  process.env.CLAUDE_CONFIG_DIR = join(
    home,
    'claude',
  )
  process.env.CODEX_HOME = join(
    home,
    'codex',
  )
  process.env.PNYX_SEMANTIC = 'off'
  process.env.PNYX_GH_AXI = 'false'
  commands.hydra([
    'create',
    'lab',
    '--helper',
    'off',
  ])
  repo = upgradeRepo({ root: home })
  restarts = 0
})

afterEach(async () => {
  await server?.close()
  server = undefined
  rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
})

const {
  startServer,
  until,
} = hostObserver({ describe: () => loadHydra({ hydraId: 'lab' }).state })

const start = ({ sdk = hydraSdk() }: { sdk?: ReturnType<typeof hydraSdk> } = {}) => startServer({
  hydraId: 'lab',
  query: sdk.query,
  upgradeRoot: repo.install,
  restart: () => restarts++,
})
const upgrade = () => loadHydra({ hydraId: 'lab' }).state.upgrades?.find(operation => operation.id === 'up')
const send = ({
  text,
  id,
}: {
  text: string
  id: string
}) => commands.hydra([
  'send',
  '--hydra',
  'lab',
  '--text',
  text,
  '--event-id',
  id,
])

test(
  '/upgrade waits behind Hydra\'s running turn, holds later messages and never reaches Hydra',
  async () => {
    const sdk = hydraSdk()
    sdk.control.hold = true
    server = await start({ sdk })
    await send({
      text: 'Look at the board',
      id: 'look',
    })
    await until({ check: () => sdk.calls[0]?.raw.length === 1 })

    await send({
      text: '/upgrade',
      id: 'up',
    })
    await until({ check: () => upgrade()?.state === 'queued' })

    assert.equal(
      sdk.calls[0]!.raw.length,
      1,
    )
    assert.ok('up:hosted' in loadHydra({ hydraId: 'lab' }).state.eventIds)

    await send({
      text: 'After the upgrade',
      id: 'after',
    })
    const released = new Date().toISOString()
    sdk.control.hold = false
    sdk.release()
    await until({ check: () => sdk.calls.some(call => call.raw.some(text => text.includes('After the upgrade'))) })

    assert.equal(
      upgrade()!.state,
      'current',
    )
    assert.ok(upgrade()!.startedAt! >= released)

    await until({ check: () => loadHydra({ hydraId: 'lab' }).state.cards[HYDRA_CARD]?.sessionActivity === 'finished' })

    assert.ok(sdk.calls.flatMap(call => call.raw).every(text => !text.includes('/upgrade')))
    assert.equal(
      restarts,
      0,
    )
  },
)

test(
  'an idle Hydra\'s /upgrade restarts only after the build passes, and the new server finishes it',
  async () => {
    const to = repo.publish({
      files: { 'build.sh': building({ version: 'two' }) },
      message: 'two',
    })
    server = await start()

    await send({
      text: '/upgrade',
      id: 'up',
    })
    await until({ check: () => upgrade()?.state === 'restarting' })

    assert.equal(
      restarts,
      1,
    )
    assert.equal(
      repo.built(),
      'two',
    )
    assert.equal(
      upgrade()!.to,
      to,
    )

    await server.close()
    server = await start()
    await until({ check: () => upgrade()?.state === 'done' })

    assert.deepEqual(
      upgrade()!.steps.map(step => `${step.step}:${step.state}`),
      [
        'pull:done',
        'install:done',
        'build:done',
        'restart:done',
      ],
    )
  },
)

test(
  'a failed /upgrade goes back without restarting',
  async () => {
    const from = repo.head()
    repo.publish({
      files: { 'build.sh': 'echo "error TS2322: Type string is not assignable" >&2\nexit 2\n' },
      message: 'broken',
    })
    server = await start()

    await send({
      text: '/upgrade',
      id: 'up',
    })
    await until({ check: () => upgrade()?.state === 'failed' })

    assert.equal(
      upgrade()!.failed,
      'build',
    )
    assert.match(
      upgrade()!.error!,
      /TS2322/,
    )
    assert.equal(
      repo.head(),
      from,
    )
    assert.equal(
      restarts,
      0,
    )
  },
)

test(
  'Send now runs a queued /upgrade without waiting for Hydra\'s turn',
  async () => {
    const sdk = hydraSdk()
    sdk.control.hold = true
    server = await start({ sdk })
    await send({
      text: 'Look at the board',
      id: 'look',
    })
    await until({ check: () => sdk.calls[0]?.raw.length === 1 })
    await send({
      text: '/upgrade',
      id: 'up',
    })
    await until({ check: () => upgrade()?.state === 'queued' })

    await askHost({
      hydraId: 'lab',
      body: {
        action: 'compact',
        card: HYDRA_CARD,
        sendNow: 'up',
      },
    })
    await until({ check: () => upgrade()?.state === 'current' })

    assert.equal(
      loadHydra({ hydraId: 'lab' }).state.cards[HYDRA_CARD]?.sessionActivity,
      'working',
    )
  },
)

test(
  'a /upgrade still queued when the server stops runs on the next server',
  async () => {
    const sdk = hydraSdk()
    sdk.control.hold = true
    server = await start({ sdk })
    await send({
      text: 'Look at the board',
      id: 'look',
    })
    await until({ check: () => sdk.calls[0]?.raw.length === 1 })
    await send({
      text: '/upgrade',
      id: 'up',
    })
    await until({ check: () => upgrade()?.state === 'queued' })

    await server.close()
    server = await start()
    await until({ check: () => upgrade()?.state === 'current' })
  },
)

const heard = ({
  sdk,
  text,
}: {
  sdk: ReturnType<typeof hydraSdk>
  text: string
}) => sdk.calls.some(call => call.raw.some(raw => raw.includes(text)))
const stop = () => askHost({
  hydraId: 'lab',
  body: { action: 'stop' },
})
const buildRunning = () => upgrade()?.steps.some(step => step.step === 'build' && step.state === 'running') ?? false

test(
  'Stop goes back like a failed step, and a message sent during the upgrade reaches Hydra after it',
  async () => {
    const from = repo.head()
    repo.publish({
      files: { 'build.sh': 'echo two > built.txt\nexec sleep 30\n' },
      message: 'slow build',
    })
    const sdk = hydraSdk()
    server = await start({ sdk })
    await send({
      text: '/upgrade',
      id: 'up',
    })
    await until({ check: buildRunning })

    await send({
      text: 'Sent during the upgrade',
      id: 'during',
    })
    await until({ check: () => upgrade()?.held?.some(message => message.id === 'during') ?? false })

    assert.equal(
      heard({
        sdk,
        text: 'Sent during the upgrade',
      }),
      false,
    )

    assert.deepEqual(
      await stop(),
      { stopped: 'upgrade' },
    )
    await until({ check: () => upgrade()?.state === 'stopped' })

    assert.equal(
      upgrade()!.rolledBack,
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
      restarts,
      0,
    )

    await until({
      check: () => heard({
        sdk,
        text: 'Sent during the upgrade',
      }),
    })
    assert.deepEqual(
      upgrade()!.held,
      [],
    )
  },
)

test(
  'a message sent during an upgrade waits through the restart, which Stop cannot cut',
  async () => {
    repo.publish({
      files: { 'build.sh': `sleep 1\n${building({ version: 'two' })}` },
      message: 'two',
    })
    const sdk = hydraSdk()
    server = await start({ sdk })
    await send({
      text: '/upgrade',
      id: 'up',
    })
    await until({ check: buildRunning })
    await send({
      text: 'Sent during the upgrade',
      id: 'during',
    })
    await until({ check: () => upgrade()?.state === 'restarting' })

    assert.deepEqual(
      await stop(),
      { stopped: 'none: Pnyx is restarting after the upgrade and comes back in a few seconds' },
    )
    assert.equal(
      heard({
        sdk,
        text: 'Sent during the upgrade',
      }),
      false,
    )

    await server.close()
    const next = hydraSdk()
    server = await start({ sdk: next })
    await until({ check: () => upgrade()?.state === 'done' })
    await until({
      check: () => heard({
        sdk: next,
        text: 'Sent during the upgrade',
      }),
    })

    assert.equal(
      repo.built(),
      'two',
    )
    assert.equal(
      heard({
        sdk,
        text: 'Sent during the upgrade',
      }),
      false,
    )
  },
)

test(
  'a worker cannot run pnyx-axi upgrade',
  async () => {
    process.env.PNYX_ACTOR = 'worker:ship'

    try {
      await assert.rejects(
        upgradeCli([]),
        { code: 'OWNER_ONLY' },
      )
    } finally {
      delete process.env.PNYX_ACTOR
    }
  },
)

// The status the server sends a page that connects.
const hint = async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/hydra/lab/ws?token=${localToken()}`)
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await new Promise<UpgradeStatus>((
      resolve,
      reject,
    ) => {
      timer = setTimeout(
        () => reject(new Error('no upgrade status reached the page within 10s')),
        10_000,
      )
      ws.on(
        'message',
        data => {
          const message = JSON.parse(String(data)) as {
            type: string
            upgrade?: UpgradeStatus
          }

          if (message.type === 'upgrade') {
            resolve(message.upgrade!)
          }
        },
      )
    })
  } finally {
    clearTimeout(timer)
    ws.terminate()
  }
}

test(
  'the page hears of an upgrade only when origin main is ahead',
  async () => {
    server = await start()
    assert.equal(
      (await hint()).available,
      false,
    )
    await server.close()

    repo.publish({
      files: { 'build.sh': building({ version: 'two' }) },
      message: 'two',
    })
    server = await start()
    assert.equal(
      (await hint()).available,
      true,
    )
  },
)
