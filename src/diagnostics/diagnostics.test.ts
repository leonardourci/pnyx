import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { emptyHydra, replay } from '#app/reducer.ts'
import { recoveryCandidates } from './recovery-state.ts'
import type { HydraEvent } from '#app/model.ts'
import { timeline, serviceRows, type TimelineRow } from './timeline.ts'
import { RECOVERY_PAUSE_MS } from './recovery-state.ts'
import { healthFacts, nativeHealth } from './health.ts'
import type { NativeWork } from '#workers/provider.ts'

const events: HydraEvent[] = [
  {
    v: 1,
    seq: 1,
    id: 'start',
    at: '2026-01-01T00:00:00Z',
    actor: 'pnyx',
    cardId: '$hydra',
    type: 'hydra.helper-started',
    data: {
      id: 'batch',
      tasks: ['task'],
      prompt: 'PRIVATE_BODY',
      seqs: [1],
    },
  },
  {
    v: 1,
    seq: 2,
    id: 'finish',
    at: '2026-01-01T00:00:01Z',
    actor: 'pnyx',
    cardId: '$hydra',
    type: 'hydra.helper-finished',
    transaction: 'transaction',
    data: {
      batch: 'batch',
      outcomes: [],
    },
  },
  {
    v: 1,
    seq: 3,
    id: 'ack',
    at: '2026-01-01T00:00:01Z',
    actor: 'pnyx',
    cardId: '$hydra',
    type: 'hydra.helper-acknowledged',
    data: {
      batches: ['batch'],
      through: 2,
    },
  },
]

test(
  'timeline joins a task to its helper finish and acknowledgement and pages without repeating equal timestamps',
  () => {
    const first = timeline({
      events,
      filter: {
        task: 'task',
        limit: 1,
      },
    })
    assert.deepEqual(
      first.entries.map(row => row.id),
      ['ack'],
    )
    assert.ok(first.cursor)
    const second = timeline({
      events,
      filter: {
        task: 'task',
        limit: 1,
        cursor: first.cursor,
      },
    })
    assert.deepEqual(
      second.entries.map(row => row.id),
      ['finish'],
    )
    assert.equal(
      second.entries[0]?.transaction,
      'transaction',
    )
    const third = timeline({
      events,
      filter: {
        task: 'task',
        limit: 1,
        cursor: second.cursor,
      },
    })
    assert.deepEqual(
      third.entries.map(row => row.id),
      ['start'],
    )
    assert.equal(
      third.more,
      false,
    )
    assert.ok(!JSON.stringify([
      first,
      second,
      third,
    ]).includes('PRIVATE_BODY'))
    assert.throws(
      () => timeline({
        events,
        filter: {
          limit: 1,
          cursor: 'garbage',
        },
      }),
      /Invalid timeline cursor/,
    )
  },
)

test(
  'timeline filters intersect, retain both sources and include inclusive time boundaries',
  () => {
    const service: TimelineRow[] = [
      {
        source: 'service',
        id: 'operation',
        offset: 4,
        seq: 2,
        at: '2026-01-01T00:00:01Z',
        type: 'resume',
        taskId: 'task',
        sessionId: 'session',
        correlationId: 'message',
      },
    ]
    const page = timeline({
      events,
      service,
      filter: {
        task: 'task',
        session: 'session',
        message: 'message',
        since: Date.parse('2026-01-01T00:00:01Z'),
        until: Date.parse('2026-01-01T00:00:01Z'),
        limit: 10,
      },
    })
    assert.deepEqual(
      page.entries.map(row => row.id),
      ['operation'],
    )
    const retried: HydraEvent = {
      v: 1,
      seq: 4,
      id: 'retry',
      at: '2026-01-01T00:00:03Z',
      actor: 'pnyx',
      cardId: 'task',
      sessionId: 'new-assignment',
      type: 'diagnostic.retry',
      data: {
        message: 'message',
        number: 1,
        status: 'failed',
        sessionId: 'original-session',
        at: '2026-01-01T00:00:03Z',
      },
    }
    const actual = timeline({
      events: [retried],
      filter: {
        session: 'original-session',
        limit: 1,
      },
    })
    assert.equal(
      actual.entries[0]?.sessionId,
      'original-session',
    )
    assert.equal(
      actual.entries[0]?.recordedSessionId,
      'new-assignment',
    )
    assert.equal(
      actual.entries[0]?.state,
      'failed',
    )
    assert.equal(
      actual.entries[0]?.attempt,
      1,
    )
    assert.equal(
      page.entries[0]?.offset,
      4,
    )
    assert.equal(
      timeline({
        events,
        service,
        filter: {
          task: 'other',
          limit: 10,
        },
      }).entries.length,
      0,
    )
    assert.deepEqual(
      timeline({
        events,
        filter: {
          batch: 'batch',
          limit: 10,
        },
      }).entries.map(row => row.id),
      [
        'ack',
        'finish',
        'start',
      ],
    )
  },
)

