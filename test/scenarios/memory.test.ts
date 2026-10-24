import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { HYDRA_CARD } from '../../src/core/hydra.ts'
import { projectMemoryView, writeProjectMemory } from '../../src/projects/memory.ts'
import { ownerMemory, ownerRevision } from '../../src/store/owner-memory.ts'
import { scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()
const OWNER_LIMIT = 24000
const PROJECT_LIMIT = 10000

test(
  'larger memory budgets accept their limits, refuse growth and still ask for curation',
  async () => {
    const s = await pnyx.scenario()
    const path = await s.project({ name: 'budgets' })
    const ownerText = 'o'.repeat(OWNER_LIMIT)
    const projectText = 'p'.repeat(PROJECT_LIMIT)
    await s.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        ownerText,
      ],
    })
    assert.match(
      await s.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      }),
      /24000 of 24000 characters/,
    )
    assert.match(
      await s.owner({
        args: [
          'hydra',
          'digest',
        ],
      }),
      /Owner memory uses 24000 of 24000 characters\. Load the inscribe skill/,
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'owner',
          'memory',
          'set',
          '--key',
          'learnings',
          '--text',
          'overflow',
        ],
      }),
      'MEMORY_FULL',
    )
    assert.equal(
      ownerMemory().preferences?.text,
      ownerText,
    )
    await s.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'Ask before moving preferences.',
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
        projectText,
      ],
    })
    assert.match(
      await s.owner({
        args: [
          'project',
          'memory',
          'list',
          '--project',
          path,
        ],
      }),
      /10000 of 10000 characters/,
    )
    assert.match(
      await s.owner({
        args: [
          'hydra',
          'digest',
        ],
      }),
      /nearly full: load inscribe with this project/,
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'project',
          'memory',
          'set',
          '--project',
          path,
          '--key',
          'learnings',
          '--text',
          'overflow',
        ],
      }),
      'MEMORY_FULL',
    )
    assert.equal(
      projectMemoryView({ path }).documents.preferences,
      projectText,
    )
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
        'Keep project preferences.',
      ],
    })
    assert.equal(
      projectMemoryView({ path }).documents.preferences,
      'Keep project preferences.',
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'hydra',
          'memory',
          'set',
          '--key',
          'scope',
          '--text',
          'x'.repeat(1501),
        ],
      }),
      'MEMORY_FULL',
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'project',
          'worker-notes',
          'set',
          '--project',
          path,
          '--text',
          'x'.repeat(1501),
          '--reason',
          'Too long',
        ],
      }),
      'MEMORY_FULL',
    )
  },
)

