import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { git } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

// git as a worker runs it, which can fail: the refusal and its text are the result.
function attempt({
  cwd,
  args,
  env = {},
}: {
  cwd: string
  args: string[]
  env?: NodeJS.ProcessEnv
}) {
  const run = spawnSync(
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
        ...env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    },
  )

  return {
    ok: run.status === 0,
    out: `${run.stdout}${run.stderr}`.trim(),
  }
}

const upstreamOf = ({
  cwd,
  branch,
}: {
  cwd: string
  branch: string
}) => git({
  cwd,
  args: [
    'for-each-ref',
    '--format=%(upstream)',
    `refs/heads/${branch}`,
  ],
})

test(
  'task branches never track the default branch, so a push cannot land on it',
  async () => {
    const s = await pnyx.scenario()
    const project = await s.project({ name: 'safe-push' })
    const origin = `${project}.git`
    // The setting behind the incident: a plain push goes to the branch's upstream.
    git({
      cwd: project,
      args: [
        'config',
        'push.default',
        'upstream',
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
      cwd: origin,
      args: [
        'rev-parse',
        'refs/heads/main',
      ],
    })

    const start = async ({ key }: { key: string }) => {
      await s.owner({
        args: [
          'task',
          'create',
          '--title',
          key,
          '--key',
          key,
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
          key,
        ],
      })

      return s.task({ key }).copy!
    }

    // A fresh copy has no upstream, and the push the landing rule names is the only one that publishes the branch.
    const first = await start({ key: 'first' })
    assert.ok(first.branch)
    writeFileSync(
      join(
        first.path,
        'pool-proof',
      ),
      'keep this ignored file\n',
    )
    assert.equal(
      upstreamOf({
        cwd: first.path,
        branch: first.branch,
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

    for (const args of [
      [
        'add',
        'work.txt',
      ],
      [
        'commit',
        '-qm',
        'work',
      ],
    ]) {
      git({
        cwd: first.path,
        args,
      })
    }

    assert.equal(
      attempt({
        cwd: first.path,
        args: ['push'],
      }).ok,
      false,
    )
    assert.equal(
      git({
        cwd: origin,
        args: [
          'rev-parse',
          'refs/heads/main',
        ],
      }),
      main,
    )
    git({
      cwd: first.path,
      args: [
        'push',
        '-u',
        'origin',
        `HEAD:refs/heads/${first.branch}`,
      ],
    })
    assert.equal(
      git({
        cwd: origin,
        args: [
          'rev-parse',
          `refs/heads/${first.branch}`,
        ],
      }),
      git({
        cwd: first.path,
        args: [
          'rev-parse',
          'HEAD',
        ],
      }),
    )
    assert.equal(
      git({
        cwd: origin,
        args: [
          'rev-parse',
          'refs/heads/main',
        ],
      }),
      main,
    )
    assert.equal(
      upstreamOf({
        cwd: first.path,
        branch: first.branch,
      }),
      `refs/remotes/origin/${first.branch}`,
    )

    // A branch the worker makes itself is untracked too, because Pnyx started its agent with that git setting.
    const agent = await s.agent({ cwd: first.path })
    const workerEnv = agent.env
    assert.equal(
      workerEnv.GIT_CONFIG_COUNT,
      '1',
    )
    assert.ok(attempt({
      cwd: first.path,
      args: [
        'switch',
        '--quiet',
        '-c',
        'fix/own',
        'origin/main',
      ],
      env: workerEnv,
    }).ok)
    assert.equal(
      upstreamOf({
        cwd: first.path,
        branch: 'fix/own',
      }),
      '',
    )
    assert.ok(attempt({
      cwd: first.path,
      args: [
        'switch',
        '--quiet',
        first.branch,
      ],
    }).ok)
    assert.ok(attempt({
      cwd: first.path,
      args: [
        'checkout',
        '--quiet',
        '-B',
        'fix/rebuilt',
        'origin/main',
      ],
      env: workerEnv,
    }).ok)
    assert.equal(
      upstreamOf({
        cwd: first.path,
        branch: 'fix/rebuilt',
      }),
      '',
    )
    assert.equal(
      attempt({
        cwd: first.path,
        args: ['push'],
        env: workerEnv,
      }).ok,
      false,
    )
    assert.equal(
      git({
        cwd: origin,
        args: [
          'rev-parse',
          'refs/heads/main',
        ],
      }),
      main,
    )
    attempt({
      cwd: first.path,
      args: [
        'switch',
        '--quiet',
        first.branch,
      ],
    })

    // A codex worker's shell gets the same setting.
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'codexed',
        '--key',
        'codexed',
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
        'codexed',
        '--harness',
        'codex',
      ],
    })
    const codexed = await s.agent({ cwd: s.task({ key: 'codexed' }).copy!.path })
    assert.equal(
      codexed.config?.['shell_environment_policy.set.GIT_CONFIG_COUNT'],
      '1',
    )
    assert.equal(
      codexed.config?.['shell_environment_policy.set.GIT_CONFIG_KEY_0'],
      'branch.autoSetupMerge',
    )

    // Branches made before this fix still track the default branch: a recorded copy's, a removed copy's and another Hydra's.
    git({
      cwd: first.path,
      args: [
        'branch',
        '--set-upstream-to=origin/main',
        first.branch,
      ],
    })
    git({
      cwd: project,
      args: [
        'branch',
        '--track',
        'pnyx/other-task-1',
        'origin/main',
      ],
    })
    git({
      cwd: project,
      args: [
        'branch',
        '--track',
        'fix/feature-work',
        'origin/main',
      ],
    })
    await start({ key: 'second' })
    assert.equal(
      upstreamOf({
        cwd: first.path,
        branch: first.branch,
      }),
      '',
    )
    assert.equal(
      upstreamOf({
        cwd: project,
        branch: 'pnyx/other-task-1',
      }),
      '',
    )
    // Only task branches are repaired, and only when they track the default branch.
    assert.equal(
      upstreamOf({
        cwd: project,
        branch: 'fix/feature-work',
      }),
      'refs/remotes/origin/main',
    )
    git({
      cwd: first.path,
      args: [
        'branch',
        `--set-upstream-to=origin/${first.branch}`,
        first.branch,
      ],
    })
    await start({ key: 'third' })
    assert.equal(
      upstreamOf({
        cwd: first.path,
        branch: first.branch,
      }),
      `refs/remotes/origin/${first.branch}`,
    )

    // The upstream push reads is branch.<name>.merge, even where the fetch refspec maps no tracking branch for it.
    git({
      cwd: project,
      args: [
        'branch',
        'pnyx/custom-refspec-1',
        'origin/main',
      ],
    })

    for (const [
      key,
      value,
    ] of [
        [
          'branch.pnyx/custom-refspec-1.remote',
          'origin',
        ],
        [
          'branch.pnyx/custom-refspec-1.merge',
          'refs/heads/main',
        ],
      ]) {
      git({
        cwd: project,
        args: [
          'config',
          key!,
          value!,
        ],
      })
    }

    git({
      cwd: project,
      args: [
        'config',
        'remote.origin.fetch',
        '+refs/heads/pnyx/*:refs/remotes/origin/pnyx/*',
      ],
    })
    assert.equal(
      upstreamOf({
        cwd: project,
        branch: 'pnyx/custom-refspec-1',
      }),
      '',
    )
    await start({ key: 'fourth' })
    assert.equal(
      attempt({
        cwd: project,
        args: [
          'config',
          'branch.pnyx/custom-refspec-1.merge',
        ],
      }).ok,
      false,
    )
    git({
      cwd: project,
      args: [
        'config',
        'remote.origin.fetch',
        '+refs/heads/*:refs/remotes/origin/*',
      ],
    })

    // A task whose branch exists but whose copy is gone starts again: the folder was deleted, or the copy removed with no idle slot to reuse.
    const gone = await start({ key: 'gone' })
    await s.owner({
      args: [
        'task',
        'detach',
        'gone',
      ],
    })
    git({
      cwd: project,
      args: [
        'branch',
        '--set-upstream-to=origin/main',
        gone.branch!,
      ],
    })
    rmSync(
      gone.path,
      {
        recursive: true,
        force: true,
      },
    )
    await s.owner({
      args: [
        'task',
        'start',
        'gone',
      ],
    })
    const again = s.task({ key: 'gone' }).copy!
    assert.equal(
      again.branch,
      gone.branch,
    )
    assert.ok(existsSync(again.path))
    assert.equal(
      git({
        cwd: again.path,
        args: [
          'branch',
          '--show-current',
        ],
      }),
      gone.branch,
    )
    assert.equal(
      upstreamOf({
        cwd: project,
        branch: gone.branch!,
      }),
      '',
    )

    // The first task's work lands on main, as its merged pull request would; a removed copy's slot is reused by the next task with its ignored files and no upstream.
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
        'detach',
        'first',
      ],
    })
    const pooled = await start({ key: 'pooled' })
    assert.equal(
      pooled.path,
      first.path,
    )
    assert.ok(existsSync(join(
      pooled.path,
      'pool-proof',
    )))
    assert.equal(
      upstreamOf({
        cwd: pooled.path,
        branch: pooled.branch!,
      }),
      '',
    )
  },
)
