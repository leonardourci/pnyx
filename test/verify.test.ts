import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import test from 'node:test'

const reviews = [
  'review-code',
  'audit-tests',
  'deslop',
].map(name => '- [x] Ran `' + name + '`').join('\n')

function fixture({
  t,
  docs = false,
}: {
  t: test.TestContext
  docs?: boolean
}) {
  const root = mkdtempSync(join(
    tmpdir(),
    'pnyx-verify-test-',
  ))
  t.after(() => rmSync(
    root,
    {
      recursive: true,
      force: true,
    },
  ))
  const repo = join(
    root,
    'repo',
  )
  const origin = join(
    root,
    'origin.git',
  )
  const bin = join(
    root,
    'bin',
  )
  const calls = join(
    root,
    'calls.jsonl',
  )
  const edited = join(
    root,
    'edited.md',
  )
  const pr = join(
    root,
    'pr.json',
  )
  mkdirSync(repo)
  mkdirSync(bin)

  const git = ({
    args,
    cwd = repo,
  }: {
    args: string[]
    cwd?: string
  }) => execFileSync(
    'git',
    args,
    {
      cwd,
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
      '--bare',
      '--initial-branch=trunk',
      origin,
    ],
  })
  git({
    args: [
      'init',
      '--initial-branch=trunk',
    ],
  })
  git({
    args: [
      'config',
      'user.email',
      'fixture@example.invalid',
    ],
  })
  git({
    args: [
      'config',
      'user.name',
      'Fixture',
    ],
  })
  git({
    args: [
      'remote',
      'add',
      'origin',
      origin,
    ],
  })
  mkdirSync(join(
    repo,
    'scripts',
  ))

  for (const name of [
    'verify.ts',
    'marker.ts',
  ]) {
    copyFileSync(
      resolve(
        'scripts',
        name,
      ),
      join(
        repo,
        'scripts',
        name,
      ),
    )
  }

  writeFileSync(
    join(
      repo,
      'package.json',
    ),
    '{"type":"module"}',
  )
  writeFileSync(
    join(
      repo,
      'README.md',
    ),
    'base\n',
  )
  git({
    args: [
      'add',
      '.',
    ],
  })
  git({
    args: [
      'commit',
      '-m',
      'base',
    ],
  })
  git({
    args: [
      'push',
      '-u',
      'origin',
      'trunk',
    ],
  })
  git({
    args: [
      'switch',
      '-c',
      'feature',
    ],
  })
  const changed = docs ? 'README.md' : 'behavior.ts'
  writeFileSync(
    join(
      repo,
      changed,
    ),
    'changed\n',
  )
  git({
    args: [
      'add',
      '.',
    ],
  })
  git({
    args: [
      'commit',
      '-m',
      'change behavior',
    ],
  })
  const head = git({
    args: [
      'rev-parse',
      'HEAD',
    ],
  })
  writeFileSync(
    pr,
    JSON.stringify({
      number: 7,
      headRefOid: head,
      body: `Description\n\n${reviews}`,
    }),
  )

  for (const command of [
    'pnpm',
    'node',
    'gh',
  ]) {
    const executable = join(
      bin,
      command,
    )
    writeFileSync(
      executable,
      `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
const command = ${JSON.stringify(command)}
fs.appendFileSync(process.env.CALLS, JSON.stringify({ command, args }) + '\\n')
if (command === 'gh') {
  if (args[1] === 'view') process.stdout.write(fs.readFileSync(process.env.PR))
  else if (args[1] === 'edit') fs.writeFileSync(process.env.EDITED, fs.readFileSync(0))
} else {
  if (args.includes('lint:fix') && process.env.AUTOFIX) fs.writeFileSync('behavior.ts', 'fixed\\n')
  if ((args.includes('lint:fix') || args.includes('eslint')) && process.env.LINT_FAIL) {
    console.error('behavior.ts:1 unused variable cannot be fixed')
    process.exitCode = 1
  }
}
`,
    )
    chmodSync(
      executable,
      0o755,
    )
  }

  return {
    git,
    head,
    repo,
    pr,
    run({
      extra = {},
      args = [],
    }: {
      extra?: Record<string, string>
      args?: string[]
    } = {}) {
      const env = { ...process.env }

      for (const name of [
        'PNYX_ACTOR',
        'PNYX_TASK',
        'PNYX_HYDRA',
      ]) {
        delete env[name]
      }

      const result = spawnSync(
        process.execPath,
        [
          join(
            repo,
            'scripts/verify.ts',
          ),
          ...args,
        ],
        {
          cwd: repo,
          env: {
            ...env,
            PNYX_HOME: join(
              root,
              'pnyx',
            ),
            TMPDIR: root,
            PATH: `${bin}${delimiter}${process.env.PATH}`,
            CALLS: calls,
            PR: pr,
            EDITED: edited,
            ...extra,
          },
          encoding: 'utf8',
          timeout: 60_000,
        },
      )
      assert.ifError(result.error)

      return {
        status: result.status,
        output: result.stdout + result.stderr,
        calls: existsSync(calls) ? readFileSync(
          calls,
          'utf8',
        ).trim()
          .split('\n')
          .map(line => JSON.parse(line) as {
            command: string
            args: string[]
          }) : [],
        body: existsSync(edited) ? readFileSync(
          edited,
          'utf8',
        ) : undefined,
      }
    },
  }
}

