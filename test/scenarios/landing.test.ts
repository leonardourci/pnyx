import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { git, scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()

const change = ({
  copy,
  file,
}: {
  copy: string
  file: string
}) => {
  mkdirSync(
    join(
      copy,
      file,
      '..',
    ),
    { recursive: true },
  )
  writeFileSync(
    join(
      copy,
      file,
    ),
    `${file}\n`,
  )
}

const commitAll = ({ copy }: { copy: string }) => {
  git({
    cwd: copy,
    args: [
      'add',
      '.',
    ],
  })
  git({
    cwd: copy,
    args: [
      'commit',
      '-q',
      '-m',
      'work',
    ],
  })
}

const push = ({
  copy,
  to = 'HEAD',
}: {
  copy: string
  to?: string
}) => git({
  cwd: copy,
  args: [
    'push',
    '-q',
    'origin',
    to,
  ],
})

test(
  'a task in its own copy is done only once its pull request merges: a ready pull request goes to the owner, only the owner merges, and the merge frees the copy for the next task on a fresh branch',
  async () => {
    const s = await pnyx.scenario()
    const app = await s.project({ name: 'app' })
    assert.match(
      await s.owner({
        args: [
          'project',
          'list',
        ],
      }),
      new RegExp(
        `^ {2}app,${app},attached,pr,owner$`,
        'm',
      ),
    )
    assert.equal(
      (await s.ownerRefusal({
        args: [
          'project',
          'set',
          app,
          '--merge',
          'anyone',
        ],
      })).error,
      '--merge must be owner or hydra',
    )
    const hydraAgent = await s.chat({ text: 'Ship the invoice export.' })
    const hydra = s.as({ agent: hydraAgent })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Invoice export',
        '--key',
        'ship',
        '--project',
        app,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'ship',
      ],
    })
    const card = s.task({ key: 'ship' })
    const copy = card.copy!.path
    assert.deepEqual(
      [
        card.copy?.state,
        card.copy?.via,
        git({
          cwd: copy,
          args: [
            'branch',
            '--show-current',
          ],
        }),
        git({
          cwd: copy,
          args: [
            'rev-parse',
            'HEAD',
          ],
        }),
      ],
      [
        'active',
        'worktree',
        `pnyx/${s.hydraId}-${card.id}`,
        git({
          cwd: app,
          args: [
            'rev-parse',
            'origin/main',
          ],
        }),
      ],
    )
    const agent = await s.agent({ cwd: copy })
    const worker = s.as({ agent })
    assert.match(
      agent.received[0]!,
      /^Landing: commit on your branch, push it, open a ready pull request .* the owner merges it; never merge it yourself\./m,
    )

    const notDone = async () => (await worker.refusal({
      args: [
        'task',
        'status',
        'ship',
        'done',
      ],
    })).error
    change({
      copy,
      file: 'export.txt',
    })
    assert.equal(
      await notDone(),
      'not done yet: 1 file uncommitted',
    )
    commitAll({ copy })
    const head = git({
      cwd: copy,
      args: [
        'rev-parse',
        '--short',
        'HEAD',
      ],
    })
    assert.equal(
      await notDone(),
      `not done yet: commit ${head} is not pushed; no linked pull request`,
    )

    push({ copy })
    // Installed dependencies are ignored files the pool keeps for the next task.
    appendFileSync(
      join(
        app,
        '.git',
        'info',
        'exclude',
      ),
      'deps/\n',
    )
    change({
      copy,
      file: 'deps/installed',
    })
    const url = s.pullRequest({
      number: 1,
      draft: true,
      checks: '0 passed, 0 failed, 1 total',
    })
    await worker.run({
      args: [
        'link',
        'ship',
        '--url',
        url,
      ],
    })
    await until({
      what: 'Pnyx to read the draft pull request',
      check: () => s.task({ key: 'ship' }).links[0]?.draft === true,
    })
    assert.equal(
      s.task({ key: 'ship' }).column,
      s.column({ role: 'in_progress' }),
    )

    s.pullRequest({
      number: 1,
      checks: '0 passed, 0 failed, 1 total',
    })
    await until({
      what: 'the ready pull request to put the task in Needs you',
      check: () => s.task({ key: 'ship' }).column === s.column({ role: 'needs_you' }),
    })
    assert.deepEqual(
      [
        s.task({ key: 'ship' }).status?.state,
        s.task({ key: 'ship' }).status?.note,
        await notDone(),
      ],
      [
        'needs_you',
        `Pull request ready for owner review: ${url}`,
        'not done yet: its pull request has not merged',
      ],
    )
    const ready = s.task({ key: 'ship' }).status?.id
    s.pullRequest({
      number: 1,
      checks: '0 passed, 0 failed, 1 total',
      comments: 1,
    })
    await until({
      what: 'the worker to hear about the review comment',
      check: () => s.received({ cwd: copy }).some(m => m.startsWith(`1 new review comment on ${url}.`)),
    })
    assert.equal(
      s.task({ key: 'ship' }).status?.id,
      ready,
    )

    for (const [
      who,
      error,
    ] of [
        [
          hydra,
          'the owner merges this project\'s pull requests; ask them',
        ],
        [
          worker,
          'only the owner or Hydra merges a pull request',
        ],
      ] as const) {
      assert.equal(
        (await who.refusal({
          args: [
            'task',
            'merge',
            'ship',
          ],
        })).error,
        error,
      )
    }

    assert.equal(
      (await s.ownerRefusal({
        args: [
          'task',
          'merge',
          'ship',
        ],
      })).error,
      'checks are still running: 0 passed, 0 failed, 1 total',
    )
    s.pullRequest({
      number: 1,
      checks: '1 passed, 0 failed, 1 total',
      comments: 1,
    })
    const heard = hydraAgent.received.length
    await s.owner({
      args: [
        'task',
        'merge',
        'ship',
      ],
    })
    // GitHub merged the branch into main.
    push({
      copy,
      to: 'HEAD:main',
    })
    assert.equal(
      s.merges({ number: 1 }),
      1,
    )
    assert.deepEqual(
      [
        s.task({ key: 'ship' }).links[0]?.state,
        s.task({ key: 'ship' }).status?.state,
        s.task({ key: 'ship' }).status?.actor,
        s.task({ key: 'ship' }).column,
      ],
      [
        'merged',
        'done',
        'pnyx',
        s.column({ role: 'done' }),
      ],
    )
    // The merged pull request is where this project's work lands, so the worker's own done now goes through.
    await worker.run({
      args: [
        'task',
        'status',
        'ship',
        'done',
        '--note',
        'Merged',
      ],
    })
    await until({
      what: 'the merge to wake Hydra',
      check: () => hydraAgent.received.length > heard,
    })
    const released = await until({
      what: 'the copy to go back to the pool',
      check: () => s.task({ key: 'ship' }).copy?.state === 'removed' && s.task({ key: 'ship' }).copy,
    })
    assert.deepEqual(
      [
        released.reason,
        s.task({ key: 'ship' }).folder,
        git({
          cwd: app,
          args: [
            'rev-parse',
            '--verify',
            '--quiet',
            card.copy!.branch!,
          ],
        }).length > 0,
      ],
      [
        'its work landed; its folder went back to the pool',
        undefined,
        true,
      ],
    )

    // The finished worker leaves the copy, so the pool can hand it on.
    await s.owner({
      args: [
        'task',
        'detach',
        'ship',
      ],
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Invoice import',
        '--key',
        'next',
        '--project',
        app,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'next',
      ],
    })
    const next = s.task({ key: 'next' })
    assert.deepEqual(
      [
        next.copy?.path,
        git({
          cwd: copy,
          args: [
            'branch',
            '--show-current',
          ],
        }),
        git({
          cwd: copy,
          args: [
            'rev-parse',
            'HEAD',
          ],
        }),
        git({
          cwd: copy,
          args: [
            'status',
            '--porcelain',
          ],
        }),
      ],
      [
        copy,
        `pnyx/${s.hydraId}-${next.id}`,
        git({
          cwd: copy,
          args: [
            'rev-parse',
            'origin/main',
          ],
        }),
        '',
      ],
    )
    assert.ok(existsSync(join(
      copy,
      'deps',
      'installed',
    )))
  },
)

