import { agentInput } from '#app/agent-input.ts'
import { applyDecision } from '#app/decision.ts'
import { background } from '#app/background.ts'
import type { Host, Live } from '#app/host-types.ts'
import { inbox } from '#hydra/update-queue.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { createHydraTurns } from '#hydra/turns.ts'
import { loadHydra } from '#app/store.ts'
import type { Writer } from '#app/writer.ts'
import { pnyxHome } from '#store/storage.ts'
import { declareTask } from '#tasks/declarations.ts'
import type { Card } from '#tasks/model.ts'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { trackChildren } from './children.ts'
import type { createCompactionControl } from '#workers/compaction/control.ts'
import { activeCompaction, compactCommand } from '#workers/compaction/state.ts'
import { accountEnvironment } from './dispatch.ts'
import { HYDRA_TURN_POLL_MS, IDLE_MS, WORKER_COMMANDS } from './host.ts'
import type { createHostedDelivery } from './hosted-delivery.ts'
import { steeringMessages } from './inbox-notice.ts'
import type { AgentRef } from './model.ts'
import { nativeIdle } from './native-session.ts'
import type { createPermissionBridge } from './permission-bridge.ts'
import { permissionEvent } from './permission-rules.ts'
import type { HostedSession, Provider } from './provider.ts'
import { harnessOf, providerLabel } from './providers.ts'
import { sessionId } from './session-attachments.ts'
import { steeringWorkerIdentity } from './steering.ts'
import type { createSteeringDelivery } from './steering-delivery.ts'
import { liveReplies } from './streaming.ts'
import type { createUsageTracker } from './usage-tracker.ts'

