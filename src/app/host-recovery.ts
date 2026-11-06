import { applyDecision } from './decision.ts'
import { background } from './background.ts'
import { readEvents } from './event-log.ts'
import type { Host, Live } from './host-types.ts'
import { loadHydra } from './store.ts'
import type { Writer } from './writer.ts'
import { hostedHydra, pnyxRunsHydra } from '#hydra/hydra.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { HydraAgentChange } from '#hydra/model.ts'
import { operationEvent, type createHydraOperations, type createHydraOutage } from '#hydra/operations.ts'
import type { createWakeQueue } from '#hydra/wake-queue.ts'
import { wakeReasons } from '#hydra/wake-reasons.ts'
import { WAKE_TURN, findHydraTurnToResume, wakeCursor, wakesThrough } from '#hydra/wakes.ts'
import type { createRoutineHelper } from '#routine-helper/runner.ts'
import { liveTask } from '#tasks/select.ts'
import type { upgradeQueue } from '#upgrade/queue.ts'
import type { trackChildren } from '#workers/children.ts'
import type { createCompactionControl } from '#workers/compaction/control.ts'
import { recordCompaction } from '#workers/compaction/record.ts'
import { WORKER_RESUME, findWorkerTurnToResume } from '#workers/host.ts'
import type { createHostedDelivery } from '#workers/hosted-delivery.ts'
import type { AgentRef } from '#workers/model.ts'
import type { createPermissionBridge } from '#workers/permission-bridge.ts'
import { decideReply } from '#workers/reply-rules.ts'
import { steeringHeld } from '#workers/steering.ts'

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
  changeAgent,
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
  write<T>({ fn }: { fn: ({ writer }: { writer: Writer }) => T }): T
  note({ fn }: { fn: ({ writer }: { writer: Writer }) => void }): void
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
  changeAgent({ change }: { change: HydraAgentChange }): void
  endOperation: ReturnType<typeof createHydraOperations>['endOperation']
  expireOrphans: ReturnType<typeof createPermissionBridge>['expireOrphans']
  send: ReturnType<typeof createHostedDelivery>['send']
  helper: ReturnType<typeof createRoutineHelper>
  releaseCompact: ReturnType<typeof createCompactionControl>['releaseCompact']
  planRetry: ReturnType<typeof createHydraOutage>['planRetry']
  startFrom: ReturnType<typeof createWakeQueue>['startFrom']
  host(): Host
}) {
  const recover: Host['recover'] = async () => {
    // A session whose earlier processes could not be stopped is left interrupted rather than run twice.
    const fenced = await children.sweep()
    upgrades.recover()

    // No stop outlives the server: an upgrade or restart the step above did not end, or a compaction of Hydra
    // the stop cut, ends here, and Hydra gets the recap and its queue.
    note({
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
                  error: `Pnyx restarted during ${pass.kind}`,
                },
              }),
            })
          }
        }
      },
    })

    const cut = loadHydra({ hydraId }).state.hydraOperation
    const cutChange = loadHydra({ hydraId }).state.hydraAgentChange

    if (cutChange?.state === 'running') {
      changeAgent({
        change: {
          ...cutChange,
          state: 'failed',
          error: 'Pnyx restarted while preparing this agent change. Choose again to retry.',
        },
      })
    }

    if (cut) {
      endOperation({
        id: cut.id,
        error: `Pnyx restarted during the ${cut.kind}`,
      })
    }

    let cutHydraTurn: {
      resumeAttemptId: string
      resumeMessage: string
      wakeThrough: number
    } | undefined
    const cutWorkerTurns: {
      task: string
      resumeAttemptId: string
    }[] = []

    const cutCompactions = new Set<string>()
    write({
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
                  error: 'Pnyx restarted during compaction',
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

          const isHydra = session.id === writer.state.config?.hydra.session

          const resumable = fenced && !cutCompactions.has(session.id)

          if (resumable && isHydra && hostedHydra({ state: writer.state })) {
            cutHydraTurn = findHydraTurnToResume({
              hydraId,
              state: writer.state,
              agent: session.agent,
            })

            if (cutHydraTurn) {
              resumeAttemptId = cutHydraTurn.resumeAttemptId
            }
          } else if (resumable && task && liveTask({ card: task })
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
            note: 'Pnyx stopped during this turn. Send a message to continue it.',
            resumeAttemptId,
          })
        }
      },
    })

    // Startup never waits on an agent reopening; each resumes on its own and a failure stays on its card.
    if (cutHydraTurn) {
      const resume = cutHydraTurn
      background({
        name: 'Hydra resume',
        run: () => host().hydra({
          id: resume.resumeAttemptId,
          text: resume.resumeMessage,
          actor: 'pnyx',
        }),
      })
    }

    // A worker the restart cut continues once; one that cannot stays interrupted for Hydra or the owner.
    for (const cut of cutWorkerTurns) {
      try {
        send({
          card: cut.task,
          text: WORKER_RESUME,
          actor: 'pnyx',
          eventId: `${cut.resumeAttemptId}:turn`,
          direct: true,
        })
      } catch (error) {
        const message = (error as Error).message
        console.error(`pnyx-axi serve: ${cut.task} could not resume: ${message}`)
        note({
          fn: ({ writer }) => {
            const agent = writer.state.cards[cut.task]?.agent

            if (agent) {
              interrupt({
                writer,
                agent,
                note: `Pnyx stopped during this turn and could not resume it: ${message}. Send a message to continue it.`,
              })
            }
          },
        })
      }
    }

    for (const card of Object.values(loadHydra({ hydraId }).state.cards)) {
      if (card.id === HYDRA_CARD || !liveTask({ card }) || card.agent?.host !== 'pnyx' || steeringHeld({ card })) {
        continue
      }

      const oldest = card.steering?.find(message => !message.ack)

      if (!oldest) {
        continue
      }

      try {
        send({
          card: card.id,
          text: '',
          actor: 'pnyx',
          steering: oldest.id,
        })
      } catch (error) {
        console.error(`pnyx-axi serve: ${card.id} inbox could not resume: ${(error as Error).message}`)
      }
    }

    // A direct message handed to an agent the restart stopped may or may not have arrived; Pnyx never sends it again by itself.
    note({
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
            // The card's agent is Pnyx-hosted, so a reply still queued for it went the Pnyx route.
            if (reply.state !== 'queued' || held.has(reply.id)) {
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
                  detail: 'Pnyx restarted before the agent confirmed this message; send it again if it did not arrive',
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

    for (const card of Object.values(loadHydra({ hydraId }).state.cards)) {
      if (card.compaction?.inputs.length) {
        releaseCompact({ card: card.id })
      }
    }

    // Changes made while the server was stopped wake Hydra once it is back.
    const state = loadHydra({ hydraId }).state

    if (pnyxRunsHydra({ state })) {
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
        cutHydraTurn?.wakeThrough ?? 0,
      )

      // A Hydra that never ran has no cursor yet; its first missed report sets one.
      if (hostedHydra({ state })) {
        startFrom({ after })
      }

      // Changes from while the server was stopped can only be read against the state now.
      const missed = readEvents({ hydraId })
        .filter(event => event.seq > after && !state.helper?.handled.includes(event.seq))

      for (const event of missed) {
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

  return { recover }
}
