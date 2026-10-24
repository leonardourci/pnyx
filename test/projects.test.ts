import { commandTimeout } from '../web/src/hydra/connection.ts'
import { CLONE_TIMEOUT_MS } from '../src/projects/limits.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { hydraCheck } from '../src/cli/workers.ts'
import { hydraEvent } from '../src/core/hydra.ts'
import { firstmateProjects } from '../src/integrations/firstmate/projects.ts'
import { project } from '../src/projects/cli.ts'
import { findProject, projectsFor } from '../src/projects/read.ts'
import { listHydras } from '../src/server/hydras.ts'
import { loadHydra, readEvents, withWriter } from '../src/store/hydra-store.ts'

process.env.PNYX_SEMANTIC = 'off'

function fixture() {
  const root = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-projects-',
  )))
  process.env.PNYX_HOME = join(
    root,
    'pnyx',
  )
  const folder = join(
    root,
    'project',
  )
  mkdirSync(folder)
  const run = ({ args }: { args: string[] }) => project(args)
  const state = ({ hydraId = 'default' }: { hydraId?: string } = {}) => loadHydra({ hydraId }).state

  return {
    root,
    folder,
    run,
    state,
  }
}

test(
  'project add, detach and re-attach replay without removing tasks or history',
  async () => {
    const {
      folder,
      run,
      state,
    } = fixture()
    await run({
      args: [
        'add',
        folder,
        '--event-id',
        'add-project',
      ],
    })
    commands.task([
      'create',
      '--title',
      'Ship change',
      '--key',
      'ship',
      '--project',
      'project',
    ])
    const task = state().cards[state().keys.ship!]!
    assert.equal(
      task.project,
      folder,
    )
    await run({
      args: [
        'remove',
        'project',
      ],
    })
    assert.equal(
      state().projects?.[0]?.detached,
      true,
    )
    await assert.rejects(
      run({
        args: [
          'add',
          folder,
          '--if-revision',
          '0',
        ],
      }),
      { code: 'REVISION_CONFLICT' },
    )
    const duplicate = await run({
      args: [
        'add',
        folder,
        '--event-id',
        'add-project',
      ],
    })
    assert.ok(duplicate.duplicate)
    assert.equal(
      state().projects?.[0]?.detached,
      true,
    )
    await run({
      args: [
        'add',
        folder,
        '--if-revision',
        '2',
      ],
    })
    assert.equal(
      state().projects?.length,
      1,
    )
    assert.equal(
      state().projects?.[0]?.detached,
      false,
    )
    assert.deepEqual(
      state().cards[task.id],
      task,
    )
  },
)

test(
  'shared paths require a token naming every other Hydra, including browser writes',
  async () => {
    const {
      root,
      folder,
      run,
      state,
    } = fixture()
    commands.hydra([
      'create',
      'alpha',
      '--name',
      'Alpha Hydra',
    ])
    await run({
      args: [
        'add',
        folder,
        '--hydra',
        'alpha',
      ],
    })
    const alias = join(
      root,
      'alias',
    )
    symlinkSync(
      folder,
      alias,
    )
    const preview = await run({
      args: [
        'add',
        alias,
        '--actor',
        'web',
      ],
    })
    assert.equal(
      preview.confirmation,
      'needed',
    )
    assert.deepEqual(
      (preview.preview as { hydras: unknown }).hydras,
      [
        {
          id: 'alpha',
          name: 'Alpha Hydra',
          url: '/hydra/alpha/',
        },
      ],
    )
    assert.equal(
      state().projects,
      undefined,
    )
    await run({
      args: [
        'add',
        alias,
        '--actor',
        'web',
        '--confirm',
        String(preview.token),
      ],
    })
    assert.equal(
      state().projects?.[0]?.path,
      folder,
    )
    await run({
      args: [
        'remove',
        folder,
      ],
    })
    const old = await run({
      args: [
        'add',
        folder,
      ],
    })
    commands.hydra([
      'create',
      'third',
    ])
    await run({
      args: [
        'add',
        folder,
        '--hydra',
        'third',
        '--confirm',
        String(old.token),
      ],
    }).then(out => assert.equal(
      out.confirmation,
      'needed',
    ))
    const third = await run({
      args: [
        'add',
        folder,
        '--hydra',
        'third',
      ],
    })
    await run({
      args: [
        'add',
        folder,
        '--hydra',
        'third',
        '--confirm',
        String(third.token),
      ],
    })
    const stale = await run({
      args: [
        'add',
        folder,
        '--confirm',
        String(old.token),
      ],
    })
    assert.equal(
      stale.confirmation,
      'needed',
    )
    assert.notEqual(
      stale.token,
      old.token,
    )
  },
)

