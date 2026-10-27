import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { workerCommands } from '../src/cli/workers.ts'
import { project } from '../src/projects/cli.ts'
import { normalizedRemote } from '../src/projects/sources.ts'
import { loadHydra } from '../src/store/hydra-store.ts'

function commitFixture({
  folder,
  message,
}: {
  folder: string
  message: string
}) {
  const tree = execFileSync(
    'git',
    [
      '-C',
      folder,
      'write-tree',
    ],
    { encoding: 'utf8' },
  ).trim()
  const previous = spawnSync(
    'git',
    [
      '-C',
      folder,
      'rev-parse',
      '--verify',
      'HEAD',
    ],
    { encoding: 'utf8' },
  )
  const parents = previous.status === 0 ? `parent ${previous.stdout.trim()}\n` : ''
  const input = `tree ${tree}\n${parents}author Fixture <fixture@example.test> 0 +0000\ncommitter Fixture <fixture@example.test> 0 +0000\n\n${message}\n`
  const hash = execFileSync(
    'git',
    [
      '-C',
      folder,
      'hash-object',
      '-t',
      'commit',
      '-w',
      '--stdin',
    ],
    {
      encoding: 'utf8',
      input,
    },
  ).trim()
  execFileSync(
    'git',
    [
      '-C',
      folder,
      'update-ref',
      'HEAD',
      hash,
    ],
  )
}

function fixture({ t }: { t: TestContext }) {
  const root = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-project-memory-',
  )))
  const previous = process.env.PNYX_HOME
  process.env.PNYX_HOME = join(
    root,
    'pnyx',
  )
  process.env.PNYX_SEMANTIC = 'off'
  t.after(() => {
    if (previous === undefined) {
      delete process.env.PNYX_HOME
    } else {
      process.env.PNYX_HOME = previous
    }

    rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    )
  })
  commands.hydra([
    'create',
    'alpha',
  ])
  commands.hydra([
    'create',
    'beta',
  ])
  const folder = join(
    root,
    'repo',
  )
  mkdirSync(folder)
  const git = ({ args }: { args: string[] }) => execFileSync(
    'git',
    [
      '-C',
      folder,
      ...args,
    ],
    {
      encoding: 'utf8',
      stdio: [
        'ignore',
        'pipe',
        'pipe',
      ],
    },
  ).trim()
  git({
    args: [
      'init',
      '-b',
      'main',
    ],
  })
  writeFileSync(
    join(
      folder,
      'AGENTS.md',
    ),
    'Read the project skills.\n',
  )
  writeFileSync(
    join(
      folder,
      'CLAUDE.md',
    ),
    '@AGENTS.md\n',
  )
  writeFileSync(
    join(
      folder,
      'README.md',
    ),
    'Run pnpm test.\n',
  )
  mkdirSync(
    join(
      folder,
      '.agents',
      'skills',
      'check',
    ),
    { recursive: true },
  )
  writeFileSync(
    join(
      folder,
      '.agents',
      'skills',
      'check',
      'SKILL.md',
    ),
    'Use for checks.\n',
  )
  git({
    args: [
      'add',
      '.',
    ],
  })
  commitFixture({
    folder: folder,
    message: 'fixture: add project sources',
  })
  git({
    args: [
      'remote',
      'add',
      'origin',
      'git@example.test:owner/repo.git',
    ],
  })
  const memory = ({
    args = [],
    hydra = 'alpha',
  }: {
    args?: string[]
    hydra?: string
  } = {}) => project([
    'memory',
    ...args,
    '--project',
    'repo',
    '--hydra',
    hydra,
  ])
  const digest = ({ hydra = 'alpha' }: { hydra?: string } = {}) => workerCommands.hydra([
    'digest',
    '--hydra',
    hydra,
  ])

  return {
    root,
    folder,
    git,
    memory,
    digest,
  }
}

test(
  'remote identities share across transport and keep unrelated projects, including local paths that differ by .git, separate',
  () => {
    const normalize = ({ remote }: { remote: string }) => normalizedRemote({
      remote,
      path: '/tmp',
    })
    assert.equal(
      normalize({ remote: 'git@github.com:owner/repo.git' }),
      normalize({ remote: 'https://token@GITHUB.com/owner/repo/' }),
    )
    assert.equal(
      normalize({ remote: 'ssh://git@github.com/owner/repo.git' }),
      normalize({ remote: 'https://github.com/owner/repo' }),
    )
    assert.notEqual(
      normalize({ remote: 'https://example.test/a/repo' }),
      normalize({ remote: 'https://example.test/b/repo' }),
    )
    // A local remote is its path, so paths that differ by .git are different projects.
    assert.equal(
      normalize({ remote: '/x/local-remote' }),
      normalize({ remote: 'file:///x/local-remote' }),
    )
    assert.notEqual(
      normalize({ remote: '/x/local-remote' }),
      normalize({ remote: 'file:///x/local-remote.git' }),
    )
  },
)

for (const scope of [
  'project',
  'Hydra',
]) {
  test(
    `an ordinary ${scope} note save recovers a notice lost after the edit persisted`,
    async t => {
      const f = fixture({ t })
      await project([
        'add',
        f.folder,
        '--hydra',
        'alpha',
      ])

      const save = async () => {
        const args = [
          'worker-notes',
          'set',
          '--text',
          'Upload media.',
          '--reason',
          'Repeated media questions',
          '--hydra',
          'alpha',
        ]

        if (scope === 'project') {
          return project([
            ...args,
            '--project',
            f.folder,
          ])
        }

        return commands.hydra(args)
      }

      const writeSync = fs.writeSync
      let failNotice = true
      t.mock.method(
        fs,
        'writeSync',
        // eslint-disable-next-line pnyx/object-params -- Implements node:fs writeSync.
        (
          fd: number,
          data: Buffer,
          ...rest: []
        ) => {
          if (failNotice && String(data).includes('Standing worker instructions for')) {
            throw new Error('Notice write failed')
          }

          return writeSync(
            fd,
            data,
            ...rest,
          )
        },
      )
      syncBuiltinESMExports()

      try {
        await assert.rejects(
          save(),
          /Notice write failed/,
        )
        const state = () => loadHydra({ hydraId: 'alpha' }).state
        const documents = (await f.memory()).memory as Record<string, string>
        const notes = scope === 'project' ? documents.workers : state().hydraMemory?.workers?.text
        assert.equal(
          notes,
          'Upload media.',
        )
        assert.equal(
          state().hydraMessages?.length ?? 0,
          0,
        )
        failNotice = false
        await save()
        await save()
        const notices = state().hydraMessages!
        assert.equal(
          notices.length,
          1,
        )
        assert.equal(
          notices[0]!.actor,
          'pnyx',
        )
        assert.match(
          notices[0]!.text,
          /changed: Repeated media questions$/,
        )
      } finally {
        t.mock.restoreAll()
        syncBuiltinESMExports()
      }
    },
  )
}