test(
  'under a Hydra merge rule the worker hears each new failure and comment once, the ready pull request stays in progress, and Hydra merges only once checks are green',
  async () => {
    const s = await pnyx.scenario()
    const app = await s.project({ name: 'api' })
    await s.owner({
      args: [
        'project',
        'set',
        app,
        '--merge',
        'hydra',
      ],
    })
    const hydra = s.as({ agent: await s.chat({ text: 'Fix the rate limiter.' }) })
    await hydra.run({
      args: [
        'task',
        'create',
        '--title',
        'Rate limiter',
        '--key',
        'limit',
        '--project',
        app,
        '--reason',
        'the owner asked for it',
      ],
    })
    await hydra.run({
      args: [
        'task',
        'start',
        'limit',
        '--reason',
        'the owner asked for it',
      ],
    })
    const copy = s.task({ key: 'limit' }).copy!.path
    const agent = await s.agent({ cwd: copy })
    const worker = s.as({ agent })
    assert.match(
      agent.received[0]!,
      /^Landing: .*Hydra merges it once every check is green/m,
    )
    change({
      copy,
      file: 'limit.txt',
    })
    commitAll({ copy })
    push({ copy })
    const url = s.pullRequest({
      number: 2,
      checks: '1 passed, 1 failed, 2 total',
    })
    await worker.run({
      args: [
        'link',
        'limit',
        '--url',
        url,
      ],
    })
    const told = ({ text }: { text: string }) => s.received({ cwd: copy })
      .filter(m => m.includes(text))
    await until({
      what: 'the worker to hear about the failed check',
      check: () => told({ text: `Checks failed on ${url}` }).length > 0,
    })
    assert.equal(
      (await hydra.refusal({
        args: [
          'task',
          'merge',
          'limit',
        ],
      })).error,
      'checks are red: 1 passed, 1 failed, 2 total',
    )

    s.pullRequest({
      number: 2,
      checks: '1 passed, 1 failed, 2 total',
      comments: 2,
    })
    await until({
      what: 'the worker to hear about the new comments',
      check: () => told({ text: `2 new review comments on ${url}` }).length > 0,
    })
    s.pullRequest({
      number: 2,
      checks: '2 passed, 0 failed, 2 total',
      comments: 2,
    })
    await until({
      what: 'Pnyx to read the green checks',
      check: () => s.task({ key: 'limit' }).links[0]?.checks === '2 passed, 0 failed, 2 total',
    })
    assert.deepEqual(
      [
        told({ text: `Checks failed on ${url}` }).length,
        told({ text: `new review comments on ${url}` }).length,
        s.task({ key: 'limit' }).column,
      ],
      [
        1,
        1,
        s.column({ role: 'in_progress' }),
      ],
    )

    await hydra.run({
      args: [
        'task',
        'merge',
        'limit',
      ],
    })
    assert.deepEqual(
      [
        s.merges({ number: 2 }),
        s.task({ key: 'limit' }).status?.state,
        s.task({ key: 'limit' }).status?.note,
        (await hydra.refusal({
          args: [
            'task',
            'merge',
            'limit',
          ],
        })).code,
      ],
      [
        1,
        'done',
        `Pull request ${url} merged`,
        'NOT_FOUND',
      ],
    )
    // Pnyx read the pull request many times; only its three changes were recorded.
    assert.equal(
      s.events().filter(e => e.type === 'card.linked' && e.actor === 'pnyx').length,
      3,
    )
  },
)

