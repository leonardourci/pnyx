import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ownerArchive, ownerMemory, saveOwnerMemory } from '../../src/store/owner-memory.ts'
import { projectMemoryView } from '../../src/projects/memory.ts'
import { staleLearnings } from '../../src/memory/learnings.ts'
import { startReviewTimer, REVIEW_MS } from '../../src/review/timer.ts'
import { HYDRA_CARD } from '../../src/core/hydra.ts'
import { scenarioGroup, until } from '../../src/test-harness/harness.ts'

const pnyx = scenarioGroup()

test(
  'inscribe saves count only their layer and preserve recoverable for-now learnings across restart',
  async () => {
    const s = await pnyx.scenario()
    const path = await s.project({ name: 'memory' })
    const owner = ({ args }: { args: string[] }) => s.owner({
      args: [
        'owner',
        'memory',
        ...args,
      ],
    })
    const project = ({ args }: { args: string[] }) => s.owner({
      args: [
        'project',
        'memory',
        ...args,
        '--project',
        path,
      ],
    })
    const lines = () => ownerMemory().learnings!.lines!
    const initial = 'General normal fact'
    const temporary = 'Temporary workaround'
    await owner({
      args: [
        'set',
        '--key',
        'learnings',
        '--text',
        initial,
      ],
    })
    await owner({
      args: [
        'set',
        '--key',
        'preferences',
        '--text',
        'Use plain words',
      ],
    })
    const refusal = await s.ownerRefusal({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'learnings',
        '--text',
        `${initial}\n${temporary}`,
        '--kind',
        'for-now',
      ],
    })
    assert.equal(
      refusal.code,
      'VALIDATION_ERROR',
    )
    assert.match(
      refusal.error ?? '',
      /until/,
    )
    const condition = 'version:next-release'
    await owner({
      args: [
        'set',
        '--key',
        'learnings',
        '--text',
        `${initial}\n${temporary}`,
        '--kind',
        'for-now',
        '--until',
        condition,
      ],
    })
    await project({
      args: [
        'set',
        '--key',
        'learnings',
        '--text',
        'Project workaround',
        '--kind',
        'for-now',
        '--until',
        'date:2099-01-01',
      ],
    })
    saveOwnerMemory({
      key: 'learnings',
      after: null,
      confirmed: temporary,
      meta: {
        actor: 'cli',
        at: '2000-01-01T00:00:00Z',
        reason: 'Historical fixture confirmation',
      },
    })
    const firstDate = lines()[0]!.at

    for (let pass = 0; pass < 3; pass++) {
      await owner({
        args: [
          'save',
          '--reason',
          'No session evidence for these lines',
        ],
      })
    }

    assert.deepEqual(
      lines().map(line => line.passes),
      [
        3,
        3,
      ],
    )
    assert.equal(
      lines()[0]!.at,
      firstDate,
    )
    assert.equal(
      projectMemoryView({ path }).learnings![0]!.passes ?? 0,
      0,
    )
    assert.deepEqual(
      staleLearnings({
        lines: lines(),
        now: firstDate,
      }).map(line => line.text),
      [temporary],
    )
    await owner({
      args: [
        'set',
        '--key',
        'preferences',
        '--text',
        'Use plain words again',
      ],
    })
    await owner({ args: ['list'] })
    await owner({
      args: [
        'set',
        '--key',
        'learnings',
        '--text',
        `${initial}\n${temporary}`,
      ],
    })
    assert.deepEqual(
      lines().map(line => line.passes),
      [
        3,
        3,
      ],
    )
    await s.chat({ text: 'Read the memory without saving it' })
    await until({
      what: 'the memory-reading Hydra turn to finish',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    assert.deepEqual(
      lines().map(line => line.passes),
      [
        3,
        3,
      ],
    )

    assert.equal(
      await s.ownerRefused({
        args: [
          'owner',
          'memory',
          'save',
          '--used',
          temporary,
        ],
      }),
      'VALIDATION_ERROR',
    )
    await owner({
      args: [
        'save',
        '--used',
        temporary,
        '--reason',
        'This session reproduced the workaround successfully',
      ],
    })
    assert.deepEqual(
      lines().map(line => line.passes),
      [
        4,
        0,
      ],
    )
    const usedSave = JSON.parse(readFileSync(
      join(
        process.env.PNYX_HOME!,
        'owner',
        'memory.jsonl',
      ),
      'utf8',
    ).trim()
      .split('\n')
      .at(-1)!)
    assert.equal(
      lines()[1]!.at,
      usedSave.at,
    )
    assert.equal(
      lines()[1]!.evidence,
      'This session reproduced the workaround successfully',
    )
    assert.equal(
      lines()[0]!.at,
      firstDate,
    )
    assert.equal(
      lines()[1]!.kind,
      'for-now',
    )
    assert.equal(
      lines()[1]!.until,
      condition,
    )
    await owner({
      args: [
        'confirm',
        '--text',
        initial,
        '--reason',
        'This session verified the tool behavior',
      ],
    })
    assert.equal(
      lines()[0]!.passes,
      0,
    )

    for (let pass = 0; pass < 10; pass++) {
      await owner({
        args: [
          'save',
          '--used',
          temporary,
          '--reason',
          'The workaround was exercised in this session',
        ],
      })
    }

    assert.deepEqual(
      staleLearnings({
        lines: lines(),
        now: new Date().toISOString(),
      }).map(line => line.text),
      [initial],
    )
    const staleDigest = await s.owner({
      args: [
        'hydra',
        'digest',
      ],
    })
    assert.match(
      staleDigest,
      /STALE.*General normal fact/,
    )
    assert.doesNotMatch(
      staleDigest,
      /STALE.*Temporary workaround/,
    )
    assert.match(
      staleDigest,
      /Use plain words again/,
    )
    assert.equal(
      ownerMemory().preferences!.text,
      'Use plain words again',
    )
    const projectSave = [
      'save',
      '--event-id',
      'project-pass',
      '--reason',
      'Project review without confirming evidence',
    ]
    await project({ args: projectSave })
    await project({ args: projectSave })
    assert.equal(
      projectMemoryView({ path }).learnings![0]!.passes,
      1,
    )
    await project({
      args: [
        'save',
        '--reason',
        'No new project evidence',
      ],
    })
    await project({
      args: [
        'save',
        '--reason',
        'No new project evidence',
      ],
    })
    assert.equal(
      staleLearnings({
        lines: projectMemoryView({ path }).learnings!,
        now: firstDate,
      }).length,
      1,
    )
    const projectStaleDigest = await s.owner({
      args: [
        'hydra',
        'digest',
      ],
    })
    assert.match(
      projectStaleDigest,
      /1 stale learnings/,
    )
    await project({
      args: [
        'confirm',
        '--text',
        'Project workaround',
        '--reason',
        'The project build reproduced this workaround',
      ],
    })
    assert.equal(
      projectMemoryView({ path }).learnings![0]!.passes,
      0,
    )
    await project({
      args: [
        'save',
        '--used',
        'Project workaround',
        '--reason',
        'The workaround was exercised in this session',
      ],
    })
    assert.equal(
      projectMemoryView({ path }).learnings![0]!.passes,
      0,
    )

    assert.equal(
      lines()[0]!.passes,
      10,
    )
    const log = join(
      process.env.PNYX_HOME!,
      'owner',
      'memory.jsonl',
    )
    const before = readFileSync(
      log,
      'utf8',
    )
    const retired = { ...lines()[1]! }
    await owner({
      args: [
        'archive',
        '--text',
        temporary,
        '--reason',
        'The workaround is no longer needed',
      ],
    })
    assert.equal(
      lines().some(line => line.text === temporary),
      false,
    )
    assert.deepEqual(
      ownerArchive().at(-1),
      retired,
    )
    assert.ok(readFileSync(
      log,
      'utf8',
    ).startsWith(before))
    await project({
      args: [
        'archive',
        '--text',
        'Project workaround',
        '--reason',
        'No current evidence',
      ],
    })
    assert.equal(
      projectMemoryView({ path }).learnings!.length,
      0,
    )
    assert.equal(
      projectMemoryView({ path }).archived[0]!.until,
      'date:2099-01-01',
    )
    await pnyx.restart()
    assert.equal(
      lines()[0]!.passes,
      10,
    )
    assert.deepEqual(
      ownerArchive().at(-1),
      retired,
    )
    const listed = await owner({ args: ['list'] })
    assert.match(
      listed,
      /Temporary workaround/,
    )
    await owner({
      args: [
        'set',
        '--key',
        'learnings',
        '--text',
        `${initial}\n${retired.text}`,
        '--kind',
        retired.kind!,
        '--until',
        retired.until!,
      ],
    })
    assert.equal(
      lines()[1]!.until,
      condition,
    )
    assert.equal(
      lines()[1]!.passes ?? 0,
      0,
    )
    assert.equal(
      ownerMemory().preferences!.lines,
      undefined,
    )
    await owner({
      args: [
        'forget',
        '--key',
        'learnings',
      ],
    })
  },
)

test(
  'task and PR end conditions reach the digest from recorded completion',
  async () => {
    const s = await pnyx.scenario()
    const path = await s.project({ name: 'expiry' })
    const owner = ({ args }: { args: string[] }) => s.owner({
      args: [
        'owner',
        'memory',
        ...args,
      ],
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Finish investigation',
        '--key',
        'finish',
      ],
    })
    await owner({
      args: [
        'set',
        '--key',
        'learnings',
        '--text',
        'Until task finishes',
        '--kind',
        'for-now',
        '--until',
        `task:${s.hydraId}/finish`,
      ],
    })
    const url = s.pullRequest({
      number: 71,
      state: 'open',
    })
    await s.owner({
      args: [
        'link',
        'finish',
        '--kind',
        'github_pr',
        '--url',
        url,
      ],
    })
    await owner({
      args: [
        'set',
        '--key',
        'learnings',
        '--text',
        'Until task finishes\nUntil PR merges',
        '--kind',
        'for-now',
        '--until',
        url,
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
        'Until date passes',
        '--kind',
        'for-now',
        '--until',
        'date:2020-01-01',
      ],
    })
    const pending = await s.owner({
      args: [
        'hydra',
        'digest',
      ],
    })
    assert.doesNotMatch(
      pending,
      /EXPIRED for now/,
    )
    s.pullRequest({
      number: 71,
      state: 'merged',
    })
    await until({
      what: 'the followed PR merge',
      check: () => s.task({ key: 'finish' }).links.some(link => link.url === url && link.state === 'merged'),
    })
    assert.equal(
      s.task({ key: 'finish' }).column,
      s.column({ role: 'done' }),
    )
    const digest = await s.owner({
      args: [
        'hydra',
        'digest',
      ],
    })
    assert.match(
      digest,
      /EXPIRED for now.*Until task finishes/,
    )
    assert.match(
      digest,
      /EXPIRED for now.*Until PR merges/,
    )
  },
)