test(
  'project changes wake the light check and the summary exposes projects',
  async () => {
    const {
      folder,
      run,
    } = fixture()
    await run({
      args: [
        'add',
        folder,
      ],
    })
    const check = await hydraCheck({
      args: [
        'check',
        '--after',
        '0',
      ],
    })
    assert.match(
      JSON.stringify(check.changes),
      /Attached project/,
    )
    assert.deepEqual(
      check.projects,
      [
        {
          name: 'project',
          path: folder,
          state: 'attached',
          landing: 'pr',
          merge: 'owner',
        },
      ],
    )
    assert.deepEqual(
      (await commands.hydra(['show'])).projects,
      check.projects,
    )
  },
)

test(
  'tasks can change projects, and detached names cannot be chosen for new work',
  async () => {
    const {
      root,
      folder,
      run,
      state,
    } = fixture()
    await run({
      args: [
        'add',
        folder,
      ],
    })
    const second = join(
      root,
      'second',
    ); mkdirSync(second)
    await run({
      args: [
        'add',
        second,
      ],
    })
    commands.task([
      'create',
      '--title',
      'Ship change',
      '--key',
      'ship',
      '--project',
      'project',
    ])
    commands.task([
      'project',
      'ship',
      '--project',
      'second',
    ])
    assert.equal(
      state().cards[state().keys.ship!]!.project,
      second,
    )
    await run({
      args: [
        'remove',
        'second',
      ],
    })
    assert.throws(
      () => commands.task([
        'create',
        '--title',
        'More work',
        '--project',
        'second',
      ]),
      { code: 'NOT_FOUND' },
    )
    assert.throws(
      () => commands.task([
        'project',
        'ship',
        '--project',
        'missing',
      ]),
      { code: 'NOT_FOUND' },
    )
  },
)

test(
  'ambiguous names require full paths and folders must exist',
  async () => {
    const {
      root,
      folder,
      run,
      state,
    } = fixture()
    await run({
      args: [
        'add',
        folder,
      ],
    })
    const other = join(
      root,
      'other',
      'project',
    ); mkdirSync(
      other,
      { recursive: true },
    )
    await run({
      args: [
        'add',
        other,
      ],
    })
    assert.throws(
      () => findProject({
        state: state(),
        ref: 'project',
      }),
      { code: 'CONFLICT' },
    )
    await assert.rejects(
      run({
        args: [
          'remove',
          'project',
        ],
      }),
      { code: 'CONFLICT' },
    )
    await run({
      args: [
        'remove',
        folder,
      ],
    })
    const file = join(
      root,
      'file',
    ); writeFileSync(
      file,
      'text',
    )
    await assert.rejects(
      run({
        args: [
          'add',
          file,
        ],
      }),
      { code: 'NOT_FOUND' },
    )
  },
)

