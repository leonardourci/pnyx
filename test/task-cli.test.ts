import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const bin = join(
  import.meta.dirname,
  '../dist/cli/pnyx-axi.js',
)

function fixture() {
  const home = mkdtempSync(join(
    tmpdir(),
    'pnyx-task-cli-',
  ))
  const dir = join(
    home,
    'hydras/default',
  )
  const env = {
    ...process.env,
    PNYX_HOME: home,
    PNYX_SEMANTIC: 'off',
  }
  const run = ({ args }: { args: string[] }) => execFileSync(
    process.execPath,
    [
      bin,
      ...args,
    ],
    {
      env,
      encoding: 'utf8',
    },
  )

  const push = ({
    key,
    input,
  }: {
    key: string
    input: object
  }) => {
    const path = join(
      home,
      'push.json',
    )
    writeFileSync(
      path,
      JSON.stringify(input),
    )

    return run({
      args: [
        'push',
        '--key',
        key,
        '--file',
        path,
      ],
    })
  }

  let seq = 0

  const hook = ({
    session,
    event,
    interactive = true,
  }: {
    session: string
    event: string
    interactive?: boolean
  }) => {
    seq++
    const spool = join(
      dir,
      'spool',
    )
    mkdirSync(
      spool,
      { recursive: true },
    )
    writeFileSync(
      join(
        spool,
        `${String(seq).padStart(
          4,
          '0',
        )}.json`,
      ),
      JSON.stringify({
        id: `task-hook-${seq}`,
        at: `2026-10-14T12:00:${String(seq).padStart(
          2,
          '0',
        )}Z`,
        harness: 'claude',
        event,
        ...(interactive ? {
          terminal: {
            tty: '/dev/ttys123',
            pid: '123',
          },
        } : {}),
        payload: {
          session_id: session,
          cwd: '/task-lab',
          prompt: `Work ${session}`,
        },
      }),
    )
    push({
      key: 'probe',
      input: {},
    })
  }

  const state = () => JSON.parse(readFileSync(
    join(
      dir,
      'snapshot.json',
    ),
    'utf8',
  )).state

  return {
    home,
    dir,
    run,
    push,
    hook,
    state,
  }
}

function failure({ run }: { run: () => unknown }): {
  status: number
  stdout: string
} {
  try {
    run()
  } catch (error) {
    const {
      status,
      stdout,
    } = error as {
      status: number
      stdout: string
    }

    return {
      status,
      stdout,
    }
  }

  throw new Error('expected the command to fail')
}

test(
  'subcommand help is focused, and an unknown flag lists that subcommand\'s flags',
  () => {
    const f = fixture()
    const help = f.run({
      args: [
        'task',
        'create',
        '--help',
      ],
    })
    assert.match(
      help,
      /^usage: pnyx-axi task create --title <title>/,
    )
    assert.doesNotMatch(
      help,
      /pnyx-axi task status/,
      'other task subcommands stay out',
    )

    const unknown = failure({
      run: () => f.run({
        args: [
          'task',
          'create',
          '--title',
          'x',
          '--titel',
          'y',
        ],
      }),
    })
    assert.equal(
      unknown.status,
      2,
    )
    assert.match(
      unknown.stdout,
      /unknown flag --titel for `task create`/,
    )

    for (const flag of [
      '--title',
      '--project',
      '--brief',
    ]) {
      assert.match(
        unknown.stdout,
        new RegExp(`Valid flags:.*${flag}\\b`),
      )
    }

    assert.doesNotMatch(
      unknown.stdout,
      /positional argument/,
      'the parser\'s own advice stays out',
    )
    assert.match(
      failure({
        run: () => f.run({
          args: [
            'task',
            'lsit',
          ],
        }),
      }).stdout,
      /help\[1\]: Run `pnyx-axi task --help`/,
    )
  },
)

test(
  'task list rows keep four fields, --fields adds more, and long text is cut with its length',
  () => {
    const f = fixture()
    f.run({
      args: [
        'task',
        'create',
        '--key',
        'long',
        '--title',
        'Long brief',
        '--brief',
        'b'.repeat(1500),
      ],
    })
    const listing = f.run({
      args: [
        'task',
        'list',
      ],
    })
    assert.match(
      listing,
      /count: 1\ntasks\[1\]\{id,title,project,column\}:/,
    )
    assert.match(
      listing,
      /Long brief,none,/,
      'a task without a project still fills the field',
    )
    assert.match(
      f.run({
        args: [
          'task',
          'list',
          '--fields',
          'status,worker',
        ],
      }),
      /tasks\[1\]\{id,title,project,column,status,worker\}:/,
    )
    const colour = failure({
      run: () => f.run({
        args: [
          'task',
          'list',
          '--fields',
          'colour',
        ],
      }),
    })
    assert.equal(
      colour.status,
      2,
    )
    assert.match(
      colour.stdout,
      /unknown field: colour/,
    )

    const id = f.state().keys.long
    assert.match(
      f.run({
        args: [
          'task',
          'show',
          id,
        ],
      }),
      /… \(truncated, 1500 chars total\)/,
    )
    assert.match(
      f.run({
        args: [
          'task',
          'show',
          id,
          '--full',
        ],
      }),
      /b{1500}/,
    )
    const card = f.run({
      args: [
        'card',
        id,
      ],
    })
    assert.match(
      card,
      /… \(truncated, 1500 chars total\)/,
    )
    assert.match(
      card,
      /card .+ --full` for the brief/,
    )
    assert.match(
      f.run({
        args: [
          'card',
          id,
          '--full',
        ],
      }),
      /b{1500}/,
    )
    assert.match(
      f.run({
        args: [
          'history',
          '--limit',
          '1',
        ],
      }),
      /count: 1 of 1 total/,
    )
  },
)

test(
  'creating a Hydra that exists as asked is a no-op; other settings conflict',
  () => {
    const f = fixture()
    const create = ({ extra = [] }: { extra?: string[] } = {}) => f.run({
      args: [
        'hydra',
        'create',
        'work',
        ...extra,
      ],
    })
    create()
    const events = () => readFileSync(
      join(
        f.home,
        'hydras',
        'work',
        'events.jsonl',
      ),
      'utf8',
    )
    const before = events()
    assert.match(
      create(),
      /event: "none: unchanged"/,
    )
    assert.equal(
      events(),
      before,
      'the repeat appends nothing',
    )
    assert.match(
      failure({
        run: () => create({
          extra: [
            '--name',
            'Other',
          ],
        }),
      }).stdout,
      /Hydra already exists with other settings: work/,
    )
  },
)

test(
  'hydra homes needs a base folder, and --version answers before the commands load',
  () => {
    const f = fixture()
    const homes = failure({
      run: () => execFileSync(
        process.execPath,
        [
          bin,
          'hydra',
          'homes',
        ],
        {
          env: {
            ...process.env,
            PNYX_HOME: f.home,
            FIRSTMATE_FACTORY_BASE: '',
          },
          encoding: 'utf8',
        },
      ),
    })
    assert.equal(
      homes.status,
      2,
    )
    assert.match(
      homes.stdout,
      /missing --base/,
    )
    assert.equal(
      f.run({ args: ['--version'] }).trim(),
      JSON.parse(readFileSync(
        join(
          import.meta.dirname,
          '..',
          'package.json',
        ),
        'utf8',
      )).version,
    )
  },
)