test(
  'timed reviews surface expired memory without live tasks or advancing save counts',
  async () => {
    const s = await pnyx.scenario()
    const path = await s.project({ name: 'review-memory' })
    saveOwnerMemory({
      key: 'learnings',
      after: 'Old normal review learning',
      meta: {
        actor: 'cli',
        at: '2000-01-01T00:00:00Z',
      },
    })
    saveOwnerMemory({
      key: 'preferences',
      after: 'Keep this owner preference forever',
      meta: {
        actor: 'cli',
        at: '2000-01-01T00:00:00Z',
      },
    })
    const ownerBefore = ownerMemory()

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
        'Until date passes',
        '--kind',
        'for-now',
        '--until',
        'date:2020-01-01',
      ],
    })
    let clock = Date.parse('2030-01-01T00:00:00Z')
    const digest = await s.owner({
      args: [
        'hydra',
        'digest',
      ],
    })
    assert.match(
      digest,
      /STALE.*Old normal review learning/,
    )
    assert.match(
      digest,
      /Keep this owner preference forever/,
    )
    assert.doesNotMatch(
      digest,
      /(?:STALE|EXPIRED).*Keep this owner preference forever/,
    )
    const timer = startReviewTimer({
      hydraId: s.hydraId,
      now: () => clock,
      interval: () => () => {},
      wake: () => {},
    })

    try {
      clock += REVIEW_MS
      timer.check()
      const review = s.state().hydraReview!.block
      assert.match(
        review,
        /STALE.*Old normal review learning/,
      )
      assert.doesNotMatch(
        review,
        /(?:STALE|EXPIRED).*Keep this owner preference forever/,
      )
      assert.deepEqual(
        ownerMemory(),
        ownerBefore,
      )

      assert.match(
        review,
        /EXPIRED for now.*Until date passes/,
      )
      assert.equal(
        ownerMemory().learnings!.lines![0]!.passes ?? 0,
        0,
      )
      assert.equal(
        projectMemoryView({ path }).learnings![0]!.passes ?? 0,
        0,
      )
      assert.equal(
        s.state().cards[HYDRA_CARD]?.sessionActivity === 'working',
        false,
      )
    } finally {
      timer.close()
    }
  },
)