test(
  'service history bounds its read, ignores legacy and torn records and returns identities without error bodies',
  t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-service-query-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = home
    t.after(() => {
      if (previous === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previous
      }

      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    })
    const own = {
      v: 1,
      at: '2026-01-01T00:00:00Z',
      hydraId: 'lab',
      operationId: 'operation',
      operation: 'resume',
      eventSeq: 4,
      correlationId: 'message',
      error: { message: 'PRIVATE_TRACE_BODY' },
    }
    writeFileSync(
      join(
        home,
        'service.log',
      ),
      `${'x'.repeat(512 * 1024)}\nlegacy error\n${JSON.stringify({
        ...own,
        hydraId: 'other',
      })}\n${JSON.stringify(own)}\n{"v":1`,
    )
    const page = serviceRows({ hydraId: 'lab' })
    assert.equal(
      page.truncated,
      true,
    )
    assert.equal(
      page.rows.length,
      1,
    )
    assert.equal(
      page.rows[0]?.id,
      'operation',
    )
    assert.equal(
      page.rows[0]?.seq,
      4,
    )
    assert.equal(
      page.rows[0]?.correlationId,
      'message',
    )
    assert.ok(!JSON.stringify(page).includes('PRIVATE_TRACE_BODY'))
  },
)

const busy: NativeWork = {
  runningTurns: [],
  runningTools: [],
  unsettledInputs: ['input'],
  pendingControls: [],
  queue: { knowledge: 'unknown' },
  background: {
    knowledge: 'unknown',
    reason: 'unreported',
  },
}

