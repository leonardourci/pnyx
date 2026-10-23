import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scenarioGroup } from './harness.ts'

const pnyx = scenarioGroup()

test(
  'an idea stays held through discussion and starts only after its owner answers Go',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'exports' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'idea',
        '--title',
        'Discuss exports',
        '--hold',
        '--folder',
        folder,
      ],
    })
    assert.ok(s.task({ key: 'idea' }).hold)
    assert.equal(
      s.task({ key: 'idea' }).column,
      s.column({ role: 'queued' }),
    )
    const before = s.events().length
    assert.equal(
      (await s.ownerRefusal({
        args: [
          'task',
          'start',
          'idea',
        ],
      })).code,
      'TASK_HELD',
    )
    assert.equal(
      s.events().length,
      before,
    )
    await s.owner({
      args: [
        'task',
        'ask',
        'idea',
        '--to',
        'owner',
        '--kind',
        'go',
        '--question',
        'Build the exports as discussed?',
        '--actor',
        'hydra',
        '--reason',
        'Playback is complete',
      ],
    })
    const ask = s.task({ key: 'idea' }).asks![0]!
    assert.equal(
      s.task({ key: 'idea' }).column,
      s.column({ role: 'needs_you' }),
    )
    await s.owner({
      args: [
        'task',
        'answer',
        'idea',
        ask.id,
        '--choice',
        'Hold',
      ],
    })
    assert.ok(s.task({ key: 'idea' }).hold)
    assert.equal(
      s.task({ key: 'idea' }).column,
      s.column({ role: 'queued' }),
    )
    await s.owner({
      args: [
        'task',
        'ask',
        'idea',
        '--to',
        'owner',
        '--kind',
        'go',
        '--question',
        'Ready to build now?',
        '--actor',
        'hydra',
        '--reason',
        'The remaining questions are settled',
      ],
    })
    const go = s.task({ key: 'idea' }).asks!.at(-1)!
    await s.owner({
      args: [
        'task',
        'answer',
        'idea',
        go.id,
        '--choice',
        'Go',
      ],
    })
    assert.equal(
      s.task({ key: 'idea' }).hold,
      undefined,
    )
    assert.ok(s.task({ key: 'idea' }).asks!.at(-1)!.answered)
    await s.owner({
      args: [
        'task',
        'start',
        'idea',
      ],
    })
    assert.equal(
      s.task({ key: 'idea' }).column,
      s.column({ role: 'in_progress' }),
    )
    assert.equal(
      (await s.agent({ cwd: folder })).received.length,
      1,
    )
  },
)
