import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { taskPrompt } from '../src/cli/start.ts'
import { workerCommands } from '../src/cli/workers.ts'
import { project } from '../src/projects/cli.ts'
import { PROJECT_MEMORY_BUDGET } from '../src/projects/memory.ts'
import { normalizedRemote, projectIdentity } from '../src/projects/sources.ts'
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
  'remote identities share across transport and keep unrelated projects separate',
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
  },
)

test(
  'two Hydras share project memory, digest it and pass project context to workers',
  async t => {
    const f = fixture({ t })
    await project([
      'add',
      f.folder,
      '--hydra',
      'alpha',
    ])
    const first = await f.memory()
    assert.equal(
      first.profile,
      'missing',
    )
    assert.equal(
      (first.sources as unknown[]).length,
      4,
    )
    await f.memory({
      args: [
        'set',
        '--key',
        'profile',
        '--text',
        'Build: pnpm build. Skills: check for validation.',
        '--sources',
        String(first.fingerprint),
      ],
    })
    await f.memory({
      args: [
        'set',
        '--key',
        'preferences',
        '--text',
        'Keep PRs small.',
      ],
    })
    await f.memory({
      args: [
        'set',
        '--key',
        'learnings',
        '--text',
        'Tests use a temporary home.',
      ],
    })
    const copy = join(
      f.root,
      'copy',
    )
    execFileSync(
      'git',
      [
        'clone',
        '--quiet',
        f.folder,
        copy,
      ],
    )
    execFileSync(
      'git',
      [
        '-C',
        copy,
        'remote',
        'set-url',
        'origin',
        'https://example.test/owner/repo',
      ],
    )
    await project([
      'add',
      copy,
      '--hydra',
      'beta',
    ])
    const second = await project([
      'memory',
      'list',
      '--project',
      copy,
      '--hydra',
      'beta',
    ])
    assert.equal(
      second.id,
      first.id,
    )
    assert.equal(
      second.profile,
      'current',
    )
    assert.deepEqual(
      second.memory,
      {
        profile: 'Build: pnpm build. Skills: check for validation.',
        preferences: 'Keep PRs small.',
        learnings: 'Tests use a temporary home.',
      },
    )
    const digest = await f.digest({ hydra: 'beta' })
    assert.equal(
      typeof digest,
      'string',
    )
    assert.match(
      String(digest),
      /profile: current/,
    )
    assert.doesNotMatch(
      String(digest),
      /Keep PRs small|Tests use a temporary home/,
    )
    assert.deepEqual(
      (await project([
        'show',
        copy,
        '--hydra',
        'beta',
      ])).memory,
      second.memory,
    )
    commands.task([
      'create',
      '--title',
      'Work',
      '--key',
      'work',
      '--project',
      copy,
      '--brief',
      'Apply .agents/skills/check/SKILL.md.',
      '--hydra',
      'beta',
    ])
    const state = loadHydra({ hydraId: 'beta' }).state
    const card = state.cards[state.keys.work!]!
    const prompt = taskPrompt({
      hydraId: 'beta',
      card,
      prompt: 'Custom instruction',
    })
    assert.match(
      prompt,
      /AGENTS\.md and CLAUDE\.md[\s\S]*skills, docs and context files/,
    )
    assert.match(
      prompt,
      /shared memory \(current\)[\s\S]*Keep PRs small/,
    )
    assert.match(
      prompt,
      /Apply \.agents\/skills\/check\/SKILL\.md[\s\S]*Custom instruction/,
    )
    const hydraMemory = commands.hydra([
      'memory',
      'list',
      '--hydra',
      'beta',
    ])
    assert.equal(
      (await hydraMemory).memory,
      'none: no Hydra memory yet',
    )
    await project([
      'remove',
      copy,
      '--hydra',
      'beta',
    ])
    assert.doesNotMatch(
      String(await f.digest({ hydra: 'beta' })),
      /Keep PRs small/,
    )
    assert.match(
      JSON.stringify((await f.memory()).memory),
      /Keep PRs small/,
    )
  },
)