test(
  'a branch-landing task is done once its work is committed, its unlanded copy is kept for Hydra, and a task given the pull request rule still needs one',
  async () => {
    const s = await pnyx.scenario()
    const app = await s.project({
      name: 'site',
      flags: [
        '--landing',
        'branch',
      ],
    })
    assert.equal(
      (await s.ownerRefusal({
        args: [
          'project',
          'set',
          app,
          '--landing',
          'bogus',
        ],
      })).error,
      '--landing must be pr or branch',
    )
    assert.match(
      await s.owner({
        args: [
          'project',
          'list',
        ],
      }),
      new RegExp(
        `^ {2}site,${app},attached,branch,owner$`,
        'm',
      ),
    )
    const hydraAgent = await s.chat({ text: 'Two site fixes; open a pull request for the second.' })
    const hydra = s.as({ agent: hydraAgent })

    for (const key of [
      'copy-fix',
      'pr-fix',
    ]) {
      await s.owner({
        args: [
          'task',
          'create',
          '--title',
          key,
          '--key',
          key,
          '--project',
          app,
        ],
      })
    }

    // On the owner's word, Hydra gives one task a rule of its own.
    await hydra.run({
      args: [
        'task',
        'landing',
        'pr-fix',
        '--landing',
        'pr',
        '--reason',
        'the owner wants a pull request for it',
      ],
    })
    assert.match(
      await s.owner({
        args: [
          'task',
          'landing',
          'copy-fix',
        ],
      }),
      /^landing: branch\nmerge: owner\nfrom: project$/m,
    )

    for (const key of [
      'copy-fix',
      'pr-fix',
    ]) {
      await s.owner({
        args: [
          'task',
          'start',
          key,
        ],
      })
    }

    const copies = [
      s.task({ key: 'copy-fix' }).copy!.path,
      s.task({ key: 'pr-fix' }).copy!.path,
    ]
    const [
      branchWorker,
      prWorker,
    ] = await Promise.all(copies.map(cwd => s.agent({ cwd })))
    assert.match(
      branchWorker!.received[0]!,
      /^Landing: commit your work on your branch in this copy, then declare done\. Do not push or open a pull request/m,
    )
    assert.match(
      prWorker!.received[0]!,
      /^Landing: commit on your branch, push it, open a ready pull request/m,
    )
    assert.equal(
      (await s.as({ agent: prWorker! }).refusal({
        args: [
          'task',
          'landing',
          'pr-fix',
          '--landing',
          'branch',
        ],
      })).code,
      'FORBIDDEN',
    )

    for (const copy of copies) {
      change({
        copy,
        file: 'fix.txt',
      })
      commitAll({ copy })
    }

    await s.as({ agent: branchWorker! }).run({
      args: [
        'task',
        'status',
        'copy-fix',
        'done',
      ],
    })
    assert.match(
      (await s.as({ agent: prWorker! }).refusal({
        args: [
          'task',
          'status',
          'pr-fix',
          'done',
        ],
      })).error,
      /is not pushed; no linked pull request$/,
    )

    const kept = await until({
      what: 'the unlanded copy to be kept',
      check: () => s.task({ key: 'copy-fix' }).copy?.state === 'flagged' && s.task({ key: 'copy-fix' }).copy,
    })
    assert.equal(
      kept.reason,
      'its work has not landed on origin/main or main',
    )
    const id = s.task({ key: 'copy-fix' }).id
    await until({
      what: 'Hydra to hear the copy was kept',
      check: () => hydraAgent.received.length > 1,
    })
    const messages = await hydra.run({
      args: [
        'hydra',
        'messages',
      ],
    })
    assert.ok(
      messages.includes(`The copy of task ${id} \\"copy-fix\\" at ${copies[0]} was kept: its work has not landed`),
      messages,
    )
    // Discarding work that never landed is the owner's call: Hydra only proposes it in the chat.
    assert.match(
      await hydra.run({
        args: [
          'task',
          'copy',
          'copy-fix',
          'remove',
          '--discard',
        ],
      }),
      /^confirmation: needed$/m,
    )
    assert.deepEqual(
      [
        s.state().dispatchProposals?.map(p => p.kind),
        s.task({ key: 'copy-fix' }).copy?.state,
      ],
      [
        ['command'],
        'flagged',
      ],
    )

    // The owner lands the branch.
    push({
      copy: copies[0]!,
      to: 'HEAD:main',
    })
    await hydra.run({
      args: [
        'task',
        'copy',
        'copy-fix',
        'remove',
      ],
    })
    assert.equal(
      s.task({ key: 'copy-fix' }).copy?.reason,
      'its work landed; its folder went back to the pool',
    )

    // A commit on the default branch has landed under any rule.
    for (const args of [
      [
        'fetch',
        '-q',
        'origin',
      ],
      [
        'rebase',
        '-q',
        'origin/main',
      ],
    ]) {
      git({
        cwd: copies[1]!,
        args,
      })
    }

    push({
      copy: copies[1]!,
      to: 'HEAD:main',
    })
    await s.as({ agent: prWorker! }).run({
      args: [
        'task',
        'status',
        'pr-fix',
        'done',
      ],
    })
    await s.owner({
      args: [
        'task',
        'landing',
        'pr-fix',
        '--clear',
      ],
    })
    assert.match(
      await s.owner({
        args: [
          'task',
          'landing',
          'pr-fix',
        ],
      }),
      /^landing: branch\nmerge: owner\nfrom: project$/m,
    )
  },
)
