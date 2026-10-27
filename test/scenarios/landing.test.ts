import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { git, scenarioGroup, until } from './harness.ts'

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
