import { INSCRIBE_SKILL } from '../src/integrations/skills/names.ts'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
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
import { loadHydra, readEvents } from '../src/store/hydra-store.ts'

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
    assert.match(
      String(digest),
      /profile: current/,
    )
    assert.doesNotMatch(
      String(digest),
      /Keep PRs small|Tests use a temporary home/,
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
      /AGENTS\.md[\s\S]*CLAUDE\.md[\s\S]*CONTRIBUTING\.md[\s\S]*\.agents\/skills[\s\S]*\.claude\/skills[\s\S]*skills\//,
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
    const saved = await f.memory()
    assert.equal(
      saved.profile,
      'current',
    )
    assert.match(
      JSON.stringify(saved.memory),
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
      new RegExp(String.raw`nearly full: load ${INSCRIBE_SKILL} with this project`),
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

    // An unknown key, blank text, and a Hydra write without a reason.
    for (const args of [
      [
        '--key',
        'other',
        '--text',
        'invalid',
      ],
      [
        '--key',
        'learnings',
        '--text',
        ' ',
        '--actor',
        'hydra',
        '--reason',
        'test',
      ],
      [
        '--key',
        'learnings',
        '--text',
        'fact',
        '--actor',
        'hydra',
      ],
    ]) {
      await assert.rejects(
        f.memory({
          args: [
            'set',
            ...args,
          ],
        }),
        { code: 'VALIDATION_ERROR' },
      )
    }
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

test(
  'standing worker notes are bounded, reasoned, audited and included in future task prompts',
  async t => {
    const f = fixture({ t })
    await project([
      'add',
      f.folder,
      '--hydra',
      'alpha',
    ])
    const notes = ({
      text,
      reason,
      id,
    }: {
      text: string
      reason?: string
      id?: string
    }) => project([
      'worker-notes',
      'set',
      '--project',
      'repo',
      '--hydra',
      'alpha',
      '--text',
      text,
      ...(reason ? [
        '--reason',
        reason,
      ] : []),
      ...(id ? [
        '--event-id',
        id,
      ] : []),
    ])
    await assert.rejects(
      notes({ text: 'Upload screenshots.' }),
      { code: 'VALIDATION_ERROR' },
    )
    await assert.rejects(
      notes({
        text: 'x'.repeat(1501),
        reason: 'Too much',
      }),
      { code: 'MEMORY_FULL' },
    )
    const text = 'Upload screenshots to pr-media.\n' + 'x'.repeat(1468)
    assert.equal(
      text.length,
      1500,
    )
    await notes({
      text,
      reason: 'Workers repeatedly ask about media',
      id: 'media-rule',
    })
    await notes({
      text,
      reason: 'Workers repeatedly ask about media',
      id: 'media-rule',
    })
    const memory = await f.memory()
    assert.equal(
      (memory.memory as Record<string, string>).workers,
      text,
    )
    const notices = () => loadHydra({ hydraId: 'alpha' }).state.hydraMessages ?? []
    assert.equal(
      notices().length,
      1,
    )
    assert.equal(
      notices()[0]!.actor,
      'pnyx',
    )
    assert.equal(
      notices()[0]!.text,
      'Standing worker instructions for repo changed: Workers repeatedly ask about media',
    )
    const saved = readFileSync(
      join(
        process.env.PNYX_HOME!,
        'projects',
        String(memory.id),
        'events.jsonl',
      ),
      'utf8',
    )
    assert.match(
      saved,
      /"key":"workers"/,
    )
    assert.match(
      saved,
      /"reason":"Workers repeatedly ask about media"/,
    )
    commands.hydra([
      'worker-notes',
      'set',
      '--hydra',
      'alpha',
      '--text',
      'Keep full links.',
      '--reason',
      'Owner preference',
    ])
    const created = await commands.task([
      'create',
      '--title',
      'Media',
      '--project',
      f.folder,
      '--hydra',
      'alpha',
    ])
    const card = loadHydra({ hydraId: 'alpha' }).state.cards[(created.card as { id: string }).id]!
    const prompt = () => taskPrompt({
      hydraId: 'alpha',
      card,
    })
    assert.ok(prompt().includes(`Keep full links.\n${text}`))
    assert.equal(
      prompt().split(text).length,
      2,
    )
    await project([
      'worker-notes',
      'forget',
      '--project',
      'repo',
      '--hydra',
      'alpha',
      '--reason',
      'No longer needed',
    ])
    assert.doesNotMatch(
      prompt(),
      /Upload screenshots/,
    )
    assert.equal(
      notices().filter(message => message.text.startsWith('Standing worker instructions for repo')).length,
      2,
    )
    assert.equal(
      notices().at(-1)!.actor,
      'pnyx',
    )
  },
)

test(
  'Hydra worker notes require a reason and respect the Hydra memory budget',
  t => {
    fixture({ t })
    const save = ({
      text,
      reason,
    }: {
      text: string
      reason?: string
    }) => commands.hydra([
      'worker-notes',
      'set',
      '--hydra',
      'alpha',
      '--text',
      text,
      ...(reason ? [
        '--reason',
        reason,
      ] : []),
    ])
    assert.throws(
      () => save({ text: 'Keep links.' }),
      { code: 'VALIDATION_ERROR' },
    )
    assert.throws(
      () => save({
        text: 'x'.repeat(1501),
        reason: 'Too much',
      }),
      { code: 'MEMORY_FULL' },
    )
    save({
      text: 'x'.repeat(1500),
      reason: 'Standing instruction',
    })
    save({
      text: 'x'.repeat(1500),
      reason: 'Unchanged',
    })
    const state = () => loadHydra({ hydraId: 'alpha' }).state
    assert.equal(
      state().hydraMemory!.workers!.text.length,
      1500,
    )
    assert.equal(
      state().hydraMessages!.length,
      1,
    )
    assert.equal(
      state().hydraMessages![0]!.text,
      'Standing worker instructions for Hydra alpha changed: Standing instruction',
    )
    const saved = readEvents({ hydraId: 'alpha' }).find(event => event.type === 'hydra.memory')
    assert.equal(
      saved?.reason,
      'Standing instruction',
    )
    assert.ok(saved?.type === 'hydra.memory')
    assert.equal(
      saved.data.key,
      'workers',
    )
    commands.hydra([
      'worker-notes',
      'forget',
      '--hydra',
      'alpha',
      '--reason',
      'Retired',
    ])
    assert.equal(
      state().hydraMemory!.workers,
      undefined,
    )
    assert.equal(
      state().hydraMessages!.length,
      2,
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
