import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { wakeReasons } from '../src/hydra/wake-reasons.ts'
import { followPullRequests } from '../src/tasks/delivery/follow.ts'
import { refreshProject } from '../src/projects/refresh.ts'
import type { ProjectRefresh } from '../src/projects/refresh-types.ts'
import { git, until } from '../src/test-harness/harness.ts'
import { pnyx, type Scenario } from '../src/test-harness/pnyx.ts'

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

async function prepare({ s }: { s: Scenario }) {
  const path = await s.project({ name: 'app' })
  const publisher = s.folder({ name: 'publisher' })
  git({
    cwd: publisher,
    args: [
      'clone',
      '-q',
      `${path}.git`,
      '.',
    ],
  })
  writeFileSync(
    join(
      publisher,
      'landed.txt',
    ),
    'landed\n',
  )
  git({
    cwd: publisher,
    args: [
      'add',
      '.',
    ],
  })
  git({
    cwd: publisher,
    args: [
      'commit',
      '-qm',
      'Land change',
    ],
  })
  git({
    cwd: publisher,
    args: [
      'push',
      '-q',
      'origin',
      'main',
    ],
  })
  const target = git({
    cwd: publisher,
    args: [
      'rev-parse',
      'HEAD',
    ],
  })
  const before = git({
    cwd: path,
    args: [
      'rev-parse',
      'HEAD',
    ],
  })
  await s.owner({
    args: [
      'task',
      'create',
      '--title',
      'Ship change',
      '--key',
      'ship',
      '--project',
      path,
    ],
  })

  return {
    path,
    publisher,
    target,
    before,
  }
}

async function land({
  s,
  target,
}: {
  s: Scenario
  target: string
}) {
  const url = s.pullRequest({
    number: 1,
    head: target,
    merge: target,
  })
  await s.owner({
    args: [
      'link',
      'ship',
      '--url',
      url,
    ],
  })
  s.pullRequest({
    number: 1,
    state: 'merged',
    head: target,
    merge: target,
  })
  const result = await until({
    what: 'confirmed merge to record its project refresh',
    check: () => s.task({ key: 'ship' }).projectRefresh?.[url],
  })

  const card = s.task({ key: 'ship' })
  assert.equal(
    card.links[0]?.state,
    'merged',
  )
  assert.equal(
    card.links[0]?.mergeProof?.commit,
    target,
  )
  assert.equal(
    card.status?.state,
    'done',
  )

  return {
    url,
    result,
  }
}

