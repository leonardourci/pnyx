import { restoreSessionActivity } from '#workers/session-recovery.ts'
import { handoffPending, recoverHandoffs } from '#workers/handoff-checkout.ts'
import { applyDecision } from './decision.ts'
import { background } from './background.ts'
import { log } from './diagnostics.ts'
import { scanEvents } from './event-log.ts'
import type { Host, Live } from './host-types.ts'
import { loadTitan } from './store.ts'
import type { Writer } from './writer.ts'
import { hostedTitan, hydraDelivery, hydraEvent, othrysRunsTitan } from '#titan/titan.ts'
import { hydraConfig } from '#titan/config.ts'
import { isRoutineMessage } from '#titan/model.ts'
import { hydraInputDispatched } from '#titan/received.ts'
import { ownerActor } from './actors.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { operationEvent, type createTitanOperations, type createTitanOutage } from '#titan/operations.ts'
import type { createWakeQueue } from '#titan/wake-queue.ts'
import { wakeReasons } from '#titan/wake-reasons.ts'
import { findTitanTurnToResume, wakeCursor, wakesThrough } from '#titan/wakes.ts'
import { WAKE_TURN } from '#titan/wake-ids.ts'
import type { createRoutineHelper } from '#routine-helper/runner.ts'
import { liveTask } from '#tasks/select.ts'
import type { upgradeQueue } from '#upgrade/queue.ts'
import type { trackChildren } from '#workers/children.ts'
import { waitingCardInput } from '#workers/card-input.ts'
import type { createCompactionControl } from '#workers/compaction/control.ts'
import { recordCompaction } from '#workers/compaction/record.ts'
import { WORKER_RESUME, findWorkerTurnToResume, closedTask, toolApplicationReady } from '#workers/host.ts'
import type { createHostedDelivery } from '#workers/hosted-delivery.ts'
import type { AgentRef } from '#workers/model.ts'
import type { createPermissionBridge } from '#workers/permission-bridge.ts'
import { decideReply } from '#workers/reply-rules.ts'
import { pendingSteering, steeringHeld } from '#workers/steering.ts'
import { sweepTaskProcesses } from './task-runtime.ts'