// One provider process per hosted session: opening it, feeding it input, following what it does, and retiring it.
export function createLiveSessions({
  hydraId,
  live,
  closing,
  controller,
  children,
  streamed,
  usageTracker,
  compaction,
  at,
  write,
  note,
  record,
  interrupt,
  folderOf,
  providerOf,
  environment,
  expireEntry,
  askPermission,
  pendingSteeringIds,
  inboxNotice,
  markRead,
  ringSteering,
  settleDirect,
  directReply,
  turns,
}: {
  hydraId: string
  live: Map<string, Live>
  closing(): boolean
  controller: AbortController
  children: ReturnType<typeof trackChildren>
  streamed({ session }: { session: string }): void
  usageTracker: ReturnType<typeof createUsageTracker>
  compaction: ReturnType<typeof createCompactionControl>
  at(): string
  write<T>({ fn }: { fn: ({ writer }: { writer: Writer }) => T }): T
  note({ fn }: { fn: ({ writer }: { writer: Writer }) => void }): void
  record({
    writer,
    agent,
    input,
    actor,
    eventId,
  }: {
    writer: Writer
    agent: AgentRef
    input: Record<string, unknown>
    actor: string
    eventId?: string
  }): void
  interrupt({
    writer,
    agent,
    note,
  }: {
    writer: Writer
    agent: AgentRef
    note: string
  }): void
  folderOf({ card }: { card: Card & { agent: AgentRef } }): string
  providerOf({ provider }: { provider: string }): Provider
  environment({
    hydra,
    task,
    steeringWorker,
  }: {
    hydra?: boolean
    task?: string
    steeringWorker?: string
  }): NodeJS.ProcessEnv
  expireEntry: ReturnType<typeof createPermissionBridge>['expireEntry']
  askPermission: ReturnType<typeof createPermissionBridge>['askPermission']
  pendingSteeringIds: ReturnType<typeof createSteeringDelivery>['pendingSteeringIds']
  inboxNotice: ReturnType<typeof createSteeringDelivery>['inboxNotice']
  markRead: ReturnType<typeof createSteeringDelivery>['markRead']
  ringSteering: ReturnType<typeof createSteeringDelivery>['ringSteering']
  settleDirect: ReturnType<typeof createHostedDelivery>['settleDirect']
  directReply: ReturnType<typeof createHostedDelivery>['directReply']
  turns(): ReturnType<typeof createHydraTurns>
}) {
  const {
    compactChange,
    holdCompact,
    releaseCompact,
    sessionOwner,
    settleCompaction,
    syncCompactions,
  } = compaction

  const retire = ({
    key,
    entry,
  }: {
    key: string
    entry: Live
  }) => {
    clearTimeout(entry.idle)
    expireEntry({ entry })

    if (live.get(key) === entry) {
      live.delete(key)
    }

    entry.input.end()
    entry.session?.close()
    streamed({ session: key })
  }

  const consume = async ({
    key,
    card,
    entry,
  }: {
    key: string
    card: Card & { agent: AgentRef }
    entry: Live
  }) => {
    let failure: string | undefined
    const env = environment(card.id === HYDRA_CARD ? { hydra: true } : {
      task: card.id,
      steeringWorker: steeringWorkerIdentity({
        state: loadHydra({ hydraId }).state,
        card,
      }),
    })

    const compactOwner = () => {
      const state = loadHydra({ hydraId }).state

      return sessionOwner({
        state,
        session: key,
        fallback: card.id,
      })
    }

    try {
      const contract = card.id === HYDRA_CARD
        ? turns().hydraSession({ agent: card.agent }) : { allow: WORKER_COMMANDS }
      entry.session ??= await providerOf({ provider: card.agent.provider }).open({
        cwd: folderOf({ card }),
        agent: card.agent,
        settings: card.settings ?? {},
        ...contract,
        env: card.agent.loginFolder ? accountEnvironment({
          account: {
            provider: harnessOf({ provider: card.agent.provider }),
            folder: card.agent.loginFolder,
          },
          env,
        }) : env,
        signal: controller.signal,
        spawned: children.spawned,
      })

      if (closing() || live.get(key) !== entry) {
        entry.session.close()

        return
      }

      const current = loadHydra({ hydraId }).state.cards[card.id]

      if (current?.agent && sessionId({ agent: current.agent }) === key
        && current.steeringGeneration === card.steeringGeneration) {
        ringSteering({
          card: current,
          entry,
        })
      }

      // Messages taken between turns open the next turn together; one taken mid-turn joins the running turn.
      // ponytail: the agent may split or merge what it read ahead, so a turn's answers can be credited one turn off; the agent naming what each turn took would make it exact.
      const opening: {
        id: string | undefined
        offset: number
      }[] = []
      let answering: string[] = []
      let turnRunning = false
      // Messages taken mid-turn, so one the agent carries to its next turn can move there.
      let joined: {
        id: string | undefined
        offset: number
      }[] = []
      let completedOffset = 0

      const transcriptSize = () => {
        try {
          return statSync(entry.session?.path ?? card.agent.transcriptPath ?? '').size
        } catch {
          return 0
        }
      }

      const input = async function* () {
        for await (const item of entry.input) {
          const current = compactOwner()

          const compaction = activeCompaction({ card: current })
          const restartingCompact = compactCommand({ text: item.text }) && compaction?.id === `manual:${item.id}`

          if (current && compaction && !restartingCompact) {
            if (item.steeringIds) {
              for (const id of item.steeringIds) {
                const message = current.steering?.find(message => message.id === id && !message.ack)
                entry.steering.delete(id)

                if (message) {
                  holdCompact({
                    card: current,
                    input: {
                      id,
                      text: message.text,
                      actor: message.source,
                      route: 'steering',
                    },
                  })
                }
              }
            } else {
              holdCompact({
                card: current,
                input: {
                  id: item.id ?? randomUUID(),
                  text: item.text,
                  original: item.original,
                  actor: item.id ? loadHydra({ hydraId }).state.hydraMessages?.find(message => message.id === item.id)?.actor ?? 'pnyx' : 'pnyx',
                  route: card.id === HYDRA_CARD ? 'hydra' : 'direct',
                  accepted: card.id === HYDRA_CARD,
                  agent: item.agent,
                },
              })
            }

            continue
          }

          if (compactCommand({ text: item.text })) {
            while (!closing() && live.get(key) === entry && turnRunning) {
              await new Promise(resolve => setTimeout(
                resolve,
                HYDRA_TURN_POLL_MS,
              ))
            }

            if (closing() || live.get(key) !== entry) {
              return
            }

            if (!activeCompaction({ card: loadHydra({ hydraId }).state.cards[card.id] })) {
              compactChange({
                card: card.id,
                change: {
                  kind: 'status',
                  operation: {
                    id: `manual:${item.id ?? randomUUID()}`,
                    session: key,
                    trigger: item.id?.startsWith('context-compact:') ? 'auto' : 'manual',
                    state: 'running',
                    startedAt: at(),
                  },
                },
              })
            }
          }

          if (item.steeringIds) {
            const current = loadHydra({ hydraId }).state.cards[card.id]

            const ids = pendingSteeringIds({
              card: current,
              key,
              generation: card.steeringGeneration,
              ids: item.steeringIds,
            })

            if (!current || !ids.length) {
              for (const id of item.steeringIds) {
                entry.steering.delete(id)
              }

              continue
            }

            if (item.inline && item.id) {
              item.text = steeringMessages({
                task: current.id,
                hydraId,
                messages: (current.steering ?? []).filter(message => ids.includes(message.id)),
              })
              entry.delivered.set(
                item.id,
                ids,
              )
            } else {
              item.text = inboxNotice({
                card: current,
                ids,
              })
            }
          }

          if (!turnRunning) {
            opening.push({
              id: item.id,
              offset: transcriptSize(),
            })
          } else {
            joined.push({
              id: item.id,
              offset: transcriptSize(),
            })
            answering = item.id ? [
              ...answering,
              item.id,
            ] : answering
          }

          const owner = compactOwner()

          if (item.id && owner?.compaction?.inputs.some(input => input.id === item.id && input.route === 'direct')) {
            compactChange({
              card: owner.id,
              change: {
                kind: 'taken',
                id: item.id,
              },
            })
          }

          const original = item.original ?? item.text

          yield agentInput({
            id: item.id ?? randomUUID(),
            text: item.text,
            original,
            hydras: join(
              pnyxHome(),
              'hydras',
            ),
          })
        }
      }

      const armIdle = () => {
        clearTimeout(entry.idle)

        if (!entry.session || entry.activity !== 'finished' || !nativeIdle({ work: entry.session.snapshot().work })) {
          return
        }

        if (entry.stale) {
          retire({
            key,
            entry,
          })

          return
        }

        entry.idle = setTimeout(
          () => background({
            name: 'idle agent cleanup',
            run: () => {
              if (entry.session && nativeIdle({ work: entry.session.snapshot().work })) {
                retire({
                  key,
                  entry,
                })
              }
            },
          }),
          IDLE_MS,
        ).unref()
      }

      const compactionIds = new Map<string, string>()

      for await (const received of entry.session.run({
        input: input(),
        permission: ({
          id,
          tool,
          input,
          signal,
          description,
          questions,
          form,
        }) => askPermission({
          id,
          key,
          entry,
          tool,
          input,
          signal,
          description,
          questions,
          form,
        }),
      })) {
        const activity = typeof received === 'object' && received.type === 'turn-ended' ? 'finished' : received

        if (typeof activity === 'object' && activity.type === 'input' && entry.pendingDirect.has(activity.receipt.inputId)) {
          settleDirect({
            entry,
            inputId: activity.receipt.inputId,
            phase: activity.receipt.phase,
          })
        }

        if (typeof activity === 'object' && activity.type === 'input' && activity.receipt.phase === 'confirmed'
          && entry.delivered.has(activity.receipt.inputId)) {
          const ids = entry.delivered.get(activity.receipt.inputId)!
          entry.delivered.delete(activity.receipt.inputId)
          markRead({
            card: card.id,
            ids,
          })
          continue
        }

        if (typeof activity === 'object' && activity.type === 'answer') {
          write({
            fn: ({ writer }) => {
              const current = writer.state.cards[card.id]
              const request = current?.permissions?.find(request =>
                request.nativeId === activity.receipt.permission && request.session === key)

              if (request && request.status !== 'pending') {
                writer.append({
                  event: permissionEvent({
                    state: writer.state,
                    card: current,
                    request: {
                      ...request,
                      delivery: activity.receipt.phase,
                    },
                    meta: {
                      at: at(),
                      actor: 'pnyx',
                    },
                  }),
                })
              }
            },
          })
          continue
        }

        // A turn the server's own stop cuts stays working, so the next start resumes it.
        if (closing() && typeof received === 'object' && received.type === 'turn-ended' && received.outcome.status !== 'completed') {
          continue
        }

        if (typeof received === 'object' && received.type === 'turn-ended') {
          const outcome = received.outcome
          note({
            fn: ({ writer }) => record({
              writer,
              agent: card.agent,
              input: { activity: 'finished' },
              actor: 'pnyx',
              eventId: `native:${outcome.turn}:finished`,
            }),
          })

          for (const text of outcome.assistant) {
            entry.replies.update(text)
          }
        }

        if (entry.replaced || !closing() && live.get(key) !== entry) {
          return
        }

        if (typeof activity !== 'string' && activity.type === 'compaction') {
          syncCompactions({ state: loadHydra({ hydraId }).state })
          const current = compactOwner()

          if (!current?.agent || sessionId({ agent: current.agent }) !== key) {
            continue
          }

          const known = compactionIds.get(activity.id)
          const mapped = current.compaction?.operations.find(operation => operation.id === known)

          if (mapped && mapped.state !== 'running') {
            continue
          }

          const operation = mapped ?? activeCompaction({ card: current }) ?? {
            id: activity.id,
            session: key,
            trigger: activity.trigger,
            state: 'running' as const,
            startedAt: at(),
          }
          compactionIds.set(
            activity.id,
            operation.id,
          )
          compactChange({
            card: current.id,
            change: {
              kind: 'status',
              operation: {
                ...operation,
                state: activity.state,
                ...(activity.state !== 'running' ? { endedAt: at() } : {}),
                ...(activity.error ? { error: activity.error } : {}),
                ...(activity.unsupported ? { unsupported: true } : {}),
              },
            },
          })

          if (activity.state !== 'running') {
            settleCompaction({
              card: current.id,
              settling: true,
            })
          }

          continue
        }

        // Claude Code can compact again after a result, so held input waits until it moves on.
        if (activity === 'finished' || typeof activity !== 'string' && [
          'text',
          'tool',
          'thinking',
        ].includes(activity.type)) {
          const owner = compactOwner()

          if (owner && compaction.settling.has(owner.id)) {
            settleCompaction({
              card: owner.id,
              settling: false,
            })
          }
        }

        if (typeof activity !== 'string' && activity.type === 'usage') {
          usageTracker.mergeUsage({
            key,
            activity,
          })
          continue
        }

        if (typeof activity !== 'string' && activity.type === 'thinking') {
          const wasThinking = entry.thinking.size > 0

          if (activity.running) {
            entry.thinking.add(activity.id)
          } else {
            entry.thinking.delete(activity.id)
          }

          if (wasThinking !== (entry.thinking.size > 0)) {
            streamed({ session: key })
          }

          continue
        }

        if (typeof activity !== 'string' && activity.type === 'tool') {
          if (activity.running) {
            entry.toolNames.set(
              activity.id,
              activity.tool ?? 'tool',
            )
            entry.tools.set(
              activity.id,
              Date.now(),
            )
          } else {
            entry.tools.delete(activity.id)
            entry.toolNames.delete(activity.id)
          }

          streamed({ session: key })

          continue
        }

        if (typeof activity !== 'string' && activity.type === 'structured') {
          continue
        }

        if (typeof activity !== 'string' && activity.type === 'work') {
          streamed({ session: key })
          armIdle()
          continue
        }

        if (typeof activity !== 'string' && activity.type !== 'text') {
          continue
        }

        if (typeof activity !== 'string') {
          entry.replies.update(activity)
          streamed({ session: key })

          continue
        }

        if (activity === 'carried') {
          const carried = joined.pop()

          if (carried) {
            answering = answering.filter(id => id !== carried.id)
            opening.unshift(carried)
          }

          continue
        }

        if (activity === 'finished') {
          const owner = compactOwner()
          const unfinished = activeCompaction({ card: owner })

          if (unfinished) {
            compactChange({
              card: owner!.id,
              change: {
                kind: 'status',
                operation: {
                  ...unfinished,
                  state: entry.stopping ? 'cancelled' : 'failed',
                  endedAt: at(),
                  ...(!entry.stopping ? {
                    error: 'The agent ended its turn without reporting a compaction outcome. Native compact is unavailable in this session.',
                    unsupported: true,
                  } : {}),
                },
              },
            })
            releaseCompact({ card: owner!.id })
          }

          turnRunning = false
          entry.stopping = false
          entry.tools.clear()
          entry.toolNames.clear()
          entry.thinking.clear()
          completedOffset = transcriptSize()
          entry.replies.finish()
          streamed({ session: key })

          if (card.id === HYDRA_CARD) {
            turns().turnFinished({
              entry,
              answering,
            })
          }
        } else {
          const opened = opening.splice(0)
          const answers = opened.flatMap(item => item.id ? [item.id] : [])
          const startOffset = opened.length ? opened[0]!.offset : 0
          answering = answers
          joined = []
          turnRunning = true
          let ownerStarted: boolean | undefined

          if (card.id === HYDRA_CARD) {
            ownerStarted = turns().startedByOwner({ answers })
          }

          entry.replies.start({
            ownerStarted,
            offset: Math.max(
              startOffset,
              completedOffset,
            ),
          })
          streamed({ session: key })
        }

        if (activity === 'finished') {
          const current = loadHydra({ hydraId }).state.cards[card.id]
          const pending = entry.input.pending({
            includes: ({ steeringIds }) => {
              if (!steeringIds) {
                return true
              }

              return pendingSteeringIds({
                card: current,
                key,
                generation: card.steeringGeneration,
                ids: steeringIds,
              }).length > 0
            },
          })

          if (pending) {
            continue
          }
        }

        if (activity !== entry.activity) {
          entry.activity = activity

          if (card.id === HYDRA_CARD && activity !== 'working') {
            turns().activityChanged({ activity })
          }

          note({
            fn: ({ writer }) => {
              const eventId = turns().activityEventId({
                writer,
                card,
                activity,
              })

              record({
                writer,
                agent: card.agent,
                input: { activity },
                actor: 'pnyx',
                eventId,
              })
            },
          })
          clearTimeout(entry.idle)

          if (activity === 'finished') {
            if (card.id === HYDRA_CARD) {
              turns().turnRecorded()
            }

            armIdle()
          }
        }
      }
    } catch (error) {
      failure = (error as Error).message
    }

    // A session that ended before confirming a direct input: an input the agent took may have arrived; one it never took did not.
    if (!closing() && !entry.replaced) {
      for (const [
        inputId,
        pending,
      ] of entry.pendingDirect) {
        directReply({
          card: pending.card,
          inputId,
          state: pending.taken ? 'delivery_unknown' : 'failed',
          detail: pending.taken
            ? `the agent stopped before confirming this message${failure ? `: ${failure.slice(
              0,
              300,
            )}` : ''}; check the conversation, and send it again if it did not arrive`
            : `the agent stopped before taking this message${failure ? `: ${failure.slice(
              0,
              300,
            )}` : ''}; nothing was delivered`,
        })
      }

      entry.pendingDirect.clear()
    }

    const compactCard = compactOwner()
    const unfinishedCompact = activeCompaction({ card: compactCard })

    if (unfinishedCompact && !closing()) {
      compactChange({
        card: compactCard!.id,
        change: {
          kind: 'status',
          operation: {
            ...unfinishedCompact,
            state: 'failed',
            endedAt: at(),
            error: failure ?? 'The agent stopped during compaction',
          },
        },
      })
      releaseCompact({ card: card.id })
    }

    if (entry.replaced || !closing() && live.get(key) !== entry) {
      return
    }

    retire({
      key,
      entry,
    })

    if (card.id === HYDRA_CARD) {
      turns().sessionEnded({ entry })
    }

    if (!closing() && entry.activity === 'working') {
      const name = providerLabel({ provider: card.agent.provider })
      const text = `${name} stopped during this turn${failure ? `: ${failure.slice(
        0,
        300,
      )}` : ''}. Send a message to continue it.`
      note({
        fn: ({ writer }) => {
          interrupt({
            writer,
            agent: card.agent,
            note: text,
          })

          const attached = writer.state.cards[card.id]?.sessionIds?.includes(key)

          const done = writer.state.cards[card.id]?.status?.state === 'done'

          if (failure && card.id !== HYDRA_CARD && attached && !done) {
            applyDecision({
              writer,
              decision: declareTask({
                state: writer.state,
                ref: card.id,
                status: 'blocked',
                note: text,
                meta: {
                  at: at(),
                  actor: 'pnyx',
                },
              }),
            })
          }
        },
      })
    }
  }

  const open = ({
    card,
    session,
  }: {
    card: Card & { agent: AgentRef }
    session?: HostedSession
  }): Live => {
    const key = sessionId({ agent: card.agent })
    const running = live.get(key)

    const reassigned = running && (running.task !== card.id
      || running.generation !== card.steeringGeneration)

    const staleIdle = running && running.stale && running.activity !== 'working'
    const retireStale = staleIdle && running.session
      && nativeIdle({ work: running.session.snapshot().work })

    if (running && (reassigned || retireStale)) {
      running.replaced = true
      retire({
        key,
        entry: running,
      })
    } else if (running) {
      clearTimeout(running.idle)

      return running
    }

    folderOf({ card })
    const entry: Live = {
      input: inbox(),
      replies: liveReplies(),
      activity: 'finished',
      steering: new Set(),
      delivered: new Map(),
      pendingDirect: new Map(),
      task: card.id,
      generation: card.steeringGeneration,
      session,
      thinking: new Set(),
      tools: new Map(),
      toolNames: new Map(),
    }
    live.set(
      key,
      entry,
    )
    entry.consumed = consume({
      key,
      card,
      entry,
    })

    return entry
  }

  const action: Host['action'] = ({
    card,
    action,
  }) => {
    const entry = card.agent && live.get(sessionId({ agent: card.agent }))

    if (!entry?.session) {
      return action
    }

    const work = entry.session.snapshot().work
    const calls = work.runningTools.map(id => {
      const recorded = action?.calls.find(call => call.id === id)

      return recorded ?? {
        id,
        tool: entry.toolNames.get(id) ?? 'tool',
      }
    })

    return {
      ...action,
      calls,
      done: nativeIdle({ work }),
      thinking: entry.thinking.size > 0 && calls.length === 0,
      work,
    }
  }

  const thread: Host['thread'] = ({
    card,
    page,
  }) => {
    const entry = card.agent && live.get(sessionId({ agent: card.agent }))

    return entry ? entry.replies.page({ page }) : page
  }

  const close = () => {
    for (const [
      key,
      entry,
    ] of live) {
      retire({
        key,
        entry,
      })
    }
  }

  return {
    retire,
    open,
    action,
    thread,
    close,
  }
}
