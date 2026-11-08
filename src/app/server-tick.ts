import type { startReviewTimer } from '#hydra/review-timer.ts'
import { ingestSpool } from '#integrations/hooks/ingest.ts'
import { settleDone, settles } from '#projects/copies.ts'
import { readSettings } from '#settings/store.ts'
import { spoolFiles } from '#store/storage.ts'
import type { createSourceRunner } from '#task-sources/runner.ts'
import { sourceDeadline } from '#task-sources/state.ts'
import { followPullRequests, needsPullRequestFollow } from '#tasks/delivery/follow.ts'
import { fireReminders } from '#tasks/fire-reminders.ts'
import { resumeWaits, waitResumesPending, notifyWaitResumes } from '#tasks/resume-waits.ts'
import type { ReminderScheduler } from '#tasks/reminder-scheduler.ts'
import { reminderDeadline } from '#tasks/reminders.ts'
import { hideDone } from '#tasks/retention.ts'
import { doneDeadline } from '#tasks/retention-rules.ts'
import { advanceQueues } from '#workers/advance-queue.ts'
import { steeringToFollow } from '#workers/inbox-follow-up.ts'
import { QUEUE_POLL_MS } from '#workers/queue.ts'
import { followUpReplies, repliesToFollow } from '#workers/reply-retry.ts'
import { background } from './background.ts'
import { logFailure } from './diagnostics.ts'
import type { createHost } from './host.ts'
import type { HydraState } from './model.ts'
import type { createServerWorkers } from './server-workers.ts'

// How often replies a route could not confirm are checked for a resend.
const REPLY_POLL_MS = 30_000

type ServerWorkers = ReturnType<typeof createServerWorkers>