// Startup recovery after the server stopped: what each owner left running is ended, resumed or woken, in this order.
export function createHostRecovery({
  hydraId,
  live,
  children,
  upgrades,
  at,
  write,
  note,
  interrupt,
  endOperation,
  expireOrphans,
  send,
  helper,
  releaseCompact,
  planRetry,
  startFrom,
  host,
}: {
  hydraId: string
  live: Map<string, Live>
  children: ReturnType<typeof trackChildren>
  upgrades: ReturnType<typeof upgradeQueue>
  at(): string
  write<T>({ fn }: { fn: ({ writer }: { writer: Writer }) => T }): Promise<T>
  note({ fn }: { fn: ({ writer }: { writer: Writer }) => void }): Promise<void>
  interrupt({
    writer,
    agent,
    note,
    resumeAttemptId,
  }: {
    writer: Writer
    agent: AgentRef
    note: string
    resumeAttemptId?: string
  }): void
  endOperation: ReturnType<typeof createTitanOperations>['endOperation']
  expireOrphans: ReturnType<typeof createPermissionBridge>['expireOrphans']
  send: ReturnType<typeof createHostedDelivery>['send']
  helper: ReturnType<typeof createRoutineHelper>
  releaseCompact: ReturnType<typeof createCompactionControl>['releaseCompact']
  planRetry: ReturnType<typeof createTitanOutage>['planRetry']
  startFrom: ReturnType<typeof createWakeQueue>['startFrom']
  host(): Host
}) {
  let fenced = true

  const recover: Host['recover'] = async () => {
    await restoreSessionActivity({ hydraId })
    // A session whose earlier processes could not be stopped is left interrupted rather than run twice.
    fenced = false
    fenced = await children.sweep()
    fenced = await sweepTaskProcesses({
      hydraId,
      state: loadTitan({ hydraId }).state,
    }) && fenced
    await upgrades.recover()

    if (fenced) {
      await recoverHandoffs({ hydraId })
    }

    // No stop outlives the server: an upgrade or restart the step above did not end, or a compaction of Titan
    // the stop cut, ends here, and Titan gets the recap and its queue.
    await note({
      fn: ({ writer }) => {
        for (const pass of writer.state.historyMilestones ?? []) {
          if (pass.state === 'started' && (pass.kind === 'inscribe' || pass.blocking === false)) {
            applyDecision({
              writer,
              decision: operationEvent({
                state: writer.state,
                meta: {
                  at: at(),
                  actor: 'pnyx',
                },
                operation: {
                  id: pass.id,
                  kind: pass.kind,
                  through: pass.through,
                  historySince: pass.historySince,
                  parent: pass.parent,
                  blocking: pass.blocking,
                  state: 'failed',
                  error: `Othrys restarted during ${pass.kind}`,
                },
              }),
            })
          }
        }
      },
    })

    const cut = loadTitan({ hydraId }).state.hydraOperation
    const unsettled = loadTitan({ hydraId }).state.hydraAgentChange

    // An older version held owner messages behind an agent change waiting for a choice; a cut operation's recap already carries them.
    if (unsettled) {
      const state = loadTitan({ hydraId }).state
      const after = (state.eventIds[unsettled.id] ?? 1) - 1
      const hydra = hydraConfig({ state }).hydra.id
      const held = cut ? [] : (state.hydraMessages ?? []).filter(message => message.hydra === hydra
        && ownerActor({ actor: message.actor }) && (state.eventIds[message.id] ?? 0) > after
        && !message.stopped && !message.failure && !isRoutineMessage({ message })
        && !hydraInputDispatched({
          state,
          message,
        }))
      await write({
        fn: ({ writer }) => applyDecision({
          writer,
          decision: hydraEvent({
            state: writer.state,
            cardId: TITAN_CARD,
            meta: {
              at: at(),
              actor: 'pnyx',
            },
            change: {
              type: 'hydra.agent-change',
              data: {
                ...unsettled,
                state: 'cancelled',
              },
            },
          }),
        }),
      })

      for (const message of held) {
        background({
          name: 'Titan held message',
          run: () => host().hydra({
            id: message.id,
            text: hydraDelivery({ message }),
            actor: message.actor,
          }),
        })
      }
    }

    if (cut) {
      endOperation({
        id: cut.id,
        error: `Othrys restarted during the ${cut.kind}`,
      })
    }

    let cutTitanTurn: {
      resumeAttemptId: string
      resumeMessage: string
      wakeThrough: number
    } | undefined
    const cutWorkerTurns: {
      task: string
      resumeAttemptId: string
    }[] = []

    const cutCompactions = new Set<string>()
    await write({
      fn: ({ writer }) => {
        for (const card of Object.values(writer.state.cards)) {
          const operation = card.compaction?.operations.findLast(operation => operation.state === 'running')

          if (operation && !live.has(operation.session)) {
            if (operation.trigger === 'manual') {
              cutCompactions.add(operation.session)
            }

            recordCompaction({
              writer,
              card: card.id,
              at: at(),
              change: {
                kind: 'status',
                operation: {
                  ...operation,
                  state: 'failed',
                  endedAt: at(),
                  error: 'Othrys restarted during compaction',
                },
              },
            })
          }
        }

        expireOrphans({ writer })

        for (const session of Object.values(writer.state.sessions ?? {})) {
          const wasWorking = (session.sessionActivity ?? session.activity) === 'working'

          if (session.agent.host !== 'pnyx' || live.has(session.id) || !wasWorking) {
            continue
          }

          let resumeAttemptId: string | undefined
          const task = session.taskId ? writer.state.cards[session.taskId] : undefined

          const isTitan = session.id === writer.state.config?.hydra.session

          const resumable = fenced && !cutCompactions.has(session.id)

          if (resumable && isTitan && hostedTitan({ state: writer.state })) {
            cutTitanTurn = findTitanTurnToResume({
              hydraId,
              state: writer.state,
              agent: session.agent,
            })

            if (cutTitanTurn) {
              resumeAttemptId = cutTitanTurn.resumeAttemptId
            }
          } else if (resumable && task && liveTask({ card: task })
            && !handoffPending({
              hydraId,
              task: task.id,
            })
            && !closedTask({
              state: writer.state,
              card: task,
            })
            && !steeringHeld({ card: task })
            && session.id !== writer.state.config?.hydra.session) {
            resumeAttemptId = findWorkerTurnToResume({
              hydraId,
              state: writer.state,
              agent: session.agent,
            })

            if (resumeAttemptId) {
              cutWorkerTurns.push({
                task: task.id,
                resumeAttemptId,
              })
            }
          }

          interrupt({
            writer,
            agent: session.agent,
            note: 'Othrys stopped during this turn. Send a message to continue it.',
            resumeAttemptId,
          })
        }
      },
    })

    // Startup never waits on an agent reopening; each resumes on its own and a failure stays on its card.
    if (cutTitanTurn) {
      const resume = cutTitanTurn
      background({
        name: 'Titan resume',
        context: {
          hydraId,
          taskId: TITAN_CARD,
          correlationId: resume.resumeAttemptId,
        },
        run: () => host().hydra({
          id: resume.resumeAttemptId,
          text: resume.resumeMessage,
          actor: 'pnyx',
        }),
      })
    }

    // A worker the restart cut continues once; one that cannot stays interrupted for Titan or the owner.
    for (const cut of cutWorkerTurns) {
      try {
        await send({
          card: cut.task,
          text: WORKER_RESUME,
          actor: 'pnyx',
          eventId: `${cut.resumeAttemptId}:turn`,
          direct: true,
        })
      } catch (error) {
        const message = (error as Error).message
        log({
          level: 'error',
          operation: 'worker resume',
          error,
          hydraId,
          taskId: cut.task,
          correlationId: cut.resumeAttemptId,
        })
        await note({
          fn: ({ writer }) => {
            const agent = writer.state.cards[cut.task]?.agent

            if (agent) {
              interrupt({
                writer,
                agent,
                note: `Othrys stopped during this turn and could not resume it: ${message}. Send a message to continue it.`,
              })
            }
          },
        })
      }
    }

    for (const card of Object.values(loadTitan({ hydraId }).state.cards)) {
      if (card.id === TITAN_CARD || !liveTask({ card }) || card.agent?.host !== 'pnyx' || steeringHeld({ card })
        || handoffPending({
          hydraId,
          task: card.id,
        })) {
        continue
      }

      const next = pendingSteering({ card })[0]

      if (!next) {
        continue
      }

      try {
        await send({
          card: card.id,
          text: '',
          actor: 'pnyx',
          steering: next.id,
        })
      } catch (error) {
        log({
          level: 'error',
          operation: 'inbox resume',
          error,
          hydraId,
          taskId: card.id,
          correlationId: next.id,
        })
      }
    }

    // A direct message handed to an agent the restart stopped may or may not have arrived; Othrys never sends it again by itself.
    await note({
      fn: ({ writer }) => {
        for (const card of Object.values(writer.state.cards)) {
          if (card.agent?.host !== 'pnyx') {
            continue
          }

          const held = new Set([
            ...(card.steering ?? []).flatMap(message => message.reply ? [message.reply] : []),
            ...(card.compaction?.inputs ?? []).map(input => input.id),
          ])

          for (const reply of card.replies ?? []) {
            // The card's agent is Othrys-hosted, so a reply still queued for it went the Othrys route.
            // A card send not yet handed to a session stays queued for its own reconcile.
            if (reply.state !== 'queued' || held.has(reply.id) || waitingCardInput({ reply })) {
              continue
            }

            applyDecision({
              writer,
              decision: decideReply({
                state: writer.state,
                ref: card.id,
                data: {
                  reply: reply.id,
                  state: 'delivery_unknown',
                  route: 'pnyx',
                  detail: 'Othrys restarted before the agent confirmed this message; send it again if it did not arrive',
                },
                meta: {
                  at: at(),
                  actor: 'pnyx',
                  id: `unconfirmed:${reply.id}`,
                },
              }),
            })
          }
        }
      },
    })

    await helper.recover()

    for (const card of Object.values(loadTitan({ hydraId }).state.cards)) {
      if (card.compaction?.inputs.length) {
        releaseCompact({ card: card.id })
      }
    }

    const pendingTools = loadTitan({ hydraId }).state

    for (const card of Object.values(pendingTools.cards)) {
      if (fenced && toolApplicationReady({
        state: pendingTools,
        card,
      })) {
        host().toolsChanged({ task: card.id })
      }
    }

    // Changes made while the server was stopped wake Titan once it is back.
    const state = loadTitan({ hydraId }).state

    if (othrysRunsTitan({ state })) {
      if (state.hydraStatus?.state === 'down') {
        planRetry()
      }

      const turns = Object.entries(state.eventIds).flatMap(([
        id,
        seq,
      ]) => id.endsWith(':hosted') ? [seq] : [])
      const startedWakes = wakesThrough({
        state,
        pattern: WAKE_TURN,
      })
      let unhandled = Math.max(
        0,
        ...turns,
      )

      // A log from before handled wakes were recorded counts a wake once its turn started.
      if (startedWakes > 0) {
        unhandled = startedWakes
      }

      // The resumed turn answers the wake it continues, so that wake's changes are not offered twice.
      const after = Math.max(
        wakeCursor({
          state,
          fallback: unhandled,
        }),
        cutTitanTurn?.wakeThrough ?? 0,
      )

      // A Titan that never ran has no cursor yet; its first missed report sets one.
      if (hostedTitan({ state })) {
        startFrom({ after })
      }

      // Changes from while the server was stopped can only be read against the state now.
      const missed = scanEvents({
        hydraId,
        after,
      })

      for (const event of missed) {
        if (state.helper?.handled.includes(event.seq)) {
          continue
        }

        const reasons = wakeReasons({
          state,
          events: [event],
        })

        if (reasons.length) {
          host().wake({
            seq: event.seq,
            card: event.cardId,
            reasons,
            event,
          })
        }
      }
    }
  }

  return {
    recover,
    fenced: () => fenced,
  }
}
