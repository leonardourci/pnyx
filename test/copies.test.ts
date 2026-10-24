import assert from 'node:assert/strict'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { startTask } from '../src/cli/start.ts'
import { decidePush } from '../src/core/decide.ts'
import { POOL_IDLE, settleDone } from '../src/copies/copies.ts'
import { ingestSpool } from '../src/integrations/hooks/ingest.ts'
import { project } from '../src/projects/cli.ts'
import { hydraDir, loadHydra, withWriter } from '../src/store/hydra-store.ts'

process.env.PNYX_SEMANTIC = 'off'
process.env.PNYX_GH_AXI = join(
  import.meta.dirname,
  'fixtures/github/gh-axi.sh',
)
const meta = {
  at: '2026-10-15T00:00:00Z',
  actor: 'test',
}
const ROOT = join(
  import.meta.dirname,
  '..',
)
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

const git = ({
  cwd,
  args,
}: {
  cwd: string
  args: string[]
}) =>
  execFileSync(
    'git',
    [
      '-C',
      cwd,
      ...args,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...GIT_ENV,
      },
      stdio: [
        'ignore',
        'pipe',
        'pipe',
      ],
    },
  ).trim()

async function lab({ remote = false }: { remote?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-copies-',
  )))
  process.env.PNYX_HOME = join(
    root,
    'pnyx',
  )
  const repo = join(
    root,
    'app',
  )
  mkdirSync(repo)
  git({
    cwd: repo,
    args: [
      'init',
      '-q',
      '-b',
      'main',
    ],
  })
  writeFileSync(
    join(
      repo,
      'README.md',
    ),
    'app\n',
  )
  git({
    cwd: repo,
    args: [
      'add',
      '.',
    ],
  })
  git({
    cwd: repo,
    args: [
      'commit',
      '-q',
      '-m',
      'init',
    ],
  })
  const origin = join(
    root,
    'origin.git',
  )

  if (remote) {
    git({
      cwd: root,
      args: [
        'init',
        '-q',
        '--bare',
        '-b',
        'main',
        origin,
      ],
    })
    git({
      cwd: repo,
      args: [
        'remote',
        'add',
        'origin',
        origin,
      ],
    })
    git({
      cwd: repo,
      args: [
        'push',
        '-q',
        '-u',
        'origin',
        'main',
      ],
    })
  }

  const run = ({
    args,
    hydra = 'lab',
  }: {
    args: string[]
    hydra?: string
  }) => commands[args[0] as keyof typeof commands]([
    ...args.slice(1),
    '--hydra',
    hydra,
  ])
  run({
    args: [
      'hydra',
      'create',
      'lab',
    ],
  })
  run({
    args: [
      'hydra',
      'set',
      '--command',
      'true',
    ],
  })
  await project([
    'add',
    repo,
    '--hydra',
    'lab',
  ])
  run({
    args: [
      'task',
      'create',
      '--title',
      'Fix it',
      '--key',
      'fix',
      '--project',
      'app',
    ],
  })
  const state = () => loadHydra({ hydraId: 'lab' }).state
  const task = state().keys.fix!
  const cardOf = ({ id }: { id: string }) => state().cards[id]!

  const create = ({ key }: { key: string }) => {
    run({
      args: [
        'task',
        'create',
        '--title',
        key,
        '--key',
        key,
        '--project',
        'app',
      ],
    })

    return state().keys[key]!
  }

  const start = ({ id }: { id: string }) => startTask({
    hydraId: 'lab',
    task: id,
    via: 'command',
    meta,
  })
  const done = ({ id }: { id: string }) => run({
    args: [
      'move',
      id,
      'done',
      '--actor',
      'web',
    ],
  })
  const worker = ({
    session,
    cwd,
  }: {
    session: string
    cwd: string
  }) => withWriter({
    hydraId: 'lab',
    fn: ({ writer }) => {
      const input = {
        agent: {
          provider: 'claude-code',
          sessionId: session,
          cwd,
        },
        terminal: { tty: '/dev/ttys123' },
      }
      const pushed = decidePush({
        state: writer.state,
        newCardId: `c${writer.state.seq + 1}`,
        key: session,
        input,
        meta,
      })

      if ('event' in pushed) {
        writer.append({ event: pushed.event })
      }
    },
  })
  const attach = ({
    id,
    session,
  }: {
    id: string
    session: string
  }) =>
    run({
      args: [
        'task',
        'attach',
        id,
        '--session',
        `claude-code:${session}`,
      ],
    })

  return {
    root,
    repo,
    origin,
    run,
    state,
    task,
    card: () => cardOf({ id: task }),
    cardOf,
    create,
    start,
    done,
    worker,
    attach,
  }
}

