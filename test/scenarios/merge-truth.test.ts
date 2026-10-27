import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { git, scenarioGroup, until } from '../../src/test-harness/harness.ts'
import type { FakePullRequest } from '../../src/test-harness/github.ts'

import { withWriter } from '../../src/store/hydra-store.ts'
import { decideLink } from '../../src/core/decide.ts'
import { advanceQueues } from '../../src/queue/advance.ts'

const pnyx = scenarioGroup()
const HEAD = 'a'.repeat(40)

for (const {
  name,
  input,
  error,
} of [
  {
    name: 'a missing required check',
    input: {
      required: [
        {
          context: 'build',
          app: 10,
        },
      ],
    },
    error: /missing required check: build/,
  },
  {
    name: 'a required app mismatch',
    input: {
      required: [
        {
          context: 'build',
          app: 10,
        },
      ],
      runs: [
        {
          name: 'build',
          app: 11,
          conclusion: 'success',
        },
      ],
    },
    error: /missing required check: build \(app 10\)/,
  },
  {
    name: 'unreadable rules',
    input: { unreadable: 'rules' },
    error: /branch rules unreadable/,
  },
  {
    name: 'unreadable classic protection',
    input: { unreadable: 'legacy' },
    error: /classic protection unreadable/,
  },
  {
    name: 'unreadable required app identity',
    input: {
      unreadable: 'legacy-app',
      legacy: [
        {
          context: 'build',
          app: 10,
        },
      ],
      runs: [
        {
          name: 'build',
          app: 11,
          conclusion: 'success',
        },
      ],
    },
    error: /required producer identity is unreadable/,
  },
  {
    name: 'unreadable producer evidence',
    input: { unreadable: 'runs' },
    error: /check producers unreadable/,
  },
  {
    name: 'unreadable commit statuses',
    input: { unreadable: 'statuses' },
    error: /commit statuses unreadable/,
  },
  {
    name: 'a draft',
    input: { draft: true },
    error: /still a draft/,
  },
  {
    name: 'red checks',
    input: { checks: '0 passed, 1 failed, 1 total' },
    error: /checks are red/,
  },
  {
    name: 'running checks',
    input: { checks: '0 passed, 0 failed, 1 total' },
    error: /checks are still running/,
  },
] satisfies {
  name: string
  input: Omit<FakePullRequest, 'number'>
  error: RegExp
}[]) {
  test(
    `merge refuses ${name} before submitting anything`,
    async () => {
      const s = await pnyx.scenario()
      await s.owner({
        args: [
          'task',
          'create',
          '--title',
          'Check merge evidence',
          '--key',
          'ship',
        ],
      })
      const url = s.pullRequest({
        number: 1,
        ...input,
      })
      await s.owner({
        args: [
          'link',
          'ship',
          '--url',
          url,
        ],
      })
      const refused = await s.ownerRefusal({
        args: [
          'task',
          'merge',
          'ship',
        ],
      })
      assert.match(
        refused.error!,
        error,
      )
      assert.equal(
        s.merges({ number: 1 }),
        0,
      )
      assert.equal(
        s.mergeArguments({ number: 1 }).length,
        0,
      )
      assert.notEqual(
        s.task({ key: 'ship' }).status?.state,
        'done',
      )
      assert.notEqual(
        s.task({ key: 'ship' }).links[0]?.state,
        'merged',
      )
    },
  )
}

test(
  'a push after verification refuses the checked SHA and allows a fresh verified retry',
  async () => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Head race',
        '--key',
        'ship',
      ],
    })
    const url = s.pullRequest({
      number: 1,
      head: HEAD,
      pushBeforeMerge: 'c'.repeat(40),
    })
    await s.owner({
      args: [
        'link',
        'ship',
        '--url',
        url,
      ],
    })
    const refused = await s.ownerRefusal({
      args: [
        'task',
        'merge',
        'ship',
      ],
    })
    assert.match(
      refused.error!,
      /Head branch was modified/,
    )
    assert.equal(
      s.merges({ number: 1 }),
      0,
    )
    assert.deepEqual(
      s.mergeArguments({ number: 1 }),
      [
        [
          'api',
          'PUT',
          `/repos/o/${s.hydraId}/pulls/1/merge`,
          '--field',
          `sha=${HEAD}`,
          '--field',
          'merge_method=merge',
          '--jq',
          '{payload: tojson}',
          '--full',
        ],
      ],
    )
    assert.equal(
      s.task({ key: 'ship' }).links[0]?.mergeAttempt,
      undefined,
    )
    assert.ok(s.events().some(event => event.type === 'card.linked' && event.data.after?.mergeAttempt?.head === HEAD))
    s.pullRequest({
      number: 1,
      head: 'c'.repeat(40),
    })
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
    assert.equal(
      s.task({ key: 'ship' }).links[0]?.mergeProof?.head,
      'c'.repeat(40),
    )
    assert.equal(
      s.task({ key: 'ship' }).status?.state,
      'done',
    )
  },
)