test(
  'verify discovers a non-main default branch and marks a clean reviewed PR after checks',
  t => {
    const f = fixture({ t })
    const result = f.run()
    assert.equal(
      result.status,
      0,
      result.output,
    )
    assert.deepEqual(
      result.calls.map(call => call.command),
      [
        'pnpm',
        'pnpm',
        'pnpm',
        'pnpm',
        'node',
        'node',
        'gh',
        'gh',
      ],
    )
    assert.match(
      result.body!,
      new RegExp(f.head),
    )
    assert.match(
      result.body!,
      /pnyx-checks:v1/,
    )
    assert.match(
      result.body!,
      /Description/,
    )
    assert.match(
      result.output,
      /\.agents\/skills\/review-code\/SKILL.md/,
    )
  },
)

test(
  'verify fetches a newer default branch, stops before checks and leaves rebasing to the developer',
  t => {
    const f = fixture({ t })
    f.git({
      args: [
        'switch',
        'trunk',
      ],
    })
    writeFileSync(
      join(
        f.repo,
        'upstream.ts',
      ),
      'new upstream behavior\n',
    )
    f.git({
      args: [
        'add',
        '.',
      ],
    })
    f.git({
      args: [
        'commit',
        '-m',
        'upstream',
      ],
    })
    f.git({
      args: [
        'push',
        'origin',
        'trunk',
      ],
    })
    f.git({
      args: [
        'switch',
        'feature',
      ],
    })
    f.git({
      args: [
        'update-ref',
        'refs/remotes/origin/trunk',
        f.head,
      ],
    })
    const result = f.run()
    assert.equal(
      result.status,
      1,
      result.output,
    )
    assert.match(
      result.output,
      /git rebase refs\/remotes\/origin\/trunk/,
    )
    assert.deepEqual(
      result.calls,
      [],
    )
    assert.equal(
      f.git({
        args: [
          'rev-parse',
          'HEAD',
        ],
      }),
      f.head,
    )
    assert.equal(
      result.body,
      undefined,
    )
  },
)

test(
  'verify fails closed if the default branch cannot be fetched',
  t => {
    const f = fixture({ t })
    f.git({
      args: [
        'remote',
        'set-url',
        'origin',
        join(
          f.repo,
          'missing.git',
        ),
      ],
    })
    const result = f.run()
    assert.equal(
      result.status,
      1,
    )
    assert.deepEqual(
      result.calls,
      [],
    )
    assert.equal(
      result.body,
      undefined,
    )
  },
)

