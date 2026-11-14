import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { rows, startPnyx, until, type Hydra, type Pnyx } from './setup/pnyx.ts'
import { building, upgradeFolder } from './setup/upgrade.ts'

interface Upgrade {
  id: string
  state: string
  steps: {
    step: string
    state: string
  }[]
  failed?: string
  error?: string
  rolledBack?: boolean
  from?: string
  to?: string
}

let pnyx: Pnyx
let folder: ReturnType<typeof upgradeFolder>
let restarts = 0
const root = join(
  process.env.TMPDIR!,
  'upgrades',
)

beforeAll(async () => {
  mkdirSync(root)
  folder = upgradeFolder({ root })
  pnyx = await startPnyx({
    upgradeRoot: folder.install,
    // A real restart replaces this process; the tests restart the server themselves.
    restart: () => {
      restarts++
    },
  })
})

// The upgrades the page's chat shows for this Hydra, newest last.
const upgrades = ({ hydra }: { hydra: Hydra }) => rows<{ value: Upgrade[] }>({
  text: 'select value from hydra_values where hydra_id = $1 and key = \'upgrades\'',
  values: [hydra.id],
})[0]?.value ?? []

// The upgrade notice the page shows when origin main is ahead of the running build.
const upgradeNotice = () => rows<{ available: boolean }>({ text: 'select available from upgrade_status where id = \'current\'' })[0]

const settled = ({
  hydra,
  state,
}: {
  hydra: Hydra
  state: string
}) => until({
  what: `the upgrade to end ${state}`,
  check: () => upgrades({ hydra }).find(upgrade => upgrade.state === state),
})

const upgrade = ({ hydra }: { hydra: Hydra }) => hydra.owner({
  args: [
    'hydra',
    'send',
    '--text',
    '/upgrade',
  ],
})

test(
  'a failed install, build or data check goes back to the previous commit and its build, while Hydra keeps working',
  async () => {
    const hydra = await pnyx.hydra()
    const turn = pnyx.claude.plan({
      hydra: hydra.id,
      text: 'keep working',
      reply: 'Still here.',
      partial: 'Still',
      hold: true,
    })
    const session = await hydra.chat({ text: 'keep working' })
    const previous = folder.head()

    folder.publish({
      files: {
        'build.sh': building({
          version: 'broken',
          fail: true,
        }),
      },
      message: 'a build that fails',
    })
    await upgrade({ hydra })
    const build = await settled({
      hydra,
      state: 'failed',
    })
    expect(build).toMatchObject({
      failed: 'build',
      error: 'type error in build',
      rolledBack: true,
      from: previous,
    })
    expect(build.steps.map(step => [
      step.step,
      step.state,
    ])).toEqual([
      [
        'pull',
        'done',
      ],
      [
        'install',
        'done',
      ],
      [
        'build',
        'failed',
      ],
    ])
    expect(folder.head()).toBe(previous)
    expect(folder.built()).toBe('one')

    folder.publish({
      files: {
        'build.sh': building({
          version: 'unreadable data',
          dataExit: 1,
        }),
      },
      message: 'a build whose data check fails',
    })
    await upgrade({ hydra })
    await until({
      what: 'the data check to fail',
      check: () => upgrades({ hydra }).find(upgrade => upgrade.failed === 'data' && upgrade.state === 'failed'),
    })
    expect(folder.head()).toBe(previous)
    expect(folder.built()).toBe('one')

    folder.publish({
      files: {
        'install.sh': 'echo "lockfile out of date" >&2; exit 1\n',
        'build.sh': building({ version: 'never built' }),
      },
      message: 'an install that fails',
    })
    await upgrade({ hydra })
    const install = await until({
      what: 'the install to fail',
      check: () => upgrades({ hydra }).find(upgrade => upgrade.failed === 'install' && upgrade.state === 'failed'),
    })
    expect(install.error).toBe('lockfile out of date')
    expect(install.steps.map(step => step.step)).toEqual([
      'pull',
      'install',
    ])
    expect(folder.head()).toBe(previous)
    expect(folder.built()).toBe('one')

    expect(restarts).toBe(0)
    expect(session.closed).toBe(false)
    turn.release()
    await until({
      what: 'Hydra to finish its turn',
      check: () => session.answered === 1,
    })
    folder.publish({
      files: { 'install.sh': 'exit 0\n' },
      message: 'install works again',
    })
  },
)