test(
  'clone requires an explicit destination, clones code directly, and retries an event once',
  async () => {
    const {
      root,
      folder,
      run,
      state,
    } = fixture()
    execFileSync(
      'git',
      [
        'init',
        '--bare',
        folder,
      ],
      { stdio: 'ignore' },
    )
    await assert.rejects(
      run({
        args: [
          'add',
          '--clone',
          folder,
        ],
      }),
      { code: 'VALIDATION_ERROR' },
    )
    await assert.rejects(
      run({
        args: [
          'add',
          '--into',
          join(
            root,
            'no',
          ),
        ],
      }),
      { code: 'VALIDATION_ERROR' },
    )
    const into = join(
      root,
      'copy',
    )
    await run({
      args: [
        'add',
        '--clone',
        folder,
        '--into',
        into,
        '--event-id',
        'clone-copy',
      ],
    })
    assert.equal(
      readFileSync(
        join(
          into,
          '.git',
          'HEAD',
        ),
        'utf8',
      ).startsWith('ref:'),
      true,
    )
    assert.equal(
      state().projects?.[0]?.path,
      into,
    )
    const retry = await run({
      args: [
        'add',
        '--clone',
        folder,
        '--into',
        into,
        '--event-id',
        'clone-copy',
      ],
    })
    assert.ok(retry.duplicate)
    await assert.rejects(
      run({
        args: [
          'add',
          '--clone',
          join(
            root,
            'missing',
          ),
          '--into',
          join(
            root,
            'bad',
          ),
        ],
      }),
      { code: 'CLONE_FAILED' },
    )
  },
)

test(
  'Firstmate project folders are canonical, read-only and refreshed from the home',
  async () => {
    const {
      root,
      folder,
      run,
      state,
    } = fixture()
    const home = join(
      root,
      'firstmate',
    )
    cpSync(
      join(
        import.meta.dirname,
        'fixtures',
        'firstmate-home',
      ),
      home,
      { recursive: true },
    )
    mkdirSync(join(
      home,
      'projects',
    ))
    symlinkSync(
      folder,
      join(
        home,
        'projects',
        'linked',
      ),
    )
    writeFileSync(
      join(
        home,
        'projects',
        'file',
      ),
      'ignore',
    )
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        const decision = hydraEvent({
          state: writer.state,
          meta: {
            at: '2026-10-15T12:00:00Z',
            actor: 'test',
          },
          cardId: '$hydra',
          change: {
            type: 'board.configured',
            data: {
              id: 'default',
              name: 'Hydra',
              hydra: {
                id: 'firstmate',
                name: 'Hydra',
                kind: 'firstmate',
                home,
              },
              columns: [
                {
                  id: 'parked',
                  title: 'Parked',
                },
              ],
            },
          },
        })

        if ('event' in decision) {
          writer.append({ event: decision.event })
        }
      },
    })
    const before = readEvents({ hydraId: 'default' }).length
    const list = await run({ args: ['list'] })
    assert.equal(
      list.readonly,
      true,
    )
    assert.deepEqual(
      projectsFor({ state: state() }),
      [
        {
          name: 'project',
          path: folder,
          detached: false,
        },
      ],
    )
    await assert.rejects(
      run({
        args: [
          'add',
          folder,
        ],
      }),
      { code: 'READ_ONLY' },
    )
    await assert.rejects(
      run({
        args: [
          'remove',
          'project',
        ],
      }),
      { code: 'READ_ONLY' },
    )
    assert.equal(
      readEvents({ hydraId: 'default' }).length,
      before,
    )
    commands.task([
      'create',
      '--title',
      'Aliased work',
      '--key',
      'alias-work',
    ])
    const input = join(
      root,
      'aliased-task.json',
    )
    writeFileSync(
      input,
      JSON.stringify({
        project: 'linked',
        agent: {
          provider: 'claude-code',
          sessionId: 'alias-worker',
        },
        activity: 'working',
        attention: [
          {
            key: 'question',
            kind: 'question',
            blocking: true,
          },
        ],
      }),
    )
    commands.push([
      '--key',
      'alias-work',
      '--file',
      input,
    ])
    const summary = listHydras().find(h => h.id === 'default')?.projects[0]
    assert.deepEqual(
      summary,
      {
        name: 'project',
        path: folder,
        references: [
          folder,
          'project',
          'linked',
        ],
        live: 1,
        asks: 1,
      },
    )
    rmSync(join(
      home,
      'projects',
      'linked',
    ))
    assert.deepEqual(
      firstmateProjects({ home }),
      [],
    )
    // The sidebar follows the Firstmate home even though no event was written.
    assert.deepEqual(
      listHydras().find(h => h.id === 'default')?.projects,
      [],
    )
  },
)

