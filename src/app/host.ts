import { agentInput } from './agent-input.ts'
import { nativeIdle } from '#workers/native-session.ts'
import { memoryConditions } from '#memory/conditions.ts'
import { background } from './background.ts'
import { requireReady } from '#tasks/dependencies.ts'
import { attachedImages } from '#hydra/images.ts'
import { enqueueSteering, recordSteeringAttempt } from '#workers/inbox.ts'
import { activeCompaction, compactCommand } from '#workers/compaction/state.ts'
import { recordCompaction } from '#workers/compaction/record.ts'
import { upgradeCommand } from '#upgrade/model.ts'
import { upgradeQueue } from '#upgrade/queue.ts'
import { RESTART_SIGNAL } from '#upgrade/restart.ts'
import type { CompactInput, CompactionChange } from '#workers/compaction/model.ts'
import { commentEpoch, commentInput, needsCommentNote } from '#workers/compaction/comments.ts'
import { pendingSteering, steeringClaim, sameClaim, steeringWorkerIdentity, steeringHeld } from '#workers/steering.ts'
import { steeringNotice } from '#workers/inbox-notice.ts'
import { requireUnheld } from '#tasks/holds.ts'
import { createRoutineHelper } from '#routine-helper/runner.ts'
import { helperAgent, helperBatch, helperEvent, helperPermission, helperReason } from '#routine-helper/route.ts'
import { activeHelperBatches, helperLeases, outcomeLines, wakeHandled } from '#routine-helper/state.ts'
import { isHelper } from '#routine-helper/leases.ts'
import { taskMention } from '#hydra/mentions.ts'
import { pausedDeclaration } from '#tasks/lifecycle.ts'
import { setupCheck, setupDigest } from '#setup/check.ts'
import { projectDigest } from '#projects/context.ts'
import { accountEnvironment, chooseCandidate, readUsage } from '#workers/dispatch.ts'
import { defaultLogin, effectiveDispatch, type Harness } from '#workers/dispatch-config.ts'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { claudeProvider, transcriptPath, type QueryFn } from '#workers/claude.ts'
import { codexProvider, type SpawnCodex } from '#workers/codex.ts'
import { mergeWindows, type HostedSession, type HostedUsage, type ModelOption, type PermissionDecision } from '#workers/provider.ts'
import { liveReplies } from '#workers/streaming.ts'
import { copyTagged } from '#workers/tagged-updates.ts'
import { seenAt, terminalPresence, type Presence } from '#workers/presence.ts'
import { harvestTranscripts } from '#integrations/hooks/harvest.ts'
import { MAX_RESENDS } from '#workers/reply-retry.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
import { explained } from './cli-support.ts'
import { permissionAnswer, permissionEvent } from '#workers/permission-rules.ts'
import { declareTask } from '#tasks/declarations.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { QUIET_REPLY, hostedHydra, hydraEvent, pnyxRunsHydra, reportActor } from '#hydra/hydra.ts'
import { hydraConfig } from '#hydra/config.ts'
import { eventReasons, reasonLine, wakeReasons } from '#hydra/wake-reasons.ts'
import { freeTask } from '#workers/start.ts'
import { clip, hydraDigest } from '#hydra/digest.ts'
import { ownerMemory } from '#memory/owner-memory.ts'
import { prepareHydraFolder } from '#setup/skills.ts'
import type { Decision, HydraState } from './model.ts'
import { decidePush } from '#tasks/push.ts'
import { findCard } from '#tasks/push-rules.ts'
import { decideOutcome } from '#tasks/delivery/outcome.ts'
import { decideSession } from '#workers/sessions.ts'
import { HYDRA_ACTOR, ownerActor } from './actors.ts'
import { HydraError } from '#store/errors.ts'
import type { Card } from '#tasks/model.ts'
import type { AgentRef, AgentSession, AgentSettings, Attention, PermissionRequest } from '#workers/model.ts'
import type { HydraMessage } from '#hydra/model.ts'
import { harnessControls } from '#workers/controls.ts'
import { liveTask } from '#tasks/select.ts'
import { INTERRUPTED, sessionId } from '#workers/session-attachments.ts'
import { hydraDir } from './home-migration.ts'
import { loadHydra } from './store.ts'
import { readEvents } from './event-log.ts'
import { withWriter, type Writer } from './writer.ts'
import { pnyxHome } from '#store/storage.ts'
import type { Host, Live } from './host-types.ts'
import { IDLE_MS, WAKE_MS, STALL_MS, BUSY_MS, PAUSE_MS, STALL_REPEAT_MAX_MS, UNCONFIRMED_QUOTE_CHARS, WORKER_RESUME, WORKER_COMMANDS, INHERITED, harnessAccount, sameChosenSettings, steeringAssignment, findWorkerTurnToResume } from '#workers/host.ts'
import { isFolder } from '#workers/folders.ts'
import { providerName, storedModels, storeModels, catalogOffers } from '#workers/model-catalog.ts'
import { wakeId, WAKE_ID, WAKE_TURN, WAKE_HANDLED, REPLY_RULES, sealed, decisionsText, wakeText, outageMinutes, recapText, wakesThrough, wakeCursor, findHydraTurnToResume, type QueuedUpdate } from '#hydra/wakes.ts'
import type { StallItem } from '#hydra/stalls.ts'
import { inbox } from '#hydra/update-queue.ts'

export type { QueryFn } from '#workers/claude.ts'

// After a failed start Pnyx tries again after each of these waits, then every last one, until a start works.
const RETRY_MS = [
  60_000,
  120_000,
  300_000,
  600_000,
]