test(
  'default-branch source changes invalidate only the profile, and stale refreshes are refused',
  async t => {
    const f = fixture({ t })
    await project([
      'add',
      f.folder,
      '--hydra',
      'alpha',
    ])
    const first = await f.memory()
    const saveProfile = ({ fingerprint }: { fingerprint: string }) => f.memory({
      args: [
        'set',
        '--key',
        'profile',
        '--text',
        'Build: pnpm build.',
        '--sources',
        fingerprint,
      ],
    })
    await saveProfile({ fingerprint: String(first.fingerprint) })
    await f.memory({
      args: [
        'set',
        '--key',
        'preferences',
        '--text',
        'No squash merges.',
      ],
    })
    f.git({
      args: [
        'switch',
        '-c',
        'worker',
      ],
    })
    writeFileSync(
      join(
        f.folder,
        'AGENTS.md',
      ),
      'New conventions.\n',
    )
    f.git({
      args: [
        'add',
        '.',
      ],
    })
    commitFixture({
      folder: f.folder,
      message: 'fixture: change worker conventions',
    })
    assert.equal(
      (await f.memory()).profile,
      'current',
    )
    f.git({
      args: [
        'switch',
        'main',
      ],
    })
    f.git({
      args: [
        'merge',
        '--ff-only',
        'worker',
      ],
    })
    const changed = await f.memory()
    assert.equal(
      changed.profile,
      'out of date',
    )
    assert.deepEqual(
      changed.changed,
      ['AGENTS.md'],
    )
    assert.match(
      String(await f.digest()),
      /profile: out of date/,
    )
    await assert.rejects(
      saveProfile({ fingerprint: String(first.fingerprint) }),
      { code: 'SOURCES_CHANGED' },
    )
    await saveProfile({ fingerprint: String(changed.fingerprint) })
    assert.equal(
      (await f.memory()).profile,
      'current',
    )
    assert.match(
      JSON.stringify((await f.memory()).memory),
      /No squash merges/,
    )
    rmSync(join(
      f.folder,
      '.agents',
      'skills',
      'check',
      'SKILL.md',
    ))
    writeFileSync(
      join(
        f.folder,
        'README.md',
      ),
      'Run pnpm lint.\n',
    )
    mkdirSync(
      join(
        f.folder,
        'skills',
        'new',
      ),
      { recursive: true },
    )
    writeFileSync(
      join(
        f.folder,
        'skills',
        'new',
        'SKILL.md',
      ),
      'New skill.\n',
    )
    f.git({
      args: [
        'add',
        '-A',
      ],
    })
    commitFixture({
      folder: f.folder,
      message: 'fixture: update project guidance',
    })
    assert.deepEqual(
      (await f.memory()).changed,
      [
        '.agents/skills/check/SKILL.md',
        'README.md',
        'skills/new/SKILL.md',
      ],
    )
    f.git({
      args: [
        'branch',
        '-m',
        'unrecognized',
      ],
    })
    const unavailable = await f.memory()
    assert.equal(
      unavailable.profile,
      'unavailable',
    )
    await assert.rejects(
      saveProfile({ fingerprint: String(unavailable.fingerprint) }),
      { code: 'SOURCES_CHANGED' },
    )
  },
)

