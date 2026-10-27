import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { git, scenarioGroup, until } from '../../src/test-harness/harness.ts'

const pnyx = scenarioGroup({ incorporateSteering: true })

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
  'a task in its own copy is done only once its pull request merges: a ready pull request asks the owner, approval lets Hydra merge, and the merge frees the copy for the next task on a fresh branch',
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
    const mergeQuestion = s.task({ key: 'ship' }).asks?.find(ask => ask.kind === 'merge')
    assert.ok(mergeQuestion)
    await s.owner({
      args: [
        'task',
        'answer',
        'ship',
        mergeQuestion.id,
        '--choice',
        'Merge',
      ],
    })
    assert.equal(
      s.task({ key: 'ship' }).column,
      s.column({ role: 'in_progress' }),
    )
    assert.ok(s.task({ key: 'ship' }).asks?.find(ask => ask.id === mergeQuestion.id)?.answered)
    s.pullRequest({
      number: 1,
      checks: '1 passed, 0 failed, 1 total',
      comments: 1,
    })
    await until({
      what: 'the approved green merge wake',
      check: () => hydraAgent.received.some(text => text.includes('approved merge is green') && text.includes(url)),
    })
    const heard = hydraAgent.received.length
    // The fake forge confirms a merge only after its remote contains the landed commit.
    push({
      copy,
      to: 'HEAD:main',
    })
    await hydra.run({
      args: [
        'task',
        'merge',
        'ship',
        '--reason',
        'Owner approved and all checks passed',
      ],
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
    await until({
      what: 'the merge to wake Hydra',
      check: () => hydraAgent.received.slice(heard).some(text => text.startsWith('<pnyx-wake>')),
    })
    await until({
      what: 'the copy to go back to the pool',
      check: () => s.task({ key: 'ship' }).copy?.state === 'removed',
    })
    assert.deepEqual(
      [
        s.task({ key: 'ship' }).copy?.reason,
        s.task({ key: 'ship' }).folder,
        git({
          cwd: app,
          args: [
            'rev-parse',
            '--short',
            card.copy!.branch!,
          ],
        }),
      ],
      [
        'its work landed; its folder went back to the pool',
        undefined,
        head,
      ],
    )

    // Someone else moves main on; the next task must start from it, not from what this folder last saw.
    const elsewhere = s.folder({ name: 'elsewhere' })
    git({
      cwd: elsewhere,
      args: [
        'clone',
        '-q',
        `${app}.git`,
        '.',
      ],
    })
    change({
      copy: elsewhere,
      file: 'later.txt',
    })
    commitAll({ copy: elsewhere })
    push({ copy: elsewhere })

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
          cwd: app,
          args: [
            'ls-remote',
            `${app}.git`,
            'main',
          ],
        }).split('\t')[0],
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
        // Pnyx read the pull request many times; only its three changes were recorded.
        s.events().filter(e => e.type === 'card.linked' && e.actor === 'pnyx').length,
      ],
      [
        1,
        1,
        s.column({ role: 'in_progress' }),
        3,
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
  },
)