for (const behavior of [
  'queued',
  'open',
  'readback-failed',
] as const) {
  test(
    `${behavior} stays unfinished with its copy, then follower confirmation converges across restart`,
    async () => {
      const s = await pnyx.scenario()
      const app = await s.project({
        name: `app-${behavior}`,
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

      if (behavior === 'open') {
        await s.owner({
          args: [
            'task',
            'create',
            '--title',
            'Wait for confirmed landing',
            '--key',
            'next',
            '--project',
            app,
          ],
        })
        await s.owner({
          args: [
            'task',
            'queue',
            'next',
            '--behind',
            s.task({ key: 'ship' }).sessionIds![0]!,
          ],
        })
      }

      const url = s.pullRequest({
        number: 1,
        head,
        mergeBehavior: behavior,
      })
      await s.owner({
        args: [
          'link',
          'ship',
          '--url',
          url,
        ],
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
        new RegExp(`merge: ${behavior === 'queued' ? 'queued' : 'unknown'}`),
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
        behavior === 'queued' ? 'queued' : 'unknown',
      )

      if (behavior !== 'readback-failed') {
        await s.owner({
          args: [
            'task',
            'merge',
            'ship',
          ],
        })
      }

      assert.equal(
        s.merges({ number: 1 }),
        1,
      )

      if (behavior === 'readback-failed') {
        s.pullRequest({
          number: 1,
          head,
        })
        await until({
          what: 'readable unconfirmed detail to replace the read error',
          check: () =>
            s.task({ key: 'ship' }).links[0]?.mergeAttempt?.detail === 'GitHub has not confirmed a merge or a queue entry',
        })
      }

      if (behavior === 'open') {
        s.pullRequest({
          number: 1,
          head,
          state: 'merged',
          merge: 'invalid',
        })
        await until({
          what: 'invalid forge confirmation to remain visibly unfinished',
          check: () =>
            s.task({ key: 'ship' }).links[0]?.mergeAttempt?.detail?.includes('no merge commit'),
        })
        assert.equal(
          s.task({ key: 'ship' }).links[0]?.state,
          'open',
        )
        assert.notEqual(
          s.task({ key: 'ship' }).status?.state,
          'done',
        )
        assert.notEqual(
          s.task({ key: 'ship' }).copy?.state,
          'removed',
        )
        await advanceQueues({ hydraId: s.hydraId })
        assert.notEqual(
          s.task({ key: 'ship' }).status?.state,
          'done',
        )
        assert.notEqual(
          s.task({ key: 'ship' }).copy?.state,
          'removed',
        )
        assert.equal(
          s.task({ key: 'next' }).sessionIds?.length ?? 0,
          0,
        )
      }

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
      assert.equal(
        s.merges({ number: 1 }),
        1,
      )
    },
  )
}

test(
  'proven empty requirements allow a normal merge and persist forge confirmation',
  async () => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'No required checks',
        '--key',
        'ship',
      ],
    })
    const url = s.pullRequest({ number: 1 })
    await s.owner({
      args: [
        'link',
        'ship',
        '--url',
        url,
      ],
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
      /merge: merged/,
    )
    assert.equal(
      s.task({ key: 'ship' }).status?.state,
      'done',
    )
    assert.equal(
      s.task({ key: 'ship' }).links[0]?.mergeProof?.head,
      HEAD,
    )
    assert.equal(
      s.task({ key: 'ship' }).links[0]?.mergeProof?.commit,
      'b'.repeat(40),
    )
    assert.equal(
      s.merges({ number: 1 }),
      1,
    )
  },
)

test(
  'server restart schedules Done recovery when the last merged proof is the only remaining work',
  async () => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Recover confirmed merge',
        '--key',
        'ship',
      ],
    })
    await s.owner({
      args: [
        'task',
        'status',
        'ship',
        'working',
      ],
    })
    const url = s.pullRequest({
      number: 1,
      state: 'merged',
    })
    await pnyx.restart({
      whileStopped: () => {
        withWriter({
          hydraId: s.hydraId,
          fn: ({ writer }) => {
            const at = new Date().toISOString()
            const decision = decideLink({
              state: writer.state,
              ref: s.task({ key: 'ship' }).id,
              url,
              link: {
                kind: 'github_pr',
                url,
                state: 'merged',
                mergeProof: {
                  head: HEAD,
                  commit: 'b'.repeat(40),
                  confirmedAt: at,
                },
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
        assert.notEqual(
          s.task({ key: 'ship' }).status?.state,
          'done',
        )
      },
    })
    await until({
      what: 'restart to reconcile persisted merge proof',
      check: () => s.task({ key: 'ship' }).status?.state === 'done',
    })
    assert.equal(
      s.merges({ number: 1 }),
      0,
    )
  },
)
