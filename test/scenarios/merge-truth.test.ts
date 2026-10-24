import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { git, scenarioGroup, until } from './harness.ts'
import type { FakePullRequest } from './github.ts'

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
    name: 'unreadable producer evidence',
    input: { unreadable: 'runs' },
    error: /check producers unreadable/,
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
  'a push after verification refuses the exact checked SHA and retains an unfinished attempt',
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
      s.task({ key: 'ship' }).links[0]?.mergeAttempt?.head,
      HEAD,
    )
    assert.notEqual(
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