test(
  'one durable move removes only the selected owner learning and replays among project saves',
  async () => {
    const s = await pnyx.scenario()
    const path = await s.project({ name: 'moves' })
    await s.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'Ask before moving preferences.',
      ],
    })
    const first = 'The parser project uses a generated schema.'
    const second = 'The parser project checks fixtures before release.'
    const general = 'Keep reports concise.'
    await s.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'learnings',
        '--text',
        [
          first,
          second,
          general,
        ].join('\n'),
      ],
    })
    const original = ownerMemory().learnings!.lines!.find(line => line.text === first)
    await s.owner({
      args: [
        'project',
        'memory',
        'set',
        '--project',
        path,
        '--key',
        'learnings',
        '--text',
        'Existing project fact.',
      ],
    })
    const project = projectMemoryView({ path })
    const projectLog = join(
      process.env.PNYX_HOME!,
      'projects',
      project.id,
      'events.jsonl',
    )
    const ownerLog = join(
      process.env.PNYX_HOME!,
      'owner',
      'memory.jsonl',
    )
    const projectBefore = readFileSync(
      projectLog,
      'utf8',
    )
    const ownerBefore = readFileSync(
      ownerLog,
      'utf8',
    )
    const revision = ownerRevision()
    assert.equal(
      await s.ownerRefused({
        args: [
          'owner',
          'memory',
          'move',
          '--project',
          path,
          '--text',
          first,
          '--if-revision',
          String(revision - 1),
        ],
      }),
      'REVISION_CONFLICT',
    )
    assert.equal(
      readFileSync(
        ownerLog,
        'utf8',
      ),
      ownerBefore,
    )
    assert.equal(
      readFileSync(
        projectLog,
        'utf8',
      ),
      projectBefore,
    )
    await s.owner({
      args: [
        'owner',
        'memory',
        'move',
        '--project',
        path,
        '--text',
        first,
        '--if-revision',
        String(revision),
      ],
    })
    assert.equal(
      ownerMemory().learnings?.text,
      [
        second,
        general,
      ].join('\n'),
    )
    assert.equal(
      ownerMemory().preferences?.text,
      'Ask before moving preferences.',
    )
    assert.equal(
      projectMemoryView({ path }).documents.learnings,
      [
        'Existing project fact.',
        first,
      ].join('\n'),
    )
    assert.deepEqual(
      projectMemoryView({ path }).learnings?.find(line => line.text === first),
      original,
    )
    assert.equal(
      readFileSync(
        projectLog,
        'utf8',
      ),
      projectBefore,
    )
    const ownerAfterMove = readFileSync(
      ownerLog,
      'utf8',
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'owner',
          'memory',
          'move',
          '--project',
          path,
          '--text',
          first,
          '--if-revision',
          String(revision),
        ],
      }),
      'VALIDATION_ERROR',
    )
    assert.equal(
      readFileSync(
        ownerLog,
        'utf8',
      ),
      ownerAfterMove,
    )
    assert.equal(
      readFileSync(
        projectLog,
        'utf8',
      ),
      projectBefore,
    )
    const committed = readFileSync(
      ownerLog,
      'utf8',
    ).slice(ownerBefore.length)
      .trim()
      .split('\n')
    assert.equal(
      committed.length,
      1,
    )
    const transaction = JSON.parse(committed[0]!)
    assert.equal(
      transaction.after,
      [
        second,
        general,
      ].join('\n'),
    )
    assert.equal(
      transaction.projectMove.event.after,
      [
        'Existing project fact.',
        first,
      ].join('\n'),
    )
    await s.owner({
      args: [
        'project',
        'memory',
        'set',
        '--project',
        path,
        '--key',
        'learnings',
        '--text',
        [
          'Updated project fact.',
          first,
        ].join('\n'),
      ],
    })
    await s.owner({
      args: [
        'owner',
        'memory',
        'move',
        '--project',
        path,
        '--text',
        second,
      ],
    })
    await pnyx.restart()
    assert.doesNotMatch(
      await s.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      }),
      /parser project/,
    )
    const loaded = await s.owner({
      args: [
        'project',
        'memory',
        'list',
        '--project',
        path,
      ],
    })
    assert.match(
      loaded,
      /Updated project fact/,
    )
    assert.match(
      loaded,
      /uses a generated schema/,
    )
    assert.match(
      loaded,
      /checks fixtures before release/,
    )
    assert.doesNotMatch(
      loaded,
      /Existing project fact/,
    )
    assert.equal(
      projectMemoryView({ path }).revision,
      project.revision + 3,
    )
  },
)

