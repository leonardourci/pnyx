import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { git, scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()

test(
  'queued stays unfinished with its copy, then follower confirmation converges across restart',
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

    const url = s.pullRequest({
      number: 1,
      head,
      mergeBehavior: 'queued',
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
