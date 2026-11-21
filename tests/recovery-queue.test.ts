import { expect, test, vi } from 'vitest'
import { emptyHydra } from '#app/reducer.ts'
import type { Writer } from '#app/writer.ts'
import { createDiagnosticRecovery } from '#diagnostics/recovery.ts'

const gate = vi.hoisted(() => ({
  entered: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
  now: Date.parse('2026-01-01T00:00:00.000Z'),
  receiptState: 'failed' as 'failed' | 'delivered',
  noticeEligible: false,
  writes: 0,
}))
const state = emptyHydra()

vi.mock(
  '#app/store.ts',
  () => ({ loadHydra: () => ({ state }) }),
)
vi.mock(
  '#app/event-log.ts',
  () => ({ scanEvents: () => [] }),
)
vi.mock(
  '#diagnostics/recovery-state.ts',
  async () => ({
    ...await vi.importActual<typeof import('#diagnostics/recovery-state.ts')>('#diagnostics/recovery-state.ts'),
    recoverySubjects: () => [
      {
        card: { id: 'notice' },
        reply: { id: 'notice-message' },
      },
      {
        card: { id: 'retry' },
        reply: { id: 'retry-message' },
      },
    ],
    recoveryCandidates: () => [
      {
        taskId: 'notice',
        messageId: 'notice-message',
        receiptState: gate.receiptState,
        eligible: gate.noticeEligible,
        attempts: [
          {
            message: 'notice-message',
            number: 1,
            status: 'unknown',
            sessionId: 'notice-session',
            at: new Date(gate.now).toISOString(),
          },
        ],
      },
      {
        taskId: 'retry',
        messageId: 'retry-message',
        receiptState: 'failed',
        eligible: true,
        attempts: [
          {
            message: 'retry-message',
            number: 1,
            status: 'failed',
            sessionId: 'retry-session',
            at: new Date(gate.now).toISOString(),
          },
        ],
      },
    ],
  }),
)
vi.mock(
  '#app/writer.ts',
  () => ({
    withWriter: async ({ fn }: { fn({ writer }: { writer: Writer }): unknown }) => {
      gate.writes += 1
      gate.entered.resolve()
      await gate.release.promise

      return fn({
        writer: {
          state,
          dir: '',
          append: () => {},
          observe: () => {},
          afterCommit: () => {},
        },
      })
    },
  }),
)

test.each([
  {
    phase: 'notice',
    receiptState: 'failed',
  },
  {
    phase: 'confirmation',
    receiptState: 'delivered',
  },
] as const)(
  'closing recovery during a queued $phase write leaves no retry timer behind',
  async ({ receiptState }) => {
    gate.entered = Promise.withResolvers<void>()
    gate.release = Promise.withResolvers<void>()
    gate.receiptState = receiptState
    gate.noticeEligible = false
    gate.writes = 0
    const schedule = vi.fn(() => () => {})
    const recovery = createDiagnosticRecovery({
      hydraId: 'closing-recovery',
      sessions: () => [],
      enabled: () => true,
      changed: () => {},
      clock: {
        now: () => gate.now,
        schedule,
      },
    })
    const reconciliation = recovery.reconcile()

    try {
      const phase = await Promise.race([
        gate.entered.promise.then(() => 'waiting'),
        reconciliation,
      ])
      expect(phase).toBe('waiting')
      await recovery.close()
      gate.release.resolve()
      await reconciliation
      expect(schedule).not.toHaveBeenCalled()
    } finally {
      gate.release.resolve()
      await Promise.allSettled([reconciliation])
      await recovery.close()
    }
  },
)

test(
  'concurrent recovery notices schedule one retry timer per incident',
  async () => {
    gate.entered = Promise.withResolvers<void>()
    gate.release = Promise.withResolvers<void>()
    gate.receiptState = 'failed'
    gate.noticeEligible = true
    gate.writes = 0
    const cancel = vi.fn()
    const schedule = vi.fn(() => cancel)
    const recovery = createDiagnosticRecovery({
      hydraId: 'concurrent-recovery',
      sessions: () => [],
      enabled: () => true,
      changed: () => {},
      clock: {
        now: () => gate.now,
        schedule,
      },
    })
    const reconciliations = Promise.all([
      recovery.reconcile(),
      recovery.reconcile(),
    ])

    try {
      const phase = await Promise.race([
        gate.entered.promise.then(() => 'waiting'),
        reconciliations,
      ])
      expect(phase).toBe('waiting')
      expect(gate.writes).toBe(2)
      gate.release.resolve()
      await reconciliations
      expect(schedule).toHaveBeenCalledTimes(2)
      await recovery.close()
      expect(cancel).toHaveBeenCalledTimes(2)
    } finally {
      gate.release.resolve()
      await Promise.allSettled([reconciliations])
      await recovery.close()
    }
  },
)