const commit = ({
  cwd,
  file,
}: {
  cwd: string
  file: string
}) => {
  writeFileSync(
    join(
      cwd,
      file,
    ),
    `${file}\n`,
  )
  git({
    cwd,
    args: [
      'add',
      '.',
    ],
  })
  git({
    cwd,
    args: [
      'commit',
      '-q',
      '-m',
      file,
    ],
  })
}

const head = ({ cwd }: { cwd: string }) => git({
  cwd,
  args: [
    'symbolic-ref',
    '--short',
    'HEAD',
  ],
})

test(
  'a start makes the task its own git worktree and later starts reuse it',
  async () => {
    const {
      repo,
      state,
      task,
      card,
    } = await lab()
    await startTask({
      hydraId: 'lab',
      task,
      via: 'command',
      meta: {
        ...meta,
        id: 's1',
      },
    })
    const copy = card().copy!
    assert.equal(
      copy.path,
      realpathSync(join(
        hydraDir({ hydraId: 'lab' }),
        'copies',
        'app-1',
      )),
    )
    assert.deepEqual(
      {
        via: copy.via,
        branch: copy.branch,
        base: copy.base,
        state: copy.state,
        project: copy.project,
      },
      {
        via: 'worktree',
        branch: `pnyx/lab-${task}`,
        base: 'main',
        state: 'active',
        project: repo,
      },
    )
    assert.equal(
      git({
        cwd: copy.path,
        args: [
          'rev-parse',
          '--abbrev-ref',
          'HEAD',
        ],
      }),
      `pnyx/lab-${task}`,
    )
    assert.equal(
      card().folder,
      copy.path,
    )
    assert.equal(
      card().launch?.folder,
      copy.path,
    )

    await startTask({
      hydraId: 'lab',
      task,
      via: 'command',
      meta: {
        ...meta,
        id: 's2',
      },
    })
    assert.equal(
      Object.values(state().cards).filter(c => c.copy).length,
      1,
    )
    assert.equal(
      card().launch?.folder,
      copy.path,
    )
  },
)

test(
  'a copy made under boards/ keeps working after its Hydra moves to hydras/',
  async () => {
    const {
      root,
      repo,
      run,
      task,
      card,
    } = await lab()
    await startTask({
      hydraId: 'lab',
      task,
      via: 'command',
      meta: {
        ...meta,
        id: 's1',
      },
    })
    const home = process.env.PNYX_HOME!
    const {
      path,
      branch,
    } = card().copy!
    writeFileSync(
      join(
        path,
        'fix.txt',
      ),
      'fixed\n',
    )
    git({
      cwd: path,
      args: [
        'add',
        '.',
      ],
    })
    git({
      cwd: path,
      args: [
        'commit',
        '-q',
        '-m',
        'fix',
      ],
    })
    git({
      cwd: repo,
      args: [
        'merge',
        '-q',
        '--ff-only',
        branch!,
      ],
    })
    const old = join(
      home,
      'boards/lab/copies',
      'app-1',
    )
    const moved = join(
      home,
      'hydras/lab/copies',
      'app-1',
    )
    // Lay the Hydra out as an older version left it, then look from a new process's view.
    renameSync(
      join(
        home,
        'hydras',
      ),
      join(
        home,
        'boards',
      ),
    )
    const log = join(
      home,
      'boards/lab/events.jsonl',
    )
    writeFileSync(
      log,
      readFileSync(
        log,
        'utf8',
      ).replaceAll(
        `${home}/hydras/`,
        `${home}/boards/`,
      ),
    )
    rmSync(join(
      home,
      'boards/lab/snapshot.json',
    ))
    git({
      cwd: repo,
      args: [
        'worktree',
        'repair',
        old,
      ],
    })
    symlinkSync(
      home,
      join(
        root,
        'later',
      ),
    )
    process.env.PNYX_HOME = join(
      root,
      'later',
    )

    assert.equal(
      card().copy?.path,
      old,
    )
    assert.equal(
      git({
        cwd: old,
        args: [
          'rev-parse',
          '--abbrev-ref',
          'HEAD',
        ],
      }),
      `pnyx/lab-${task}`,
    )
    assert.equal(
      realpathSync(join(
        home,
        'boards/lab',
      )),
      join(
        home,
        'hydras/lab',
      ),
    )
    assert.ok(git({
      cwd: repo,
      args: [
        'worktree',
        'list',
        '--porcelain',
      ],
    }).includes(`worktree ${moved}\n`))
    run({
      args: [
        'move',
        task,
        'done',
        '--actor',
        'web',
      ],
    })
    assert.equal(
      settleDone({ hydraId: 'lab' }),
      1,
    )
    assert.deepEqual(
      [
        card().copy?.state,
        card().copy?.path,
      ],
      [
        'removed',
        old,
      ],
    )
    assert.ok(existsSync(moved))
  },
)

