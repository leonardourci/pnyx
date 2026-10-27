import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectMemoryView } from '../../src/projects/memory.ts'
import { ownerMemory } from '../../src/store/owner-memory.ts'
import { scenarioGroup } from './harness.ts'

const pnyx = scenarioGroup()

test(
  'moving a for-now learning preserves its end condition and unused-save count across replay',
  async () => {
    const s = await pnyx.scenario()
    const path = await s.project({ name: 'for-now-transfer' })
    const text = 'Keep the legacy parser for this version.'
    await s.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'learnings',
        '--text',
        text,
        '--kind',
        'for-now',
        '--until',
        'version:2.0.0',
      ],
    })
    await s.owner({
      args: [
        'owner',
        'memory',
        'save',
        '--reason',
        'Curated memory without using the parser rule.',
      ],
    })
    const learning = ownerMemory().learnings!.lines!.find(line => line.text === text)!
    assert.equal(
      learning.kind,
      'for-now',
    )
    assert.equal(
      learning.until,
      'version:2.0.0',
    )
    assert.equal(
      learning.passes,
      1,
    )
    await s.owner({
      args: [
        'owner',
        'memory',
        'move',
        '--project',
        path,
        '--text',
        text,
      ],
    })
    assert.equal(
      ownerMemory().learnings,
      undefined,
    )
    assert.deepEqual(
      projectMemoryView({ path }).learnings?.find(line => line.text === text),
      learning,
    )
    await s.owner({
      args: [
        'project',
        'memory',
        'save',
        '--project',
        path,
        '--reason',
        'Curated the project without using the parser rule.',
      ],
    })
    await pnyx.restart()
    const moved = projectMemoryView({ path }).learnings?.find(line => line.text === text)
    assert.deepEqual(
      moved,
      {
        ...learning,
        passes: 2,
      },
    )
    await s.owner({
      args: [
        'project',
        'memory',
        'save',
        '--project',
        path,
        '--used',
        text,
        '--reason',
        'Verified the parser compatibility requirement.',
      ],
    })
    assert.equal(
      projectMemoryView({ path }).learnings?.find(line => line.text === text)?.passes,
      0,
    )
  },
)
