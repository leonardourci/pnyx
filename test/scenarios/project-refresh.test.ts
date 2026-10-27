import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { refreshProject } from '../../src/projects/refresh.ts'
import type { ProjectRefresh } from '../../src/projects/refresh-types.ts'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { git, scenarioGroup, until } from './harness.ts'
import { wakeReasons } from '../../src/core/wake-reasons.ts'
import { followPullRequests } from '../../src/landing/follow.ts'

const pnyx = scenarioGroup()
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