// The one coalesced scheduler tick of a mounted Hydra: read the log, run what is due, and set the next wake.
export function createServerTick({
  hydraId,
  dir,
  state,
  closed,
  pump,
  followDelay,
  reminderScheduler,
  runWorker,
  triedResends,
  resendReply,
  agents,
  sources,
  review,
  recover,
}: {
  hydraId: string
  dir: string
  state(): HydraState
  closed(): boolean
  pump(): void
  followDelay: number
  reminderScheduler: ReminderScheduler
  runWorker: ServerWorkers['runWorker']
  triedResends: ServerWorkers['triedResends']
  resendReply: ServerWorkers['resendReply']
  agents(): Pick<ReturnType<typeof createHost>, 'unconfirmed'>
  sources(): ReturnType<typeof createSourceRunner>
  review(): ReturnType<typeof startReviewTimer>
  recover(): void
}) {
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let cancelReminder = () => {}
  let queueRun: Promise<void> | undefined
  let queueCheckedAt = 0
  let queueNeedsRetry = false
  let followRun: Promise<void> | undefined
  let settling: Promise<void> | undefined
  let followCheckedAt = 0
  let replyRun: Promise<void> | undefined
  let replyCheckedAt = 0
  const waitResumeRetryAfter = new Map<string, number>()
  let scheduled = false
  let lastSuccessAt: string | undefined
  let lastSuccessSeq: number | undefined
  let lastFailureAt: string | undefined

  const kick = () => {
    if (closed() || scheduled) {
      return
    }

    scheduled = true
    setImmediate(() => {
      scheduled = false

      if (closed()) {
        return
      }

      let repliesPending = false

      try {
        if (spoolFiles({ dir }).length > 0) {
          ingestSpool({ hydraId })
        }

        pump()
        resumeWaits({
          hydraId,
          state: state(),
        })
        pump()

        if (!queueRun && Date.now() - queueCheckedAt >= QUEUE_POLL_MS) {
          queueCheckedAt = Date.now()
          queueRun = (async () => {
            try {
              queueNeedsRetry = await advanceQueues({
                hydraId,
                active: () => !closed(),
                state: state(),
              })
            } catch (error) {
              queueNeedsRetry = true
              logFailure({
                operation: 'queue',
                error,
                context: {
                  hydraId,
                  eventSeq: state().seq,
                },
              })
            } finally {
              queueRun = undefined
              kick()
            }
          })()
        }

        const following = needsPullRequestFollow({ state: state() })

        if (following && !followRun && Date.now() - followCheckedAt >= followDelay) {
          followCheckedAt = Date.now()
          followRun = (async () => {
            try {
              await followPullRequests({
                hydraId,
                active: () => !closed(),
              })
            } catch (error) {
              logFailure({
                operation: 'follow',
                error,
                context: {
                  hydraId,
                  eventSeq: state().seq,
                },
              })
            } finally {
              followRun = undefined
              kick()
            }
          })()
        }

        const replyCheckDue = Date.now() - replyCheckedAt >= REPLY_POLL_MS
        repliesPending = repliesToFollow({ state: state() }) || steeringToFollow({ state: state() })

        const waitResumes = waitResumesPending({
          state: state(),
          retryAfter: waitResumeRetryAfter,
        })

        if (!replyRun && repliesPending && (replyCheckDue || waitResumes)) {
          replyCheckedAt = Date.now()
          replyRun = (async () => {
            try {
              await notifyWaitResumes({
                hydraId,
                retryAfter: waitResumeRetryAfter,
                retryDelay: REPLY_POLL_MS,
              })

              if (steeringToFollow({ state: state() })) {
                await runWorker({
                  args: [
                    'inbox-follow',
                    hydraId,
                  ],
                })
              }

              if (closed()) {
                return
              }

              await followUpReplies({
                hydraId,
                tried: triedResends,
                resend: resendReply,
                unconfirmed: agents().unconfirmed,
              })
            } catch (error) {
              if (!closed()) {
                logFailure({
                  operation: 'replies',
                  error,
                  context: {
                    hydraId,
                    eventSeq: state().seq,
                  },
                })
              }
            } finally {
              replyRun = undefined
              kick()
            }
          })()
        }

        sources().reconcile()
        background({
          name: 'diagnostic reconcile',
          run: recover,
          context: {
            hydraId,
            eventSeq: state().seq,
          },
        })
        background({
          name: 'review',
          run: review().check,
          context: {
            hydraId,
            eventSeq: state().seq,
          },
        })
        fireReminders({
          hydraId,
          at: new Date(reminderScheduler.now()).toISOString(),
          state: state(),
        })
        pump()
        const deadline = doneDeadline({
          state: state(),
          hours: readSettings().settings.doneAfterHours,
        })

        if (deadline !== undefined && deadline <= Date.now()) {
          hideDone({ hydraId })
          pump()
        }

        // One settle at a time; it reads the copies with git, off the event loop.
        if (!settling && Object.values(state().cards).some(card => settles({ card }))) {
          const settle = async () => {
            try {
              await settleDone({ hydraId })
            } catch (error) {
              logFailure({
                operation: 'settling copies',
                error,
                context: {
                  hydraId,
                  eventSeq: state().seq,
                },
              })

              return
            } finally {
              settling = undefined
            }

            pump()
          }

          settling = settle()
        }

        lastSuccessAt = new Date().toISOString()
        lastSuccessSeq = state().seq
      } catch (error) {
        lastFailureAt = new Date().toISOString()
        // A held lock or a damaged log; the next change retries.
        logFailure({
          operation: 'scheduler tick',
          error,
          context: { hydraId },
        })
      } finally {
        clearTimeout(expiryTimer)
        cancelReminder()
        const reminder = reminderDeadline({ state: state() })

        if (reminder !== undefined) {
          cancelReminder = reminderScheduler.schedule({
            at: reminder,
            fire: kick,
          })
        }

        const deadlines = [
          sourceDeadline({ state: state() }),
          sources().deadline(),
          doneDeadline({
            state: state(),
            hours: readSettings().settings.doneAfterHours,
          }),
          ...(!queueRun && (queueNeedsRetry || Object.values(state().cards).some(c => c.queue))
            ? [queueCheckedAt + QUEUE_POLL_MS] : []),
        ]
          .filter((at): at is number => at !== undefined)

        if (!followRun && needsPullRequestFollow({ state: state() })) {
          deadlines.push(followCheckedAt + followDelay)
        }

        const replyFollowUpDue = !replyRun && repliesPending

        if (replyFollowUpDue) {
          deadlines.push(replyCheckedAt + REPLY_POLL_MS)
        }

        const deadline = deadlines.length ? Math.min(...deadlines) : undefined

        if (deadline !== undefined) {
          expiryTimer = setTimeout(
            kick,
            Math.max(
              100,
              Math.min(
                60_000,
                deadline - Date.now(),
              ),
            ),
          )
        }
      }
    })
  }

  return {
    health: () => ({
      lastSuccessAt,
      lastSuccessSeq,
      lastFailureAt,
    }),
    kick,
    get queueRun() {
      return queueRun
    },
    get replyRun() {
      return replyRun
    },
    get followRun() {
      return followRun
    },
    get settling() {
      return settling
    },
    get expiryTimer() {
      return expiryTimer
    },
    get cancelReminder() {
      return cancelReminder
    },
  }
}