test(
  'a released task reclaims its slot as active and reserves it before its worker attaches',
  async () => {
    const {
      task,
      card,
      cardOf,
      create,
      start,
      done,
    } = await lab()
    await start({ id: task })
    const { path } = card().copy!
    done({ id: task })
    settleDone({ hydraId: 'lab' })
    await start({ id: task })
    assert.equal(
      card().copy?.path,
      path,
    )
    assert.equal(
      card().copy?.state,
      'active',
    )
    const next = create({ key: 'next' })
    await start({ id: next })
    assert.notEqual(
      cardOf({ id: next }).copy?.path,
      path,
    )
    assert.equal(
      settleDone({ hydraId: 'lab' }),
      1,
    )
    assert.equal(
      card().copy?.state,
      'removed',
    )
  },
)

test(
  'a released task changing to a project with the same basename gets the correct repository',
  async () => {
    const {
      root,
      repo,
      task,
      card,
      start,
      done,
      run,
    } = await lab()
    await start({ id: task })
    const previous = card().copy!.path
    done({ id: task })
    settleDone({ hydraId: 'lab' })
    const other = join(
      root,
      'other',
      'app',
    )
    mkdirSync(
      other,
      { recursive: true },
    )
    git({
      cwd: other,
      args: [
        'init',
        '-q',
        '-b',
        'main',
      ],
    })
    commit({
      cwd: other,
      file: 'other-project.txt',
    })
    await project([
      'add',
      other,
      '--hydra',
      'lab',
    ])
    run({
      args: [
        'task',
        'project',
        task,
        '--project',
        other,
      ],
    })
    await start({ id: task })
    assert.notEqual(
      card().copy?.path,
      previous,
    )
    assert.equal(
      card().copy?.project,
      other,
    )
    assert.equal(
      existsSync(join(
        card().copy!.path,
        'other-project.txt',
      )),
      true,
    )
    assert.equal(
      git({
        cwd: previous,
        args: [
          'rev-parse',
          '--git-common-dir',
        ],
      }),
      join(
        repo,
        '.git',
      ),
    )
  },
)