test(
  'unavailable and closed conditions stay unexpired when another Hydra cannot be read',
  async () => {
    const s = await pnyx.scenario()
    const owner = ({ args }: { args: string[] }) => s.owner({
      args: [
        'owner',
        'memory',
        ...args,
      ],
    })
    await owner({
      args: [
        'set',
        '--key',
        'learnings',
        '--text',
        'Unknown task',
        '--kind',
        'for-now',
        '--until',
        'task:My.Hydra_1/unknown',
      ],
    })
    const url = s.pullRequest({
      number: 72,
      state: 'closed',
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Closed PR',
        '--key',
        'closed',
      ],
    })
    await s.owner({
      args: [
        'link',
        'closed',
        '--kind',
        'github_pr',
        '--url',
        url,
      ],
    })
    await until({
      what: 'the followed closed PR',
      check: () => s.task({ key: 'closed' }).links.some(link => link.url === url && link.state === 'closed'),
    })
    await owner({
      args: [
        'set',
        '--key',
        'learnings',
        '--text',
        'Unknown task\nClosed PR condition',
        '--kind',
        'for-now',
        '--until',
        url,
      ],
    })
    const broken = join(
      process.env.PNYX_HOME!,
      'hydras',
      'Unreadable.Hydra',
    )
    mkdirSync(broken)
    writeFileSync(
      join(
        broken,
        'events.jsonl',
      ),
      '{broken\n',
    )

    try {
      const digest = await s.owner({
        args: [
          'hydra',
          'digest',
        ],
      })
      assert.match(
        digest,
        /Confirmed.*Unknown task/,
      )
      assert.match(
        digest,
        /Confirmed.*Closed PR condition/,
      )
      assert.doesNotMatch(
        digest,
        /EXPIRED for now/,
      )
      await owner({ args: ['list'] })
    } finally {
      rmSync(
        broken,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)