test(
  'verify keeps lint fixes, runs remaining checks and requires committing before a marker',
  t => {
    const f = fixture({ t })
    const result = f.run({ extra: { AUTOFIX: '1' } })
    assert.equal(
      result.status,
      1,
      result.output,
    )
    assert.equal(
      readFileSync(
        join(
          f.repo,
          'behavior.ts',
        ),
        'utf8',
      ),
      'fixed\n',
    )
    assert.match(
      result.output,
      /behavior.ts/,
    )
    assert.match(
      result.output,
      /uncommitted changes/,
    )
    assert.ok(result.calls.some(call => call.args.includes('build')))
    assert.equal(
      result.body,
      undefined,
    )
  },
)

test(
  'verify prints unfixable lint issues and keeps running independent checks',
  t => {
    const f = fixture({ t })
    const result = f.run({ extra: { LINT_FAIL: '1' } })
    assert.equal(
      result.status,
      1,
      result.output,
    )
    assert.match(
      result.output,
      /unused variable cannot be fixed/,
    )
    assert.ok(result.calls.some(call => call.args.includes('build')))
    assert.equal(
      result.body,
      undefined,
    )
  },
)

test(
  'verify requires all reviews even when automated checks pass',
  t => {
    const f = fixture({ t })
    const pr = JSON.parse(readFileSync(
      f.pr,
      'utf8',
    ))
    writeFileSync(
      f.pr,
      JSON.stringify({
        ...pr,
        body: pr.body.replace(
          '[x]',
          '[ ]',
        ),
      }),
    )
    const result = f.run()
    assert.equal(
      result.status,
      1,
      result.output,
    )
    assert.match(
      result.output,
      /complete review-code/,
    )
    assert.equal(
      result.body,
      undefined,
    )
  },
)

test(
  'docs-only verification skips automated checks but still requires reviews',
  t => {
    const f = fixture({
      t,
      docs: true,
    })
    const result = f.run()
    assert.equal(
      result.status,
      0,
      result.output,
    )
    assert.deepEqual(
      result.calls.map(call => call.command),
      [
        'gh',
        'gh',
      ],
    )
    assert.match(
      result.body!,
      /pnyx-checks:v1/,
    )
  },
)

test(
  'verify refuses a marker for an unpushed or dirty PR head',
  t => {
    const f = fixture({ t })
    writeFileSync(
      f.pr,
      JSON.stringify({
        number: 7,
        headRefOid: 'older',
        body: reviews,
      }),
    )
    writeFileSync(
      join(
        f.repo,
        'README.md',
      ),
      'uncommitted\n',
    )
    const result = f.run()
    assert.equal(
      result.status,
      1,
      result.output,
    )
    assert.match(
      result.output,
      /push first/,
    )
    assert.match(
      result.output,
      /uncommitted changes/,
    )
    assert.equal(
      result.body,
      undefined,
    )
  },
)

test(
  'checks-only runs automated checks without reading or editing the PR',
  t => {
    const f = fixture({ t })
    rmSync(f.pr)
    const result = f.run({ args: ['--checks-only'] })
    assert.equal(
      result.status,
      0,
      result.output,
    )
    assert.ok(result.calls.some(call => call.args.includes('build')))
    assert.ok(result.calls.every(call => call.command !== 'gh'))
    assert.equal(
      result.body,
      undefined,
    )
    assert.match(
      result.output,
      /not written: --checks-only/,
    )
  },
)

test(
  'checks-only still fails when lint cannot be fixed or fixes need committing',
  t => {
    const failures: Record<string, string>[] = [
      { LINT_FAIL: '1' },
      { AUTOFIX: '1' },
    ]

    for (const extra of failures) {
      const f = fixture({ t })
      const result = f.run({
        args: ['--checks-only'],
        extra,
      })
      assert.equal(
        result.status,
        1,
        result.output,
      )
      assert.ok(result.calls.every(call => call.command !== 'gh'))
      assert.equal(
        result.body,
        undefined,
      )
    }
  },
)

test(
  'verify rejects unknown flags before running checks or touching the PR',
  t => {
    const f = fixture({ t })
    const result = f.run({ args: ['--checks-onyl'] })
    assert.equal(
      result.status,
      1,
      result.output,
    )
    assert.deepEqual(
      result.calls,
      [],
    )
    assert.equal(
      result.body,
      undefined,
    )
    assert.match(
      result.output,
      /Usage: pnpm verify/,
    )
  },
)