function contents({ path }: { path: string }) {
  return {
    head: git({
      cwd: path,
      args: [
        'rev-parse',
        'HEAD',
      ],
    }),
    branch: git({
      cwd: path,
      args: [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ],
    }),
    files: git({
      cwd: path,
      args: [
        'status',
        '--porcelain',
        '--untracked-files=all',
      ],
    }),
    diff: git({
      cwd: path,
      args: [
        'diff',
        'HEAD',
      ],
    }),
    readme: readFileSync(
      join(
        path,
        'README.md',
      ),
      'utf8',
    ),
  }
}

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

    // 2d732aa0: a copy is never removed without proof its work landed.
    assert.match(
      await hydra.run({
        args: [
          'task',
          'copy',
          'copy-fix',
          'remove',
        ],
      }),
      /^ {2}landed: false$/m,
    )
    assert.deepEqual(
      [
        s.task({ key: 'copy-fix' }).copy?.state,
        existsSync(copies[0]!),
      ],
      [
        'flagged',
        true,
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

test(
  'a merge waits for every required check green on its head; a queued merge stays unfinished with its copy and is not submitted twice; the merge GitHub confirms finishes the task, advances the clean project once, and holds across restart',
  async () => {
    const s = await pnyx.scenario()
    const app = await s.project({
      name: 'app',
      flags: [
        '--merge',
        'hydra',
      ],
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Ship safely',
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
    const copy = s.task({ key: 'ship' }).copy!.path
    await s.agent({ cwd: copy })
    writeFileSync(
      join(
        copy,
        'work.txt',
      ),
      'retain until merged\n',
    )
    git({
      cwd: copy,
      args: [
        'add',
        'work.txt',
      ],
    })
    git({
      cwd: copy,
      args: [
        'commit',
        '-qm',
        'ship',
      ],
    })
    git({
      cwd: copy,
      args: [
        'push',
        '-q',
        'origin',
        'HEAD',
      ],
    })
    const head = git({
      cwd: copy,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })

    // 97c60b05, 157ededf: a merge needs every required check verified green on the head, including
    // checks past the first page, whatever the aggregate claims.
    const required = Array.from(
      { length: 101 },
      (
        _,
        index,
      ) => ({
        context: `check-${index}`,
        app: 10,
      }),
    )
    const runs = required.map(check => ({
      name: check.context,
      app: 10,
      conclusion: 'success' as string | null,
    }))
    const url = s.pullRequest({
      number: 1,
      head,
      checks: '102 passed, 0 failed, 102 total',
      required,
      runs: [
        ...runs.map((
          run,
          index,
        ) => ({
          ...run,
          conclusion: index === 100 ? 'failure' : run.conclusion,
        })),
        {
          name: 'deploy',
          app: 10,
          conclusion: null,
        },
      ],
    })
    await s.owner({
      args: [
        'link',
        'ship',
        '--url',
        url,
      ],
    })
    assert.deepEqual(
      [
        await s.ownerRefusal({
          args: [
            'task',
            'merge',
            'ship',
          ],
        }),
        s.merges({ number: 1 }),
      ],
      [
        {
          code: 'CONFLICT',
          error: 'check is not green: check-100; check still running: deploy',
        },
        0,
      ],
    )
    s.pullRequest({
      number: 1,
      head,
      required,
      runs,
      mergeBehavior: 'queued',
    })
    const output = await s.owner({
      args: [
        'task',
        'merge',
        'ship',
      ],
    })
    assert.match(
      output,
      new RegExp('merge: queued'),
    )
    const pending = s.task({ key: 'ship' })
    assert.equal(
      pending.links[0]?.state,
      'open',
    )
    assert.equal(
      pending.links[0]?.mergeAttempt?.head,
      head,
    )
    assert.notEqual(
      pending.status?.state,
      'done',
    )
    assert.notEqual(
      pending.copy?.state,
      'removed',
    )
    assert.equal(
      existsSync(join(
        copy,
        'work.txt',
      )),
      true,
    )
    assert.equal(
      s.merges({ number: 1 }),
      1,
    )
    assert.equal(
      s.events().some(event => event.type === 'card.linked' && event.data.after?.state === 'merged'),
      false,
    )
    await pnyx.restart()
    assert.equal(
      s.task({ key: 'ship' }).links[0]?.mergeAttempt?.outcome,
      'queued',
    )

    await s.owner({
      args: [
        'task',
        'merge',
        'ship',
      ],
    })

    assert.equal(
      s.merges({ number: 1 }),
      1,
    )

    git({
      cwd: copy,
      args: [
        'push',
        '-q',
        'origin',
        'HEAD:main',
      ],
    })
    s.pullRequest({
      number: 1,
      head,
      merge: head,
      state: 'merged',
    })
    await until({
      what: 'confirmed merge to finish the task',
      check: () => s.task({ key: 'ship' }).status?.state === 'done',
    })
    await until({
      what: 'confirmed landing to settle the retained copy',
      check: () => s.task({ key: 'ship' }).copy?.state === 'removed',
    })
    const confirmed = s.task({ key: 'ship' }).links[0]!
    // The confirmed merge advances the clean attached project, which needs no wake.
    const refreshed = await until({
      what: 'the confirmed merge to refresh the project',
      check: () => s.task({ key: 'ship' }).projectRefresh?.[url],
    })
    assert.deepEqual(
      [
        refreshed.state,
        refreshed.after,
        git({
          cwd: app,
          args: [
            'rev-parse',
            'HEAD',
          ],
        }),
        wakeReasons({
          state: s.state(),
          events: s.events().filter(event => event.type === 'project.refreshed'),
        }),
      ],
      [
        'advanced',
        head,
        head,
        [],
      ],
    )
    assert.equal(
      confirmed.state,
      'merged',
    )
    assert.equal(
      confirmed.mergeProof?.head,
      head,
    )
    assert.equal(
      confirmed.mergeProof?.commit,
      head,
    )
    assert.equal(
      s.merges({ number: 1 }),
      1,
    )
    await pnyx.restart()
    assert.deepEqual(
      s.task({ key: 'ship' }).links[0]?.mergeProof,
      confirmed.mergeProof,
    )
    await followPullRequests({ hydraId: s.hydraId })
    assert.equal(
      s.events().filter(event => event.type === 'project.refreshed').length,
      1,
    )
    assert.equal(
      s.merges({ number: 1 }),
      1,
    )
  },
)

test(
  'follower preserves a dirty copy and tells Hydra why',
  async () => {
    const s = await pnyx.scenario()
    const {
      path,
      target,
    } = await prepare({ s })
    writeFileSync(
      join(
        path,
        'README.md',
      ),
      'owner edits\n',
    )
    const saved = contents({ path })
    const defaultHead = git({
      cwd: path,
      args: [
        'rev-parse',
        'refs/heads/main',
      ],
    })
    await s.chat({ text: 'Watch this landing' })
    const hydra = await s.agent({ hydra: true })
    const { result } = await land({
      s,
      target,
    })
    assert.ok(result.state === 'needs-attention' || result.state === 'unknown')
    assert.ok(result.reason)
    assert.deepEqual(
      contents({ path }),
      saved,
    )
    assert.equal(
      git({
        cwd: path,
        args: [
          'rev-parse',
          'refs/heads/main',
        ],
      }),
      defaultHead,
    )
    await until({
      what: 'Hydra to receive an actionable refresh failure',
      check: () => hydra.received.some(text => text.includes('project refresh:') && text.includes(result.reason!)),
    })
    const recorded = s.events().filter(event => event.type === 'project.refreshed')
    await pnyx.restart()
    await followPullRequests({ hydraId: s.hydraId })
    assert.equal(
      s.events().filter(event => event.type === 'project.refreshed').length,
      recorded.length,
    )
  },
)

test(
  'refresh lock churn cannot bypass its deadline',
  async t => {
    const s = await pnyx.scenario()
    const {
      path,
      target,
      before,
    } = await prepare({ s })
    const lock = join(
      path,
      '.git',
      'pnyx-project-refresh.lock',
    )
    const symlink = fsPromises.symlink
    const readlink = fsPromises.readlink
    let now = 0
    let attempts = 0
    let result: ProjectRefresh | undefined
    t.mock.method(
      fsPromises,
      'symlink',
      // eslint-disable-next-line pnyx/object-params -- preserves the fs API signature
      async (...args: Parameters<typeof symlink>) => {
        if (args[1] === lock) {
          assert.ok(
            ++attempts <= 3,
            'lock churn must stop at the deadline',
          )
          now += 15_000
          throw Object.assign(
            new Error('lock was just created'),
            { code: 'EEXIST' },
          )
        }

        return symlink(...args)
      },
    )
    t.mock.method(
      fsPromises,
      'readlink',
      // eslint-disable-next-line pnyx/object-params -- preserves the fs API signature
      async (...args: Parameters<typeof readlink>) => {
        if (args[0] === lock) {
          throw Object.assign(
            new Error('lock was just removed'),
            { code: 'ENOENT' },
          )
        }

        return readlink(...args)
      },
    )
    syncBuiltinESMExports()

    try {
      await refreshProject({
        path,
        url: 'https://github.com/fixture/project/pull/1',
        merge: target,
        isPending: () => true,
        lockWait: {
          now: () => now,
          schedule: () => {
            throw new Error('a vanished lock needs no timer')
          },
        },
        complete: ({ result: completed }) => {
          result = completed
        },
      })
      assert.equal(
        attempts,
        2,
      )
      assert.ok(result)
      assert.equal(
        result.state,
        'unknown',
      )
      assert.match(
        result.reason!,
        /timed out waiting for the active project refresh after 30000ms/,
      )
      assert.ok(result.reason!.includes(lock))
      assert.equal(
        git({
          cwd: path,
          args: [
            'rev-parse',
            'HEAD',
          ],
        }),
        before,
      )
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
  },
)

test(
  'project refresh waits for its owner under EMFILE and advances after release',
  async t => {
    const s = await pnyx.scenario()
    const {
      path,
      target,
      before,
    } = await prepare({ s })
    // Fault injection needs a free native slot, independent of earlier Hydras.
    await pnyx.restart({
      whileStopped: async () => {
        const lock = join(
          path,
          '.git',
          'pnyx-project-refresh.lock',
        )
        symlinkSync(
          `pnyx-refresh:${process.pid}:external-owner`,
          lock,
        )
        const original = fs.watch
        let injected = false
        const errors = t.mock.method(
          console,
          'error',
          () => {},
        )
        t.mock.method(
          fs,
          'watch',
          // eslint-disable-next-line pnyx/object-params -- Node owns fs.watch's signature.
          (...args: Parameters<typeof fs.watch>) => {
            if (String(args[0]) !== join(
              path,
              '.git',
            )) {
              return Reflect.apply(
                original,
                fs,
                args,
              ) as fs.FSWatcher
            }

            injected = true
            throw Object.assign(
              new Error('refresh watcher limit'),
              { code: 'EMFILE' },
            )
          },
        )
        syncBuiltinESMExports()
        t.after(() => {
          fs.rmSync(
            lock,
            { force: true },
          )
          t.mock.restoreAll()
          syncBuiltinESMExports()
        })
        let result: ProjectRefresh | undefined
        const results: ProjectRefresh[] = []
        const refreshing = refreshProject({
          path,
          url: 'https://github.com/fixture/project/pull/1',
          merge: target,
          isPending: () => true,
          complete: ({ result: value }) => {
            result = value
            results.push(value)
          },
        })

        try {
          await until({
            what: 'refresh to wait through its watcher failure',
            check: () => injected && errors.mock.calls.length > 0,
          })
          assert.equal(
            result,
            undefined,
          )
          assert.equal(
            git({
              cwd: path,
              args: [
                'rev-parse',
                'HEAD',
              ],
            }),
            before,
          )
          unlinkSync(lock)
          await refreshing
          assert.equal(
            results[0]?.state,
            'advanced',
          )
          assert.equal(
            git({
              cwd: path,
              args: [
                'rev-parse',
                'HEAD',
              ],
            }),
            target,
          )
        } finally {
          fs.rmSync(
            lock,
            { force: true },
          )
          await refreshing
          t.mock.restoreAll()
          syncBuiltinESMExports()
        }
      },
    })
  },
)