test(
  'recovery requires a durable failure, known idle ownership and an unspent budget across replay',
  () => {
    assert.equal(
      RECOVERY_PAUSE_MS,
      30_000,
    )
    const state = replay({
      state: emptyHydra(),
      events: [
        {
          v: 1,
          seq: 1,
          id: 'create',
          at: '2026-01-01T00:00:00Z',
          actor: 'cli',
          cardId: 'task',
          type: 'task.created',
          data: {
            key: 'task',
            title: 'Task',
          },
        },
      ],
    })
    const card = state.cards.task
    assert.ok(card)
    card.agent = {
      provider: 'codex',
      sessionId: 'session',
      host: 'pnyx',
    }
    card.sessionIds = ['codex:session']
    card.steeringGeneration = 1
    card.replies = [
      {
        id: 'message',
        state: 'failed',
      },
    ]
    const events: HydraEvent[] = [
      {
        v: 1,
        seq: 2,
        id: 'original',
        sessionId: 'codex:session',
        at: '2026-01-01T00:00:00Z',
        actor: 'cli',
        cardId: 'task',
        type: 'card.replied',
        data: {
          reply: 'message',
          route: 'pnyx',
          state: 'queued',
          text: 'Synthetic instruction',
        },
      },
    ]
    const idle: NativeWork = {
      runningTurns: [],
      runningTools: [],
      unsettledInputs: [],
      pendingControls: [],
      queue: {
        knowledge: 'known',
        count: 0,
      },
      background: {
        knowledge: 'known',
        tasks: [],
      },
    }
    const sessions = [
      {
        sessionId: 'codex:session',
        taskId: 'task',
        attached: true,
        leased: false,
        generation: 1,
        work: idle,
        inputs: [],
      },
    ]
    assert.equal(
      recoveryCandidates({
        state,
        sessions,
        events,
        enabled: true,
        now: Date.parse('2026-01-01T00:01:00Z'),
      })[0]?.eligible,
      true,
    )
    assert.equal(
      recoveryCandidates({
        state,
        sessions,
        events,
        enabled: false,
        now: Date.parse('2026-01-01T00:01:00Z'),
      })[0]?.eligible,
      false,
    )
    assert.equal(
      recoveryCandidates({
        state,
        sessions: [],
        events,
        enabled: true,
        now: Date.parse('2026-01-01T00:01:00Z'),
      })[0]?.eligible,
      false,
    )
    assert.equal(
      recoveryCandidates({
        state,
        sessions: [
          {
            ...sessions[0]!,
            leased: true,
          },
        ],
        events,
        enabled: true,
        now: Date.parse('2026-01-01T00:01:00Z'),
      })[0]?.eligible,
      false,
    )
    assert.equal(
      recoveryCandidates({
        state,
        sessions: [
          {
            ...sessions[0]!,
            work: busy,
          },
        ],
        events,
        enabled: true,
        now: Date.parse('2026-01-01T00:01:00Z'),
      })[0]?.eligible,
      false,
    )
    const original = events[0]
    assert.ok(original)
    assert.equal(
      recoveryCandidates({
        state,
        sessions,
        events: [
          {
            ...original,
            sessionId: 'codex:other',
          },
        ],
        enabled: true,
        now: Date.parse('2026-01-01T00:01:00Z'),
      })[0]?.eligible,
      false,
    )
    assert.equal(
      recoveryCandidates({
        state,
        sessions: [
          {
            ...sessions[0]!,
            generation: 2,
          },
        ],
        events,
        enabled: true,
        now: Date.parse('2026-01-01T00:01:00Z'),
      })[0]?.eligible,
      false,
    )
    assert.equal(
      recoveryCandidates({
        state,
        sessions,
        events,
        enabled: true,
        now: Date.parse('2026-01-01T00:31:00Z'),
      })[0]?.eligible,
      false,
    )
    assert.equal(
      recoveryCandidates({
        state,
        sessions,
        events: [
          {
            ...original,
            at: 'unknown',
          },
        ],
        enabled: true,
        now: Date.parse('2026-01-01T00:01:00Z'),
      })[0]?.eligible,
      false,
    )
    card.steeringGeneration = 3
    assert.equal(
      recoveryCandidates({
        state,
        sessions: [
          {
            ...sessions[0]!,
            generation: 3,
          },
        ],
        events,
        enabled: true,
        now: Date.parse('2026-01-01T00:01:00Z'),
      })[0]?.reason,
      'the original assignment is not current',
    )
    card.steeringGeneration = 1
    const reserved = replay({
      state,
      events: [
        {
          v: 1,
          seq: 3,
          id: 'reserved',
          at: '2026-01-01T00:00:01Z',
          actor: 'pnyx',
          cardId: 'task',
          type: 'diagnostic.retry',
          data: {
            message: 'message',
            number: 1,
            status: 'reserved',
            sessionId: 'codex:session',
            generation: 1,
            at: '2026-01-01T00:00:01Z',
          },
        },
      ],
    })
    assert.equal(
      recoveryCandidates({
        state: reserved,
        sessions,
        events,
        enabled: true,
        now: Date.parse('2026-01-01T00:01:00Z'),
      })[0]?.eligible,
      false,
    )
    reserved.cards.task!.replies = [
      {
        id: 'message',
        state: 'queued',
      },
    ]
    assert.equal(
      recoveryCandidates({
        state: reserved,
        sessions,
        events,
        enabled: true,
        now: Date.parse('2026-01-01T00:01:00Z'),
      }).length,
      1,
    )
    reserved.cards.task!.replies = [
      {
        id: 'message',
        state: 'failed',
      },
    ]
    const exhausted = replay({
      state: reserved,
      events: [
        {
          v: 1,
          seq: 4,
          id: 'failed-one',
          at: '2026-01-01T00:00:02Z',
          actor: 'pnyx',
          cardId: 'task',
          type: 'diagnostic.retry',
          data: {
            message: 'message',
            number: 1,
            status: 'failed',
            sessionId: 'codex:session',
            generation: 1,
            at: '2026-01-01T00:00:02Z',
          },
        },
        {
          v: 1,
          seq: 5,
          id: 'failed-two',
          at: '2026-01-01T00:00:33Z',
          actor: 'pnyx',
          cardId: 'task',
          type: 'diagnostic.retry',
          data: {
            message: 'message',
            number: 2,
            status: 'failed',
            sessionId: 'codex:session',
            generation: 1,
            at: '2026-01-01T00:00:33Z',
          },
        },
      ],
    })
    assert.equal(
      recoveryCandidates({
        state: exhausted,
        sessions,
        events,
        enabled: true,
        now: Date.parse('2026-01-01T00:01:00Z'),
      })[0]?.reason,
      'recovery budget exhausted',
    )
    card.replies = [
      {
        id: 'message',
        state: 'delivery_unknown',
      },
    ]
    assert.equal(
      recoveryCandidates({
        state,
        sessions,
        events,
        enabled: true,
        now: Date.parse('2026-01-01T00:01:00Z'),
      }).length,
      0,
    )
  },
)