test(
  'one project budget refuses growth, warns near full and preserves append-only replacements',
  async t => {
    const f = fixture({ t })
    await project([
      'add',
      f.folder,
      '--hydra',
      'alpha',
    ])
    const long = 'p'.repeat(PROJECT_MEMORY_BUDGET - 10)
    await f.memory({
      args: [
        'set',
        '--key',
        'preferences',
        '--text',
        long,
        '--event-id',
        'preference',
        '--if-revision',
        '0',
      ],
    })
    const file = join(
      process.env.PNYX_HOME!,
      'projects',
      String((await f.memory()).id),
      'events.jsonl',
    )
    const before = readFileSync(
      file,
      'utf8',
    )
    await assert.rejects(
      f.memory({
        args: [
          'set',
          '--key',
          'learnings',
          '--text',
          'x'.repeat(11),
        ],
      }),
      { code: 'MEMORY_FULL' },
    )
    assert.equal(
      readFileSync(
        file,
        'utf8',
      ),
      before,
    )
    assert.match(
      String(await f.digest()),
      /nearly full: load inscribe with this project/,
    )
    const duplicate = await f.memory({
      args: [
        'set',
        '--key',
        'preferences',
        '--text',
        'changed',
        '--event-id',
        'preference',
        '--if-revision',
        '0',
      ],
    })
    assert.equal(
      duplicate.skipped,
      'duplicate',
    )
    await assert.rejects(
      f.memory({
        args: [
          'forget',
          '--key',
          'preferences',
          '--if-revision',
          '0',
        ],
      }),
      { code: 'REVISION_CONFLICT' },
    )
    await f.memory({
      args: [
        'set',
        '--key',
        'preferences',
        '--text',
        'Short preference.',
      ],
    })
    await f.memory({
      args: [
        'forget',
        '--key',
        'preferences',
      ],
    })
    assert.ok(readFileSync(
      file,
      'utf8',
    ).startsWith(before))
    assert.equal(
      (await f.memory()).memory,
      'none: no project memory yet',
    )
    await assert.rejects(
      f.memory({
        args: [
          'set',
          '--key',
          'other',
          '--text',
          'invalid',
        ],
      }),
      { code: 'VALIDATION_ERROR' },
    )
    await assert.rejects(
      f.memory({
        args: [
          'set',
          '--key',
          'learnings',
          '--text',
          ' ',
          '--actor',
          'hydra',
          '--reason',
          'test',
        ],
      }),
      { code: 'VALIDATION_ERROR' },
    )
    await assert.rejects(
      f.memory({
        args: [
          'set',
          '--key',
          'learnings',
          '--text',
          'fact',
          '--actor',
          'hydra',
        ],
      }),
      { code: 'VALIDATION_ERROR' },
    )
  },
)

test(
  'path fallback is isolated and non-git source changes invalidate a saved profile',
  async t => {
    const f = fixture({ t })
    f.git({
      args: [
        'remote',
        'remove',
        'origin',
      ],
    })
    const local = projectIdentity({ path: f.folder })
    assert.match(
      local.identity,
      /^path:/,
    )
    const plain = join(
      f.root,
      'plain',
    )
    mkdirSync(plain)
    writeFileSync(
      join(
        plain,
        'AGENTS.md',
      ),
      'Local conventions.',
    )
    assert.notEqual(
      projectIdentity({ path: plain }).id,
      local.id,
    )
    await project([
      'add',
      plain,
      '--hydra',
      'alpha',
    ])
    const run = ({ args }: { args: string[] }) => project([
      'memory',
      ...args,
      '--project',
      plain,
      '--hydra',
      'alpha',
    ])
    const first = await run({ args: ['list'] })
    await run({
      args: [
        'set',
        '--key',
        'profile',
        '--text',
        'Local project.',
        '--sources',
        String(first.fingerprint),
      ],
    })
    writeFileSync(
      join(
        plain,
        'AGENTS.md',
      ),
      'Changed conventions.',
    )
    const changed = await run({ args: ['list'] })
    assert.equal(
      changed.profile,
      'out of date',
    )
    assert.deepEqual(
      changed.changed,
      ['AGENTS.md'],
    )
  },
)

