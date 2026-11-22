import { requestRestart } from '#upgrade/restart.ts'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, beforeEach, expect, test } from 'vitest'
import { startPnyx, until, type Hydra, type Pnyx } from './setup/pnyx.ts'
import { building, git, upgradeFolder } from './setup/upgrade.ts'

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

// Every test starts from the first commit, its build and no restarts, so the tests pass alone and in any order.
beforeEach(() => {
  folder.reset()
  restarts = 0
})

const upgrades = ({ hydra }: { hydra: Hydra }) => pnyx.home().scopes[hydra.id]?.state.upgrades ?? []

const upgradeNotice = () => pnyx.home().upgrade

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
  'a failed install or build goes back to the previous commit and its build, while Hydra keeps working',
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
      check: () => upgrades({ hydra }).at(-1)?.steps.some(step => step.step === 'build' && step.state === 'done'),
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
      'pnyx.js',
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
  'upgrades keep feature and detached checkouts and save local edits with a restore command',
  async () => {
    for (const mode of [
      'main',
      'feature',
      'detached',
    ]) {
      folder.reset()
      const hydra = await pnyx.hydra()
      const next = folder.publish({
        files: { 'build.sh': building({ version: mode }) },
        message: mode,
      })

      if (mode === 'feature') {
        git({
          cwd: folder.install,
          args: [
            'checkout',
            '-b',
            'feature',
          ],
        })
      } else if (mode === 'detached') {
        git({
          cwd: folder.install,
          args: [
            'checkout',
            '--detach',
          ],
        })
      }

      const local = 'echo saved local edit\n'
      const untracked = join(
        folder.install,
        'local-notes.txt',
      )
      writeFileSync(
        untracked,
        'Keep these untracked notes',
      )
      writeFileSync(
        join(
          folder.install,
          'build.sh',
        ),
        local,
      )
      await upgrade({ hydra })
      const built = await until({
        what: 'the upgrade build to settle',
        check: () => upgrades({ hydra }).find(operation => [
          'restarting',
          'failed',
          'refused',
          'current',
        ].includes(operation.state)),
      })
      expect(built.state).toBe('restarting')
      await pnyx.restart()
      const result = await settled({
        hydra,
        state: 'done',
      })
      expect(folder.head()).toBe(next)
      const notices = result.reasons?.join(' ') ?? ''
      expect(notices).toContain('git stash apply')

      if (mode !== 'main') {
        expect(notices).toContain(mode === 'detached' ? 'Detached HEAD' : 'feature')
      }

      expect(git({
        cwd: folder.install,
        args: [
          'show',
          'refs/stash:build.sh',
        ],
      })).toBe(local.trim())
      const stash = /Saved local work as ([0-9a-f]+)/.exec(notices)?.[1]
      expect(stash).toBeDefined()
      const restored = spawnSync(
        'git',
        [
          'stash',
          'apply',
          String(stash),
        ],
        {
          cwd: folder.install,
          encoding: 'utf8',
        },
      )
      expect(restored.stdout + restored.stderr).toContain('build.sh')
      expect(readFileSync(
        untracked,
        'utf8',
      )).toBe('Keep these untracked notes')
      const branch = git({
        cwd: folder.install,
        args: [
          'rev-parse',
          '--abbrev-ref',
          'HEAD',
        ],
      })
      expect(branch).toBe(mode === 'detached' ? 'HEAD' : mode)
    }
  },
)

test(
  'a built upgrade also waits while a worker on another Hydra is mid-turn, and restarts once that turn ends',
  async () => {
    const hydra = await pnyx.hydra()
    const other = await pnyx.hydra()
    const workerFolder = other.folder({ name: 'busy' })
    await other.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Long job',
        '--key',
        'busy',
        '--folder',
        workerFolder,
      ],
    })
    const turn = pnyx.claude.plan({
      hydra: other.id,
      match: ({ text }) => text.includes('<pnyx-worker'),
      reply: 'Job done.',
      partial: 'Job',
      hold: true,
    })
    await other.owner({
      args: [
        'task',
        'start',
        'busy',
      ],
    })
    const worker = await other.agent({ cwd: workerFolder })
    folder.publish({
      files: { 'build.sh': building({ version: 'three' }) },
      message: 'three',
    })

    await upgrade({ hydra })
    await until({
      what: 'the finished build to wait for the worker',
      check: () => {
        const upgrade = upgrades({ hydra }).at(-1)

        return upgrade?.state === 'waiting' && upgrade.steps.some(step => step.step === 'build' && step.state === 'done')
      },
    })
    expect(upgrades({ hydra }).at(-1)?.state).toBe('waiting')
    expect(worker.answered).toBe(0)
    expect(restarts).toBe(0)

    turn.release()
    await until({
      what: 'the restart once the worker\'s turn ended',
      check: () => restarts === 1,
    })
    expect(worker.answered).toBe(1)
  },
)

test(
  'a detached restart imports an installation path containing a fragment character',
  async () => {
    const install = join(
      root,
      'C# install',
    )
    mkdirSync(
      join(
        install,
        'dist',
        'upgrade',
      ),
      { recursive: true },
    )
    writeFileSync(
      join(
        install,
        'package.json',
      ),
      JSON.stringify({ type: 'module' }),
    )
    const marker = join(
      install,
      'restarted',
    )
    writeFileSync(
      join(
        install,
        'dist',
        'upgrade',
        'restart.js',
      ),
      `import { writeFileSync } from 'node:fs'; export function restartPnyx() { writeFileSync(${JSON.stringify(marker)}, 'restarted') }`,
    )
    await requestRestart({ root: install })
    expect(readFileSync(
      marker,
      'utf8',
    )).toBe('restarted')
  },
)