test(
  'claim filesystem failures are reported instead of treated as busy slots',
  async t => {
    const {
      task,
      card,
      start,
    } = await lab()
    const original = fs.openSync
    t.mock.method(
      fs,
      'openSync',
      // eslint-disable-next-line pnyx/object-params -- Implements node:fs openSync.
      (
        path: fs.PathLike,
        flags: fs.OpenMode,
        mode?: fs.Mode,
      ) => {
        if (String(path).endsWith('.claim')) {
          throw Object.assign(
            new Error('disk full'),
            { code: 'ENOSPC' },
          )
        }

        return original(
          path,
          flags,
          mode,
        )
      },
    )
    syncBuiltinESMExports()

    try {
      await assert.rejects(
        start({ id: task }),
        /disk full/,
      )
      assert.equal(
        card().copy,
        undefined,
      )
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
  },
)

test(
  'an old claim owned by a live process stays reserved',
  async () => {
    const {
      task,
      card,
      cardOf,
      create,
      start,
      done,
    } = await lab()
    await start({ id: task })
    const { path } = card().copy!
    done({ id: task })
    settleDone({ hydraId: 'lab' })
    const claim = `${path}.claim`
    writeFileSync(
      claim,
      String(process.pid),
    )
    fs.utimesSync(
      claim,
      new Date(0),
      new Date(0),
    )
    const next = create({ key: 'next' })
    await start({ id: next })
    assert.notEqual(
      cardOf({ id: next }).copy?.path,
      path,
    )
    assert.equal(
      readFileSync(
        claim,
        'utf8',
      ),
      String(process.pid),
    )
  },
)

test(
  'competing starts recover a dead claim without sharing a slot',
  async () => {
    const {
      task,
      card,
      cardOf,
      create,
      start,
      done,
    } = await lab()
    await start({ id: task })
    const { path } = card().copy!
    done({ id: task })
    settleDone({ hydraId: 'lab' })
    const dead = execFileSync(
      process.execPath,
      [
        '-e',
        'process.stdout.write(String(process.pid))',
      ],
      { encoding: 'utf8' },
    )
    writeFileSync(
      `${path}.claim`,
      dead,
    )
    const ids = [
      create({ key: 'one' }),
      create({ key: 'two' }),
    ]
    const exec = promisify(execFile)
    await Promise.all(ids.map(id => exec(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { taskFolder } from './src/copies/copies.ts'; taskFolder({ hydraId: 'lab', task: ${JSON.stringify(id)}, meta: { actor: 'test', at: '2026-10-21T00:00:00Z' } })`,
      ],
      {
        cwd: ROOT,
        env: process.env,
      },
    )))
    const paths = ids.map(id => cardOf({ id }).copy!.path)
    assert.equal(
      new Set(paths).size,
      2,
    )
    assert.ok(paths.includes(path))
    assert.equal(
      existsSync(`${path}.claim`),
      false,
    )
    assert.equal(
      POOL_IDLE,
      2,
    )
  },
)

test(
  'a pooled copy starts its next branch from the fetched remote default branch',
  async () => {
    const {
      root,
      task,
      card,
      cardOf,
      create,
      start,
      done,
      origin,
    } = await lab({ remote: true })
    await start({ id: task })
    const { path } = card().copy!
    done({ id: task })
    settleDone({ hydraId: 'lab' })

    const elsewhere = join(
      root,
      'elsewhere',
    )
    git({
      cwd: root,
      args: [
        'clone',
        '-q',
        origin,
        elsewhere,
      ],
    })
    git({
      cwd: elsewhere,
      args: [
        'switch',
        '-q',
        '-c',
        'trunk',
      ],
    })
    commit({
      cwd: elsewhere,
      file: 'upstream.txt',
    })
    git({
      cwd: elsewhere,
      args: [
        'push',
        '-q',
        'origin',
        'trunk',
      ],
    })
    git({
      cwd: origin,
      args: [
        'symbolic-ref',
        'HEAD',
        'refs/heads/trunk',
      ],
    })

    const next = create({ key: 'next' })
    await start({ id: next })
    assert.equal(
      cardOf({ id: next }).copy?.base,
      'trunk',
    )
    assert.equal(
      cardOf({ id: next }).copy?.path,
      path,
    )
    assert.equal(
      git({
        cwd: path,
        args: [
          'rev-parse',
          'HEAD',
        ],
      }),
      git({
        cwd: elsewhere,
        args: [
          'rev-parse',
          'HEAD',
        ],
      }),
    )
  },
)

for (const failure of [
  'fetch',
  'default discovery',
]) {
  test(
    `a failed ${failure} keeps a pooled slot untouched instead of using a stale base`,
    async () => {
      const {
        root,
        repo,
        origin,
        task,
        card,
        cardOf,
        create,
        start,
        done,
      } = await lab({ remote: true })
      await start({ id: task })
      const {
        path,
        branch,
      } = card().copy!
      done({ id: task })
      settleDone({ hydraId: 'lab' })

      if (failure === 'fetch') {
        git({
          cwd: repo,
          args: [
            'remote',
            'set-url',
            'origin',
            join(
              root,
              'missing.git',
            ),
          ],
        })
      } else {
        git({
          cwd: origin,
          args: [
            'symbolic-ref',
            'HEAD',
            'refs/heads/missing',
          ],
        })
      }

      const next = create({ key: 'next' })
      await assert.rejects(
        start({ id: next }),
        /could not refresh.*default branch/,
      )
      assert.equal(
        head({ cwd: path }),
        branch,
      )
      assert.equal(
        cardOf({ id: next }).copy,
        undefined,
      )
      assert.equal(
        existsSync(`${path}.claim`),
        false,
      )
    },
  )
}

test(
  'a pooled copy that is dirty again is never taken',
  async () => {
    const {
      task,
      card,
      cardOf,
      create,
      start,
      done,
    } = await lab()
    await start({ id: task })
    const {
      path,
      branch,
    } = card().copy!
    done({ id: task })
    settleDone({ hydraId: 'lab' })
    assert.ok(existsSync(path))
    writeFileSync(
      join(
        path,
        'stray.txt',
      ),
      'stray\n',
    )

    const next = create({ key: 'next' })
    await start({ id: next })
    assert.notEqual(
      cardOf({ id: next }).copy?.path,
      path,
    )
    assert.equal(
      head({ cwd: path }),
      branch,
    )
    assert.ok(existsSync(join(
      path,
      'stray.txt',
    )))
  },
)

test(
  'a slot an attached worker runs in is kept past the cap, never handed to another task, and trimmed once detached',
  async () => {
    const {
      task,
      card,
      cardOf,
      create,
      start,
      done,
      worker,
      attach,
      run,
    } = await lab()
    const others = Array.from(
      { length: POOL_IDLE },
      (
        _,
        i,
      ) => create({ key: `more-${i}` }),
    )
    await start({ id: task })
    const { path } = card().copy!
    worker({
      session: 'w',
      cwd: path,
    })
    await attach({
      id: task,
      session: 'w',
    })

    for (const id of others) {
      await start({ id })
      done({ id })
    }

    settleDone({ hydraId: 'lab' })
    done({ id: task })
    settleDone({ hydraId: 'lab' })
    assert.equal(
      card().copy?.state,
      'removed',
    )
    assert.ok(existsSync(path))

    const next = create({ key: 'next' })
    await start({ id: next })
    assert.notEqual(
      cardOf({ id: next }).copy?.path,
      path,
    )
    done({ id: next })
    settleDone({ hydraId: 'lab' })
    run({
      args: [
        'task',
        'detach',
        task,
      ],
    })
    settleDone({ hydraId: 'lab' })
    const paths = new Set([
      task,
      ...others,
    ].map(id => cardOf({ id }).copy!.path))
    assert.equal(
      paths.size,
      POOL_IDLE + 1,
    )
    assert.equal(
      [...paths].filter(existsSync).length,
      POOL_IDLE,
    )
  },
)

test(
  'manual attachment keeps the worker branch and copy ownership unchanged',
  async () => {
    const {
      task,
      card,
      cardOf,
      create,
      start,
      done,
      worker,
      attach,
    } = await lab()
    await start({ id: task })
    const {
      path,
      branch,
    } = card().copy!
    worker({
      session: 'w',
      cwd: path,
    })
    await attach({
      id: task,
      session: 'w',
    })
    done({ id: task })
    settleDone({ hydraId: 'lab' })
    const next = create({ key: 'next' })
    await attach({
      id: next,
      session: 'w',
    })
    assert.equal(
      head({ cwd: path }),
      branch,
    )
    assert.equal(
      card().copy?.state,
      'removed',
    )
    assert.equal(
      cardOf({ id: next }).copy,
      undefined,
    )
    assert.equal(
      cardOf({ id: next }).agent?.cwd,
      path,
    )
    const other = create({ key: 'other' })
    await start({ id: other })
    assert.notEqual(
      cardOf({ id: other }).copy?.path,
      path,
    )
  },
)

test(
  'an unlanded or dirty copy is flagged for Hydra, and only the owner discards it',
  async () => {
    const {
      run,
      state,
      task,
      card,
    } = await lab()
    await startTask({
      hydraId: 'lab',
      task,
      via: 'command',
      meta,
    })
    const { path } = card().copy!
    writeFileSync(
      join(
        path,
        'draft.txt',
      ),
      'draft\n',
    )
    run({
      args: [
        'move',
        task,
        'done',
        '--actor',
        'web',
      ],
    })
    settleDone({ hydraId: 'lab' })
    assert.equal(
      card().copy?.state,
      'flagged',
    )
    assert.equal(
      card().copy?.reason,
      'it has uncommitted changes',
    )
    assert.match(
      state().hydraMessages!.at(-1)!.text,
      new RegExp(`copy of task ${task}.*uncommitted changes`),
    )
    assert.ok(existsSync(path))

    await assert.rejects(
      async () => run({
        args: [
          'task',
          'copy',
          task,
          'remove',
          '--safe',
          '--actor',
          'hydra',
        ],
      }),
      /uncommitted changes/,
    )
    const proposed = await run({
      args: [
        'task',
        'copy',
        task,
        'remove',
        '--discard',
        '--actor',
        'hydra',
      ],
    })
    assert.ok('confirmation' in proposed && 'help' in proposed)
    assert.equal(
      proposed.confirmation,
      'needed',
    )
    assert.match(
      JSON.stringify(proposed.help),
      /Confirm or Dismiss/,
    )
    const asked = await run({
      args: [
        'task',
        'copy',
        task,
        'remove',
        '--discard',
      ],
    }) as Record<string, unknown>
    assert.equal(
      asked.confirmation,
      'needed',
    )
    assert.ok(existsSync(path))
    await run({
      args: [
        'task',
        'copy',
        task,
        'remove',
        '--discard',
        '--confirm',
        String(asked.token),
      ],
    })
    assert.equal(
      card().copy?.state,
      'removed',
    )
    assert.equal(
      existsSync(path),
      false,
    )
  },
)

test(
  'a merged link without current-head evidence keeps a flagged copy',
  async () => {
    const {
      run,
      task,
      card,
    } = await lab()
    await startTask({
      hydraId: 'lab',
      task,
      via: 'command',
      meta,
    })
    const { path } = card().copy!
    writeFileSync(
      join(
        path,
        'fix.txt',
      ),
      'fixed\n',
    )
    git({
      cwd: path,
      args: [
        'add',
        '.',
      ],
    })
    git({
      cwd: path,
      args: [
        'commit',
        '-q',
        '-m',
        'fix',
      ],
    })
    run({
      args: [
        'move',
        task,
        'done',
        '--actor',
        'web',
      ],
    })
    settleDone({ hydraId: 'lab' })
    assert.match(
      card().copy?.reason ?? '',
      /has not landed on main/,
    )

    run({
      args: [
        'link',
        task,
        '--url',
        'https://github.com/o/app/pull/7',
        '--state',
        'merged',
      ],
    })
    await run({
      args: [
        'task',
        'copy',
        task,
        'remove',
        '--actor',
        'hydra',
      ],
    })
    assert.equal(
      card().copy?.state,
      'flagged',
    )
    assert.ok(existsSync(path))
  },
)

test(
  '--in-place works in the project folder unless another Hydra has a worker there',
  async () => {
    const {
      repo,
      run,
      task,
      card,
    } = await lab()
    run({
      args: [
        'hydra',
        'create',
        'other',
      ],
      hydra: 'other',
    })
    run({
      args: [
        'task',
        'create',
        '--title',
        'Elsewhere',
        '--key',
        'elsewhere',
      ],
      hydra: 'other',
    })
    const elsewhere = loadHydra({ hydraId: 'other' }).state.keys.elsewhere!
    const payload = JSON.stringify({
      session_id: 'other-1',
      hook_event_name: 'SessionStart',
      cwd: repo,
      prompt: 'go',
    })
    const hooked = spawnSync(
      '/bin/sh',
      [
        join(
          ROOT,
          'setup',
          'hooks',
          'pnyx-hook.sh',
        ),
        'claude',
        'SessionStart',
      ],
      {
        input: payload,
        env: {
          PATH: process.env.PATH,
          PNYX_HOME: process.env.PNYX_HOME,
          PNYX_HYDRA: 'other',
          PNYX_TASK: elsewhere,
        },
      },
    )
    assert.equal(
      hooked.status,
      0,
    )
    ingestSpool({ hydraId: 'other' })
    assert.deepEqual(
      loadHydra({ hydraId: 'other' }).state.cards[elsewhere]!.sessionIds,
      ['claude-code:other-1'],
    )

    await assert.rejects(
      startTask({
        hydraId: 'lab',
        task,
        via: 'command',
        inPlace: true,
        meta,
      }),
      /worker of Hydra other already runs/,
    )
    await assert.rejects(
      startTask({
        hydraId: 'lab',
        task,
        via: 'command',
        folder: repo,
        meta,
      }),
      /worker of Hydra other/,
    )
    assert.equal(
      card().copy,
      undefined,
    )

    run({
      args: [
        'task',
        'detach',
        elsewhere,
      ],
      hydra: 'other',
    })
    await startTask({
      hydraId: 'lab',
      task,
      via: 'command',
      inPlace: true,
      meta,
    })
    assert.equal(
      card().launch?.folder,
      repo,
    )
    assert.equal(
      card().copy,
      undefined,
    )
  },
)

test(
  'a project copy command or a command with its own folder replaces the worktree',
  async () => {
    const {
      root,
      repo,
      run,
      task,
      card,
    } = await lab()
    const made = join(
      root,
      'made',
    )
    await project([
      'set',
      'app',
      '--copy',
      `mkdir -p "${made}/$PNYX_TASK" && echo "$PNYX_PROJECT" && echo "${made}/$PNYX_TASK"`,
      '--hydra',
      'lab',
    ])
    await startTask({
      hydraId: 'lab',
      task,
      via: 'command',
      meta,
    })
    assert.deepEqual(
      {
        path: card().copy?.path,
        via: card().copy?.via,
      },
      {
        path: join(
          made,
          task,
        ),
        via: 'command',
      },
    )
    assert.equal(
      card().launch?.folder,
      join(
        made,
        task,
      ),
    )

    run({
      args: [
        'task',
        'create',
        '--title',
        'Own folder',
        '--key',
        'own',
        '--project',
        'app',
      ],
    })
    run({
      args: [
        'hydra',
        'set',
        '--command-folder',
        'own',
      ],
    })
    const own = loadHydra({ hydraId: 'lab' }).state.keys.own!
    await startTask({
      hydraId: 'lab',
      task: own,
      via: 'command',
      meta,
    })
    const card2 = loadHydra({ hydraId: 'lab' }).state.cards[own]!
    assert.equal(
      card2.launch?.folder,
      repo,
    )
    assert.equal(
      card2.copy,
      undefined,
    )
  },
)

test(
  'a deleted copy is made again on its branch, and a working agent keeps its copy in Done',
  async () => {
    const {
      run,
      task,
      card,
    } = await lab()
    await startTask({
      hydraId: 'lab',
      task,
      via: 'command',
      meta,
    })
    const {
      path,
      branch,
    } = card().copy!
    rmSync(
      path,
      {
        recursive: true,
        force: true,
      },
    )
    await startTask({
      hydraId: 'lab',
      task,
      via: 'command',
      meta,
    })
    assert.equal(
      card().copy?.path,
      path,
    )
    assert.equal(
      git({
        cwd: path,
        args: [
          'symbolic-ref',
          '--short',
          'HEAD',
        ],
      }),
      branch,
    )

    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const pushed = decidePush({
          state: writer.state,
          newCardId: `c${writer.state.seq + 1}`,
          key: card().key,
          input: { activity: 'working' },
          meta,
        })

        if ('event' in pushed) {
          writer.append({ event: pushed.event })
        }
      },
    })
    run({
      args: [
        'move',
        task,
        'done',
        '--actor',
        'web',
      ],
    })
    assert.equal(
      settleDone({ hydraId: 'lab' }),
      0,
    )
    assert.ok(existsSync(path))
  },
)

test(
  'a confirmed-safe copy whose commit is on no branch stays',
  async () => {
    const {
      task,
      card,
      run,
    } = await lab()
    await startTask({
      hydraId: 'lab',
      task,
      via: 'command',
      meta,
    })
    const { path } = card().copy!
    git({
      cwd: path,
      args: [
        'checkout',
        '-q',
        '--detach',
      ],
    })
    writeFileSync(
      join(
        path,
        'loose.txt',
      ),
      'loose\n',
    )
    git({
      cwd: path,
      args: [
        'add',
        '.',
      ],
    })
    git({
      cwd: path,
      args: [
        'commit',
        '-q',
        '-m',
        'loose',
      ],
    })
    assert.throws(
      () => run({
        args: [
          'task',
          'copy',
          task,
          'remove',
          '--safe',
          '--actor',
          'hydra',
        ],
      }),
      /unproved work/,
    )
    assert.equal(
      card().copy?.state,
      'active',
    )
    assert.ok(existsSync(path))
  },
)

test(
  'a copy from the project copy command is released, never deleted',
  async () => {
    const {
      root,
      run,
      task,
      card,
    } = await lab()
    const made = join(
      root,
      'made',
    )
    await project([
      'set',
      'app',
      '--copy',
      `mkdir -p "${made}/$PNYX_TASK" && echo "${made}/$PNYX_TASK"`,
      '--hydra',
      'lab',
    ])
    await startTask({
      hydraId: 'lab',
      task,
      via: 'command',
      meta,
    })
    run({
      args: [
        'move',
        task,
        'done',
        '--actor',
        'web',
      ],
    })
    settleDone({ hydraId: 'lab' })
    assert.equal(
      card().copy?.state,
      'flagged',
    )
    await run({
      args: [
        'task',
        'copy',
        task,
        'remove',
        '--safe',
        '--actor',
        'hydra',
      ],
    })
    assert.equal(
      card().copy?.state,
      'removed',
    )
    assert.match(
      card().copy?.reason ?? '',
      /folder stays/,
    )
    assert.ok(existsSync(join(
      made,
      task,
    )))
    await assert.rejects(
      startTask({
        hydraId: 'lab',
        task,
        via: 'command',
        folder: made,
        inPlace: true,
        meta,
      }),
      /either --folder or --in-place/,
    )
  },
)

test(
  'copy settlement proves the actual head before squash-merge cleanup and reuse',
  async t => {
    for (const outcome of [
      'landed',
      'later commit',
      'dirty',
      'untracked',
      'wrong repository',
      'wrong branch',
      'unknown',
      'queued',
      'divergent',
      'changed during proof',
    ]) {
      await t.test(
        outcome,
        async () => {
          const f = await lab({ remote: true })
          await f.start({ id: f.task })
          const copy = f.card().copy!
          const cwd = copy.path

          for (const file of [
            'first.txt',
            'second.txt',
          ]) {
            writeFileSync(
              join(
                cwd,
                file,
              ),
              `${file}\n`,
            )
            git({
              cwd,
              args: [
                'add',
                '.',
              ],
            })
            git({
              cwd,
              args: [
                'commit',
                '-qm',
                file,
              ],
            })
          }

          const head = git({
            cwd,
            args: [
              'rev-parse',
              'HEAD',
            ],
          })
          git({
            cwd,
            args: [
              'push',
              '-q',
              'origin',
              copy.branch!,
            ],
          })
          git({
            cwd: f.repo,
            args: [
              'merge',
              '--squash',
              copy.branch!,
            ],
          })
          git({
            cwd: f.repo,
            args: [
              'commit',
              '-qm',
              'squash both changes',
            ],
          })
          const merge = git({
            cwd: f.repo,
            args: [
              'rev-parse',
              'HEAD',
            ],
          })
          git({
            cwd: f.repo,
            args: [
              'push',
              '-q',
              'origin',
              'main',
            ],
          })
          git({
            cwd,
            args: [
              'push',
              '-q',
              'origin',
              '--delete',
              copy.branch!,
            ],
          })
          const origin = join(
            f.root,
            'origin.git',
          )
          git({
            cwd: f.repo,
            args: [
              'config',
              `url.${origin}.insteadOf`,
              'https://github.com/example/app.git',
            ],
          })
          git({
            cwd: f.repo,
            args: [
              'remote',
              'set-url',
              'origin',
              'https://github.com/example/app.git',
            ],
          })

          if (outcome === 'later commit' || outcome === 'divergent') {
            if (outcome === 'divergent') {
              git({
                cwd,
                args: [
                  'reset',
                  '--hard',
                  'HEAD~1',
                ],
              })
            }

            writeFileSync(
              join(
                cwd,
                'local.txt',
              ),
              'keep this local work\n',
            )
            git({
              cwd,
              args: [
                'add',
                '.',
              ],
            })
            git({
              cwd,
              args: [
                'commit',
                '-qm',
                'local work after the merged head',
              ],
            })
          }

          if (outcome === 'dirty') {
            writeFileSync(
              join(
                cwd,
                'first.txt',
              ),
              'uncommitted tracked work\n',
            )
          }

          if (outcome === 'untracked') {
            writeFileSync(
              join(
                cwd,
                'draft.txt',
              ),
              'untracked work\n',
            )
          }

          let current = git({
            cwd,
            args: [
              'rev-parse',
              'HEAD',
            ],
          })
          const status = git({
            cwd,
            args: [
              'status',
              '--porcelain',
            ],
          })
          const response = join(
            f.root,
            'landing.toon',
          )
          const gh = join(
            f.root,
            'gh-axi',
          )
          const branch = outcome === 'wrong branch' ? 'another-branch' : copy.branch!
          const merged = outcome !== 'queued'
          writeFileSync(
            response,
            outcome === 'unknown' ? 'api_response:\n  body: unreadable\n'
              : `api_response:\n  body: "${head} ${merge} ${merged} ${branch} main"\n`,
          )
          let concurrentWorker = ''

          if (outcome === 'changed during proof') {
            concurrentWorker = `printf 'concurrent work\\n' > '${cwd}/concurrent.txt'\ngit -C '${cwd}' add .\nGIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.com GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.com git -C '${cwd}' commit -qm 'concurrent worker'\n`
          }

          writeFileSync(
            gh,
            `#!/bin/sh\n${concurrentWorker}cat '${response}'\n`,
            { mode: 0o755 },
          )
          const previousGh = process.env.PNYX_GH_AXI
          process.env.PNYX_GH_AXI = gh

          try {
            const repository = outcome === 'wrong repository' ? 'another/app' : 'example/app'
            f.run({
              args: [
                'link',
                f.task,
                '--url',
                `https://github.com/${repository}/pull/7`,
                '--state',
                'merged',
              ],
            })
            f.done({ id: f.task })
            settleDone({ hydraId: 'lab' })

            if (outcome === 'changed during proof') {
              const changedHead = git({
                cwd,
                args: [
                  'rev-parse',
                  'HEAD',
                ],
              })
              assert.notEqual(
                changedHead,
                current,
              )
              current = changedHead
              assert.equal(
                readFileSync(
                  join(
                    cwd,
                    'concurrent.txt',
                  ),
                  'utf8',
                ),
                'concurrent work\n',
              )
            }

            assert.equal(
              f.card().copy?.state,
              outcome === 'landed' ? 'removed' : 'flagged',
            )
            assert.ok(existsSync(cwd))
            assert.equal(
              git({
                cwd,
                args: [
                  'rev-parse',
                  'HEAD',
                ],
              }),
              current,
            )
            assert.equal(
              git({
                cwd,
                args: [
                  'status',
                  '--porcelain',
                ],
              }),
              status,
            )
            assert.equal(
              git({
                cwd,
                args: [
                  'cat-file',
                  '-t',
                  head,
                ],
              }),
              'commit',
            )

            if (outcome !== 'landed') {
              assert.throws(
                () => f.run({
                  args: [
                    'task',
                    'copy',
                    f.task,
                    'remove',
                    '--safe',
                    '--actor',
                    'hydra',
                  ],
                }),
                /unproved work/,
              )
            }

            const next = f.create({ key: 'follow-up' })
            await f.start({ id: next })
            assert.equal(
              f.cardOf({ id: next }).copy?.path === cwd,
              outcome === 'landed',
            )
            assert.equal(
              git({
                cwd: f.repo,
                args: [
                  'rev-parse',
                  copy.branch!,
                ],
              }),
              current,
            )
          } finally {
            process.env.PNYX_GH_AXI = previousGh
          }
        },
      )
    }
  },
)

