import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { until } from '#test-harness/harness.ts'
import { pnyx, type Scenario } from '#test-harness/pnyx.ts'

const run = promisify(execFile)
const FIXTURE_TIMEOUT_MS = 20_000

// Claude Code sends `compacting` when a compaction starts and again every 30 seconds while it runs, each under a new uuid.
const compacting = (): SDKMessage => ({
  type: 'system',
  subtype: 'status',
  status: 'compacting',
  uuid: randomUUID(),
  session_id: '',
})

const compacted = (): SDKMessage => ({
  type: 'system',
  subtype: 'status',
  status: null,
  compact_result: 'success',
  uuid: randomUUID(),
  session_id: '',
})

// The owner sends /compact to a Hydra that has already answered once; the compaction holds after `before` until released.
async function compact({
  s,
  before,
  after,
}: {
  s: Scenario
  before: SDKMessage[]
  after: SDKMessage[]
}) {
  await s.chat({ text: 'Ready to compact' })
  const agent = await s.agent({ hydra: true })
  await until({
    what: 'Hydra to finish its first turn',
    check: () => s.answered({ cwd: agent.cwd }) === 1 && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
  })
  const turn = pnyx.claude.plan({
    text: '/compact',
    hold: true,
    before,
    after,
  })

  try {
    await s.chat({ text: '/compact' })
    await until({
      what: 'the compaction to run',
      check: () => s.state().cards[HYDRA_CARD]?.compaction?.operations.some(operation => operation.state === 'running'),
    })
    const held = 'Held while compacting'
    await s.owner({
      args: [
        'hydra',
        'send',
        '--text',
        held,
      ],
    })
    await until({
      what: 'the owner’s message to wait for the compaction',
      check: () => s.state().cards[HYDRA_CARD]?.compaction?.inputs
        .some(input => input.text.includes(held)),
    })
  } finally {
    turn.release()
  }

  await until({
    what: 'the held message to reach Hydra after the compaction',
    check: () => s.received({ cwd: agent.cwd }).some(text => text.includes('Held while compacting'))
      && !s.state().cards[HYDRA_CARD]?.compaction?.inputs.length,
  })

  return s.state().cards[HYDRA_CARD]!.compaction!.operations
}

test(
  'a long manual /compact stays one operation through Claude Code’s repeated statuses, and its result releases held input',
  async () => {
    const s = await pnyx.scenario()
    const operations = await compact({
      s,
      before: [compacting()],
      after: [
        compacting(),
        compacting(),
        compacted(),
      ],
    })
    assert.deepEqual(
      operations.map(({
        trigger,
        state,
      }) => ({
        trigger,
        state,
      })),
      [
        {
          trigger: 'manual',
          state: 'done',
        },
      ],
    )
  },
)

test(
  'a compaction that leads straight into another shows them one after the other, and held input arrives once both end',
  async () => {
    const s = await pnyx.scenario()
    const operations = await compact({
      s,
      before: [compacting()],
      after: [
        compacted(),
        compacting(),
        compacting(),
        compacted(),
      ],
    })
    assert.deepEqual(
      operations.map(({
        trigger,
        state,
      }) => ({
        trigger,
        state,
      })),
      [
        {
          trigger: 'manual',
          state: 'done',
        },
        {
          trigger: 'auto',
          state: 'done',
        },
      ],
    )
    assert.ok(operations[0]!.endedAt! <= operations[1]!.startedAt)
  },
)

test(
  'a compaction its agent stops reporting fails at its deadline and releases held input',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-compaction-deadline-',
    ))
    t.after(() => rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    ))
    // Its clock belongs to the child, so advancing it cannot move other flows' timers.
    const result = await run(
      process.execPath,
      [
        '--conditions=source',
        join(
          import.meta.dirname,
          '..',
          'src',
          'test-harness',
          'fixtures',
          'compaction-deadline.ts',
        ),
      ],
      {
        env: {
          ...process.env,
          HOME: root,
          PNYX_HOME: join(
            root,
            'pnyx',
          ),
          CLAUDE_CONFIG_DIR: join(
            root,
            'claude',
          ),
          CODEX_HOME: join(
            root,
            'codex',
          ),
        },
        timeout: FIXTURE_TIMEOUT_MS,
      },
    )
    assert.match(
      result.stdout,
      /A silent compaction failed at its deadline and released held input/,
    )
  },
)