test(
  'CLI exposes projects without touching the real Pnyx home',
  () => {
    const { folder } = fixture()
    const bin = resolve(
      import.meta.dirname,
      '../dist/cli/pnyx-axi.js',
    )
    const out = execFileSync(
      process.execPath,
      [
        bin,
        'project',
        'add',
        folder,
      ],
      {
        encoding: 'utf8',
        env: process.env,
      },
    )
    assert.match(
      out,
      /hydra.project/,
    )
    const list = execFileSync(
      process.execPath,
      [
        bin,
        'project',
        'list',
      ],
      {
        encoding: 'utf8',
        env: process.env,
      },
    )
    assert.match(
      list,
      /attached/,
    )
    assert.match(
      list,
      /readonly: false/,
    )
  },
)

test(
  'clone sharing returns an attachment continuation after cloning into a chosen empty folder',
  async () => {
    const {
      root,
      folder,
      run,
      state,
    } = fixture()
    const source = join(
      root,
      'source',
    )
    execFileSync(
      'git',
      [
        'init',
        '--bare',
        source,
      ],
      { stdio: 'ignore' },
    )
    commands.hydra([
      'create',
      'other',
    ])
    await run({
      args: [
        'add',
        folder,
        '--hydra',
        'other',
      ],
    })
    const preview = await run({
      args: [
        'add',
        '--clone',
        source,
        '--into',
        folder,
      ],
    })
    assert.equal(
      preview.confirmation,
      'needed',
    )
    assert.match(
      String(preview.help),
      /Clone completed/,
    )
    assert.equal(
      state().projects,
      undefined,
    )
    await run({
      args: [
        'add',
        folder,
        '--confirm',
        String(preview.token),
      ],
    })
    assert.equal(
      state().projects?.[0]?.path,
      folder,
    )
  },
)

test(
  'web project attachment requires absolute laptop folders',
  async () => {
    const { run } = fixture()
    await assert.rejects(
      run({
        args: [
          'add',
          '.',
          '--actor',
          'web',
        ],
      }),
      { code: 'VALIDATION_ERROR' },
    )
  },
)

test(
  'standalone task labels still work after a project is attached',
  async () => {
    const {
      folder,
      run,
      state,
    } = fixture()
    await run({
      args: [
        'add',
        folder,
      ],
    })
    commands.task([
      'create',
      '--title',
      'Labelled work',
      '--key',
      'labelled',
      '--project',
      'free-label',
    ])
    assert.equal(
      state().cards[state().keys.labelled!]!.project,
      'free-label',
    )
    commands.task([
      'create',
      '--title',
      'Project work',
      '--key',
      'linked',
      '--project',
      'project',
    ])
    assert.equal(
      state().cards[state().keys.linked!]!.project,
      folder,
    )
  },
)

test(
  'the web receipt deadline outlasts git clone and retains ordinary command deadlines',
  () => {
    assert.ok(commandTimeout({
      name: 'project',
      args: [
        'add',
        '--clone',
        'url',
        '--into',
        '/folder',
      ],
    }) > CLONE_TIMEOUT_MS)
    assert.equal(
      commandTimeout({
        name: 'project',
        args: ['list'],
      }),
      60000,
    )
    assert.equal(
      commandTimeout({
        name: 'reply',
        args: [],
      }),
      140000,
    )
  },
)