export function createHost({
  hydraId,
  query,
  spawnCodex,
  changed,
  streamed = () => {},
  queued = () => {},
  wakeDelay = WAKE_MS,
  stallDelay = STALL_MS,
  busyDelay = BUSY_MS,
  stallRepeatMax = STALL_REPEAT_MAX_MS,
  pauseDelay = PAUSE_MS,
  retryDelays = RETRY_MS,
  helperBound,
  upgradeRoot,
  restart = () => process.kill(
    process.pid,
    RESTART_SIGNAL,
  ),
  presence = ({ session }) => terminalPresence({
    session,
    verifyProcess: true,
  }),
}: {
  hydraId: string
  query?: QueryFn
  spawnCodex?: SpawnCodex
  presence?({ session }: { session: AgentSession }): Presence
  changed(): void
  streamed?({ session }: { session: string }): void
  // Hydra's queue of unread changes grew, or its check turn took or finished them.
  queued?(): void
  wakeDelay?: number
  stallDelay?: number
  busyDelay?: number
  stallRepeatMax?: number
  pauseDelay?: number
  retryDelays?: number[]
  helperBound?: number
  // The Pnyx folder /upgrade pulls into, and how the server restarts after it; tests pass their own.
  upgradeRoot?: string
  restart?(): void
}): Host {
  const providers = {
    'claude-code': claudeProvider({ query }),
    codex: codexProvider({ spawnCodex }),
  }
  const modelCatalogs = new Map<string, Promise<ModelOption[]>>()
  const commandCatalogs = new Map<string, {
    command: string
    description: string
    source: string
    kind: 'command'
  }[]>()
  const controller = new AbortController()
  const starting = new Set<string>()
  const live = new Map<string, Live>()
  const observedAssignments = new Map(Object.values(loadHydra({ hydraId }).state.cards)
    .map(card => [
      card.id,
      steeringAssignment({ card }),
    ]))
  // The latest size and spend each session reported, kept after its process idles out.
  const usages = new Map<string, Omit<HostedUsage, 'type'>>()
  const pending = new Map<string, {
    card: string
    entry: Live
    finish({ result }: { result: PermissionDecision }): void
  }>()
  let closing = false
  let hydraTurn = Promise.resolve()
  const queuedHydra = new Set<string>()
  // Retries a failed start on a growing wait; each failed try plans the next one.
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retries = 0
  // Recorded wakes, or wakeStart before the first, say how far Hydra has checked.
  let wakeThrough = 0, wakeStart: number | undefined
  let wakeTimer: ReturnType<typeof setTimeout> | undefined
  // Changes since Hydra's last finished check turn; the ones through readThrough are in its running turn.
  let updates: QueuedUpdate[] = []
  // Each queued change's reason lines, worked out from the state it landed in.
  const wakeReasonsAt = new Map<number, string[]>()
  // ponytail: helper work main's wake passed over stays queued here in memory; a restart leaves it to the task's state and the timed review.
  const parked = new Set<number>()
  // Parked updates each main wake delivers, by its through seq; they leave the queue once that turn finishes.
  const wakeParked = new Map<number, number[]>()
  let readingParked: number[] = []
  let readThrough = 0

  const write = <T>({ fn }: { fn: ({ writer }: { writer: Writer }) => T }): T => {
    const result = withWriter({
      hydraId,
      fn: ({ writer }) => {
        drainSpool({ writer })

        return fn({ writer })
      },
    })
    changed()

    return result
  }

  const apply = ({
    writer,
    decision,
  }: {
    writer: Writer
    decision: Decision
  }) => {
    if ('event' in decision) {
      writer.append({ event: decision.event })
    }
  }

  const sessionKey = ({ agent }: { agent: AgentRef }) => `${agent.provider === 'claude-code' ? 'claude' : agent.provider}:${agent.sessionId}`

  const expire = ({ id }: { id: string }) => {
    const waiting = pending.get(id)

    if (!waiting) {
      return
    }

    waiting.finish({
      result: {
        behavior: 'deny',
        message: 'This permission request expired.',
      },
    })
    note({
      fn: ({ writer }) => {
        const card = writer.state.cards[waiting.card]
        const request = card?.permissions?.find(p => p.id === id && p.status === 'pending')

        if (card && request) {
          writer.append({
            event: permissionEvent({
              state: writer.state,
              card,
              request: {
                ...request,
                status: 'expired',
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
  }

  const expireEntry = ({ entry }: { entry: Live }) => {
    for (const [
      id,
      waiting,
    ] of pending) {
      if (waiting.entry === entry) {
        expire({ id })
      }
    }
  }

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

  const folderOf = ({ card }: { card: Card & { agent: AgentRef } }): string => {
    const { cwd } = card.agent

    if (!cwd || !isFolder({ path: cwd })) {
      throw new HydraError({
        message: `the agent's folder ${cwd ?? '(none)'} is gone, so its session cannot continue`,
        code: 'FOLDER_MISSING',
        help: [card.agent.host === 'pnyx' ? `Run \`pnyx-axi task detach ${card.id}\`, then \`pnyx-axi task start ${card.id} --folder <absolute path>\` to start fresh from the brief` : `Run \`pnyx-axi task start ${card.id} --via pnyx --replace-session ${sessionId({ agent: card.agent })} --folder <absolute path>\` to start fresh from the brief`],
      })
    }

    return cwd
  }

  const at = () => new Date().toISOString()
  const upgrades = upgradeQueue({
    root: upgradeRoot,
    state: () => loadHydra({ hydraId }).state,
    record: ({
      operation,
      eventId = randomUUID(),
    }) => {
      write({
        fn: ({ writer }) => writer.append({
          event: {
            v: 1,
            id: eventId,
            seq: writer.state.seq + 1,
            cardId: HYDRA_CARD,
            actor: 'pnyx',
            at: at(),
            type: 'pnyx.upgrade',
            data: operation,
          },
        }),
      })
      queued()
    },
    schedule: ({
      id,
      run,
    }) => {
      queuedHydra.add(id)
      const previous = hydraTurn
      hydraTurn = (async () => {
        await previous

        // Hydra's later turns wait on this one, so it never rejects.
        try {
          await run()
        } catch (error) {
          console.error(`pnyx-axi serve: /upgrade could not run: ${(error as Error).message}`)
        } finally {
          queuedHydra.delete(id)
        }
      })()
    },
    working: () => {
      const card = loadHydra({ hydraId }).state.cards[HYDRA_CARD]

      return Boolean(activeCompaction({ card }))
        || (card?.agent ? live.get(sessionId({ agent: card.agent }))?.activity === 'working' : false)
    },
    closing: () => closing,
    restart,
    deliver: async ({ message }) => {
      try {
        await host.hydra({
          text: message.text,
          original: message.original,
          actor: message.actor,
          id: message.id,
        })
      } catch (error) {
        console.error(`pnyx-axi serve: a message held during the upgrade could not reach Hydra: ${(error as Error).message}`)
      }
    },
    at,
  })

  const compactChange = ({
    card,
    change,
  }: {
    card: string
    change: CompactionChange
  }) => write({
    fn: ({ writer }) => recordCompaction({
      writer,
      card,
      change,
      at: at(),
    }),
  })
  const teachComments = ({
    card,
    id,
    text,
  }: {
    card: string
    id: string
    text: string
  }) => write({
    fn: ({ writer }) => {
      const current = writer.state.cards[card]

      if (current && needsCommentNote({
        card: current,
        text,
      })) {
        recordCompaction({
          writer,
          card,
          at: at(),
          change: {
            kind: 'comments',
            epoch: commentEpoch({ card: current }),
            message: id,
          },
        })
      }

      return current ? commentInput({
        card: writer.state.cards[card]!,
        id,
        text,
      }) : text
    },
  })

  const holdCompact = ({
    card,
    input,
  }: {
    card: Card
    input: Omit<CompactInput, 'at'>
  }) => {
    if (!activeCompaction({ card })) {
      return false
    }

    compactChange({
      card: card.id,
      change: {
        kind: 'held',
        input: {
          ...input,
          at: at(),
        },
      },
    })

    return true
  }

  const releasingCompact = new Set<string>()

  const sessionOwner = ({
    state,
    session,
    fallback,
  }: {
    state: HydraState
    session: string
    fallback: string
  }) => state.cards[session === state.config?.hydra.session
    ? HYDRA_CARD : state.sessions?.[session]?.taskId ?? fallback]

  const syncCompactions = ({ state }: { state: HydraState }) => {
    for (const card of Object.values(state.cards)) {
      for (const operation of card.compaction?.operations ?? []) {
        if (operation.state !== 'running') {
          continue
        }

        const destination = sessionOwner({
          state,
          session: operation.session,
          fallback: card.id,
        })
        const stays = card.agent && sessionId({ agent: card.agent }) === operation.session
          && (!destination || destination.id === card.id)

        if (stays) {
          continue
        }

        compactChange({
          card: card.id,
          change: {
            kind: 'status',
            operation: {
              ...operation,
              state: 'failed',
              endedAt: at(),
              error: 'The agent session left this task during compaction',
            },
          },
        })

        if (destination?.agent && sessionId({ agent: destination.agent }) === operation.session) {
          compactChange({
            card: destination.id,
            change: {
              kind: 'status',
              operation,
            },
          })
        }

        releaseCompact({ card: card.id })
      }
    }
  }

  const releaseCompact = ({ card: id }: { card: string }) => {
    if (closing || releasingCompact.has(id)) {
      return
    }

    releasingCompact.add(id)
    let advanced = false
    setTimeout(
      () => {
        void (async () => {
          const card = loadHydra({ hydraId }).state.cards[id]

          if (!card || activeCompaction({ card })) {
            return
          }

          const inputs = [...(card.compaction?.inputs ?? [])].sort((
            a,
            b,
          ) => Number(b.id === card.compaction?.priority)
            - Number(a.id === card.compaction?.priority))

          for (const input of inputs) {
            if (closing) {
              return
            }

            if (activeCompaction({ card: loadHydra({ hydraId }).state.cards[id] })) {
              return
            }

            if (input.route === 'hydra') {
              await host.hydra({
                text: input.text,
                original: input.original,
                actor: input.actor,
                id: input.id,
                release: input.accepted,
                selected: input.agent,
              })

              while (!closing && queuedHydra.has(input.id)) {
                await new Promise(resolve => setTimeout(
                  resolve,
                  20,
                ))
              }

              const marker = input.accepted ? `${input.id}:compact:hosted` : `${input.id}:hosted`
              const noOp = reportActor({ actor: input.actor })
                || (input.id.startsWith('helper-outcomes:') && !helperPending())

              if (closing || (!noOp && !(marker in loadHydra({ hydraId }).state.eventIds))) {
                return
              }
            } else {
              send({
                card: id,
                text: input.text,
                original: input.original,
                actor: input.actor,
                ...(input.route === 'steering' ? { steering: input.id } : {
                  direct: true,
                  inputId: input.id,
                }),
              })

              if (input.route === 'direct') {
                while (!closing && loadHydra({ hydraId }).state.cards[id]?.compaction?.inputs
                  .some(queued => queued.id === input.id)) {
                  await new Promise(resolve => setTimeout(
                    resolve,
                    20,
                  ))
                }

                if (closing) {
                  return
                }
              }
            }

            if (input.route !== 'direct') {
              compactChange({
                card: id,
                change: {
                  kind: 'taken',
                  id: input.id,
                },
              })
            }

            advanced = true
          }
        })().catch((error: Error) => console.error(`pnyx-axi serve: compact queue retained: ${error.message}`))
          .finally(() => {
            releasingCompact.delete(id)
            const current = loadHydra({ hydraId }).state.cards[id]

            if (advanced && current?.compaction?.inputs.length
              && !activeCompaction({ card: current })) {
              releaseCompact({ card: id })
            }
          })
      },
      0,
    ).unref()
  }

  const record = ({
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
  }) => {
    // Sessions may move between tasks while their process keeps running.
    const session = writer.state.sessions?.[sessionId({ agent })]
    const card = session && writer.state.cards[session.taskId ?? session.originCardId]

    apply({
      writer,
      decision: decidePush({
        state: writer.state,
        key: card?.key ?? sessionKey({ agent }),
        input: {
          agent: session?.agent ?? agent,
          ...input,
          source: {
            adapter: 'pnyx',
            objectId: agent.sessionId,
            observedAt: at(),
          },
        },
        meta: {
          at: at(),
          actor,
          id: eventId,
        },
      }),
    })
  }

  const hosted = ({
    writer,
    ref,
  }: {
    writer: Writer
    ref: string
  }): Card & { agent: AgentRef } => {
    const card = findCard({
      state: writer.state,
      ref,
    })

    if (card.agent?.host !== 'pnyx') {
      throw new HydraError({
        message: `card ${card.id} has no agent that Pnyx runs`,
        code: 'NO_ROUTE',
      })
    }

    return card as Card & { agent: AgentRef }
  }

  const outsideSession = ({
    writer,
    card,
  }: {
    writer: Writer
    card: Card
  }): AgentSession => {
    const agent = card.agent

    if (!liveTask({ card }) || !agent || ![
      'claude-code',
      'codex',
    ].includes(agent.provider)
      || agent.host || agent.agentId || agent.paseoAgentId) {
      throw new HydraError({
        message: 'Continue in Pnyx needs an outside Claude Code or Codex session attached to a task',
        code: 'NO_ROUTE',
      })
    }

    const session = writer.state.sessions?.[sessionId({ agent })]

    if (!session || session.taskId !== card.id) {
      throw new HydraError({
        message: 'the session is no longer attached to this task',
        code: 'SESSION_CONFLICT',
      })
    }

    return session
  }

  const requireGone = ({ current }: { current: Presence }) => {
    if (current.state !== 'gone') {
      throw new HydraError({
        message: current.state === 'present' ? 'the outside session still runs in its terminal; end it before continuing in Pnyx' : `cannot confirm the outside session has ended: ${current.detail}`,
        code: 'SESSION_RUNNING',
        help: ['End the outside session, then try Continue in Pnyx again'],
      })
    }
  }

  const startTarget = ({
    writer,
    ref,
    replacement,
  }: {
    writer: Writer
    ref: string
    replacement?: string
  }): Card => {
    if (!replacement) {
      return freeTask({
        state: writer.state,
        ref,
      })
    }

    const card = findCard({
      state: writer.state,
      ref,
    })
    requireUnheld({ card })
    requireReady({
      state: writer.state,
      card,
    })

    const previous = outsideSession({
      writer,
      card,
    })

    if (previous.id !== replacement) {
      throw new HydraError({
        message: 'the task has a different session now; reopen its card before starting fresh',
        code: 'SESSION_CONFLICT',
      })
    }

    requireGone({ current: presence({ session: previous }) })

    return card
  }

  const interrupt = ({
    writer,
    agent,
    note,
    resumeAttemptId,
  }: {
    writer: Writer
    agent: AgentRef
    note: string
    resumeAttemptId?: string
  }) => {
    record({
      writer,
      agent,
      input: { activity: 'interrupted' },
      actor: 'pnyx',
      eventId: resumeAttemptId,
    })
    const session = writer.state.sessions?.[sessionId({ agent })]
    let task: Card | undefined

    if (session?.id === writer.state.config?.hydra.session) {
      task = writer.state.cards[HYDRA_CARD]
    } else if (session?.taskId) {
      task = writer.state.cards[session.taskId]
    }

    if (task) {
      const attention: Attention[] = [
        {
          kind: 'interrupted',
          key: INTERRUPTED,
          blocking: true,
          text: note,
        },
        ...task.attention.filter(a => a.key !== INTERRUPTED),
      ]
      apply({
        writer,
        decision: decidePush({
          state: writer.state,
          key: task.key,
          input: { attention },
          meta: {
            at: at(),
            actor: 'pnyx',
          },
        }),
      })
    }
  }

  // A failed write is logged, not thrown: the agent keeps running and the next change records again.
  const note = ({ fn }: { fn: ({ writer }: { writer: Writer }) => void }) => {
    try {
      write({ fn })
    } catch (error) {
      console.error(`pnyx-axi serve: ${(error as Error).message}`)
    }
  }

  // Hydra's own commands are recorded as its writes, so they never wake it; a worker's carry its task.
  const environment = ({
    hydra = false,
    task,
    steeringWorker,
  }: {
    hydra?: boolean
    task?: string
    steeringWorker?: string
  } = {}) => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !INHERITED.test(name))),
    PNYX_HOME: pnyxHome(),
    PNYX_HYDRA: hydraId,
    ...(hydra ? {
      PNYX_ACTOR: HYDRA_ACTOR,
      PNYX_HOSTED: 'hydra',
    } : task ? {
      PNYX_ACTOR: `worker:${task}`,
      PNYX_STEERING_WORKER: steeringWorker,
    } : {}),
  })

  const hydraInstructions = () =>
    `You are Hydra for Pnyx Hydra "${hydraId}". Your contract is AGENTS.md in your current folder; follow it. Use pnyx-axi with --hydra ${hydraId}; PNYX_ACTOR=hydra is already set. Projects attach later; your current folder belongs to Hydra.`

  let memoryStamp: string | undefined

  const digest = ({ remember = true }: { remember?: boolean } = {}) => {
    const owner = ownerMemory()
    const state = loadHydra({ hydraId }).state

    const projects = projectDigest({ state })

    if (remember) {
      memoryStamp = JSON.stringify({
        owner,
        hydra: state.hydraMemory,
        projects,
      })
    }

    return hydraDigest({
      conditions: memoryConditions(),
      hydraId,
      state,
      owner,
      projects,
      setup: setupDigest({
        items: setupCheck({
          hydraId,
          state,
        }),
      }),
    })
  }

  const memoryChangeNote = () => {
    const owner = ownerMemory()
    const state = loadHydra({ hydraId }).state
    const stamp = JSON.stringify({
      owner,
      hydra: state.hydraMemory,
      projects: projectDigest({ state }),
    })
    const changed = memoryStamp !== undefined && memoryStamp !== stamp
    memoryStamp = stamp

    return changed ? ' Memory changed; load owner memory with owner memory list, Hydra memory with hydra memory list or project memory with project show <name|path> when needed.' : ''
  }

  // Hydra runs Pnyx's own CLI without asking; every other prompt waits in Hydra's chat.
  const hydraSession = () => ({
    instructions: hydraInstructions(),
    allow: ['pnyx-axi'],
    context: digest,
  })

  const providerOf = ({ provider }: { provider: string }) => {
    if (provider !== 'claude-code' && provider !== 'codex') {
      throw new HydraError({
        message: `unsupported hosted provider: ${provider}`,
        code: 'VALIDATION_ERROR',
      })
    }

    return providers[provider]
  }

  const askPermission = ({
    id: nativeId,
    key,
    entry,
    tool,
    input,
    signal,
    description,
    questions,
    form,
  }: {
    tool: string
    input: Record<string, unknown>
    signal: AbortSignal
    description?: string
    key: string
    entry: Live
    id: string
  } & Pick<PermissionRequest, 'questions' | 'form'>): Promise<PermissionDecision> => {
    if (closing || signal.aborted) {
      return Promise.resolve({
        behavior: 'deny',
        message: 'This permission request expired.',
      })
    }

    return new Promise<PermissionDecision>(resolve => {
      const id = randomUUID()
      const abort = () => expire({ id })

      const finish = ({ result }: { result: PermissionDecision }) => {
        pending.delete(id)
        signal.removeEventListener(
          'abort',
          abort,
        )
        resolve(result)
      }

      const request: PermissionRequest = {
        id,
        nativeId,
        session: key,
        tool,
        input,
        status: 'pending',
        ...(description ? { description } : {}),
        ...(questions?.length ? { questions } : {}),
        ...(form ? { form } : {}),
      }
      signal.addEventListener(
        'abort',
        abort,
        { once: true },
      )

      try {
        write({
          fn: ({ writer }) => {
            const session = writer.state.sessions?.[key]
            const current = session?.id === writer.state.config?.hydra.session
              ? writer.state.cards[HYDRA_CARD]
              : session?.taskId ? writer.state.cards[session.taskId] : undefined

            if (!current || current.agent?.host !== 'pnyx' || sessionId({ agent: current.agent }) !== key) {
              throw new HydraError({
                message: 'the agent is no longer attached to this task',
                code: 'NO_ROUTE',
              })
            }

            pending.set(
              id,
              {
                card: current.id,
                entry,
                finish,
              },
            )
            writer.append({
              event: permissionEvent({
                state: writer.state,
                card: current,
                request,
                meta: {
                  at: at(),
                  actor: 'pnyx',
                },
              }),
            })
          },
        })
      } catch (error) {
        finish({
          result: {
            behavior: 'deny',
            message: `Could not record permission: ${(error as Error).message}`,
          },
        })
      }
    })
  }

  const pendingSteeringIds = ({
    card,
    key,
    generation,
    ids,
  }: {
    card?: Card
    key: string
    generation?: number
    ids: string[]
  }) => {
    if (!card?.agent || !liveTask({ card }) || sessionId({ agent: card.agent }) !== key
      || card.steeringGeneration !== generation || steeringHeld({ card })) {
      return []
    }

    return (card.steering ?? []).filter(message => !message.ack && ids.includes(message.id))
      .map(message => message.id)
  }

  const inboxNotice = ({
    card,
    ids,
  }: {
    card: Card
    ids: string[]
  }) => {
    const messages = (card.steering ?? []).filter(message => ids.includes(message.id))
    const images = messages.flatMap(message => attachedImages({
      text: message.text,
      hydras: join(
        pnyxHome(),
        'hydras',
      ),
    }))

    return [
      steeringNotice({
        task: card.id,
        hydraId,
        ids,
      }),
      ...new Set(images.map(path => `[image: ${path}]`)),
    ].join('\n')
  }

  const unnotifiedSteering = ({
    card,
    entry,
    message: ref,
    attempt,
  }: {
    card: Card
    entry?: Live
    message?: string
    attempt?: string
  }) => {
    const sameOpening = entry?.task === card.id && entry.generation === card.steeringGeneration

    return [...(card.steering ?? [])].sort((
      a,
      b,
    ) => Number(b.id === card.compaction?.priority)
            - Number(a.id === card.compaction?.priority)).filter(message => {
      if (message.ack) {
        return false
      }

      if (attempt) {
        const alreadyAttempted = message.attempts.some(known => known.id === attempt)

        return message.id === ref && !alreadyAttempted
      }

      return !sameOpening || !entry.steering.has(message.id)
    })
  }

  const ringSteering = ({
    card,
    entry,
    message: ref,
    attempt,
  }: {
    card: Card
    entry: Live
    message?: string
    attempt?: string
  }) => {
    if (card.id === HYDRA_CARD || !liveTask({ card })
      || steeringHeld({ card }) || activeCompaction({ card })) {
      return
    }

    const claim = steeringClaim({ card })

    if (!claim) {
      return
    }

    const messages = unnotifiedSteering({
      card,
      entry,
      message: ref,
      attempt,
    })

    if (!messages.length) {
      return
    }

    const ids = messages.map(message => message.id)

    for (const message of messages) {
      teachComments({
        card: card.id,
        id: message.id,
        text: message.text,
      })
    }

    for (const id of ids) {
      entry.steering.add(id)
    }

    entry.input.push({
      text: '',
      steeringIds: ids,
    })
    write({
      fn: ({ writer }) => {
        const current = writer.state.cards[card.id]

        if (!current || !sameClaim({
          current: steeringClaim({ card: current }),
          claim,
        })) {
          return
        }

        for (const message of messages) {
          if (current.steering?.find(stored => stored.id === message.id)?.ack) {
            continue
          }

          recordSteeringAttempt({
            writer,
            ref: card.id,
            id: message.id,
            attempt: {
              id: attempt ?? randomUUID(),
              claim,
              at: at(),
              actor: 'pnyx',
              result: 'delivered',
            },
            meta: {
              actor: 'pnyx',
              at: at(),
            },
          })
        }
      },
    })
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

    try {
      entry.session ??= await providerOf({ provider: card.agent.provider }).open({
        cwd: folderOf({ card }),
        agent: card.agent,
        settings: card.settings ?? {},
        ...(card.id === HYDRA_CARD ? hydraSession() : { allow: WORKER_COMMANDS }),
        env: card.agent.loginFolder ? accountEnvironment({
          account: {
            provider: card.agent.provider === 'codex' ? 'codex' : 'claude',
            folder: card.agent.loginFolder,
          },
          env,
        }) : env,
        signal: controller.signal,
      })

      if (closing || live.get(key) !== entry) {
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

      const compactOwner = () => {
        const state = loadHydra({ hydraId }).state

        return sessionOwner({
          state,
          session: key,
          fallback: card.id,
        })
      }

      const input = async function* () {
        for await (const item of entry.input) {
          const current = compactOwner()

          if (current && activeCompaction({ card: current })) {
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
            while (!closing && live.get(key) === entry && turnRunning) {
              await new Promise(resolve => setTimeout(
                resolve,
                20,
              ))
            }

            if (closing || live.get(key) !== entry) {
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
                    trigger: 'manual',
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

            item.text = inboxNotice({
              card: current,
              ids,
            })
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
          let text = item.text

          if (item.id) {
            text = teachComments({
              card: card.id,
              id: item.id,
              text: item.text,
            })
          }

          yield agentInput({
            id: item.id ?? randomUUID(),
            text,
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

      for await (const activity of entry.session.run({
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
        if (entry.replaced || !closing && live.get(key) !== entry) {
          return
        }

        if (typeof activity !== 'string' && activity.type === 'compaction') {
          syncCompactions({ state: loadHydra({ hydraId }).state })
          const current = compactOwner()

          if (!current?.agent || sessionId({ agent: current.agent }) !== key) {
            continue
          }

          const mapped = compactionIds.get(activity.id)
          const matched = current?.compaction?.operations.find(operation => operation.id === mapped)
          const previous = matched
            ?? activeCompaction({ card: current })
          const operation = previous && (activity.trigger === 'manual' || previous.id === activity.id) ? previous : {
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
              },
            },
          })

          if (activity.state !== 'running') {
            releaseCompact({ card: current.id })
          }

          continue
        }

        if (typeof activity !== 'string' && activity.type === 'usage') {
          const before = usages.get(key) ?? {}
          usages.set(
            key,
            {
              ...before,
              ...Object.fromEntries(([
                'used',
                'window',
                'cost',
                'plan',
              ] as const).flatMap(field => activity[field] === undefined ? [] : [
                [
                  field,
                  activity[field],
                ],
              ])),
              ...(activity.limits ? {
                limits: mergeWindows({
                  base: before.limits ?? [],
                  over: activity.limits,
                }),
              } : {}),
            },
          )

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
            entry.tools.set(
              activity.id,
              Date.now(),
            )
          } else {
            entry.tools.delete(activity.id)
          }

          streamed({ session: key })

          continue
        }

        if (typeof activity !== 'string' && activity.type === 'structured') {
          continue
        }

        if (typeof activity !== 'string' && activity.type === 'work') {
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
                  ...(!entry.stopping ? { error: 'The agent ended its turn without reporting a compaction outcome. Native compact is unavailable in this session.' } : {}),
                },
              },
            })
            releaseCompact({ card: owner!.id })
          }

          turnRunning = false
          entry.stopping = false
          entry.tools.clear()
          entry.thinking.clear()
          completedOffset = transcriptSize()
          entry.replies.finish()
          streamed({ session: key })

          if (card.id === HYDRA_CARD) {
            const texts = entry.replies.texts()
            const asks = answering
            note({
              fn: ({ writer }) => copyTagged({
                writer,
                texts,
                asks,
                at: new Date().toISOString(),
              }),
            })
            finishReading()
            const messages = loadHydra({ hydraId }).state.hydraMessages ?? []
            const ownerInput = messages.some(message => answering.includes(message.id)
              && ownerActor({ actor: message.actor }))

            if (ownerInput && texts.at(-1)?.trim() === QUIET_REPLY) {
              entry.input.push({
                text: `<pnyx-wake>The owner wrote to you; reply to them in one standalone message.\n${REPLY_RULES}</pnyx-wake>`,
              })
            }
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
            const messages = loadHydra({ hydraId }).state.hydraMessages ?? []
            const opener = ({ message }: { message: HydraMessage }) =>
              answers.includes(message.id)
            const ownerMessage = ({ message }: { message: HydraMessage }) =>
              ownerActor({ actor: message.actor })
            ownerStarted = messages.some(message => opener({ message })
              && ownerMessage({ message }))
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
            mainTasks.clear()

            if (activity === 'finished' && readingParked.length) {
              const done = new Set(readingParked)
              updates = updates.filter(update => !done.has(update.seq))

              for (const seq of done) {
                parked.delete(seq)
              }

              queued()
            }

            readingParked = []
          }

          note({
            fn: ({ writer }) => {
              const handledThrough = wakesThrough({
                state: writer.state,
                pattern: WAKE_HANDLED,
              })
              // The wake this turn read counts as handled only now that the turn finished.
              const handledWake = card.id === HYDRA_CARD && activity === 'finished' && readThrough > handledThrough
              let eventId: string | undefined

              if (handledWake) {
                eventId = `wake:${readThrough}:handled`
              }

              if (card.id === HYDRA_CARD && activity === 'finished') {
                const batches = [...helperBatchesPresented]

                if (batches.length || outcomesPresented > (writer.state.helper?.delivered ?? 0)) {
                  apply({
                    writer,
                    decision: hydraEvent({
                      state: writer.state,
                      cardId: HYDRA_CARD,
                      meta: {
                        at: at(),
                        actor: 'pnyx',
                      },
                      change: {
                        type: 'hydra.helper-acknowledged',
                        data: {
                          batches,
                          through: outcomesPresented,
                        },
                      },
                    }),
                  })
                }
              }

              if (card.id === HYDRA_CARD && activity === 'finished') {
                helperBatchesPresented.clear()
              }

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
              armWake()
            }

            armIdle()
          }
        }
      }
    } catch (error) {
      failure = (error as Error).message
    }

    const compactCard = (() => {
      const state = loadHydra({ hydraId }).state

      return sessionOwner({
        state,
        session: key,
        fallback: card.id,
      })
    })()
    const unfinishedCompact = activeCompaction({ card: compactCard })

    if (unfinishedCompact && !closing) {
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

    if (entry.replaced || !closing && live.get(key) !== entry) {
      return
    }

    retire({
      key,
      entry,
    })

    // A check turn cut before it finished hands its updates back; they reach Hydra once the owner continues it.
    if (card.id === HYDRA_CARD && entry.activity === 'working') {
      readThrough = wakeCursor({
        state: loadHydra({ hydraId }).state,
        fallback: wakeStart ?? 0,
      })
      queued()
    } else if (card.id === HYDRA_CARD) {
      finishReading()
    }

    if (!closing && entry.activity === 'working') {
      const name = card.agent.provider === 'codex' ? 'Codex' : 'Claude Code'
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
            apply({
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
      task: card.id,
      generation: card.steeringGeneration,
      session,
      thinking: new Set(),
      tools: new Map(),
    }
    live.set(
      key,
      entry,
    )
    void consume({
      key,
      card,
      entry,
    })

    return entry
  }

  // eventId names the turn's working record, as a resumed turn's does.
  const send = ({
    card: ref,
    text,
    original,
    actor,
    eventId,
    steering,
    attempt,
    direct,
    inputId,
  }: {
    card: string
    text: string
    original?: string
    actor: string
    eventId?: string
    steering?: string
    attempt?: string
    direct?: boolean
    inputId?: string
  }) => {
    if (attempt !== undefined && (!attempt.trim() || !steering)) {
      throw new HydraError({
        message: 'A notification attempt needs a persisted steering ID',
        code: 'VALIDATION_ERROR',
      })
    }

    direct ||= compactCommand({ text })
    const card = write({
      fn: ({ writer }) => {
        const card = hosted({
          writer,
          ref,
        })

        if (!direct && card.id !== HYDRA_CARD) {
          if (steering) {
            if (!card.steering?.some(message => message.id === steering)) {
              throw new HydraError({
                message: 'Steering message was not persisted',
                code: 'VALIDATION_ERROR',
              })
            }
          } else {
            steering = inputId ?? randomUUID()
            enqueueSteering({
              writer,
              ref: card.id,
              id: steering,
              text,
              source: actor,
              meta: {
                actor,
                at: at(),
              },
            })
          }

          if (steeringHeld({ card })) {
            return writer.state.cards[card.id] as Card & { agent: AgentRef }
          }

          const current = writer.state.cards[card.id]!
          const running = live.get(sessionId({ agent: card.agent }))
          const unread = unnotifiedSteering({
            card: current,
            entry: running,
            message: steering,
            attempt,
          }).length

          if (!unread) {
            return undefined
          }
        }

        if (!live.has(sessionId({ agent: card.agent }))) {
          folderOf({ card })
        }

        if (card.attention.some(a => a.key === INTERRUPTED)) {
          const attention = card.attention.filter(a => a.key !== INTERRUPTED)
          const meta = {
            at: at(),
            actor,
          }
          const input = { attention }
          const decision = decidePush({
            state: writer.state,
            key: card.key,
            input,
            meta,
          })
          apply({
            writer,
            decision,
          })
        }

        record({
          writer,
          agent: card.agent,
          input: { activity: 'working' },
          actor,
          eventId,
        })

        return writer.state.cards[card.id] as Card & { agent: AgentRef }
      },
    })

    if (!card) {
      return
    }

    if (!direct && steeringHeld({ card })) {
      return { deferred: true }
    }

    if (holdCompact({
      card,
      input: {
        id: steering ?? inputId ?? randomUUID(),
        text,
        original,
        actor,
        route: steering ? 'steering' : 'direct',
      },
    })) {
      return { queued: true }
    }

    const entry = open({ card })
    entry.activity = 'working'
    entry.sentAt = Date.now()

    if (direct || card.id === HYDRA_CARD) {
      entry.input.push({
        text,
        original,
        id: inputId,
      })
    } else {
      ringSteering({
        card,
        entry,
        message: steering,
        attempt,
      })
    }
  }

  const helperFailed = ({ state }: { state: HydraState }) => Object.values(state.helper?.runs ?? {})
    .some(batch => batch.error)

  const helperPending = () => {
    const state = loadHydra({ hydraId }).state

    return outcomeLines({ state }).length > 0 || helperFailed({ state })
  }

  // A failed batch sends routine work to main until main has seen the failure.
  const helperOpen = ({ state }: { state: HydraState }) => !!helperAgent({ state })
    && !helperFailed({ state })

  // Tasks main's running turn was woken for; the helper leaves them until that turn ends.
  const mainTasks = new Set<string>()
  // A wake's tasks join mainTasks only once its turn really starts.
  const wakeTasks = new Map<string, string[]>()

  const wakeMain = ({
    id,
    text,
    tasks,
  }: {
    id: string
    text: string
    tasks: string[]
  }) => {
    wakeTasks.set(
      id,
      tasks,
    )

    return host.hydra({
      id,
      actor: 'pnyx',
      text,
    }).finally(() => wakeTasks.delete(id))
  }

  // One check turn at a time; a busy Hydra is woken when its turn finishes.
  const armWake = () => {
    if (!closing && !wakeTimer && (wakeThrough || helperPending())) {
      wakeTimer = setTimeout(
        () => background({
          name: 'Hydra wake',
          run: fireWake,
          retry: armWake,
        }),
        wakeDelay,
      )
    }
  }

  // The outage a queued recap turn reports; its text is built when the turn starts, so it leaves out messages answered first.
  let outage: NonNullable<HydraState['hydraStatus']> | undefined

  // One recap per outage: its id names the down event, so a retried or repeated recap starts at most one turn.
  const recapTurn = ({ down }: { down: NonNullable<HydraState['hydraStatus']> }) => background({
    name: 'Hydra recap',
    retry: planRetry,
    run: () => host.hydra({
      id: `back:${down.seq}`,
      actor: 'pnyx',
      text: recapText({
        state: loadHydra({ hydraId }).state,
        since: down.since,
        after: down.after ?? down.seq,
        now: Date.now(),
      }),
    }),
  })

  // A start worked after Hydra was down: say so in Pnyx's voice, then give Hydra the recap once the turn that started it ends.
  const back = ({
    down,
    turn,
    hydra,
  }: {
    down: NonNullable<HydraState['hydraStatus']>
    turn: string
    hydra: string
  }) => {
    clearTimeout(retryTimer)
    retryTimer = undefined
    retries = 0
    const now = Date.now()
    write({
      fn: ({ writer }) => {
        const meta = {
          at: new Date(now).toISOString(),
          actor: 'pnyx',
        }
        apply({
          writer,
          decision: hydraEvent({
            state: writer.state,
            meta,
            cardId: HYDRA_CARD,
            change: {
              type: 'hydra.status',
              data: {
                state: 'up',
                since: meta.at,
              },
            },
          }),
        })
        apply({
          writer,
          decision: hydraEvent({
            state: writer.state,
            meta,
            cardId: HYDRA_CARD,
            change: {
              type: 'hydra.message',
              data: {
                action: 'send',
                hydra,
                text: `Hydra is back after ${outageMinutes({
                  since: down.since,
                  now,
                })} min.`,
              },
            },
          }),
        })
      },
    })

    outage = down

    if (turn !== `back:${down.seq}`) {
      recapTurn({ down })
    }
  }

  // The recap turn tries the start again; a Hydra that is up, or no longer Pnyx's to run, needs no retry.
  const retryStart = () => {
    retryTimer = undefined
    const state = loadHydra({ hydraId }).state
    const status = state.hydraStatus

    if (closing || status?.state !== 'down' || !pnyxRunsHydra({ state })) {
      return
    }

    recapTurn({ down: status })
  }

  const planRetry = () => {
    if (retryTimer || closing) {
      return
    }

    retryTimer = setTimeout(
      () => background({
        name: 'Hydra retry',
        run: retryStart,
        retry: planRetry,
      }),
      retryDelays[Math.min(
        retries,
        retryDelays.length - 1,
      )],
    )
    retries += 1
  }

  let outcomesPresented = 0
  const helperBatchesPresented = new Set<string>()
  const helper = createRoutineHelper({
    hydraId,
    provider: ({ harness }) => providers[harness === 'claude' ? 'claude-code' : 'codex'],
    environment: ({
      harness,
      actor,
    }) => {
      const effective = effectiveDispatch({
        hydraId,
        state: loadHydra({ hydraId }).state,
      })
      const name = harnessAccount({
        effective,
        harness,
      })
      const account = name ? effective.accounts[name] : undefined
      const env = {
        ...environment({ hydra: true }),
        PNYX_ACTOR: actor,
      }

      return account ? accountEnvironment({
        account,
        env,
      }) : env
    },
    context: () => digest({ remember: false }),
    changed: () => {
      changed()
      armWake()
    },
    bound: helperBound,
    agentFor: () => {
      const state = loadHydra({ hydraId }).state
      const effective = effectiveDispatch({
        hydraId,
        state,
      })
      const main = state.config?.hydra.agent
        ?? effective.dispatch.rules.hydra?.candidates[0]
        ?? effective.dispatch.default[0]

      return helperAgent({
        state,
        main,
      })
    },
    handback: armWake,
    outcomesReady: armWake,
  })

  const updatesText = ({
    state,
    after,
    seqs,
  }: {
    state: HydraState
    after: number
    seqs: number[]
  }) => {
    const chosen = new Set(seqs)
    const reports = (state.hydraMessages ?? [])
      .filter(message => chosen.has(state.eventIds[message.id] ?? -1)
      && reportActor({ actor: message.actor }))

    return wakeText({
      hydraId,
      state,
      now: Date.now(),
      after,
      reasons: [...new Set(seqs.flatMap(seq => wakeReasonsAt.get(seq) ?? []))],
      reports,
      check: reports.length < chosen.size,
      pick: {
        tasks: updates.filter(update => chosen.has(update.seq)).map(update => update.card),
        asks: reports.flatMap(message => message.ask ?? []),
      },
    })
  }

  // Unread updates the helper may take; main keeps the tasks it handles now or has other updates for.
  const routeUpdates = ({
    state,
    after,
  }: {
    state: HydraState
    after: number
  }) => {
    const unread = updates.filter(update => (update.seq > after && update.seq <= wakeThrough)
      || parked.has(update.seq))
    const seqs = new Set(unread.map(update => update.seq))
    const routed = new Map(seqs.size ? readEvents({ hydraId })
      .filter(event => seqs.has(event.seq))
      .flatMap(event => {
        const task = helperEvent({
          state,
          event,
        })

        return task ? [
          [
            event.seq,
            {
              task,
              question: event.type === 'hydra.message' && !!event.data.ask,
            },
          ],
        ] as const : []
      }) : [])
    // Main keeps a task whose outcome or hand-back it has not acknowledged, so it can act on what the helper escalated.
    const mainOnly = new Set([
      ...mainTasks,
      ...unread.filter(update => !routed.has(update.seq)).map(update => update.card),
      ...(state.helper?.outcomes ?? []).filter(outcome => outcome.audience === 'owner'
        && outcome.seq > (state.helper?.delivered ?? 0)).map(outcome => outcome.task),
      ...Object.values(state.helper?.runs ?? {}).filter(batch => batch.error)
        .flatMap(batch => batch.tasks),
    ])
    const items = [...routed]
      .filter(([
        , item,
      ]) => !mainOnly.has(item.task))
      .map(([
        seq,
        item,
      ]) => ({
        seq,
        ...item,
      }))

    return {
      items,
      mainOnly,
    }
  }

  // Runs before main's wake checks so the helper takes routine tasks even while main works.
  const offerUpdates = async ({
    state,
    after,
  }: {
    state: HydraState
    after: number
  }) => {
    if (!helperOpen({ state }) || helper.busy()) {
      return
    }

    const batch = helperBatch({
      items: routeUpdates({
        state,
        after,
      }).items,
      prompt: ({ seqs }) => updatesText({
        state,
        after,
        seqs,
      }),
    })

    if (!batch) {
      return
    }

    const claimed = new Set(batch.seqs)

    if (await helper.offer({
      tasks: batch.tasks,
      prompt: batch.text,
      seqs: batch.seqs,
    })) {
      updates = updates.filter(update => !claimed.has(update.seq))

      for (const seq of claimed) {
        parked.delete(seq)
      }

      wakeThrough = Math.max(
        0,
        ...updates.map(update => update.seq),
      )
      queued()
    }
  }

  const fireWake = async () => {
    wakeTimer = undefined
    const current = loadHydra({ hydraId }).state

    if (closing || !pnyxRunsHydra({ state: current })) {
      return
    }

    await offerUpdates({
      state: current,
      after: wakeCursor({
        state: current,
        fallback: wakeStart ?? 0,
      }),
    })
    const state = loadHydra({ hydraId }).state
    const session = state.config?.hydra.session
    const card = state.cards[HYDRA_CARD]
    const after = wakeCursor({
      state,
      fallback: wakeStart ?? 0,
    })

    // An interrupted Hydra waits for the owner; the next change after that wakes it.
    if ((card?.sessionActivity ?? card?.activity) === 'interrupted'
      || card?.attention.some(a => a.key === INTERRUPTED)
      || queuedHydra.size || (session && live.get(session)?.activity === 'working')) {
      return
    }

    const open = helperOpen({ state })
    // Updates the helper can take wait for its next batch rather than riding along with main's.
    const helperSeqs = new Set(open ? routeUpdates({
      state,
      after,
    }).items.map(item => item.seq) : [])
    // A parked update the helper can no longer take is main's, even below main's cursor.
    const batch = updates.filter(update => !helperSeqs.has(update.seq)
      && (parked.has(update.seq) || (update.seq > after && update.seq <= wakeThrough)))

    if (!batch.length) {
      if (helperPending()) {
        return host.hydra({
          id: `helper-outcomes:${state.seq}`,
          actor: 'pnyx',
          text: '<pnyx-wake>The routine helper left outcomes or handed a batch back. Handle the pending records below; relay owner outcomes in one plain line each with full links.</pnyx-wake>',
        })
      }

      return
    }

    const through = Math.max(
      after,
      ...batch.map(update => update.seq),
    )
    wakeParked.set(
      through,
      batch.filter(update => parked.has(update.seq)).map(update => update.seq),
    )

    for (const seq of helperSeqs) {
      if (seq <= through) {
        parked.add(seq)
      }
    }

    // Progress is never queued, so main's reports are every unread message the helper does not hold.
    const held = new Set(activeHelperBatches({ state }).flatMap(batch => batch.seqs))
    const reports = (state.hydraMessages ?? []).filter(message => {
      const seq = state.eventIds[message.id]

      if (seq === undefined || !reportActor({ actor: message.actor })) {
        return false
      }

      const unread = seq > after && seq <= through && !state.helper?.handled.includes(seq)

      return batch.some(update => update.seq === seq)
        || (unread && !held.has(seq) && !helperSeqs.has(seq) && !parked.has(seq))
    })
    const reportSeqs = new Set(reports.map(message => state.eventIds[message.id]))
    const review = state.hydraReview
    let reviewText: string | undefined

    if (review && review.seq > after && review.seq <= through) {
      reviewText = review.block
    }

    const text = wakeText({
      hydraId,
      state,
      now: Date.now(),
      after,
      reasons: [...new Set(batch.flatMap(update => wakeReasonsAt.get(update.seq) ?? []))],
      reports,
      check: batch.some(update => !reportSeqs.has(update.seq)) || !reports.length,
      review: reviewText,
    })

    return wakeMain({
      id: wakeId({
        through,
        state,
      }),
      text,
      tasks: batch.map(update => update.card),
    })
  }

  const finishReading = () => {
    const unread = updates.filter(update => update.seq > readThrough || parked.has(update.seq))

    for (const seq of wakeReasonsAt.keys()) {
      if (seq <= readThrough && !parked.has(seq)) {
        wakeReasonsAt.delete(seq)
      }
    }

    if (unread.length !== updates.length) {
      updates = unread
      queued()
    }
  }

  // A stall or an ended wait makes no event, so it is polled.
  const checkStalls = async () => {
    try {
      return await wakeOnStall()
    } catch (error) {
      console.error(`pnyx-axi serve: ${(error as Error).message}`)
    }
  }

  // When a paused task's wait ends: its --until, never for a hold, or pauseDelay after a worker's pause with neither.
  const waitEnd = ({ card }: { card: Card }): number | undefined => {
    const declaration = pausedDeclaration({ card })

    if (!declaration) {
      return undefined
    }

    if (declaration.until) {
      return Date.parse(declaration.until)
    }

    // A hold keeps its worker out of stall checks too, until the owner or Hydra resumes it.
    if (declaration.hold) {
      return Infinity
    }

    // Hydra or the owner parking a task, or a task with no worker, is not a wait.
    const parked = declaration.actor === HYDRA_ACTOR || ownerActor({ actor: declaration.actor })
      || !card.sessionIds?.length

    if (parked) {
      return undefined
    }

    return Date.parse(declaration.at) + pauseDelay
  }

  // A stall fired before is due again after the stall delay doubled per earlier alarm, up to stallRepeatMax.
  const stallDue = ({
    id,
    now,
  }: {
    id: string
    now: number
  }) => {
    const fired = stalled.get(id)

    if (!fired) {
      return true
    }

    const repeatAfter = Math.min(
      stallDelay * 2 ** fired.count,
      stallRepeatMax,
    )

    return now - fired.at >= repeatAfter
  }

  const workerStalls = ({
    state,
    card,
    now,
  }: {
    state: HydraState
    card: Card & { agent: AgentRef }
    now: number
  }): StallItem[] => {
    const requests = (card.permissions ?? []).filter(p => p.status === 'pending')

    if (requests.length) {
      return requests.flatMap(p => {
        const waited = p.at ? now - Date.parse(p.at) : 0

        if (waited < stallDelay) {
          return []
        }

        return [
          {
            id: `stall:${p.id}`,
            card: card.id,
            kind: 'permission',
            detail: `${p.tool} has waited ${Math.round(waited / 1000)} s for an answer`,
          },
        ]
      })
    }

    const key = sessionId({ agent: card.agent })
    const entry = live.get(key)

    if (entry?.activity !== 'working') {
      return []
    }

    const declaredWaitEnd = waitEnd({ card })

    if (declaredWaitEnd !== undefined && now < declaredWaitEnd) {
      return []
    }

    const toolStarts = [...entry.tools.values()]

    if (toolStarts.length) {
      const busySince = Math.min(...toolStarts)
      const busyFor = now - busySince

      if (busyFor < busyDelay) {
        return []
      }

      return [
        {
          id: `stall:${card.id}:tool:${busySince}`,
          card: card.id,
          kind: 'quiet',
          detail: `the worker has been inside one tool call for ${Math.round(busyFor / 1000)} s`,
        },
      ]
    }

    const agent = state.sessions?.[key]
    const seen = Math.max(
      agent ? seenAt({ session: agent }) : 0,
      entry.sentAt ?? 0,
    )

    if (!seen || now - seen < stallDelay) {
      return []
    }

    return [
      {
        id: `stall:${card.id}:${seen}`,
        card: card.id,
        kind: 'quiet',
        detail: `the worker has been working with no sign of life for ${Math.round((now - seen) / 1000)} s`,
      },
    ]
  }

  // A worker that ended its turn still declaring working stopped without saying why, whoever runs it; this repeats the turn-ended wake while it lasts.
  const idleStall = ({
    state,
    card,
    now,
  }: {
    state: HydraState
    card: Card & { agent: AgentRef }
    now: number
  }): StallItem[] => {
    const turnEnded = (card.sessionActivity ?? card.activity) === 'finished'
    const declaresWorking = card.tracking === 'declared' && card.status?.state === 'working'
    const asking = card.attention.some(a => a.blocking && !a.answered)

    if (!turnEnded || !declaresWorking || asking || !liveTask({ card })) {
      return []
    }

    const session = state.sessions?.[sessionId({ agent: card.agent })]

    if (!session) {
      return []
    }

    const seen = seenAt({ session })

    if (!seen || now - seen < stallDelay) {
      return []
    }

    return [
      {
        id: `stall:${card.id}:idle:${seen}`,
        card: card.id,
        kind: 'turn ended',
        detail: `the worker ended its turn ${Math.round((now - seen) / 1000)} s ago and still declares working`,
      },
    ]
  }

  // A paused worker's wait that ended wakes Hydra once, whoever runs the worker.
  const endedWaits = ({
    state,
    now,
  }: {
    state: HydraState
    now: number
  }): StallItem[] => Object.values(state.cards).flatMap(card => {
    const declaredWaitEnd = waitEnd({ card })
    const declaration = pausedDeclaration({ card })

    const waiting = declaredWaitEnd === undefined || now < declaredWaitEnd

    if (card.id === HYDRA_CARD || !liveTask({ card }) || waiting || !declaration) {
      return []
    }

    const id = `wait:${declaration.id}`

    if (wakeHandled({
      state,
      id,
    })) {
      return []
    }

    const named = declaration.until ? `until ${declaration.until}` : `since ${declaration.at}`
    const note = declaration.note ? `: ${declaration.note}` : ''

    return [
      {
        id,
        card: card.id,
        kind: 'wait ended',
        detail: `the worker paused ${named}${note}`,
      },
    ]
  })

  // A message the worker never confirmed after its resends wakes Hydra once; the server reports it each check.
  const unconfirmedReplies = new Map<string, Omit<StallItem, 'id'>>()

  const missingReplies = ({ state }: { state: HydraState }): StallItem[] => {
    for (const id of unconfirmedReplies.keys()) {
      if (wakeHandled({
        state,
        id,
      })) {
        unconfirmedReplies.delete(id)
      }
    }

    return [...unconfirmedReplies].map(([
      id,
      item,
    ]) => ({
      id,
      ...item,
    }))
  }

  const wakeOnStall = async () => {
    const state = loadHydra({ hydraId }).state
    const hydraCard = state.cards[HYDRA_CARD]
    const session = state.config?.hydra.session

    if (closing || !hostedHydra({ state })) {
      return
    }

    // A Hydra that cannot start holds main's stall alarms, which would otherwise be spent on starts that never reach it.
    const mainWaits = state.hydraStatus?.state === 'down' || queuedHydra.size > 0
      || (hydraCard?.sessionActivity ?? hydraCard?.activity) === 'interrupted'
      || hydraCard?.attention.some(a => a.key === INTERRUPTED)
      || (session && live.get(session)?.activity === 'working')
    const now = Date.now()
    const stalls = Object.values(state.cards).flatMap(card => {
      if (card.id === HYDRA_CARD || !card.agent) {
        return []
      }

      const worker = card as Card & { agent: AgentRef }
      const idle = idleStall({
        state,
        card: worker,
        now,
      })

      if (idle.length || card.agent.host !== 'pnyx') {
        return idle
      }

      return workerStalls({
        state,
        card: worker,
        now,
      })
    })
      .filter(stall => stallDue({
        id: stall.id,
        now,
      }))
    const waits = endedWaits({
      state,
      now,
    }).filter(wait => !stalled.has(wait.id))
    const unconfirmed = missingReplies({ state }).filter(reply => !stalled.has(reply.id))
    const fired = [
      ...stalls,
      ...waits,
      ...unconfirmed,
    ]

    if (!fired.length) {
      return
    }

    const alarm = ({ stall }: { stall: StallItem }) => {
      const count = stalled.get(stall.id)?.count ?? 0

      if (count === 0) {
        return stall.detail
      }

      return `${stall.detail} (alarm ${count + 1})`
    }

    const delivered = ({ items }: { items: StallItem[] }) => {
      const at = Date.now()

      for (const item of items) {
        const count = stalled.get(item.id)?.count ?? 0
        stalled.set(
          item.id,
          {
            count: count + 1,
            at,
          },
        )
      }
    }

    const after = wakeCursor({
      state,
      fallback: wakeStart ?? 0,
    })
    const stallText = ({
      items,
      helper: picked = false,
    }: {
      items: StallItem[]
      helper?: boolean
    }) => `<pnyx-wake>Why you are woken:\n${items.map(item => sealed({
      text: reasonLine({
        state,
        card: item.card,
        kind: item.kind,
        detail: alarm({ stall: item }),
      }),
    })).join('\n')}\nRun \`pnyx-axi hydra check --after ${after} --hydra ${hydraId}\`; its requests and agents show what waits. If it waits on the owner, tell them in one line of reply text unless an earlier reply or its question card already did. Otherwise apply Questions and scope in your contract: answer what unambiguously fulfills the owner's accepted ask, escalate an unsettled choice, or nudge the worker. Reply only ${QUIET_REPLY} when it has already cleared or the owner was already told.\n${decisionsText({
      state,
      now,
      pick: picked ? {
        tasks: items.map(item => item.card),
        asks: [],
      } : undefined,
    })}\n${REPLY_RULES}</pnyx-wake>`
    const mainOnly = new Set([
      ...routeUpdates({
        state,
        after,
      }).mainOnly,
      ...fired.filter(item => !helperReason({
        state,
        task: item.card,
        kind: item.kind,
      })).map(item => item.card),
    ])
    const routine = fired.filter(item => !mainOnly.has(item.card))
    const batch = helperOpen({ state }) && !helper.busy() ? helperBatch({
      items: routine.map((
        item,
        index,
      ) => ({
        task: item.card,
        seq: index,
        question: false,
      })),
      prompt: ({ seqs }) => stallText({
        items: seqs.map(index => routine[index]!),
        helper: true,
      }),
    }) : undefined
    const offered = batch?.seqs.map(index => routine[index]!) ?? []

    if (batch && await helper.offer({
      tasks: batch.tasks,
      prompt: batch.text,
      seqs: [],
      once: offered.filter(item => item.kind === 'wait ended' || item.kind === 'not confirmed').map(item => item.id),
    })) {
      delivered({ items: offered })
    }

    // Alarms the helper can take stay undelivered, so they fire again for its next batch.
    const rest = fired.filter(item => !offered.includes(item)
      && (mainOnly.has(item.card) || !helperOpen({ state })))
    // A wait or reply named first keeps its own turn id, which holds it to one wake across a restart.
    const [first] = [
      ...waits,
      ...unconfirmed,
      ...stalls,
    ].filter(item => rest.includes(item))

    if (mainWaits || !first) {
      return
    }

    const firstCount = stalled.get(first.id)?.count ?? 0
    const wakeTurnId = firstCount === 0 ? first.id : `${first.id}:${firstCount + 1}`

    await wakeMain({
      id: wakeTurnId,
      text: stallText({ items: rest }),
      tasks: rest.map(item => item.card),
    })
    delivered({ items: rest })
  }

  // Each stall or wait fired so far: how many times, and when last.
  const stalled = new Map<string, {
    count: number
    at: number
  }>()
  const stallTimer = setInterval(
    () => background({
      name: 'worker stall check',
      run: checkStalls,
    }),
    Math.min(
      stallDelay / 4,
      15_000,
    ),
  )
  stallTimer.unref()

  const host: Host = {
    async catalogCommands({
      card,
      provider = card.agent?.provider ?? 'claude-code',
    }) {
      const harness = provider === 'codex' ? 'codex' : 'claude-code'
      const cacheKey = JSON.stringify([
        harness,
        card.agent?.loginFolder,
        card.agent?.cwd ?? card.folder,
      ])

      const retained = () => {
        const saved = loadHydra({ hydraId }).state.cards[card.id]?.compaction?.catalogs
        const commands = commandCatalogs.get(cacheKey) ?? saved?.[cacheKey] ?? []
        const matches = card.agent?.provider === harness
        const session = matches && card.agent ? sessionId({ agent: card.agent }) : undefined
        const operation = loadHydra({ hydraId }).state.cards[card.id]?.compaction?.operations
          .findLast(operation => operation.session === session)
        const unavailable = operation?.state === 'failed'
          && /method not found|unknown method|not supported|unavailable in this session/i.test(operation.error ?? '')
          ? operation.error : undefined
        const native = commands.some(item => item.command === '/compact') || !providers[harness].compact ? commands : [
          ...commands,
          {
            command: '/compact',
            description: 'Compact the conversation',
            source: 'Agent commands',
            kind: 'command' as const,
          },
        ]

        return native.map(item => item.command === '/compact' && unavailable ? {
          ...item,
          unavailable,
          description: `Unavailable: ${unavailable}`,
        } : item)
      }

      const matchesProvider = card.agent?.provider === harness
      const session = matchesProvider && card.agent ? sessionId({ agent: card.agent }) : undefined
      const entry = session ? live.get(session) : undefined

      if (!entry?.session?.commands) {
        return retained()
      }

      let timer: ReturnType<typeof setTimeout> | undefined

      try {
        const lookup = entry.session.commands().then(commands => {
          const found = commands.filter(item => item.builtin).map(item => ({
            command: `/${item.name}`,
            description: item.description,
            source: 'Agent commands',
            kind: 'command' as const,
          }))

          if (found.length && !closing) {
            commandCatalogs.set(
              cacheKey,
              found,
            )
            const saved = loadHydra({ hydraId }).state.cards[card.id]?.compaction?.catalogs
            const previous = saved?.[cacheKey]

            if (JSON.stringify(previous) !== JSON.stringify(found)) {
              compactChange({
                card: card.id,
                change: {
                  kind: 'catalog',
                  key: cacheKey,
                  commands: found,
                },
              })
            }
          }
        })
        await Promise.race([
          lookup,
          new Promise<void>(resolve => {
            timer = setTimeout(
              resolve,
              100,
            )
          }),
        ])

        return retained()
      } catch {
        // The disk index remains usable when the native command list is unavailable.
        return retained()
      } finally {
        clearTimeout(timer)
      }
    },
    async models({ harness }) {
      const state = loadHydra({ hydraId }).state
      const effective = effectiveDispatch({
        hydraId,
        state,
      })
      const main = harnessAccount({
        effective,
        harness,
      })
      const account = main ? effective.accounts[main] : undefined
      const env = account ? accountEnvironment({
        account,
        env: environment(),
      }) : environment()

      const key = `${harness}:${account?.folder ?? ''}`
      let catalog = modelCatalogs.get(key)

      if (!catalog) {
        const provider = providerOf({ provider: providerName({ harness }) })
        const cwd = hydraDir({ hydraId })
        const stored = storedModels({ key })

        // The folder's own settings apply on top of the shared list; a failed read is dropped so the picker can retry.
        const settle = ({ models }: { models: ModelOption[] | Promise<ModelOption[]> }) => {
          const settled = Promise.resolve(models)
            .then(models => provider.defaults({
              cwd,
              env,
              models,
            }))
          modelCatalogs.set(
            key,
            settled,
          )
          void settled.catch(() => {
            if (modelCatalogs.get(key) === settled) {
              modelCatalogs.delete(key)
            }
          })

          return settled
        }

        // The harness is read once per server; a stored list answers meanwhile and a failed read keeps it.
        const read = provider.models({
          cwd,
          env,
        }).then(models => {
          const changed = JSON.stringify(models) !== JSON.stringify(stored)

          if (changed) {
            storeModels({
              key,
              models,
            })
          }

          if (changed && stored) {
            void settle({ models })
          }

          return models
        })
        void read.catch(() => {})
        catalog = settle({ models: stored ?? read })
      }

      return catalog
    },
    hydraId,
    hydra: ({
      text,
      original,
      actor,
      id,
      release = false,
      selected,
    }) => {
      if (reportActor({ actor })) {
        changed()

        return Promise.resolve({ state: 'queued' })
      }

      if (ownerActor({ actor }) && upgradeCommand({ text })) {
        upgrades.request({ id })
        queued()

        return Promise.resolve({ state: 'queued' })
      }

      // Hydra waits for a running upgrade, so a message sent meanwhile queues behind it.
      if (!release && upgrades.hold({
        message: {
          id,
          text,
          original,
          actor,
          at: at(),
        },
      })) {
        queued()

        return Promise.resolve({ state: 'queued' })
      }

      const queuedState = loadHydra({ hydraId }).state
      const queuedDispatch = effectiveDispatch({
        hydraId,
        state: queuedState,
      }).dispatch
      const requestedAgent = selected ?? queuedState.config?.hydra.agent
        ?? queuedDispatch.rules.hydra?.candidates[0] ?? queuedDispatch.default[0]
        ?? { harness: 'claude' as const }
      const deliveryId = release ? `${id}:compact:hosted` : `${id}:hosted`
      const current = loadHydra({ hydraId }).state.cards[HYDRA_CARD]

      if (current && holdCompact({
        card: current,
        input: {
          id,
          text,
          original,
          actor,
          route: 'hydra',
          agent: requestedAgent,
        },
      })) {
        return Promise.resolve({ state: 'queued' })
      }

      if (queuedHydra.has(id)) {
        return Promise.resolve({ state: 'queued' })
      }

      queuedHydra.add(id)
      const turn = hydraTurn.then(async () => {
        if (closing) {
          return { state: 'queued' }
        }

        let state = loadHydra({ hydraId }).state
        const compactCard = state.cards[HYDRA_CARD]

        if (compactCard && holdCompact({
          card: compactCard,
          input: {
            id,
            text,
            original,
            actor,
            route: 'hydra',
            agent: requestedAgent,
          },
        })) {
          return { state: 'queued' }
        }

        if (id.startsWith('helper-outcomes:') && !helperPending()) {
          return { state: 'queued' }
        }

        const config = hydraConfig({
          state,
          id: hydraId,
        })

        if (config.hydra.kind === 'firstmate') {
          return { state: 'queued' }
        }

        if (deliveryId in state.eventIds) {
          return { state: 'queued' }
        }

        const previous = state.cards[HYDRA_CARD]

        write({
          fn: ({ writer }) => {
            if (previous?.agent?.host === 'pnyx') {
              record({
                writer,
                agent: previous.agent,
                input: { activity: 'working' },
                actor,
              })
            } else {
              apply({
                writer,
                decision: decidePush({
                  state: writer.state,
                  key: HYDRA_CARD,
                  input: { activity: 'working' },
                  meta: {
                    at: at(),
                    actor,
                  },
                }),
              })
            }
          },
        })
        let prepared: HostedSession | undefined

        try {
          if (previous?.agent && previous.agent.host !== 'pnyx') {
            throw new HydraError({
              message: 'This Hydra already has an outside agent. Continue it in its own harness.',
              code: 'NO_ROUTE',
            })
          }

          const effective = effectiveDispatch({
            hydraId,
            state,
          })
          const candidate = requestedAgent
            ?? effective.dispatch.rules.hydra?.candidates[0]
            ?? effective.dispatch.default[0]
            ?? { harness: 'claude' as const }
          const main = harnessAccount({
            effective,
            harness: candidate.harness,
          })
          const account = main ? effective.accounts[main] : undefined
          const provider = providerName({ harness: candidate.harness })
          const dispatch = previous?.agent?.provider !== provider
            && account && main ? chooseCandidate({
              config: {
                ...effective,
                dispatch: {
                  ...effective.dispatch,
                  default: [candidate],
                  workers: { [account.provider]: [main] },
                  projects: {},
                },
              },
              offers: candidate.model
                ? await catalogOffers({
                  host,
                  harnesses: [candidate.harness],
                }) : undefined,
            }) : undefined
          const settings: AgentSettings = Object.fromEntries(Object.entries(candidate).filter(([
            key,
            value,
          ]) => key !== 'harness' && value !== undefined)
            .map(([
              key,
              value,
            ]) => [
              key,
              String(value),
            ]))
          const cwd = join(
            hydraDir({ hydraId }),
            'agent',
          )
          prepareHydraFolder({ folder: cwd })
          let card = previous
          const previousAgent = card?.agent
          const running = previousAgent && live.get(sessionId({ agent: previousAgent }))
          // A person's message joins Hydra's running turn when the same session takes it; Pnyx's own wakes wait for the turn to end.
          const sameSession = previousAgent?.provider === provider
            && sameChosenSettings({
              current: card?.settings,
              chosen: settings,
            })
          const stopping = Boolean(running && running.stopping)
          const joinsTurn = actor !== 'pnyx' && sameSession && !stopping

          while (!joinsTurn && previousAgent && running?.activity === 'working'
            && live.get(sessionId({ agent: previousAgent })) === running && !closing) {
            await new Promise(resolve => setTimeout(
              resolve,
              20,
            ))
          }

          if (closing) {
            throw new Error('Pnyx is stopping')
          }

          state = loadHydra({ hydraId }).state
          card = state.cards[HYDRA_CARD]
          const agent = card?.agent?.provider === provider ? card.agent : undefined
          const changedSettings = !sameChosenSettings({
            current: card?.settings,
            chosen: settings,
          })

          if (running && previousAgent && (!agent || changedSettings)) {
            retire({
              key: sessionId({ agent: previousAgent }),
              entry: running,
            })
          }

          if (!agent || !live.has(sessionId({ agent }))) {
            prepared = await providerOf({ provider }).open({
              cwd,
              agent,
              settings,
              ...hydraSession(),
              env: agent?.loginFolder ? accountEnvironment({
                account: {
                  provider: candidate.harness,
                  folder: agent.loginFolder,
                },
                env: environment({ hydra: true }),
              }) : dispatch ? accountEnvironment({
                account: {
                  provider: dispatch.provider,
                  folder: dispatch.folder,
                },
                env: environment({ hydra: true }),
              }) : environment({ hydra: true }),
              signal: controller.signal,
            })
          }

          const ref: AgentRef = agent ?? {
            provider,
            sessionId: prepared!.id,
            cwd,
            host: 'pnyx',
            ...(prepared?.path ? { transcriptPath: prepared.path } : {}),
            ...(dispatch ? {
              account: dispatch.account,
              loginFolder: dispatch.folder,
            } : {}),
          }
          const claimed = write({
            fn: ({ writer }) => {
              const meta = {
                at: at(),
                actor,
              }

              if (previousAgent && !agent) {
                harvestTranscripts({
                  writer,
                  cardIds: [HYDRA_CARD],
                  at: meta.at,
                })
              }

              apply({
                writer,
                decision: decidePush({
                  state: writer.state,
                  key: HYDRA_CARD,
                  input: {
                    attention: writer.state.cards[HYDRA_CARD]?.attention
                      .filter(a => a.key !== INTERRUPTED) ?? [],
                  },
                  meta,
                }),
              })
              apply({
                writer,
                decision: decidePush({
                  state: writer.state,
                  key: sessionKey({ agent: ref }),
                  input: {
                    agent: ref,
                    title: 'Hydra',
                    settings: {
                      ...Object.fromEntries(Object.keys(card?.settings ?? {})
                        .map(key => [
                          key,
                          null,
                        ])),
                      ...settings,
                    },
                    activity: 'working',
                    attention: [],
                    source: {
                      adapter: 'pnyx',
                      objectId: ref.sessionId,
                      observedAt: meta.at,
                    },
                  },
                  meta,
                }),
              })
              const current = hydraConfig({
                state: writer.state,
                id: hydraId,
              })
              apply({
                writer,
                decision: hydraEvent({
                  state: writer.state,
                  meta: {
                    ...meta,
                    id: deliveryId,
                  },
                  cardId: HYDRA_CARD,
                  change: {
                    type: 'board.configured',
                    data: {
                      ...current,
                      hydra: {
                        ...current.hydra,
                        session: sessionId({ agent: ref }),
                      },
                    },
                  },
                }),
              })

              return writer.state.cards[HYDRA_CARD] as Card & { agent: AgentRef }
            },
          })
          // Reopened sessions receive full context; a running wake only notes memory changes.
          const opened = Boolean(prepared)
          const entry = open({
            card: claimed,
            session: prepared,
          })
          prepared = undefined
          const down = loadHydra({ hydraId }).state.hydraStatus

          if (down?.state === 'down') {
            back({
              down,
              turn: id,
              hydra: config.hydra.id,
            })
          }

          const waking = /^(wake|stall|wait|unconfirmed):/.test(id) && !opened && Boolean(entry.session)
          const memoryNote = waking ? memoryChangeNote() : ''
          const recap = outage && id === `back:${outage.seq}` ? recapText({
            state: loadHydra({ hydraId }).state,
            since: outage.since,
            after: outage.after ?? outage.seq,
            now: Date.now(),
          }) : undefined

          if (recap) {
            outage = undefined
          }

          const helperState = loadHydra({ hydraId }).state
          const helperLines = outcomeLines({ state: helperState })
          let helperText = ''
          // Main holds the tasks whose outcomes or hand-backs it is given, as it holds a wake's tasks.
          const presentedTasks = [
            ...(helperState.helper?.outcomes ?? [])
              .filter(outcome => outcome.audience === 'owner' && outcome.seq > (helperState.helper?.delivered ?? 0))
              .map(outcome => outcome.task),
            ...Object.values(helperState.helper?.runs ?? {}).filter(batch => batch.error)
              .flatMap(batch => batch.tasks),
          ]

          if (activeHelperBatches({ state: helperState }).length) {
            helperText = `\n<pnyx-wake>${sealed({ text: helperLeases({ state: helperState }).join('\n') })}</pnyx-wake>`
          }

          if (helperLines.length) {
            outcomesPresented = Math.max(
              outcomesPresented,
              ...helperState.helper!.outcomes.map(outcome => outcome.seq),
            )
            helperText += `\n<pnyx-wake>Helper outcomes to relay, one line each:\n${sealed({ text: helperLines.join('\n') })}\n${REPLY_RULES}</pnyx-wake>`
          }

          const pendingBatches = Object.values(helperState.helper?.runs ?? {})
            .filter(batch => batch.error)

          // Every failed batch reaches main as one notice naming its tasks, not one wake each.
          if (pendingBatches.length) {
            const tasks = [...new Set(pendingBatches.flatMap(batch => batch.tasks))]
              .map(task => taskMention({
                id: task,
                title: helperState.cards[task]?.title ?? task,
              }))
            const errors = [...new Set(pendingBatches.map(batch => batch.error ?? 'interrupted'))]

            for (const batch of pendingBatches) {
              helperBatchesPresented.add(batch.id)
            }

            const handedBack = pendingBatches.length === 1 ? 'a batch' : `${pendingBatches.length} batches`
            const notice = `The routine helper handed back ${handedBack} for ${tasks.join(', ')}: ${errors.join('; ')}`
            const wakes = pendingBatches.map(batch => sealed({ text: batch.prompt })).join('\n')
            helperText += `\n<pnyx-wake>${sealed({ text: notice })}. These tasks are yours now: check their current state before acting, because earlier actions may have completed. The wakes it was given:\n${wakes}</pnyx-wake>`
          }

          const inputText = recap ?? (memoryNote ? text.replace(
            REPLY_RULES,
            `${memoryNote}\n${REPLY_RULES}`,
          ) : text)
          entry.activity = 'working'

          for (const task of [
            ...wakeTasks.get(id) ?? [],
            ...presentedTasks,
          ]) {
            mainTasks.add(task)
          }

          entry.input.push({
            text: compactCommand({ text }) ? text : inputText + helperText,
            original: original ?? text,
            id,
            agent: requestedAgent,
          })
          const wakeThroughSeq = WAKE_ID.exec(id)?.[1]

          if (wakeThroughSeq) {
            readThrough = Number(wakeThroughSeq)
            readingParked = wakeParked.get(readThrough) ?? []
            wakeParked.delete(readThrough)
            queued()
          }

          return { state: 'queued' }
        } catch (error) {
          prepared?.close()

          if (closing) {
            return { state: 'failed' }
          }

          const reason = (error as Error).message
          // An outside agent is not Pnyx's to start, so it is refused once rather than retried.
          const retried = !(error instanceof HydraError && error.code === 'NO_ROUTE')
          const detail = retried
            ? `Hydra could not start: ${reason}. Pnyx is retrying; check the harness login and settings if this lasts.`
            : `Hydra could not start: ${reason}`
          // Finished rather than interrupted, so a retry or the next wake starts Hydra again; a cut turn's attention still waits for the owner.
          write({
            fn: ({ writer }) => {
              const down = writer.state.hydraStatus?.state === 'down'
              const now = at()

              if (previous?.agent?.host === 'pnyx') {
                record({
                  writer,
                  agent: previous.agent,
                  input: { activity: 'finished' },
                  actor: 'pnyx',
                })
              }

              apply({
                writer,
                decision: decidePush({
                  state: writer.state,
                  key: HYDRA_CARD,
                  input: { activity: 'finished' },
                  meta: {
                    at: now,
                    actor: 'pnyx',
                  },
                }),
              })

              if (retried && !down) {
                apply({
                  writer,
                  decision: hydraEvent({
                    state: writer.state,
                    meta: {
                      at: now,
                      actor: 'pnyx',
                    },
                    cardId: HYDRA_CARD,
                    change: {
                      type: 'hydra.status',
                      data: {
                        state: 'down',
                        since: now,
                        detail: reason,
                        after: Math.min(
                          writer.state.seq,
                          (writer.state.eventIds[id] ?? Infinity) - 1,
                        ),
                      },
                    },
                  }),
                })
              }

              // Retries fail quietly; the owner hears of each failure their own message meets.
              if (!down || ownerActor({ actor })) {
                apply({
                  writer,
                  decision: hydraEvent({
                    state: writer.state,
                    meta: {
                      at: now,
                      actor: 'pnyx',
                    },
                    cardId: HYDRA_CARD,
                    change: {
                      type: 'hydra.message',
                      data: {
                        action: 'send',
                        hydra: config.hydra.id,
                        text: detail,
                      },
                    },
                  }),
                })
              }
            },
          })

          if (retried) {
            planRetry()
          }

          return {
            state: 'failed',
            detail,
          }
        }
      })
      hydraTurn = turn.then(
        () => {},
        () => {},
      ).finally(() => queuedHydra.delete(id))

      return Promise.resolve({ state: 'queued' })
    },
    compact: async ({
      card: ref,
      sendNow,
    }) => {
      if (sendNow && upgrades.sendNow({ id: sendNow })) {
        return { sent: 'upgrade' }
      }

      const card = findCard({
        state: loadHydra({ hydraId }).state,
        ref,
      })
      const operation = activeCompaction({ card })

      if (!operation) {
        return { stopped: 'none: no compaction is running' }
      }

      if (sendNow) {
        if (!card.compaction?.inputs.some(input => input.id === sendNow)) {
          throw new HydraError({
            code: 'VALIDATION_ERROR',
            message: 'That message is no longer queued',
          })
        }

        compactChange({
          card: card.id,
          change: {
            kind: 'priority',
            id: sendNow,
          },
        })
      }

      const entry = card.agent && live.get(sessionId({ agent: card.agent }))

      if (!entry?.session) {
        throw new HydraError({
          code: 'NO_ROUTE',
          message: 'The compact session is unavailable',
        })
      }

      entry.stopping = true

      try {
        await entry.session.interrupt()
      } catch (error) {
        entry.stopping = false; throw error
      }

      return { stopped: 'compaction' }
    },
    // Stops only Hydra's running turn, or the upgrade running in its place; workers keep going.
    stop: async () => {
      const card = loadHydra({ hydraId }).state.cards[HYDRA_CARD]

      if (activeCompaction({ card })) {
        return host.compact({ card: HYDRA_CARD })
      }

      const upgrade = upgrades.stop()

      if (upgrade === 'restarting') {
        return { stopped: 'none: Pnyx is restarting after the upgrade and comes back in a few seconds' }
      }

      if (upgrade) {
        return { stopped: 'upgrade' }
      }

      const entry = card?.agent?.host === 'pnyx' ? live.get(sessionId({ agent: card.agent })) : undefined

      if (!entry?.session || entry.activity !== 'working') {
        return { stopped: 'none: Hydra is not working on a turn' }
      }

      entry.stopping = true
      await entry.session.interrupt()

      return { stopped: 'hydra' }
    },
    // Hydra's context window and spend, and its account's plan windows; anything unknown is left out.
    usage: async () => {
      const state = loadHydra({ hydraId }).state
      const agent = state.cards[HYDRA_CARD]?.agent

      if (!agent) {
        return { usage: 'none: Hydra has not started a session' }
      }

      const harness: Harness = agent.provider === 'codex' ? 'codex' : 'claude'
      const effective = effectiveDispatch({
        hydraId,
        state,
      })
      const name = harnessAccount({
        effective,
        harness,
        prefer: agent.account,
      })
      const account = name ? effective.accounts[name] : undefined
      const plan = await readUsage({
        account: account ?? {
          provider: harness,
          folder: agent.loginFolder ?? defaultLogin({ provider: harness }),
        },
      })

      // What the agent reported wins until its window resets; quota-axi fills the rest.
      const {
        limits = [],
        plan: reported,
        ...session
      } = usages.get(sessionId({ agent })) ?? {}
      const windows = mergeWindows({
        base: plan?.windows ?? [],
        over: limits.filter(limit => !limit.resetsAt || Date.parse(limit.resetsAt) > Date.now()),
      })
      const planName = reported ?? plan?.plan
      const helperUsage = state.helper?.usage
      const completeHelperCost = helperUsage && helperUsage.measuredBatches === helperUsage.batches
        ? helperUsage.cost : undefined

      return {
        harness,
        ...(name ? { account: name } : {}),
        ...session,
        ...(helperUsage ? { helper: helperUsage } : {}),
        ...(session.cost !== undefined && completeHelperCost !== undefined ? {
          combinedCost: session.cost + completeHelperCost,
        } : {}),
        ...(planName ? { plan: planName } : {}),
        ...(windows.length ? { windows } : {}),
      }
    },
    start: async ({
      task,
      prompt,
      folder,
      settings,
      id,
      actor,
      reason,
      replacement,
      dispatch,
    }) => {
      const {
        target,
        duplicate,
      } = write({
        fn: ({ writer }) => {
          const target = findCard({
            state: writer.state,
            ref: task,
          })
          const duplicate = `${id}:attach` in writer.state.eventIds

          if (!duplicate) {
            startTarget({
              writer,
              ref: task,
              replacement,
            })
          }

          return {
            target,
            duplicate,
          }
        },
      })

      if (duplicate) {
        return {
          task: target.id,
          event: 'none: duplicate',
          help: ['This start was already recorded; nothing was started again'],
        }
      }

      if (starting.has(target.id)) {
        throw new HydraError({
          message: `task ${target.id} is already starting`,
          code: 'SESSION_CONFLICT',
        })
      }

      const cwd = folder ?? target.folder

      if (!cwd || !isFolder({ path: cwd })) {
        throw new HydraError({
          message: cwd ? `folder not found: ${cwd}` : 'choose the folder the agent works in',
          code: 'VALIDATION_ERROR',
          help: ['Pass --folder <absolute path>'],
        })
      }

      const provider = settings.provider ?? 'claude-code'
      const {
        provider: _provider,
        ...options
      } = settings
      void _provider
      settings = options
      starting.add(target.id)
      let session: HostedSession | undefined

      try {
        const prepared = await providerOf({ provider }).open({
          cwd,
          settings,
          allow: WORKER_COMMANDS,
          env: dispatch ? accountEnvironment({
            account: {
              provider: dispatch.provider,
              folder: dispatch.folder,
            },
            env: environment({
              task: target.id,
              steeringWorker: `${id}:session`,
            }),
          }) : environment({
            task: target.id,
            steeringWorker: `${id}:session`,
          }),
          signal: controller.signal,
        })
        session = prepared

        if (closing) {
          throw new Error('Pnyx is stopping')
        }

        const claimed = write({
          fn: ({ writer }) => {
            const card = findCard({
              state: writer.state,
              ref: task,
            })

            if (`${id}:attach` in writer.state.eventIds) {
              return {
                card,
                duplicate: true as const,
              }
            }

            startTarget({
              writer,
              ref: task,
              replacement,
            })

            if ((folder ?? card.folder) !== cwd) {
              throw new HydraError({
                message: 'the task folder changed while its agent was starting; retry the start',
                code: 'CONFLICT',
              })
            }

            if (!isFolder({ path: cwd })) {
              throw new HydraError({
                message: cwd ? `folder not found: ${cwd}` : 'choose the folder the agent works in',
                code: 'VALIDATION_ERROR',
                help: ['Pass --folder <absolute path>'],
              })
            }

            const meta = {
              at: at(),
              actor,
              ...(reason ? { reason } : {}),
            }

            if (replacement) {
              apply({
                writer,
                decision: decideSession({
                  state: writer.state,
                  ref: replacement,
                  task: null,
                  meta: {
                    ...meta,
                    id: `${id}:detach`,
                  },
                }),
              })
            }

            // A marker left by an earlier agent belongs to it, not to the one starting now.
            const attention = card.attention.filter(a => a.key !== INTERRUPTED)
            const input = {
              ...(cwd !== card.folder ? { folder: cwd } : {}),
              ...(attention.length !== card.attention.length ? { attention } : {}),
            }

            if (Object.keys(input).length) {
              apply({
                writer,
                decision: decidePush({
                  state: writer.state,
                  key: card.key,
                  input,
                  meta: {
                    ...meta,
                    id: `${id}:folder`,
                  },
                }),
              })
            }

            const agent: AgentRef = {
              provider,
              sessionId: prepared.id,
              cwd,
              ...(prepared.path ? { transcriptPath: prepared.path } : {}),
              host: 'pnyx',
              ...(dispatch ? {
                account: dispatch.account,
                loginFolder: dispatch.folder,
              } : {}),
            }
            apply({
              writer,
              decision: decidePush({
                state: writer.state,
                key: sessionKey({ agent }),
                input: {
                  title: card.title,
                  agent,
                  ...(Object.keys(settings).length ? { settings } : {}),
                  activity: 'working',
                  source: {
                    adapter: 'pnyx',
                    objectId: agent.sessionId,
                    observedAt: meta.at,
                  },
                },
                meta: {
                  ...meta,
                  id: `${id}:session`,
                },
              }),
            })
            apply({
              writer,
              decision: decideSession({
                state: writer.state,
                ref: sessionId({ agent }),
                task: card.id,
                working: true,
                meta: {
                  ...meta,
                  id: `${id}:attach`,
                },
              }),
            })

            if (dispatch) {
              apply({
                writer,
                decision: hydraEvent({
                  state: writer.state,
                  meta: {
                    ...meta,
                    id: `${id}:dispatch`,
                  },
                  cardId: card.id,
                  change: {
                    type: 'task.launched',
                    data: {
                      via: 'pnyx',
                      at: meta.at,
                      folder: cwd,
                      harness: dispatch.provider,
                      dispatch: dispatch.reason,
                      ...(dispatch.override ? { override: dispatch.override } : {}),
                    },
                  },
                }),
              })
            }

            const started = writer.state.cards[card.id] as Card & { agent: AgentRef }

            return {
              card: started,
              duplicate: false as const,
            }
          },
        })

        if (claimed.duplicate) {
          session.close()

          return {
            task: claimed.card.id,
            event: 'none: duplicate',
            help: ['This start was already recorded; nothing was started again'],
          }
        }

        const entry = open({
          card: claimed.card,
          session,
        })
        entry.activity = 'working'
        entry.sentAt = Date.now()
        entry.input.push({ text: prompt })

        return {
          task: claimed.card.id,
          agent: {
            harness: provider === 'codex' ? 'codex' : 'claude',
            session: claimed.card.agent.sessionId,
            folder: claimed.card.agent.cwd,
            host: 'pnyx',
          },
          help: [`Run \`pnyx-axi reply ${claimed.card.id} --text <text>\` to continue; the Pnyx server runs the agent`],
        }
      } catch (error) {
        session?.close()
        throw error
      } finally {
        starting.delete(target.id)
      }
    },

    continue: ({
      task,
      id,
      actor,
      reason,
      check,
    }) => write({
      fn: ({ writer }) => {
        const card = findCard({
          state: writer.state,
          ref: task,
        })

        requireUnheld({ card })

        if (!check && `${id}:continue` in writer.state.eventIds) {
          return {
            task: card.id,
            event: 'none: duplicate',
          }
        }

        const session = outsideSession({
          writer,
          card,
        })
        const agent = session.agent

        const current = presence({ session })

        if (check) {
          return {
            task: card.id,
            canContinue: current.state === 'gone',
            folderMissing: !agent.cwd || !isFolder({ path: agent.cwd }),
            ...current,
          }
        }

        requireGone({ current })

        const cwd = folderOf({
          card: {
            ...card,
            agent,
          },
        })
        const meta = {
          at: at(),
          actor,
          ...(reason ? { reason } : {}),
        }
        apply({
          writer,
          decision: decidePush({
            state: writer.state,
            key: card.key,
            input: {
              agent: {
                ...agent,
                host: 'pnyx',
                resume: true,
                ...(agent.provider === 'claude-code' && !agent.transcriptPath ? {
                  transcriptPath: transcriptPath({
                    cwd,
                    session: agent.sessionId,
                  }),
                } : {}),
              },
              terminal: {},
              activity: 'finished',
              source: {
                adapter: 'pnyx',
                objectId: agent.sessionId,
                observedAt: meta.at,
              },
              attention: card.attention.filter(a => !a.key.startsWith('hook:')),
            },
            meta: {
              ...meta,
              id: `${id}:continue`,
            },
          }),
        })

        if (card.outcome?.source === 'hooks') {
          apply({
            writer,
            decision: decideOutcome({
              state: writer.state,
              ref: card.id,
              outcome: null,
              source: 'hooks',
              meta: {
                ...meta,
                id: `${id}:outcome`,
              },
            }),
          })
        }

        if (card.status?.state !== 'done') {
          apply({
            writer,
            decision: declareTask({
              state: writer.state,
              ref: card.id,
              status: 'working',
              note: 'Worker continued in Pnyx',
              meta: {
                ...meta,
                id: `${id}:working`,
              },
            }),
          })
        }

        return {
          task: card.id,
          agent: {
            harness: agent.provider === 'codex' ? 'codex' : 'claude',
            session: agent.sessionId,
            folder: agent.cwd,
            host: 'pnyx',
          },
          help: [`Send a message with \`pnyx-axi reply ${card.id} --text <text>\` to resume the session in Pnyx`],
        }
      },
    }),

    send,

    permission: ({
      task,
      request: id,
      choice,
      answer,
      actor,
      reason,
      details,
    }) => {
      const why = explained({
        meta: {
          at: at(),
          actor,
          reason,
        },
      })
      const waiting = pending.get(id)
      const result = write({
        fn: ({ writer }) => {
          const card = findCard({
            state: writer.state,
            ref: task,
          })
          const request = card.permissions?.find(p => p.id === id)

          if (!request) {
            throw new HydraError({
              message: `permission request not found: ${id}`,
              code: 'NOT_FOUND',
            })
          }

          if (request.status !== 'pending') {
            throw new HydraError({
              message: `permission request is already ${request.status}`,
              code: 'PERMISSION_CLOSED',
            })
          }

          // A question or form is the worker asking; the helper leaves its answer to main or the owner.
          if (isHelper({ actor }) && (!helperPermission({ request }) || answer !== undefined)) {
            throw new HydraError({
              message: 'This request asks a question; leave it to the main Hydra',
              code: 'MAIN_ONLY',
            })
          }

          // Hydra runs pnyx-axi unasked, so it must not clear its own prompts with it.
          if (card.id === HYDRA_CARD && actor === HYDRA_ACTOR) {
            throw new HydraError({
              message: 'Hydra cannot answer its own permission request',
              code: 'NO_ROUTE',
              help: ['The owner answers it in Hydra’s chat'],
            })
          }

          if (!waiting || waiting.card !== card.id || card.agent?.host !== 'pnyx' || sessionId({ agent: card.agent }) !== request.session) {
            writer.append({
              event: permissionEvent({
                state: writer.state,
                card,
                request: {
                  ...request,
                  status: 'expired',
                },
                meta: {
                  at: at(),
                  actor: 'pnyx',
                },
              }),
            })

            return { expired: true as const }
          }

          const answered = choice === 'allow' && (request.questions || request.form || answer !== undefined)
            ? permissionAnswer({
              request,
              value: answer,
            })
            : {}
          const recorded = answered.answers
            ? {
              answers: answered.answers.map((
                picked,
                i,
              ) => request.questions?.[i]?.secret ? ['(hidden)'] : picked),
            }
            : answered
          writer.append({
            event: permissionEvent({
              state: writer.state,
              card,
              request: {
                ...request,
                status: choice,
                ...recorded,
              },
              meta: {
                at: at(),
                actor,
                reason: why,
                details,
              },
            }),
          })

          return {
            expired: false as const,
            answered,
            receipt: {
              task: card.id,
              request: id,
              status: choice,
              ...recorded,
            },
          }
        },
      })

      if (result.expired) {
        waiting?.finish({
          result: {
            behavior: 'deny',
            message: 'This permission request expired.',
          },
        })
        throw new HydraError({
          message: 'the agent no longer waits for this request',
          code: 'PERMISSION_CLOSED',
        })
      }

      waiting?.finish({
        result: choice === 'allow' ? {
          behavior: 'allow',
          ...result.answered,
        } : {
          behavior: 'deny',
          message: why || 'Permission denied from Pnyx.',
        },
      })

      return result.receipt
    },

    set: async ({
      card: ref,
      setting,
      value,
      actor,
    }) => {
      const card = write({
        fn: ({ writer }) => {
          const card = hosted({
            writer,
            ref,
          })
          const controls = harnessControls({
            provider: card.agent.provider,
            hosted: true,
          })
          const control = controls?.controls.find(c => c.setting === setting)

          if (!control || !control.options.some(o => o.value === value)) {
            throw new HydraError({
              message: `${setting} cannot be ${value}`,
              code: 'VALIDATION_ERROR',
            })
          }

          record({
            writer,
            agent: card.agent,
            input: { settings: { [setting]: value } },
            actor,
          })

          return card
        },
      })
      const key = sessionId({ agent: card.agent })
      const running = live.get(key)

      if (!running) {
        return
      }

      try {
        if (!running.session) {
          throw new Error('Provider is still loading')
        }

        await running.session.set({
          setting,
          value,
        })
      } catch {
        // Some settings require replacing the process after its native work settles.
        running.stale = true

        const settled = running.session && nativeIdle({ work: running.session.snapshot().work })

        if (running.activity !== 'working' && settled) {
          retire({
            key,
            entry: running,
          })
        }
      }
    },

    unconfirmed: ({
      card,
      reply,
      text,
    }) => {
      unconfirmedReplies.set(
        `unconfirmed:${card}:${reply}`,
        {
          card,
          kind: 'not confirmed',
          detail: `the message "${clip({
            text,
            size: UNCONFIRMED_QUOTE_CHARS,
          })}" never showed up in the worker's session after ${MAX_RESENDS} resends`,
        },
      )
    },

    wake: ({
      seq,
      card,
      reasons,
      event,
    }) => {
      wakeStart ??= seq - 1
      wakeReasonsAt.set(
        seq,
        reasons,
      )
      wakeThrough = Math.max(
        wakeThrough,
        seq,
      )

      if (!updates.some(update => update.seq === seq)) {
        const state = loadHydra({ hydraId }).state
        const kinds = event ? eventReasons({
          state,
          event,
        }).map(reason => reason.kind) : []
        const report = event?.type === 'hydra.message'
        updates.push({
          seq,
          card: report ? event.data.task ?? card : card,
          kind: report ? event.data.kind ?? 'report' : [...new Set(kinds)].join(', ') || 'update',
        })
        queued()
      }

      armWake()
    },

    unread: ({ seq }) => {
      wakeStart ??= seq - 1
    },

    queue: () => {
      const state = loadHydra({ hydraId }).state

      return {
        waiting: [
          ...updates.filter(update => update.seq > readThrough),
          ...(state.upgrades ?? []).filter(operation => operation.state === 'queued').map(operation => ({
            seq: state.eventIds[`${operation.id}:hosted`] ?? state.seq,
            card: HYDRA_CARD,
            kind: 'upgrade',
          })),
        ],
        reading: updates.filter(update => update.seq <= readThrough),
      }
    },

    action: ({
      card,
      action,
    }) => {
      const entry = card.agent && live.get(sessionId({ agent: card.agent }))

      if (entry?.activity === 'working' && entry.thinking.size && !entry.tools.size) {
        return {
          calls: [],
          done: false,
          thinking: true,
        }
      }

      return action
    },

    thread: ({
      card,
      page,
    }) => {
      const entry = card.agent && live.get(sessionId({ agent: card.agent }))

      return entry ? entry.replies.page({ page }) : page
    },

    reconcile: ({ state }) => {
      syncCompactions({ state })

      for (const [
        id,
        waiting,
      ] of pending) {
        const card = state.cards[waiting.card]
        const request = card?.permissions?.find(p => p.id === id)

        if (!request || request.status !== 'pending' || card?.agent?.host !== 'pnyx' || sessionId({ agent: card.agent }) !== request.session) {
          expire({ id })
        }
      }

      for (const card of Object.values(state.cards)) {
        const assignment = steeringAssignment({ card })
        const previous = observedAssignments.get(card.id)
        observedAssignments.set(
          card.id,
          assignment,
        )

        if (!previous || previous === assignment || !liveTask({ card })
          || card.id === HYDRA_CARD || card.agent?.host !== 'pnyx' || steeringHeld({ card })) {
          continue
        }

        const oldest = pendingSteering({ card })[0]

        if (!oldest) {
          continue
        }

        try {
          send({
            card: card.id,
            text: '',
            actor: 'pnyx',
            steering: oldest.id,
            attempt: `reconcile:${card.id}:${state.seq}`,
          })
        } catch (error) {
          console.error(`pnyx-axi serve: ${card.id} inbox assignment could not resume: ${(error as Error).message}`)
        }
      }
    },

    recover: async () => {
      upgrades.recover()
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

            if (operation) {
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

          for (const card of Object.values(writer.state.cards)) {
            for (const request of card.permissions ?? []) {
              if (request.status === 'pending' && !pending.has(request.id)) {
                writer.append({
                  event: permissionEvent({
                    state: writer.state,
                    card,
                    request: {
                      ...request,
                      status: 'expired',
                    },
                    meta: {
                      at: at(),
                      actor: 'pnyx',
                    },
                  }),
                })
              }
            }
          }

          for (const session of Object.values(writer.state.sessions ?? {})) {
            const wasWorking = (session.sessionActivity ?? session.activity) === 'working'

            if (session.agent.host !== 'pnyx' || live.has(session.id) || !wasWorking) {
              continue
            }

            let resumeAttemptId: string | undefined
            const task = session.taskId ? writer.state.cards[session.taskId] : undefined

            if (!cutCompactions.has(session.id) && session.id === writer.state.config?.hydra.session
              && hostedHydra({ state: writer.state })) {
              cutHydraTurn = findHydraTurnToResume({
                hydraId,
                state: writer.state,
                agent: session.agent,
              })

              if (cutHydraTurn) {
                resumeAttemptId = cutHydraTurn.resumeAttemptId
              }
            } else if (!cutCompactions.has(session.id) && task && liveTask({ card: task })
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

      if (cutHydraTurn) {
        await host.hydra({
          id: cutHydraTurn.resumeAttemptId,
          text: cutHydraTurn.resumeMessage,
          actor: 'pnyx',
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
          console.error(`pnyx-axi serve: ${cut.task} could not resume: ${(error as Error).message}`)
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

      await helper.recover()

      for (const card of Object.values(loadHydra({ hydraId }).state.cards)) {
        if (card.compaction?.inputs.length) {
          releaseCompact({ card: card.id })
        }
      }

      upgrades.release()

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
          wakeStart = after
          readThrough = after
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
            host.wake({
              seq: event.seq,
              card: event.cardId,
              reasons,
              event,
            })
          }
        }
      }
    },

    close: () => {
      closing = true
      helper.close()
      clearTimeout(wakeTimer)
      clearTimeout(retryTimer)
      clearInterval(stallTimer)
      controller.abort()

      for (const [
        key,
        entry,
      ] of live) {
        retire({
          key,
          entry,
        })
      }
    },
  }

  return host
}