test(
  'a branch-landing task is done once all its work is committed, its unlanded copy is kept for Hydra, and a task given the pull request rule is done when GitHub merges its pull request',
  async () => {
    const s = await pnyx.scenario()
    const app = await s.project({
      name: 'site',
      flags: [
        '--landing',
        'branch',
        '--merge',
        'hydra',
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
        `^ {2}site,${app},attached,branch,hydra$`,
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
    const rule = ({ key }: { key: string }) => s.owner({
      args: [
        'task',
        'landing',
        key,
      ],
    })
    assert.match(
      await rule({ key: 'copy-fix' }),
      /^landing: branch\nmerge: hydra\nfrom: project$/m,
    )
    assert.match(
      await rule({ key: 'pr-fix' }),
      /^landing: pr\nmerge: hydra\nfrom: task$/m,
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
      branchAgent,
      prAgent,
    ] = await Promise.all(copies.map(cwd => s.agent({ cwd })))
    const branchWorker = s.as({ agent: branchAgent! })
    const prWorker = s.as({ agent: prAgent! })
    assert.match(
      branchAgent!.received[0]!,
      /^Landing: commit your work on your branch in this copy, then declare done\. Do not push or open a pull request/m,
    )
    assert.match(
      prAgent!.received[0]!,
      /^Landing: commit on your branch, push it, open a ready pull request/m,
    )
    assert.equal(
      (await prWorker.refusal({
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

    const done = ({ key }: { key: string }) => [
      'task',
      'status',
      key,
      'done',
    ]

    for (const copy of copies) {
      change({
        copy,
        file: 'fix.txt',
      })
    }

    assert.equal(
      (await branchWorker.refusal({
        args: done({ key: 'copy-fix' }),
      })).error,
      'not done yet: 1 file uncommitted',
    )

    for (const copy of copies) {
      commitAll({ copy })
    }

    await branchWorker.run({
      args: done({ key: 'copy-fix' }),
    })
    assert.match(
      (await prWorker.refusal({
        args: done({ key: 'pr-fix' }),
      })).error!,
      /is not pushed; no linked pull request$/,
    )

    await until({
      what: 'the unlanded copy to be kept',
      check: () => s.task({ key: 'copy-fix' }).copy?.state === 'flagged',
    })
    const id = s.task({ key: 'copy-fix' }).id
    const messages = await hydra.run({
      args: [
        'hydra',
        'messages',
      ],
    })
    assert.deepEqual(
      [
        s.task({ key: 'copy-fix' }).copy?.reason,
        messages.includes(`The copy of task ${id} \\"copy-fix\\" at ${copies[0]} was kept: its work has not landed`),
      ],
      [
        'its work has not landed on origin/main',
        true,
      ],
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

    push({ copy: copies[1]! })
    const url = s.pullRequest({ number: 3 })
    await prWorker.run({
      args: [
        'link',
        'pr-fix',
        '--url',
        url,
      ],
    })
    await until({
      what: 'Pnyx to read the open pull request',
      check: () => s.task({ key: 'pr-fix' }).links[0]?.state === 'open',
    })
    // Merged on GitHub, not through task merge.
    s.pullRequest({
      number: 3,
      state: 'merged',
    })
    await until({
      what: 'the merge on GitHub to finish the task',
      check: () => s.task({ key: 'pr-fix' }).status?.state === 'done',
    })
    assert.deepEqual(
      [
        s.task({ key: 'pr-fix' }).status?.note,
        s.task({ key: 'pr-fix' }).status?.actor,
        s.task({ key: 'pr-fix' }).column,
        s.task({ key: 'pr-fix' }).links[0]?.state,
        s.merges({ number: 3 }),
      ],
      [
        `Pull request ${url} merged`,
        'pnyx',
        s.column({ role: 'done' }),
        'merged',
        0,
      ],
    )

    await s.owner({
      args: [
        'task',
        'landing',
        'pr-fix',
        '--clear',
      ],
    })
    assert.match(
      await rule({ key: 'pr-fix' }),
      /^landing: branch\nmerge: hydra\nfrom: project$/m,
    )
  },
)

test(
  'an owner approval on an already-green pull request wakes Hydra to merge it and records Done',
  async () => {
    const s = await pnyx.scenario()
    const app = await s.project({ name: 'green-app' })
    const agent = await s.chat({ text: 'Review the completed change.' })
    const hydra = s.as({ agent })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Green change',
        '--key',
        'green',
        '--project',
        app,
      ],
    })
    await s.owner({
      args: [
        'task',
        'status',
        'green',
        'working',
      ],
    })
    const url = s.pullRequest({
      number: 147,
      checks: '1 passed, 0 failed, 1 total',
    })
    await s.owner({
      args: [
        'link',
        'green',
        '--url',
        url,
      ],
    })
    const ask = await until({
      what: 'the ready merge question',
      check: () => s.task({ key: 'green' }).asks?.find(a => a.kind === 'merge'),
    })
    assert.equal(
      s.task({ key: 'green' }).column,
      s.column({ role: 'needs_you' }),
    )
    const heard = agent.received.length
    await s.owner({
      args: [
        'task',
        'answer',
        'green',
        ask.id,
        '--choice',
        'Merge',
      ],
    })
    assert.equal(
      s.task({ key: 'green' }).column,
      s.column({ role: 'in_progress' }),
    )
    await until({
      what: 'the already-green approval wake',
      check: () => agent.received.slice(heard).some(text => text.includes('approved merge is green') && text.includes(url)),
    })
    await hydra.run({
      args: [
        'task',
        'merge',
        'green',
        '--reason',
        'The owner approved the green pull request',
      ],
    })
    assert.equal(
      s.task({ key: 'green' }).column,
      s.column({ role: 'done' }),
    )
    assert.equal(
      s.task({ key: 'green' }).links[0]?.state,
      'merged',
    )
    assert.equal(
      s.merges({ number: 147 }),
      1,
    )
  },
)