test(
  'local remotes whose paths differ by .git keep independent project memories',
  async t => {
    const f = fixture({ t })
    const firstRemote = join(
      f.root,
      'local-remote',
    )
    const secondRemote = `${firstRemote}.git`

    for (const path of [
      firstRemote,
      secondRemote,
    ]) {
      execFileSync(
        'git',
        [
          'init',
          '--bare',
          path,
        ],
        { stdio: 'ignore' },
      )
    }

    f.git({
      args: [
        'remote',
        'set-url',
        'origin',
        firstRemote,
      ],
    })
    const copy = join(
      f.root,
      'copy',
    )
    execFileSync(
      'git',
      [
        'clone',
        '--quiet',
        f.folder,
        copy,
      ],
    )
    execFileSync(
      'git',
      [
        '-C',
        copy,
        'remote',
        'set-url',
        'origin',
        `file://${secondRemote}`,
      ],
    )
    await project([
      'add',
      f.folder,
      '--hydra',
      'alpha',
    ])
    await project([
      'add',
      copy,
      '--hydra',
      'beta',
    ])
    await f.memory({
      args: [
        'set',
        '--key',
        'preferences',
        '--text',
        'First project preference.',
      ],
    })
    const second = ({ args }: { args: string[] }) => project([
      'memory',
      ...args,
      '--project',
      copy,
      '--hydra',
      'beta',
    ])
    assert.notEqual(
      (await f.memory()).id,
      (await second({ args: ['list'] })).id,
    )
    assert.equal(
      (await second({ args: ['list'] })).memory,
      'none: no project memory yet',
    )
    await second({
      args: [
        'set',
        '--key',
        'preferences',
        '--text',
        'Second project preference.',
      ],
    })
    assert.deepEqual(
      (await f.memory()).memory,
      { preferences: 'First project preference.' },
    )
    assert.deepEqual(
      (await second({ args: ['list'] })).memory,
      { preferences: 'Second project preference.' },
    )
  },
)

test(
  'a custom remote and default branch use their symbolic HEAD for freshness',
  async t => {
    const f = fixture({ t })
    f.git({
      args: [
        'branch',
        '-m',
        'trunk',
      ],
    })
    const copy = join(
      f.root,
      'upstream-copy',
    )
    execFileSync(
      'git',
      [
        'clone',
        '--quiet',
        '--single-branch',
        '--origin',
        'upstream',
        f.folder,
        copy,
      ],
    )
    const git = ({ args }: { args: string[] }) => execFileSync(
      'git',
      [
        '-C',
        copy,
        ...args,
      ],
      { encoding: 'utf8' },
    ).trim()
    git({
      args: [
        'remote',
        'set-url',
        'upstream',
        'https://example.test/owner/repo',
      ],
    })
    await project([
      'add',
      copy,
      '--hydra',
      'alpha',
    ])
    const run = ({ args }: { args: string[] }) => project([
      'memory',
      ...args,
      '--project',
      copy,
      '--hydra',
      'alpha',
    ])
    const first = await run({ args: ['list'] })
    assert.equal(
      first.ref,
      'refs/remotes/upstream/trunk',
    )
    assert.notEqual(
      first.fingerprint,
      'unavailable',
    )
    await run({
      args: [
        'set',
        '--key',
        'profile',
        '--text',
        'Custom branch profile.',
        '--sources',
        String(first.fingerprint),
      ],
    })
    assert.equal(
      (await run({ args: ['list'] })).profile,
      'current',
    )
    writeFileSync(
      join(
        copy,
        'AGENTS.md',
      ),
      'New trunk guidance.\n',
    )
    git({
      args: [
        'add',
        '.',
      ],
    })
    commitFixture({
      folder: copy,
      message: 'fixture: change trunk conventions',
    })
    git({
      args: [
        'update-ref',
        'refs/remotes/upstream/trunk',
        'HEAD',
      ],
    })
    const changed = await run({ args: ['list'] })
    assert.equal(
      changed.profile,
      'out of date',
    )
    assert.deepEqual(
      changed.changed,
      ['AGENTS.md'],
    )
  },
)