test(
  'moves refuse a full project or invalid line without changing either memory and deduplicate existing lines',
  async () => {
    const s = await pnyx.scenario()
    const path = await s.project({ name: 'full-project' })
    const line = 'This project builds locally.'
    await s.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'learnings',
        '--text',
        line,
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
        'p'.repeat(PROJECT_LIMIT),
      ],
    })
    const ownerBefore = await s.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })
    const projectBefore = await s.owner({
      args: [
        'project',
        'memory',
        'list',
        '--project',
        path,
      ],
    })
    assert.equal(
      await s.ownerRefused({
        args: [
          'owner',
          'memory',
          'move',
          '--project',
          path,
          '--text',
          line,
        ],
      }),
      'MEMORY_FULL',
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'owner',
          'memory',
          'move',
          '--project',
          path,
          '--text',
          'Missing line.',
        ],
      }),
      'VALIDATION_ERROR',
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'owner',
          'memory',
          'move',
          '--project',
          path,
          '--text',
          line + '\nMissing line.',
        ],
      }),
      'VALIDATION_ERROR',
    )
    assert.equal(
      await s.owner({
        args: [
          'owner',
          'memory',
          'list',
        ],
      }),
      ownerBefore,
    )
    assert.equal(
      await s.owner({
        args: [
          'project',
          'memory',
          'list',
          '--project',
          path,
        ],
      }),
      projectBefore,
    )
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
        'p'.repeat(PROJECT_LIMIT - line.length),
      ],
    })
    writeProjectMemory({
      path,
      hydraId: s.hydraId,
      key: 'learnings',
      after: line,
      meta: {
        at: '2026-01-01T00:00:00Z',
        actor: 'fixture',
      },
    })
    await s.owner({
      args: [
        'owner',
        'memory',
        'confirm',
        '--text',
        line,
        '--reason',
        'Verified the project build in this session.',
      ],
    })
    const confirmed = ownerMemory().learnings!.lines!.find(learning => learning.text === line)
    await s.owner({
      args: [
        'owner',
        'memory',
        'move',
        '--project',
        path,
        '--text',
        line,
      ],
    })
    assert.equal(
      ownerMemory().learnings,
      undefined,
    )
    assert.equal(
      projectMemoryView({ path }).documents.learnings,
      line,
    )
    assert.deepEqual(
      projectMemoryView({ path }).learnings?.find(learning => learning.text === line),
      confirmed,
    )
    assert.equal(
      projectMemoryView({ path }).used,
      PROJECT_LIMIT,
    )
    const emptyPath = await s.project({ name: 'empty-memory' })
    const freshLine = 'The empty project keeps its own fixtures.'
    await s.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'learnings',
        '--text',
        freshLine,
      ],
    })
    await s.owner({
      args: [
        'owner',
        'memory',
        'move',
        '--project',
        emptyPath,
        '--text',
        freshLine,
      ],
    })
    assert.equal(
      ownerMemory().learnings,
      undefined,
    )
    assert.equal(
      projectMemoryView({ path: emptyPath }).documents.learnings,
      freshLine,
    )
  },
)

test(
  'a session receives full owner memory once and later wakes receive only a short change note',
  async () => {
    const s = await pnyx.scenario()
    const path = await s.project({ name: 'on-demand' })
    const projectText = 'PROJECT_ONLY_SECRET_MARKER'
    const ownerText = ('OWNER_FULL_MARKER ' + 'Remember the owner. '.repeat(700)).trim()
    await s.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        ownerText,
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
        'learnings',
        '--text',
        projectText,
      ],
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Watch memory',
        '--key',
        'watch-memory',
      ],
    })
    const agent = await s.chat({ text: 'Start this memory session' })
    await until({
      what: 'first Hydra turn finished',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    assert.ok(agent.received[0]!.includes(ownerText))
    assert.ok(!agent.received[0]!.includes(projectText))
    const updated = ownerText + 'CHANGED_OWNER_MARKER'
    await s.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        updated,
      ],
    })
    await s.owner({
      args: [
        'hydra',
        'send',
        '--task',
        'watch-memory',
        '--actor',
        `worker:${s.task({ key: 'watch-memory' }).id}`,
        '--text',
        'Wake after the save',
      ],
    })
    await until({
      what: 'second Hydra turn finished',
      check: () => agent.received.length === 2 && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    assert.match(
      agent.received[1]!,
      /Memory changed; load owner memory/,
    )
    assert.doesNotMatch(
      agent.received[1]!,
      /OWNER_FULL_MARKER|CHANGED_OWNER_MARKER|PROJECT_ONLY_SECRET_MARKER|<pnyx-digest/,
    )
    await s.owner({
      args: [
        'hydra',
        'send',
        '--task',
        'watch-memory',
        '--actor',
        `worker:${s.task({ key: 'watch-memory' }).id}`,
        '--text',
        'Wake again without saving',
      ],
    })
    await until({
      what: 'third Hydra turn finished',
      check: () => agent.received.length === 3 && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    assert.doesNotMatch(
      agent.received[2]!,
      /Memory changed|OWNER_FULL_MARKER|CHANGED_OWNER_MARKER|PROJECT_ONLY_SECRET_MARKER|<pnyx-digest/,
    )
    assert.match(
      await s.owner({
        args: [
          'project',
          'show',
          path,
        ],
      }),
      /PROJECT_ONLY_SECRET_MARKER/,
    )
  },
)

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