test(
  'project commands persist, survive detaching and appear in Hydra checks',
  async () => {
    const {
      folder,
      run,
      state,
    } = fixture()
    await run({
      args: [
        'add',
        folder,
      ],
    })
    await run({
      args: [
        'set',
        'project',
        '--command-name',
        'local worker',
        '--command',
        'echo fixture',
        '--brings-own-folder',
        'true',
        '--event-id',
        'command-1',
      ],
    })
    await run({
      args: [
        'set',
        'project',
        '--copy',
        'echo copy-fixture',
      ],
    })
    const saved = {
      name: 'local worker',
      command: 'echo fixture',
      bringsOwnFolder: true,
    }
    assert.deepEqual(
      state().projects?.[0]?.startCommand,
      saved,
    )
    const check = await hydraCheck({
      args: [
        'check',
        '--after',
        '0',
      ],
    })
    assert.deepEqual(
      (check.projects as { startCommand: unknown }[])[0]?.startCommand,
      saved,
    )
    assert.match(
      JSON.stringify(check.changes),
      /Updated project/,
    )
    await run({
      args: [
        'remove',
        'project',
      ],
    })
    await run({
      args: [
        'add',
        folder,
      ],
    })
    assert.deepEqual(
      state().projects?.[0]?.startCommand,
      saved,
    )
    await run({
      args: [
        'set',
        'project',
        '--command-name',
        'local worker',
        '--command',
        'different',
        '--event-id',
        'command-1',
      ],
    })
    assert.deepEqual(
      state().projects?.[0]?.startCommand,
      saved,
    )
    await run({
      args: [
        'set',
        'project',
        '--command',
        '',
      ],
    })
    assert.equal(
      state().projects?.[0]?.startCommand,
      undefined,
    )
    assert.equal(
      state().projects?.[0]?.copy,
      'echo copy-fixture',
    )
  },
)

test(
  'project command settings reject incomplete values and Firstmate writes',
  async () => {
    const {
      folder,
      run,
    } = fixture()
    await run({
      args: [
        'add',
        folder,
      ],
    })
    await assert.rejects(
      run({
        args: [
          'set',
          'project',
          '--command',
          'echo fixture',
        ],
      }),
      { code: 'VALIDATION_ERROR' },
    )
    await assert.rejects(
      run({
        args: [
          'set',
          'project',
          '--command-name',
          'test',
          '--command',
          'echo fixture',
          '--brings-own-folder',
          'yes',
        ],
      }),
      { code: 'VALIDATION_ERROR' },
    )
    commands.hydra([
      'set',
      '--firstmate',
      folder,
    ])
    await assert.rejects(
      run({
        args: [
          'set',
          'project',
          '--command',
          '',
        ],
      }),
      { code: 'READ_ONLY' },
    )
  },
)

test(
  'project lookup recognizes a real path behind a saved alias and preserves its display path',
  async () => {
    const {
      root,
      folder,
      state,
      run,
    } = fixture()
    const alias = join(
      root,
      'configured-alias',
    )
    symlinkSync(
      folder,
      alias,
    )
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        const decision = hydraEvent({
          state: writer.state,
          cardId: '$projects',
          meta: {
            actor: 'cli',
            at: new Date().toISOString(),
          },
          change: {
            type: 'hydra.project',
            data: {
              before: null,
              after: {
                path: alias,
                name: 'configured-alias',
                detached: false,
              },
              sharedWith: [],
            },
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    assert.equal(
      findProject({
        state: state(),
        ref: folder,
      }).path,
      alias,
    )
    commands.task([
      'create',
      '--title',
      'Use the saved project',
      '--key',
      'alias-task',
      '--project',
      folder,
    ])
    const saved = state()
    assert.equal(
      saved.cards[saved.keys['alias-task']!]!.project,
      alias,
    )
    assert.equal(
      saved.projects?.[0]?.path,
      alias,
    )
    await run({
      args: [
        'add',
        folder,
      ],
    })
    assert.equal(
      state().projects?.length,
      1,
    )
    assert.equal(
      state().projects?.[0]?.path,
      alias,
    )
  },
)