test(
  'a commit added after release is flagged again before a pool slot can be reused',
  async () => {
    const f = await lab()
    await f.start({ id: f.task })
    const copy = f.card().copy!
    f.done({ id: f.task })
    settleDone({ hydraId: 'lab' })
    assert.equal(
      f.card().copy?.state,
      'removed',
    )
    writeFileSync(
      join(
        copy.path,
        'after-release.txt',
      ),
      'keep after release\n',
    )
    git({
      cwd: copy.path,
      args: [
        'add',
        '.',
      ],
    })
    git({
      cwd: copy.path,
      args: [
        'commit',
        '-qm',
        'unlanded after release',
      ],
    })
    const head = git({
      cwd: copy.path,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })
    const next = f.create({ key: 'next' })
    await f.start({ id: next })
    assert.equal(
      f.card().copy?.state,
      'flagged',
    )
    assert.notEqual(
      f.cardOf({ id: next }).copy?.path,
      copy.path,
    )
    assert.equal(
      git({
        cwd: copy.path,
        args: [
          'rev-parse',
          'HEAD',
        ],
      }),
      head,
    )
    assert.equal(
      readFileSync(
        join(
          copy.path,
          'after-release.txt',
        ),
        'utf8',
      ),
      'keep after release\n',
    )
  },
)
