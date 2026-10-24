import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { git, scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()

function commitFile({
  cwd,
  file,
}: {
  cwd: string
  file: string
}): string {
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

  return git({
    cwd,
    args: [
      'rev-parse',
      'HEAD',
    ],
  })
}

test(
  'an older merged PR cannot release later local work across restart or reuse',
  async () => {
    const s = await pnyx.scenario()
    const project = await s.project({ name: 'app' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'tail',
        '--title',
        'Keep local tail',
        '--project',
        project,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'tail',
      ],
    })
    const copy = s.task({ key: 'tail' }).copy!
    const head = commitFile({
      cwd: copy.path,
      file: 'landed.txt',
    })
    git({
      cwd: copy.path,
      args: [
        'push',
        '-q',
        'origin',
        'HEAD:main',
      ],
    })
    const tail = commitFile({
      cwd: copy.path,
      file: 'local.txt',
    })
    const url = s.pullRequest({
      number: 41,
      state: 'merged',
    })
    await s.owner({
      args: [
        'link',
        'tail',
        '--url',
        url,
        '--state',
        'merged',
      ],
    })
    await s.owner({
      args: [
        'move',
        'tail',
        s.column({ role: 'done' })!,
      ],
    })
    await until({
      what: 'the unlanded copy to be retained',
      check: () => s.task({ key: 'tail' }).copy?.state === 'flagged',
    })
    assert.equal(
      s.merges({ number: 41 }),
      0,
    )
    await pnyx.restart()
    await s.owner({
      args: [
        'task',
        'copy',
        'tail',
        'remove',
      ],
    })
    assert.equal(
      s.task({ key: 'tail' }).copy?.state,
      'flagged',
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'task',
          'copy',
          'tail',
          'remove',
          '--safe',
        ],
      }),
      'CONFLICT',
    )
    assert.ok(existsSync(copy.path))
    assert.equal(
      git({
        cwd: copy.path,
        args: [
          'rev-parse',
          'HEAD',
        ],
      }),
      tail,
    )
    assert.equal(
      git({
        cwd: copy.path,
        args: [
          'cat-file',
          '-t',
          head,
        ],
      }),
      'commit',
    )
    assert.equal(
      readFileSync(
        join(
          copy.path,
          'local.txt',
        ),
        'utf8',
      ),
      'local.txt\n',
    )
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'next',
        '--title',
        'Next task',
        '--project',
        project,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'next',
      ],
    })
    assert.notEqual(
      s.task({ key: 'next' }).copy?.path,
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
      tail,
    )
  },
)

test(
  'branch-ready work keeps dirty and untracked files; clean landed work can settle',
  async () => {
    const s = await pnyx.scenario()
    const project = await s.project({
      name: 'branch-app',
      flags: [
        '--landing',
        'branch',
      ],
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'branch',
        '--title',
        'Branch ready',
        '--project',
        project,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'branch',
      ],
    })
    const copy = s.task({ key: 'branch' }).copy!
    const worker = s.as({ agent: await s.agent({ cwd: copy.path }) })
    const head = commitFile({
      cwd: copy.path,
      file: 'change.txt',
    })
    await worker.run({
      args: [
        'task',
        'status',
        'branch',
        'done',
      ],
    })
    await until({
      what: 'branch-ready work to be retained',
      check: () => s.task({ key: 'branch' }).copy?.state === 'flagged',
    })
    writeFileSync(
      join(
        copy.path,
        'change.txt',
      ),
      'tracked draft\n',
    )
    writeFileSync(
      join(
        copy.path,
        'untracked.txt',
      ),
      'untracked draft\n',
    )
    git({
      cwd: copy.path,
      args: [
        'push',
        '-q',
        'origin',
        'HEAD:main',
      ],
    })
    await s.owner({
      args: [
        'task',
        'copy',
        'branch',
        'remove',
      ],
    })
    assert.equal(
      s.task({ key: 'branch' }).copy?.state,
      'flagged',
    )
    await pnyx.restart()
    assert.equal(
      readFileSync(
        join(
          copy.path,
          'untracked.txt',
        ),
        'utf8',
      ),
      'untracked draft\n',
    )
    assert.equal(
      readFileSync(
        join(
          copy.path,
          'change.txt',
        ),
        'utf8',
      ),
      'tracked draft\n',
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
        'preserve both drafts',
      ],
    })
    git({
      cwd: copy.path,
      args: [
        'push',
        '-q',
        'origin',
        'HEAD:main',
      ],
    })
    await s.owner({
      args: [
        'task',
        'copy',
        'branch',
        'remove',
      ],
    })
    assert.equal(
      s.task({ key: 'branch' }).copy?.state,
      'removed',
    )
    assert.ok(existsSync(copy.path))
    assert.equal(
      git({
        cwd: copy.path,
        args: [
          'cat-file',
          '-t',
          head,
        ],
      }),
      'commit',
    )
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'other',
        '--title',
        'Other worker',
        '--project',
        project,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'other',
      ],
    })
    assert.notEqual(
      s.task({ key: 'other' }).copy?.path,
      copy.path,
    )
  },
)
