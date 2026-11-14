import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { git } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

test(
  'task copies push their own branches and repair default-branch upstreams',
  async () => {
    const s = await pnyx.scenario()
    const project = await s.project({ name: 'safe-push' })
    git({
      cwd: project,
      args: [
        'config',
        'branch.autoSetupMerge',
        'always',
      ],
    })
    writeFileSync(
      join(
        project,
        '.git',
        'info',
        'exclude',
      ),
      'pool-proof\n',
    )
    const main = git({
      cwd: project,
      args: [
        'rev-parse',
        'refs/heads/main',
      ],
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'First',
        '--key',
        'first',
        '--project',
        project,
        '--ask',
        'Work',
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'first',
      ],
    })
    const first = s.task({ key: 'first' }).copy!
    assert.ok(first.branch)
    writeFileSync(
      join(
        first.path,
        'pool-proof',
      ),
      'keep this ignored file\n',
    )
    assert.equal(
      git({
        cwd: first.path,
        args: [
          'for-each-ref',
          '--format=%(upstream)',
          `refs/heads/${first.branch}`,
        ],
      }),
      '',
    )
    writeFileSync(
      join(
        first.path,
        'work.txt',
      ),
      'synthetic work\n',
    )
    git({
      cwd: first.path,
      args: [
        'add',
        'work.txt',
      ],
    })
    git({
      cwd: first.path,
      args: [
        'commit',
        '-qm',
        'work',
      ],
    })
    git({
      cwd: first.path,
      args: [
        'push',
        '-u',
        'origin',
        first.branch,
      ],
    })
    const tip = git({
      cwd: first.path,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })
    assert.equal(
      git({
        cwd: `${project}.git`,
        args: [
          'rev-parse',
          `refs/heads/${first.branch}`,
        ],
      }),
      tip,
    )
    assert.equal(
      git({
        cwd: `${project}.git`,
        args: [
          'rev-parse',
          'refs/heads/main',
        ],
      }),
      main,
    )
    assert.equal(
      git({
        cwd: first.path,
        args: [
          'rev-parse',
          '--abbrev-ref',
          '@{upstream}',
        ],
      }),
      `origin/${first.branch}`,
    )

    git({
      cwd: first.path,
      args: [
        'branch',
        '--set-upstream-to=origin/main',
        first.branch,
      ],
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Second',
        '--key',
        'second',
        '--project',
        project,
        '--ask',
        'Work',
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'second',
      ],
    })
    assert.equal(
      git({
        cwd: first.path,
        args: [
          'for-each-ref',
          '--format=%(upstream)',
          `refs/heads/${first.branch}`,
        ],
      }),
      '',
    )
    git({
      cwd: first.path,
      args: [
        'branch',
        `--set-upstream-to=origin/${first.branch}`,
        first.branch,
      ],
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Third',
        '--key',
        'third',
        '--project',
        project,
        '--ask',
        'Work',
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'third',
      ],
    })
    assert.equal(
      git({
        cwd: first.path,
        args: [
          'rev-parse',
          '--abbrev-ref',
          '@{upstream}',
        ],
      }),
      `origin/${first.branch}`,
    )
  },
)
git({
  cwd: first.path,
  args: [
    'push',
    'origin',
    'HEAD:refs/heads/main',
  ],
})
await s.owner({
  args: [
    'task',
    'copy',
    'first',
    'remove',
    '--safe',
  ],
})
await s.owner({
  args: [
    'task',
    'create',
    '--title',
    'Pooled',
    '--key',
    'pooled',
    '--project',
    project,
    '--ask',
    'Work',
  ],
})
await s.owner({
  args: [
    'task',
    'start',
    'pooled',
  ],
})
const pooled = s.task({ key: 'pooled' }).copy!
assert.equal(
  pooled.path,
  first.path,
)
assert.ok(pooled.branch)
assert.ok(existsSync(join(
  pooled.path,
  'pool-proof',
)))
assert.equal(
  git({
    cwd: pooled.path,
    args: [
      'for-each-ref',
      '--format=%(upstream)',
      `refs/heads/${pooled.branch}`,
    ],
  }),
  '',
)
