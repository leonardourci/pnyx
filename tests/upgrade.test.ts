import { requestRestart } from '#upgrade/restart.ts'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, beforeEach, expect, test } from 'vitest'
import { startOthrys, until, type Titan, type Othrys } from './setup/othrys.ts'
import { building, git, upgradeFolder } from './setup/upgrade.ts'

let othrys: Othrys
let folder: ReturnType<typeof upgradeFolder>
let restarts = 0
const root = join(
  process.env.TMPDIR!,
  'upgrades',
)

beforeAll(async () => {
  mkdirSync(root)
  folder = upgradeFolder({ root })
  othrys = await startOthrys({
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

const upgrades = ({ hydra }: { hydra: Titan }) =>
  othrys.home().scopes[hydra.id]?.state.upgrades ?? []

const upgradeNotice = () => othrys.home().upgrade

const settled = ({
  hydra,
  state,
}: {
  hydra: Titan
  state: string
}) => until({
  what: `the upgrade to end ${state}`,
  check: () => upgrades({ hydra }).find(upgrade => upgrade.state === state),
})

const upgrade = ({ hydra }: { hydra: Titan }) => hydra.owner({
  args: [
    'hydra',
    'send',
    '--text',
    '/upgrade',
  ],
})

test(
  'a failed install or build goes back to the previous commit and its build, while Titan keeps working',
  async () => {
    const hydra = await othrys.hydra()
    const turn = othrys.claude.plan({
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
      what: 'Titan to finish its turn',
      check: () => session.answered === 1,
    })
  },
)

test(
  'Stop during a build goes back like a failed step, and Titan keeps running',
  async () => {
    const hydra = await othrys.hydra()
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
  'a built upgrade waits for Titan\'s turn to end, restarts once, and the server comes back on the new build; a message sent during the build reaches Titan once',
  async () => {
    const hydra = await othrys.hydra()
    const published = folder.publish({
      files: { 'build.sh': building({ version: 'two' }) },
      message: 'two',
    })
    await othrys.restart()
    await until({
      what: 'the page to hear of the newer main',
      check: () => upgradeNotice()?.available === true,
    })
    const turn = othrys.claude.plan({
      hydra: hydra.id,
      text: 'long task',
      reply: 'Long task done.',
      partial: 'Long',
      hold: true,
    })
    const session = await hydra.chat({ text: 'long task' })

    await upgrade({ hydra })
    await until({
      what: 'the build to finish and wait for Titan',
      check: () => upgrades({ hydra }).at(-1)?.steps.some(step => step.step === 'build' && step.state === 'done'),
    })
    expect(restarts).toBe(0)
    expect(folder.built()).toBe('two')

    othrys.claude.plan({
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

    await othrys.restart()
    await until({
      what: 'the upgrade to finish after the restart',
      check: () => upgrades({ hydra }).at(-1)?.state === 'done',
    })
    expect(folder.head()).toBe(published)
    expect(existsSync(join(
      folder.install,
      'dist',
      'cli',
      'othrys.js',
    ))).toBe(true)
    await until({
      what: 'Titan to get the message sent during the upgrade',
      check: () => othrys.claude.sessions.some(s => s.env.OTHRYS_TITAN === hydra.id && s.received.some(text => text.endsWith('sent during the upgrade'))),
    })
    expect(othrys.claude.sessions.filter(s => s.env.OTHRYS_TITAN === hydra.id)
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
      const hydra = await othrys.hydra()
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
      await othrys.restart()
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
  'a built upgrade also waits while a worker on another Titan is mid-turn, and restarts once that turn ends',
  async () => {
    const hydra = await othrys.hydra()
    const other = await othrys.hydra()
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
    const turn = othrys.claude.plan({
      hydra: other.id,
      match: ({ text }) => text.includes('<othrys-worker'),
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
  'an interrupted legacy upgrade keeps its original commit and saved local work when it resumes',
  async () => {
    const hydra = await othrys.hydra()
    const previous = folder.head()
    const next = folder.publish({
      files: { 'build.sh': building({ version: 'resumed' }) },
      message: 'finish interrupted upgrade',
    })
    writeFileSync(
      join(
        folder.install,
        'build.sh',
      ),
      'echo saved local work\n',
    )
    git({
      cwd: folder.install,
      args: [
        'stash',
        'push',
        '-m',
        'saved before interrupted upgrade',
      ],
    })
    const saved = git({
      cwd: folder.install,
      args: [
        'rev-parse',
        'refs/stash',
      ],
    })
    git({
      cwd: folder.install,
      args: [
        'fetch',
        'origin',
        'main',
      ],
    })
    git({
      cwd: folder.install,
      args: [
        'merge',
        '--ff-only',
        'FETCH_HEAD',
      ],
    })
    const marker = join(
      folder.install,
      git({
        cwd: folder.install,
        args: [
          'rev-parse',
          '--git-path',
          'pnyx-upgrade-from',
        ],
      }),
    )
    writeFileSync(
      marker,
      JSON.stringify({
        from: previous,
        stashes: [saved],
      }),
    )
    expect(folder.built()).toBe('one')

    await upgrade({ hydra })
    const result = await settled({
      hydra,
      state: 'restarting',
    })
    expect(result).toMatchObject({
      from: previous,
      to: next,
    })
    expect(result.reasons?.join(' ')).toContain(`Saved local work as ${saved}`)
    expect(folder.built()).toBe('resumed')
    expect(git({
      cwd: folder.install,
      args: [
        'show',
        `${saved}:build.sh`,
      ],
    })).toBe('echo saved local work')
    expect(existsSync(marker)).toBe(false)
    await othrys.restart()
    await settled({
      hydra,
      state: 'done',
    })
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
      `import { writeFileSync } from 'node:fs'; export function restartOthrys() { writeFileSync(${JSON.stringify(marker)}, 'restarted') }`,
    )
    await requestRestart({ root: install })
    expect(readFileSync(
      marker,
      'utf8',
    )).toBe('restarted')
  },
)