test(
  'Stop during a build goes back like a failed step, and Hydra keeps running',
  async () => {
    const hydra = await pnyx.hydra()
    const previous = folder.head()
    const gate = join(
      root,
      'build-may-finish',
    )
    folder.publish({
      files: {
        'build.sh': building({
          version: 'slow',
          wait: gate,
        }),
      },
      message: 'a slow build',
    })
    await upgrade({ hydra })
    await until({
      what: 'the build to run',
      check: () => upgrades({ hydra }).at(-1)?.steps.some(step => step.step === 'build' && step.state === 'running'),
    })

    const stopped = await hydra.owner({
      args: [
        'hydra',
        'stop',
      ],
    })
    expect(stopped.stopped).toBe('upgrade')
    const result = await settled({
      hydra,
      state: 'stopped',
    })
    writeFileSync(
      gate,
      '',
    )
    expect(result.rolledBack).toBe(true)
    expect(folder.head()).toBe(previous)
    expect(folder.built()).toBe('one')
    expect(restarts).toBe(0)
  },
)

test(
  'a built upgrade waits for Hydra\'s turn to end, restarts once, and the server comes back on the new build; a message sent during the build reaches Hydra once',
  async () => {
    const hydra = await pnyx.hydra()
    const published = folder.publish({
      files: { 'build.sh': building({ version: 'two' }) },
      message: 'two',
    })
    await pnyx.restart()
    await until({
      what: 'the page to hear of the newer main',
      check: () => upgradeNotice()?.available === true,
    })
    const turn = pnyx.claude.plan({
      hydra: hydra.id,
      text: 'long task',
      reply: 'Long task done.',
      partial: 'Long',
      hold: true,
    })
    const session = await hydra.chat({ text: 'long task' })

    await upgrade({ hydra })
    await until({
      what: 'the build to finish and wait for Hydra',
      check: () => upgrades({ hydra }).at(-1)?.steps.some(step => step.step === 'data' && step.state === 'done'),
    })
    expect(restarts).toBe(0)
    expect(folder.built()).toBe('two')

    pnyx.claude.plan({
      hydra: hydra.id,
      text: 'sent during the upgrade',
      reply: 'Got it after the restart.',
    })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'sent during the upgrade',
      ],
    })
    turn.release()
    await until({
      what: 'the restart once the turn ended',
      check: () => restarts === 1,
    })
    await until({
      what: 'the chat to show the upgrade restarting',
      check: () => upgrades({ hydra }).at(-1)?.state === 'restarting',
    })

    await pnyx.restart()
    await until({
      what: 'the upgrade to finish after the restart',
      check: () => upgrades({ hydra }).at(-1)?.state === 'done',
    })
    expect(folder.head()).toBe(published)
    expect(existsSync(join(
      folder.install,
      'dist',
      'cli',
      'pnyx-axi.js',
    ))).toBe(true)
    await until({
      what: 'Hydra to get the message sent during the upgrade',
      check: () => pnyx.claude.sessions.some(s => s.env.PNYX_HYDRA === hydra.id && s.received.some(text => text.endsWith('sent during the upgrade'))),
    })
    expect(pnyx.claude.sessions.filter(s => s.env.PNYX_HYDRA === hydra.id)
      .flatMap(s => s.received)
      .filter(text => text.endsWith('sent during the upgrade'))).toHaveLength(1)
    expect(session.received.filter(text => text.endsWith('long task'))).toHaveLength(1)
    expect(restarts).toBe(1)
    await until({
      what: 'the page\'s upgrade notice to clear',
      check: () => upgradeNotice()?.available === false,
    })
  },
)

test(
  'a folder off main or with local changes is refused with every reason, and nothing is pulled',
  async () => {
    const hydra = await pnyx.hydra()
    const previous = folder.head()
    folder.publish({
      files: { 'build.sh': building({ version: 'refused' }) },
      message: 'refused',
    })
    writeFileSync(
      join(
        folder.install,
        'build.sh',
      ),
      'echo local edit\n',
    )
    await upgrade({ hydra })
    const refused = await until({
      what: 'the refusal',
      check: () => upgrades({ hydra }).find(upgrade => upgrade.state === 'refused'),
    })
    expect(refused).toMatchObject({ reasons: ['1 file with local changes: build.sh.'] })
    expect(folder.head()).toBe(previous)
  },
)