test(
  'health reports retained native work and unknown deadlines without releasing ownership or consuming files',
  t => {
    const dir = mkdtempSync(join(
      tmpdir(),
      'pnyx-diagnostics-',
    ))
    t.after(() => rmSync(
      dir,
      {
        recursive: true,
        force: true,
      },
    ))
    mkdirSync(join(
      dir,
      'spool',
    ))
    mkdirSync(join(
      dir,
      'helper-pending',
    ))
    writeFileSync(
      join(
        dir,
        'spool',
        '.tmp-ignored.json',
      ),
      '{}',
    )
    writeFileSync(
      join(
        dir,
        'spool',
        'eligible.json',
      ),
      '{}',
    )
    writeFileSync(
      join(
        dir,
        'helper-pending',
        'batch.json',
      ),
      'PRIVATE_COMPLETION',
    )
    const state = emptyHydra()
    state.helper = {
      runs: {
        batch: {
          id: 'batch',
          tasks: ['task'],
          prompt: 'PRIVATE_PROMPT',
          seqs: [],
          startedAt: '2026-01-01T00:00:00Z',
        },
      },
      outcomes: [],
      handled: [],
      wakes: [],
      delivered: 0,
    }
    const now = Date.parse('2026-01-01T00:00:10Z')
    const unknown = healthFacts({
      state,
      dir,
      now,
      limit: 1,
    })
    assert.equal(
      unknown.helper.batches[0]?.overdue,
      'unknown',
    )
    assert.equal(
      unknown.spool.eligible,
      1,
    )
    assert.equal(
      unknown.pendingCompletions.total,
      1,
    )
    assert.equal(
      unknown.runtime,
      'unknown',
    )
    const runtime = {
      sessions: [
        {
          sessionId: 'session',
          taskId: 'task',
          attached: true,
          stale: true,
          work: busy,
          inputs: [
            {
              id: 'input',
              taskId: 'task',
              taken: false,
            },
          ],
        },
      ],
      helper: {
        busy: true,
        batchId: 'batch',
        sessionId: 'helper-session',
        work: busy,
        deadlineAt: now,
      },
      scheduler: {
        lastSuccessAt: '2026-01-01T00:00:05Z',
        lastSuccessSeq: 3,
      },
    }
    const facts = healthFacts({
      state,
      dir,
      now,
      limit: 1,
      runtime,
    })
    assert.equal(
      facts.helper.batches[0]?.overdue,
      true,
    )
    assert.equal(
      facts.helper.batches[0]?.ownership,
      'attached',
    )
    const native = nativeHealth({
      sessions: runtime.sessions,
      limit: 1,
    })
    assert.equal(
      native.retainedTotal,
      1,
    )
    assert.equal(
      native.inputs[0]?.phase,
      'awaiting_admission',
    )
    assert.equal(
      runtime.sessions[0]?.work.unsettledInputs.length,
      1,
    )
    assert.equal(
      state.helper.runs.batch?.id,
      'batch',
    )
    assert.ok(!JSON.stringify(facts).includes('PRIVATE_'))
  },
)
