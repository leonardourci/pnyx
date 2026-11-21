import { expect, test, vi } from 'vitest'
import { emptyHydra } from '#app/reducer.ts'
import type { Writer } from '#app/writer.ts'
import { createDiagnosticRecovery } from '#diagnostics/recovery.ts'

const gate = vi.hoisted(() => ({
  entered: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
  now: Date.parse('2026-01-01T00:00:00.000Z'),
  receiptState: 'failed' as 'failed' | 'delivered',
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
        eligible: false,
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

