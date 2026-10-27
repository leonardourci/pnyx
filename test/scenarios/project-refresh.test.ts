import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { refreshProject } from '../../src/projects/refresh.ts'
import type { ProjectRefresh } from '../../src/projects/refresh-types.ts'
import { advanceQueues } from '../../src/queue/advance.ts'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, symlinkSync, readlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { git, scenarioGroup, until } from './harness.ts'
import { wakeReasons } from '../../src/core/wake-reasons.ts'
import { decideLink } from '../../src/core/decide.ts'
import { declareTask } from '../../src/core/hydra.ts'
import { withWriter } from '../../src/store/hydra-store.ts'
import { confirmedMerge } from '../../src/landing/confirmed.ts'
import { followPullRequests } from '../../src/landing/follow.ts'

const pnyx = scenarioGroup()
const runFile = promisify(execFile)
const CHILD_TIMEOUT_MS = 60_000
type Scenario = Awaited<ReturnType<typeof pnyx.scenario>>

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
  direct = false,
}: {
  s: Scenario
  target: string
  direct?: boolean
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

  if (direct) {
    await s.owner({
      args: [
        'task',
        'merge',
        'ship',
      ],
    })
  } else {
    s.pullRequest({
      number: 1,
      state: 'merged',
      head: target,
      merge: target,
    })
  }

  const result = await until({
    what: 'confirmed merge to record its project refresh',
    check: () => s.task({ key: 'ship' }).projectRefresh?.[url],
  })

  if (result.state === 'current' || result.state === 'advanced') {
    const recorded = s.events().filter(event => event.type === 'project.refreshed')
    assert.deepEqual(
      wakeReasons({
        state: s.state(),
        events: recorded,
      }),
      [],
    )
  }

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
  'task merge advances the ordinary clean default and restart does not refresh it again',
  async () => {
    const s = await pnyx.scenario()
    const {
      path,
      target,
      before,
    } = await prepare({ s })
    await s.chat({ text: 'Watch this safe landing' })
    const { result } = await land({
      s,
      target,
      direct: true,
    })
    assert.equal(
      result.state,
      'advanced',
    )
    assert.equal(
      result.before,
      before,
    )
    assert.equal(
      result.target,
      target,
    )
    assert.equal(
      result.after,
      target,
    )
    assert.equal(
      result.defaultBranch,
      'main',
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
    assert.equal(
      readFileSync(
        join(
          path,
          'landed.txt',
        ),
        'utf8',
      ),
      'landed\n',
    )
    await pnyx.restart()
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

for (const unsafe of [
  'dirty',
  'untracked',
  'diverged',
  'ahead',
  'feature',
  'detached',
  'default elsewhere',
  'index lock',
  'fetch failure',
  'refresh lock',
  'merge in progress',
]) {
  test(
    `follower preserves a copy with ${unsafe} and tells Hydra why`,
    async () => {
      const s = await pnyx.scenario()
      const {
        path,
        target,
        publisher,
      } = await prepare({ s })

      let otherCopy: string | undefined

      if (unsafe === 'dirty') {
        writeFileSync(
          join(
            path,
            'README.md',
          ),
          'owner edits\n',
        )
      } else if (unsafe === 'untracked') {
        writeFileSync(
          join(
            path,
            'owner.txt',
          ),
          'owner work\n',
        )
      } else if (unsafe === 'feature') {
        git({
          cwd: path,
          args: [
            'checkout',
            '-qb',
            'feature',
          ],
        })
      } else if (unsafe === 'diverged' || unsafe === 'detached' || unsafe === 'ahead') {
        if (unsafe === 'ahead') {
          git({
            cwd: path,
            args: [
              'pull',
              '--ff-only',
              '-q',
            ],
          })
        }

        writeFileSync(
          join(
            path,
            'owner.txt',
          ),
          'unique owner work\n',
        )
        git({
          cwd: path,
          args: [
            'add',
            '.',
          ],
        })
        git({
          cwd: path,
          args: [
            'commit',
            '-qm',
            'Owner work',
          ],
        })

        if (unsafe === 'detached') {
          git({
            cwd: path,
            args: [
              'checkout',
              '--detach',
              '-q',
            ],
          })
        }
      } else if (unsafe === 'default elsewhere') {
        git({
          cwd: path,
          args: [
            'checkout',
            '--detach',
            '-q',
          ],
        })
        otherCopy = s.folder({ name: 'default-copy' })
        git({
          cwd: path,
          args: [
            'worktree',
            'add',
            '-q',
            otherCopy,
            'main',
          ],
        })
      } else if (unsafe === 'index lock') {
        writeFileSync(
          join(
            path,
            '.git',
            'index.lock',
          ),
          'owned lock\n',
        )
      } else if (unsafe === 'refresh lock') {
        writeFileSync(
          join(
            path,
            '.git',
            'pnyx-project-refresh.lock',
          ),
          'owned lock\n',
        )
      } else if (unsafe === 'merge in progress') {
        writeFileSync(
          join(
            path,
            '.git',
            'MERGE_HEAD',
          ),
          `${target}\n`,
        )
      } else if (unsafe === 'fetch failure') {
        git({
          cwd: path,
          args: [
            'config',
            'remote.origin.url',
            join(
              publisher,
              'missing-origin',
            ),
          ],
        })
      }

      const saved = contents({ path })
      let otherSaved: ReturnType<typeof contents> | undefined

      if (otherCopy) {
        otherSaved = contents({ path: otherCopy })
      }

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

      if (otherCopy) {
        assert.deepEqual(
          contents({ path: otherCopy }),
          otherSaved,
        )
      }

      if ([
        'untracked',
        'diverged',
        'detached',
        'ahead',
      ].includes(unsafe)) {
        assert.match(
          readFileSync(
            join(
              path,
              'owner.txt',
            ),
            'utf8',
          ),
          /owner/,
        )
      }

      if (unsafe === 'index lock' || unsafe === 'refresh lock') {
        const lockName = unsafe === 'index lock' ? 'index.lock' : 'pnyx-project-refresh.lock'
        assert.equal(
          readFileSync(
            join(
              path,
              '.git',
              lockName,
            ),
            'utf8',
          ),
          'owned lock\n',
        )
        assert.match(
          result.reason,
          /lock/i,
        )
      }

      await until({
        what: 'Hydra to receive an actionable refresh failure',
        check: () => hydra.received.some(text => text.includes('project refresh:') && text.includes(result.reason!)),
      })

      if (unsafe === 'dirty') {
        const recorded = s.events().filter(event => event.type === 'project.refreshed')
        await pnyx.restart()
        await followPullRequests({ hydraId: s.hydraId })
        assert.equal(
          s.events().filter(event => event.type === 'project.refreshed').length,
          recorded.length,
        )
      }
    },
  )
}

test(
  'current default stays quiet and discovers a renamed remote default',
  async () => {
    const s = await pnyx.scenario()
    const {
      path,
      target,
      publisher,
    } = await prepare({ s })
    git({
      cwd: publisher,
      args: [
        'push',
        '-q',
        'origin',
        'main:trunk',
      ],
    })
    git({
      cwd: `${path}.git`,
      args: [
        'symbolic-ref',
        'HEAD',
        'refs/heads/trunk',
      ],
    })
    git({
      cwd: path,
      args: [
        'fetch',
        '-q',
        'origin',
      ],
    })
    git({
      cwd: path,
      args: [
        'checkout',
        '-qb',
        'trunk',
        'origin/trunk',
      ],
    })
    await s.chat({ text: 'Watch this landing' })
    const hydra = await s.agent({ hydra: true })
    const { result } = await land({
      s,
      target,
    })
    assert.equal(
      result.state,
      'current',
    )
    assert.equal(
      result.defaultBranch,
      'trunk',
    )
    await followPullRequests({ hydraId: s.hydraId })
    assert.equal(
      hydra.received.some(text => text.includes('project refresh:')),
      false,
    )
  },
)

test(
  'two Hydras using a canonical project path serialize and advance it once',
  async () => {
    const first = await pnyx.scenario()
    const second = await pnyx.scenario()
    const {
      path,
      target,
    } = await prepare({ s: first })
    const alias = join(
      second.folder({ name: 'links' }),
      'app',
    )
    symlinkSync(
      path,
      alias,
    )
    const preview = await second.owner({
      args: [
        'project',
        'add',
        alias,
      ],
    })
    const token = /^token: (.+)$/m.exec(preview)?.[1]
    assert.ok(
      token,
      preview,
    )
    await second.owner({
      args: [
        'project',
        'add',
        alias,
        '--confirm',
        token,
      ],
    })
    await second.owner({
      args: [
        'task',
        'create',
        '--title',
        'Same landing',
        '--key',
        'ship',
        '--project',
        alias,
      ],
    })
    assert.equal(
      second.state().projects?.[0]?.path,
      path,
    )
    await second.owner({
      args: [
        'task',
        'rename',
        'ship',
        '--project',
        alias,
      ],
    })
    assert.equal(
      second.task({ key: 'ship' }).project,
      alias,
    )
    const at = new Date().toISOString()
    const proof = {
      head: target,
      commit: target,
      confirmedAt: at,
    }
    const confirmations = [
      first,
      second,
    ].map(s => {
      const url = s.pullRequest({
        number: 1,
        state: 'merged',
        head: target,
        merge: target,
      })

      return {
        s,
        url,
      }
    })
    await pnyx.restart({
      whileStopped: () => {
        for (const {
          s,
          url,
        } of confirmations) {
          withWriter({
            hydraId: s.hydraId,
            fn: ({ writer }) => {
              const decision = decideLink({
                state: writer.state,
                ref: 'ship',
                url,
                link: {
                  kind: 'github_pr',
                  url,
                  state: 'merged',
                  mergeProof: proof,
                },
                meta: {
                  actor: 'pnyx',
                  at,
                },
              })
              assert.ok('event' in decision)
              writer.append({ event: decision.event })
            },
          })
        }
      },
    })
    await Promise.all(confirmations.map(({
      s,
      url,
    }) => confirmedMerge({
      hydraId: s.hydraId,
      cardId: s.task({ key: 'ship' }).id,
      url,
      proof,
    })))
    const results = confirmations.map(({
      s,
      url,
    }) => {
      const result = s.task({ key: 'ship' }).projectRefresh?.[url]
      assert.ok(
        result,
        JSON.stringify({
          task: s.task({ key: 'ship' }),
          projects: s.state().projects,
        }),
      )

      return result
    })
    assert.deepEqual(
      results.map(result => result.state).sort(),
      [
        'advanced',
        'current',
      ],
    )
    assert.equal(
      results[0]?.repository,
      results[1]?.repository,
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
  },
)

test(
  'restart after Done and saved proof recovers refresh and event replay retains its outcome',
  async () => {
    const s = await pnyx.scenario()
    const {
      path,
      target,
    } = await prepare({ s })
    const url = s.pullRequest({
      number: 1,
      state: 'merged',
      head: target,
      merge: target,
    })
    await pnyx.restart({
      whileStopped: () => {
        withWriter({
          hydraId: s.hydraId,
          fn: ({ writer }) => {
            const at = new Date().toISOString()
            const linked = decideLink({
              state: writer.state,
              ref: 'ship',
              url,
              link: {
                kind: 'github_pr',
                url,
                state: 'merged',
                mergeProof: {
                  head: target,
                  commit: target,
                  confirmedAt: at,
                },
              },
              meta: {
                actor: 'pnyx',
                at,
              },
            })
            assert.ok('event' in linked)
            writer.append({ event: linked.event })
            const done = declareTask({
              state: writer.state,
              ref: 'ship',
              status: 'done',
              note: 'Confirmed landed',
              meta: {
                actor: 'pnyx',
                at,
              },
            })
            assert.ok('event' in done)
            writer.append({ event: done.event })
          },
        })
      },
    })
    await until({
      what: 'restart to recover project refresh',
      check: () => s.task({ key: 'ship' }).projectRefresh?.[url],
    })
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
    await pnyx.restart()
    await followPullRequests({ hydraId: s.hydraId })
    assert.equal(
      s.events().filter(event => event.type === 'project.refreshed').length,
      1,
    )
    assert.equal(
      s.task({ key: 'ship' }).projectRefresh?.[url]?.state,
      'advanced',
    )
    assert.equal(
      s.merges({ number: 1 }),
      0,
    )
  },
)

test(
  'runtime alias identity supplies worker copies, instructions, landing rules and queue handoff',
  async () => {
    const s = await pnyx.scenario()
    const path = await s.project({
      name: 'alias-runtime',
      flags: [
        '--merge',
        'hydra',
      ],
    })
    const alias = join(
      s.folder({ name: 'l' }),
      'a',
    )
    symlinkSync(
      path,
      alias,
    )
    const notes = 'Keep all owner edits reachable.'
    const preferences = 'Use the shared project preferences.'
    await s.owner({
      args: [
        'project',
        'worker-notes',
        'set',
        '--project',
        path,
        '--text',
        notes,
        '--reason',
        'Project instruction',
      ],
    })
    await s.owner({
      args: [
        'project',
        'memory',
        'set',
        '--project',
        path,
        '--key',
        'preferences',
        '--text',
        preferences,
        '--reason',
        'Project preference',
      ],
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Alias task',
        '--key',
        'alias',
        '--project',
        path,
        '--brief',
        'First task',
      ],
    })
    await s.owner({
      args: [
        'task',
        'rename',
        'alias',
        '--project',
        alias,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'alias',
      ],
    })
    const copy = s.task({ key: 'alias' }).copy
    assert.ok(copy)
    assert.equal(
      copy.project,
      path,
    )
    assert.notEqual(
      copy.path,
      path,
    )
    const originalSession = s.task({ key: 'alias' }).sessionIds?.[0]
    const worker = await s.agent({ cwd: copy.path })
    await until({
      what: 'alias worker to receive shared context',
      check: () => worker.received.some(text => text.includes(preferences)),
    })
    const prompt = worker.received[0]
    assert.ok(prompt?.includes(notes))
    assert.ok(prompt?.includes('Hydra merges it once every check is green'))
    await until({
      what: 'alias worker to finish its opening turn',
      check: () => s.task({ key: 'alias' }).sessionActivity === 'finished',
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Queued task',
        '--key',
        'next',
        '--project',
        path,
        '--brief',
        'Second task',
      ],
    })
    await s.owner({
      args: [
        'task',
        'queue',
        'next',
        '--behind',
        'alias',
      ],
    })
    assert.equal(
      s.task({ key: 'next' }).queue?.session,
      s.task({ key: 'alias' }).sessionIds?.[0],
    )
    const head = git({
      cwd: copy.path,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })
    const url = s.pullRequest({
      number: 1,
      state: 'merged',
      head,
      merge: head,
    })
    await s.owner({
      args: [
        'link',
        'alias',
        '--url',
        url,
      ],
    })
    await until({
      what: 'alias task to have a confirmed merge',
      check: () => s.task({ key: 'alias' }).links[0]?.mergeProof,
    })
    await advanceQueues({ hydraId: s.hydraId })
    await until({
      what: 'queue to reuse alias worker',
      check: () => s.task({ key: 'next' }).sessionIds?.length,
    })
    assert.equal(
      s.task({ key: 'next' }).copy?.path,
      copy.path,
    )
    assert.equal(
      s.task({ key: 'next' }).sessionIds?.[0],
      originalSession,
    )
  },
)

test(
  'a reassigned task cannot refresh its captured obsolete project or consume the new project outcome',
  async () => {
    const s = await pnyx.scenario()
    const {
      path,
      target,
      before,
    } = await prepare({ s })
    const replacement = await s.project({ name: 'replacement' })
    const lock = join(
      path,
      '.git',
      'pnyx-project-refresh.lock',
    )
    symlinkSync(
      `pnyx-refresh:${process.pid}:test-owner`,
      lock,
    )
    const url = s.pullRequest({
      number: 1,
      state: 'merged',
      head: target,
      merge: target,
    })
    const proof = {
      head: target,
      commit: target,
      confirmedAt: new Date().toISOString(),
    }
    withWriter({
      hydraId: s.hydraId,
      fn: ({ writer }) => {
        const decision = decideLink({
          state: writer.state,
          ref: 'ship',
          url,
          link: {
            kind: 'github_pr',
            url,
            state: 'merged',
            mergeProof: proof,
          },
          meta: {
            actor: 'pnyx',
            at: proof.confirmedAt,
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    const running = confirmedMerge({
      hydraId: s.hydraId,
      cardId: s.task({ key: 'ship' }).id,
      url,
      proof,
    })

    try {
      await s.owner({
        args: [
          'task',
          'project',
          'ship',
          '--project',
          replacement,
        ],
      })
    } finally {
      unlinkSync(lock)
    }

    await running
    await followPullRequests({ hydraId: s.hydraId })
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
    assert.equal(
      s.task({ key: 'ship' }).projectRefresh?.[url]?.path,
      replacement,
    )
    assert.equal(
      s.events().filter(event => event.type === 'project.refreshed' && event.data.path === path).length,
      0,
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
  'a separate process waits for a live refresh lock to its bound without touching its owner or project',
  async () => {
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
    const owner = `pnyx-refresh:${process.pid}:external-owner`
    symlinkSync(
      owner,
      lock,
    )

    try {
      const child = await runFile(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      const { default: assert } = await import('node:assert/strict');
      const { refreshProject } = await import(process.argv[1]);
      let now = 0, timer, result, cancelled = false;
      const scheduled = Promise.withResolvers();
      const refresh = refreshProject({
        path: process.argv[2], url: 'https://github.com/fixture/project/pull/1', merge: process.argv[3],
        isPending: () => true,
        lockWait: {
          now: () => now,
          schedule: ({ ms, fire }) => {
            timer = { at: now + ms, fire };
            scheduled.resolve();
            return () => { cancelled = true; };
          },
        },
        complete: ({ result: completed }) => { result = completed; },
      });
      await scheduled.promise;
      assert.equal(timer.at, 30_000, 'the production lock bound stays 30 seconds');
      now = timer.at - 1;
      if (timer.at <= now) timer.fire();
      assert.equal(result, undefined, 'the live owner still holds the lock before expiry');
      now = timer.at;
      timer.fire();
      await refresh;
      assert.equal(cancelled, true, 'expiry cleans up its scheduled wait');
      process.stdout.write(JSON.stringify(result));
    `,
          new URL(
            '../../src/projects/refresh.ts',
            import.meta.url,
          ).href,
          path,
          target,
        ],
        {
          encoding: 'utf8',
          timeout: CHILD_TIMEOUT_MS,
        },
      )
      const result = JSON.parse(child.stdout)
      assert.equal(
        result.state,
        'unknown',
      )
      assert.match(
        result.reason,
        /timed out waiting for the active project refresh/,
      )
      assert.equal(
        readlinkSync(lock),
        owner,
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
    } finally {
      unlinkSync(lock)
    }
  },
)

for (const failure of [
  'synchronous',
  'asynchronous',
]) {
  test(
    `project refresh waits for its owner under ${failure} EMFILE and advances after release`,
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
              const error = Object.assign(
                new Error('refresh watcher limit'),
                { code: 'EMFILE' },
              )

              if (failure === 'synchronous') {
                throw error
              }

              const watcher = Reflect.apply(
                original,
                fs,
                args,
              ) as fs.FSWatcher
              setImmediate(() => watcher.emit(
                'error',
                error,
              ))

              return watcher
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
}
