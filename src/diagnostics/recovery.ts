import { createHash } from 'node:crypto'
import { background } from '#app/background.ts'
import { logFailure } from '#app/diagnostics.ts'
import { indexedEvents } from '#app/event-log.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { sendReply } from '#workers/reply.ts'
import type { NativeHealth } from './health.ts'
import { recoveryCandidates, recoverySubjects, recoveryKey, RECOVERY_ATTEMPTS, RECOVERY_PAUSE_MS, type RecoveryAttempt } from './recovery-state.ts'

const replyKeys = ({ event }: { event: HydraEvent }) => event.type === 'card.replied'
  ? [
    recoveryKey({
      task: event.cardId,
      message: event.data.reply,
    }),
  ] : []

const incidentId = ({
  task,
  message,
}: {
  task: string
  message: string
}) => createHash('sha256')
  .update(recoveryKey({
    task,
    message,
  }))
  .digest('hex')

export function createDiagnosticRecovery({
  hydraId,
  sessions,
  enabled,
  changed,
  pause = RECOVERY_PAUSE_MS,
}: {
  hydraId: string
  sessions(): NativeHealth[]
  enabled(): boolean
  changed(): void
  pause?: number
}) {
  let closed = false
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const running = new Map<string, Promise<void>>()
  const blocked = new Map<string, {
    taskId: string
    messageId: string
    reason: string
  }>()
  const state = (): HydraState => loadHydra({ hydraId }).state
  const originalFor = ({
    task,
    message,
  }: {
    task: string
    message: string
  }) => indexedEvents({
    hydraId,
    keys: replyKeys,
    key: recoveryKey({
      task,
      message,
    }),
  })[0]

  const candidates = () => {
    const current = state()
    const failed = recoverySubjects({ state: current }).map(({
      card,
      reply,
    }) => ({
      task: card.id,
      message: reply.id,
    }))

    if (!failed.length) {
      return []
    }

    const originals = failed.map(originalFor)
      .filter((event): event is HydraEvent => event !== undefined)

    return recoveryCandidates({
      state: current,
      sessions: sessions(),
      enabled: enabled(),
      now: Date.now(),
      events: originals,
    })
  }

  const record = ({
    task,
    attempt,
  }: {
    task: string
    attempt: RecoveryAttempt
  }) => withWriter({
    hydraId,
    fn: ({ writer }) => writer.append({
      event: {
        v: 1,
        id: `diagnostic:${incidentId({
          task,
          message: attempt.message,
        })}:${attempt.number}:${attempt.status}`,
        at: attempt.at,
        actor: 'pnyx',
        cardId: task,
        seq: writer.state.seq + 1,
        type: 'diagnostic.retry',
        data: attempt,
      },
    }),
  })

  const block = ({
    task,
    message,
    error,
  }: {
    task: string
    message: string
    error: unknown
  }) => {
    blocked.set(
      recoveryKey({
        task,
        message,
      }),
      {
        taskId: task,
        messageId: message,
        reason: 'recovery event persistence failed; automation stopped',
      },
    )
    logFailure({
      operation: 'recovery persistence',
      error,
      context: {
        hydraId,
        taskId: task,
        correlationId: message,
      },
    })
  }

  const notify = ({
    task,
    message,
  }: {
    task: string
    message: string
  }) => {
    const id = `diagnostic-alert:${incidentId({
      task,
      message,
    })}`
    let written = false

    try {
      written = withWriter({
        hydraId,
        fn: ({ writer }) => {
          if (id in writer.state.eventIds) {
            return false
          }

          writer.append({
            event: {
              v: 1,
              seq: writer.state.seq + 1,
              id,
              messageId: message,
              at: new Date().toISOString(),
              actor: 'pnyx',
              cardId: task,
              type: 'hydra.message',
              data: {
                action: 'send',
                hydra: writer.state.config?.hydra.id ?? 'hydra',
                task,
                text: '- Automatic message recovery stopped. Inspect `pnyx-axi debug health` for delivery, ownership and persistence details before acting.',
              },
            },
          })

          return true
        },
      })
    } catch (error) {
      block({
        task,
        message,
        error,
      })
    }

    if (written) {
      changed()
    }
  }

  const attempt = async ({
    task,
    message,
  }: {
    task: string
    message: string
  }) => {
    if (closed) {
      return
    }

    const candidate = candidates().find(item => item.taskId === task && item.messageId === message)

    if (!candidate?.eligible || !candidate.sessionId) {
      if (candidate?.attempts.length) {
        notify({
          task,
          message,
        })
      }

      return
    }

    const original = originalFor({
      task,
      message,
    })

    if (original?.type !== 'card.replied' || !original.data.text) {
      return
    }

    const reservation: RecoveryAttempt = {
      message,
      number: candidate.attempts.length + 1,
      status: 'reserved',
      sessionId: candidate.sessionId,
      generation: candidate.generation,
      at: new Date().toISOString(),
    }

    try {
      record({
        task,
        attempt: reservation,
      })
    } catch (error) {
      block({
        task,
        message,
        error,
      })
      notify({
        task,
        message,
      })

      return
    }

    let status: RecoveryAttempt['status']

    try {
      const receipt = await sendReply({
        hydraId,
        request: {
          card: task,
          expectedSession: candidate.sessionId,
          text: original.data.text,
          id: message,
          homes: [],
          actor: 'pnyx',
        },
      })
      status = receipt.state === 'delivered' ? 'delivered' : 'unknown'

      if (receipt.state === 'failed') {
        status = 'failed'
      }
    } catch (error) {
      // Only a durable failed receipt proves that a thrown send did not reach the native session.
      const current = state().cards[task]?.replies?.find(reply => reply.id === message)
      status = current?.state === 'failed' ? 'failed' : 'unknown'
      logFailure({
        operation: 'message recovery',
        error,
        context: {
          hydraId,
          taskId: task,
          sessionId: candidate.sessionId,
          correlationId: message,
        },
      })
    }

    try {
      record({
        task,
        attempt: {
          ...reservation,
          status,
          at: new Date().toISOString(),
        },
      })
    } catch (error) {
      block({
        task,
        message,
        error,
      })
      notify({
        task,
        message,
      })

      return
    }

    if (status === 'unknown' || (status === 'failed' && reservation.number >= RECOVERY_ATTEMPTS)) {
      notify({
        task,
        message,
      })
    }

    changed()
  }

  const launch = ({
    task,
    message,
    key,
  }: {
    task: string
    message: string
    key: string
  }) => {
    if (closed || running.has(key) || blocked.has(key)) {
      return
    }

    const run = async () => {
      try {
        await attempt({
          task,
          message,
        })
      } finally {
        running.delete(key)
        changed()
      }
    }

    const completion = run()
    running.set(
      key,
      completion,
    )
    background({
      name: 'diagnostic recovery',
      context: {
        hydraId,
        taskId: task,
        correlationId: message,
      },
      run: () => completion,
    })
  }

  return {
    blocked: () => [...blocked.values()].map(incident => ({ ...incident })),
    reconcile() {
      if (closed) {
        return
      }

      for (const candidate of candidates()) {
        const task = candidate.taskId
        const message = candidate.messageId
        const key = recoveryKey({
          task,
          message,
        })

        if (running.has(key) || timers.has(key) || blocked.has(key)) {
          continue
        }

        const unresolved = candidate.attempts.at(-1)

        if (unresolved && [
          'reserved',
          'unknown',
        ].includes(unresolved.status)
          && candidate.receiptState === 'delivered') {
          try {
            record({
              task,
              attempt: {
                ...unresolved,
                status: 'delivered',
                at: new Date().toISOString(),
              },
            })
            changed()
          } catch (error) {
            block({
              task,
              message,
              error,
            })
            notify({
              task,
              message,
            })
          }

          continue
        }

        if (!candidate.eligible) {
          const last = candidate.attempts.at(-1)

          if (last && last.status !== 'delivered') {
            notify({
              task,
              message,
            })
          }

          continue
        }

        const last = candidate.attempts.at(-1)
        const remaining = last ? Date.parse(last.at) + pause - Date.now() : 0

        if (remaining > 0) {
          timers.set(
            key,
            setTimeout(
              () => {
                timers.delete(key)
                launch({
                  task,
                  message,
                  key,
                })
              },
              remaining,
            ).unref(),
          )
        } else {
          launch({
            task,
            message,
            key,
          })
        }
      }
    },
    async close() {
      closed = true

      for (const timer of timers.values()) {
        clearTimeout(timer)
      }

      timers.clear()
      await Promise.allSettled(running.values())
    },
  }
}
