import { agentChangeKind, conversationContext, createAgentSwitch } from '#hydra/agent-switch.ts'
import { accountFor, harnessAccount } from '#workers/account-choice.ts'
import { agentInput } from './agent-input.ts'
import { agentPermissionNeedsOwner } from '#workers/permission-level.ts'
import { hydraActor } from './request-context.ts'
import { agentSettings, hydraCandidate } from '#hydra/agent-choice.ts'
import { HYDRA_COMMANDS } from './command-registry.ts'
import { PROVIDERS, harnessOf, knownProvider, providerIdOf, providerLabel } from '#workers/providers.ts'
import { nativeIdle } from '#workers/native-session.ts'
import { memoryConditions } from '#memory/conditions.ts'
import { background } from './background.ts'
import { decideReply } from '#workers/reply-rules.ts'
import { activeCompaction, compactCommand } from '#workers/compaction/state.ts'
import { recordCompaction } from '#workers/compaction/record.ts'
import { upgradeCommand, restartCommand } from '#upgrade/model.ts'
import { upgradeQueue } from '#upgrade/queue.ts'
import { requestRestart } from '#upgrade/restart.ts'
import { trackChildren } from '#workers/children.ts'
import { pendingSteering, steeringWorkerIdentity, steeringHeld } from '#workers/steering.ts'
import { steeringMessages } from '#workers/inbox-notice.ts'
import { createRoutineHelper } from '#routine-helper/runner.ts'
import { helperAgent } from '#routine-helper/route.ts'
import { activeHelperBatches, failedBatches, helperLeases, outcomeLines, ownerOutcomes, type HelperAgent } from '#routine-helper/state.ts'
import { taskMention } from '#hydra/mentions.ts'
import { setupCheck, setupDigest } from '#setup/check.ts'
import { projectDigest } from '#projects/context.ts'
import { accountEnv, accountEnvironment, agentExhausted } from '#workers/dispatch.ts'
import { defaultLogin, effectiveDispatch, loginFolder, type EffectiveDispatch } from '#workers/dispatch-config.ts'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { claudeProvider, type QueryFn } from '#workers/claude.ts'
import { codexProvider, type SpawnCodex } from '#workers/codex.ts'
import { createUsageTracker } from '#workers/usage-tracker.ts'
import { createPermissionBridge } from '#workers/permission-bridge.ts'
import { hydraFastReaches, type HostedSession } from '#workers/provider.ts'
import { liveReplies } from '#workers/streaming.ts'
import { copyTagged } from '#workers/tagged-updates.ts'
import { terminalPresence, type Presence } from '#workers/presence.ts'
import { harvestTranscripts } from '#integrations/hooks/harvest.ts'
import { MAX_RESENDS } from '#workers/reply-retry.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
import { permissionEvent } from '#workers/permission-rules.ts'
import { declareTask } from '#tasks/declarations.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { QUIET_REPLY, hostedHydra, hydraEvent, pnyxRunsHydra, reportActor } from '#hydra/hydra.ts'
import { hydraConfig } from '#hydra/config.ts'
import { wakeReasons } from '#hydra/wake-reasons.ts'
import { clip, hydraDigest } from '#hydra/digest.ts'
import { ownerMemory } from '#memory/owner-memory.ts'
import { prepareHydraFolder } from '#setup/skills.ts'
import type { HydraState } from './model.ts'
import { decidePush } from '#tasks/push.ts'
import { findCard } from '#tasks/push-rules.ts'
import { HYDRA_ACTOR, ownerActor } from './actors.ts'
import { HydraError } from '#store/errors.ts'
import type { Card } from '#tasks/model.ts'
import type { AgentRef, AgentSession, Attention } from '#workers/model.ts'
import type { HydraAgentChange, HydraMessage } from '#hydra/model.ts'
import { harnessControls } from '#workers/controls.ts'
import { liveTask } from '#tasks/select.ts'
import { INTERRUPTED, sessionId, withoutInterrupted } from '#workers/session-attachments.ts'
import { hydraAgentFolder } from './home-migration.ts'
import { loadHydra } from './store.ts'
import { readEvents } from './event-log.ts'
import { withWriter, type Writer } from './writer.ts'
import { pnyxHome } from '#store/storage.ts'
import type { Host, Live } from './host-types.ts'
import { HYDRA_TURN_POLL_MS, IDLE_MS, WAKE_MS, STALL_MS, BUSY_MS, PAUSE_MS, STALL_REPEAT_MAX_MS, UNCONFIRMED_QUOTE_CHARS, WORKER_RESUME, WORKER_COMMANDS, INHERITED, sameChosenSettings, steeringAssignment, findWorkerTurnToResume } from '#workers/host.ts'
import { isFolder } from '#workers/folders.ts'
import { createCatalogs } from '#workers/model-catalog.ts'
import { WAKE_TURN, WAKE_HANDLED, REPLY_RULES, sealed, wakesThrough, wakeCursor, findHydraTurnToResume } from '#hydra/wakes.ts'
import { createStallChecks } from '#hydra/stalls.ts'
import { createWakeQueue } from '#hydra/wake-queue.ts'
import { createWorkerStarts } from '#workers/hosted-start.ts'
import { createHostedDelivery } from '#workers/hosted-delivery.ts'
import { createHydraOperations, createHydraOutage, operationEvent } from '#hydra/operations.ts'
import { COMPACTION_DEADLINE_MS, createCompactionControl } from '#workers/compaction/control.ts'
import { createSteeringDelivery } from '#workers/steering-delivery.ts'
import { inbox } from '#hydra/update-queue.ts'
import { applyDecision } from './decision.ts'

export type { QueryFn } from '#workers/claude.ts'

// After a failed start Pnyx tries again after each of these waits, then every last one, until a start works.
const RETRY_MS = [
  60_000,
  120_000,
  300_000,
  600_000,
]

// Every Hydra this server runs answers whether one of its agents is mid-turn, so an upgrade restarts between turns.
const midTurnChecks = new Set<() => boolean>()

export const agentsMidTurn = () => [...midTurnChecks].some(check => check())

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
  compactionDelay = COMPACTION_DEADLINE_MS,
  retryDelays = RETRY_MS,
  helperBound,
  upgradeRoot,
  restart = requestRestart,
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
  compactionDelay?: number
  retryDelays?: number[]
  helperBound?: number
  // The Pnyx folder /upgrade pulls into, and how the server restarts after it; tests pass their own.
  upgradeRoot?: string
  restart?(): void | Promise<void>
}): Host {
  const providers = {
    [PROVIDERS.claude.provider]: claudeProvider({ query }),
    [PROVIDERS.codex.provider]: codexProvider({ spawnCodex }),
  }
  const children = trackChildren({ hydraId })
  const controller = new AbortController()
  const live = new Map<string, Live>()
  const midTurn = () => [...live.values()].some(entry => entry.activity === 'working')
  midTurnChecks.add(midTurn)
  const observedAssignments = new Map(Object.values(loadHydra({ hydraId }).state.cards)
    .map(card => [
      card.id,
      steeringAssignment({ card }),
    ]))
  const usageTracker = createUsageTracker({
    hydraId,
    streamed,
  })

  let closing = false
  let hydraTurn = Promise.resolve()
  const queuedHydra = new Set<string>()

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

  const sessionKey = ({ agent }: { agent: AgentRef }) => `${harnessOf({ provider: agent.provider })}:${agent.sessionId}`

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

      // Only the restart stops Hydra, of a /restart or of a built upgrade; the end recaps what waited.
      if (operation.state === 'restarting') {
        startOperation({
          id: operation.id,
          kind: operation.steps.some(step => step.step !== 'restart') ? 'upgrade' : 'restart',
        })
      } else if (![
        'queued',
        'running',
        'waiting',
      ].includes(operation.state)) {
        endOperation({
          id: operation.id,
          error: operation.state === 'done' ? undefined : operation.error ?? `upgrade ${operation.state}`,
        })
      }
    },
    midTurn: agentsMidTurn,
    closing: () => closing,
    restart,
    at,
  })

  const {
    stoppedFor,
    startOperation,
    endOperation,
  } = createHydraOperations({
    hydraId,
    queuedHydra,
    at,
    // Defined below; each is read only once an operation runs.
    note: ({ fn }) => note({ fn }),
    armWake: () => armWake(),
    host: () => host,
  })

  const compaction = createCompactionControl({
    hydraId,
    compactionDelay,
    queuedHydra,
    closing: () => closing,
    at,
    write,
    // Defined below; read when a held message is released.
    send: ({ ...input }) => send(input),
    host: () => host,
    helperPending: () => helperPending(),
    statusChanged: ({
      card,
      operation,
    }) => {
      if (card !== HYDRA_CARD) {
        return
      }

      if (operation.state === 'running') {
        startOperation({
          id: operation.id,
          kind: 'compaction',
        })
      }
    },
    // Hydra is back once its compactions settle, including one that followed straight after.
    released: ({ card }) => {
      const state = loadHydra({ hydraId }).state
      const running = state.hydraOperation
      const last = state.cards[HYDRA_CARD]?.compaction?.operations.at(-1)

      const native = state.cards[HYDRA_CARD]?.compaction?.operations
        .find(operation => operation.id === running?.id)

      if (card !== HYDRA_CARD || running?.kind !== 'compaction' || !native || native.state === 'running') {
        return
      }

      endOperation({
        id: running.id,
        error: !last || last.state === 'done' ? undefined : last.error ?? `compaction ${last.state}`,
      })
    },
  })
  const {
    compactChange,
    holdCompact,
    releaseCompact,
    sessionOwner,
    settleCompaction,
    syncCompactions,
  } = compaction

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

    applyDecision({
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
    // A turn Pnyx resumes is not reported as stopped; its card asks only when the resume is not sent or cannot reopen.
    const resuming = Boolean(resumeAttemptId)
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

    if (task && !resuming) {
      const attention: Attention[] = [
        {
          kind: 'interrupted',
          key: INTERRUPTED,
          blocking: true,
          text: note,
        },
        ...task.attention.filter(a => a.key !== INTERRUPTED),
      ]
      applyDecision({
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

  const digest = async ({ remember = true }: { remember?: boolean } = {}) => {
    const owner = ownerMemory()
    const state = loadHydra({ hydraId }).state
    const [
      projects,
      items,
    ] = await Promise.all([
      projectDigest({ state }),
      setupCheck({
        hydraId,
        state,
      }),
    ])

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
      setup: setupDigest({ items }),
    })
  }

  const memoryChangeNote = async () => {
    const owner = ownerMemory()
    const state = loadHydra({ hydraId }).state
    const stamp = JSON.stringify({
      owner,
      hydra: state.hydraMemory,
      projects: await projectDigest({ state }),
    })
    const changed = memoryStamp !== undefined && memoryStamp !== stamp
    memoryStamp = stamp

    return changed ? ' Memory changed; load owner memory with owner memory list, Hydra memory with hydra memory list or project memory with project show <name|path> when needed.' : ''
  }

  // Hydra runs Pnyx's own CLI without asking; every other prompt waits in Hydra's chat.
  const hydraSession = ({ history = false }: { history?: boolean } = {}) => {
    let contextSent = false

    return {
      instructions: hydraInstructions(),
      allow: HYDRA_COMMANDS,
      context: async () => {
        const state = loadHydra({ hydraId }).state
        const conversation = history && !contextSent ? conversationContext({
          hydraId,
          state,
        }) : ''
        contextSent = true

        const memory = await digest()

        return conversation ? memory.replace(
          '</pnyx-digest>',
          `\nConversation context:\n${sealed({ text: conversation })}\n</pnyx-digest>`,
        ) : memory
      },
    }
  }

  const providerOf = ({ provider }: { provider: string }) => {
    const known = knownProvider({ name: provider })

    if (!known) {
      throw new HydraError({
        message: `unsupported hosted provider: ${provider}`,
        code: 'VALIDATION_ERROR',
      })
    }

    return providers[known]
  }

  const {
    expireEntry,
    askPermission,
    permission,
    reconcilePermissions,
    expireOrphans,
  } = createPermissionBridge({
    hydraId,
    live,
    closing: () => closing,
    at,
    write,
    note,
  })

  const {
    pendingSteeringIds,
    inboxNotice,
    unnotifiedSteering,
    markRead,
    ringSteering,
  } = createSteeringDelivery({
    hydraId,
    at,
    write,
    note,
  })

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
      entry.session ??= await providerOf({ provider: card.agent.provider }).open({
        cwd: folderOf({ card }),
        agent: card.agent,
        settings: card.settings ?? {},
        ...(card.id === HYDRA_CARD ? hydraSession() : { allow: WORKER_COMMANDS }),
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
            while (!closing && live.get(key) === entry && turnRunning) {
              await new Promise(resolve => setTimeout(
                resolve,
                HYDRA_TURN_POLL_MS,
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
        if (closing && typeof received === 'object' && received.type === 'turn-ended' && received.outcome.status !== 'completed') {
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

        if (entry.replaced || !closing && live.get(key) !== entry) {
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
            const texts = entry.replies.texts()
            const asks = answering
            note({
              fn: ({ writer }) => copyTagged({
                writer,
                texts,
                asks,
                at: at(),
                turn: entry.session?.snapshot().outcome?.turn,
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
            turnEnded({ activity })
          }

          note({
            fn: ({ writer }) => {
              const handledThrough = wakesThrough({
                state: writer.state,
                pattern: WAKE_HANDLED,
              })
              // The wake this turn read counts as handled only now that the turn finished.
              const handledWake = card.id === HYDRA_CARD && activity === 'finished' && readThrough() > handledThrough
              let eventId: string | undefined

              if (handledWake) {
                eventId = `wake:${readThrough()}:handled`
              }

              if (card.id === HYDRA_CARD && activity === 'finished') {
                const batches = [...helperBatchesPresented]

                if (batches.length || outcomesPresented > (writer.state.helper?.delivered ?? 0)) {
                  applyDecision({
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

    // A session that ended before confirming a direct input: an input the agent took may have arrived; one it never took did not.
    if (!closing && !entry.replaced) {
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
      handBack()
    } else if (card.id === HYDRA_CARD) {
      finishReading()
    }

    if (!closing && entry.activity === 'working') {
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

  const {
    directReply,
    settleDirect,
    send,
  } = createHostedDelivery({
    live,
    at,
    write,
    note,
    hosted,
    folderOf,
    record,
    holdCompact,
    open,
    ringSteering,
    unnotifiedSteering,
  })

  const helperFailed = ({ state }: { state: HydraState }) => Object.values(state.helper?.runs ?? {})
    .some(batch => batch.error)

  const helperPending = () => {
    const state = loadHydra({ hydraId }).state

    return outcomeLines({ state }).length > 0 || helperFailed({ state })
  }

  // No helper agent when it is off or its account is no longer registered, so main takes the updates and no other login is used.
  const usableHelper = ({
    state,
    effective,
  }: {
    state: HydraState
    effective?: EffectiveDispatch
  }) => {
    const candidate = helperAgent({
      state,
      main: effective && hydraCandidate({
        state,
        dispatch: effective.dispatch,
      }),
    })

    if (candidate?.account === undefined) {
      return candidate
    }

    const known = effective ?? effectiveDispatch()

    return known.accounts[candidate.account]?.provider === candidate.harness ? candidate : undefined
  }

  // A failed batch sends routine work to main until main has seen the failure.
  const helperOpen = ({ state }: { state: HydraState }) => !!usableHelper({ state })
    && !helperFailed({ state })

  const {
    back,
    takeRecap,
    startFailed,
    planRetry,
    close: stopRetry,
  } = createHydraOutage({
    hydraId,
    retryDelays,
    closing: () => closing,
    at,
    write,
    record,
    host: () => host,
  })

  let outcomesPresented = 0
  const helperBatchesPresented = new Set<string>()
  const helper = createRoutineHelper({
    hydraId,
    spawned: children.spawned,
    provider: ({ harness }) => providers[providerIdOf({ harness })],
    environment: ({
      harness,
      actor,
      account: selectedAccount,
      loginFolder: selectedFolder,
    }) => {
      const env = {
        ...environment({ hydra: true }),
        PNYX_ACTOR: actor,
      }

      if (selectedFolder) {
        return accountEnvironment({
          account: {
            provider: harness,
            folder: selectedFolder,
          },
          env,
        })
      }

      const { account } = accountFor({
        effective: effectiveDispatch(),
        harness,
        prefer: selectedAccount,
      })

      return accountEnv({
        account,
        env,
      })
    },
    context: () => digest({ remember: false }),
    changed: () => {
      changed()
      armWake()
    },
    bound: helperBound,
    agentFor: async () => {
      const state = loadHydra({ hydraId }).state
      const effective = effectiveDispatch()
      const candidate = usableHelper({
        state,
        effective,
      })

      if (!candidate) {
        return undefined
      }

      const {
        name,
        account,
      } = accountFor({
        effective,
        harness: candidate.harness,
        prefer: candidate.account,
      })

      const nativeDefault = defaultLogin({ provider: candidate.harness })
      const folder = account ? loginFolder({ account }) : nativeDefault
      const hydraFast = await hydraFastReaches({
        hydraFast: state.config?.hydra.agent?.fast,
        models: () => host.models({
          harness: candidate.harness,
          account: name,
        }),
        model: candidate.model,
      })
      const agent: HelperAgent = {
        ...candidate,
        account: name,
        loginFolder: folder,
      }

      if (candidate.fast || hydraFast) {
        agent.fast = true
      }

      return agent
    },
    // Defined below, once the helper it offers updates to exists.
    handback: () => armWake(),
    outcomesReady: () => armWake(),
  })

  const {
    mainTasks,
    wakeTasks,
    wakeMain,
    armWake,
    routeUpdates,
    finishReading,
    turnEnded,
    readThrough,
    handBack,
    readWake,
    startFrom,
    wakeStart,
    wake,
    unread,
    queue,
    close: stopWake,
  } = createWakeQueue({
    hydraId,
    wakeDelay,
    live,
    queuedHydra,
    closing: () => closing,
    queued,
    helper,
    helperPending,
    helperOpen,
    host: () => host,
  })

  // A stall or an ended wait makes no event, so it is polled.
  const stalls = createStallChecks({
    hydraId,
    stallDelay,
    busyDelay,
    stallRepeatMax,
    pauseDelay,
    live,
    queuedHydra,
    closing: () => closing,
    helper,
    helperOpen,
    routeUpdates,
    wakeMain,
    wakeStart,
  })
  const catalogs = createCatalogs({
    hydraId,
    providers,
    liveSession: ({ key }) => live.get(key)?.session,
    closing: () => closing,
    environment: () => environment(),
    saveCatalog: ({
      card,
      key,
      commands,
    }) => compactChange({
      card,
      change: {
        kind: 'catalog',
        key,
        commands,
      },
    }),
  })

  const changeAgent = ({ change }: { change: HydraAgentChange }) => write({
    fn: ({ writer }) => applyDecision({
      writer,
      decision: hydraEvent({
        state: writer.state,
        cardId: HYDRA_CARD,
        meta: {
          at: at(),
          actor: 'pnyx',
        },
        change: {
          type: 'hydra.agent-change',
          data: change,
        },
      }),
    }),
  })

  const {
    runAgentChange,
    agentChangeAbort,
  } = createAgentSwitch({
    hydraId,
    controller,
    children,
    live,
    closing: () => closing,
    hydraTurn: () => hydraTurn,
    at,
    write,
    note,
    changeAgent,
    startOperation,
    endOperation,
    retire,
    providerOf,
    digest,
    environment,
    host: () => host,
  })

  const {
    start,
    continueInPnyx,
  } = createWorkerStarts({
    closing: () => closing,
    at,
    write,
    presence,
    providerOf,
    environment,
    controller,
    children,
    open,
    folderOf,
    sessionKey,
  })

  const host: Host = {
    catalogCommands: catalogs.commands,
    models: catalogs.models,
    hydraId,
    hydra: ({
      text,
      original,
      actor,
      id,
      release = false,
      selected,
      history = true,
    }) => {
      if (reportActor({ actor })) {
        changed()

        return Promise.resolve({ state: 'queued' })
      }

      if (ownerActor({ actor }) && restartCommand({ text })) {
        upgrades.restart({ id })
        queued()

        return Promise.resolve({ state: 'queued' })
      }

      if (ownerActor({ actor }) && upgradeCommand({ text })) {
        upgrades.request({ id })
        queued()

        return Promise.resolve({ state: 'queued' })
      }

      // While a restart, an upgrade or a compaction stops Hydra, everything for it waits in its queue; the recap when it ends tells Hydra.
      if (stoppedFor({ id })) {
        queued()

        return Promise.resolve({ state: 'queued' })
      }

      const queuedState = loadHydra({ hydraId }).state
      const queuedDispatch = effectiveDispatch().dispatch
      const desiredAgent = selected ?? (!ownerActor({ actor }) ? queuedState.hydraAgent : undefined)
        ?? hydraCandidate({
          state: queuedState,
          dispatch: queuedDispatch,
        })
      const requestedAgent = {
        ...desiredAgent,
        account: harnessAccount({
          effective: effectiveDispatch(),
          harness: desiredAgent.harness,
          prefer: desiredAgent.account,
        }),
      }
      const deliveryId = release ? `${id}:compact:hosted` : `${id}:hosted`

      if (queuedHydra.has(id)) {
        return Promise.resolve({ state: 'queued' })
      }

      queuedHydra.add(id)
      const turn = hydraTurn.then(async () => {
        if (closing) {
          return { state: 'queued' }
        }

        let state = loadHydra({ hydraId }).state

        if (stoppedFor({ id })) {
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
        const used = state.hydraAgent ?? (previous?.agent ? {
          harness: harnessOf({ provider: previous.agent.provider }),
          account: previous.agent.account ?? harnessAccount({
            effective: effectiveDispatch(),
            harness: harnessOf({ provider: previous.agent.provider }),
          }),
          model: previous.settings?.model,
          effort: previous.settings?.effort,
          mode: previous.settings?.mode,
          fast: previous.settings?.fast === 'true',
        } : undefined)
        const kind = used && agentChangeKind({
          previous: used,
          next: requestedAgent,
        })

        if (used && kind && ownerActor({ actor })) {
          write({
            fn: ({ writer }) => applyDecision({
              writer,
              decision: hydraEvent({
                state: writer.state,
                cardId: HYDRA_CARD,
                meta: {
                  at: at(),
                  actor: 'pnyx',
                },
                change: {
                  type: 'hydra.agent-change',
                  data: {
                    id,
                    previous: used,
                    next: requestedAgent,
                    kind,
                    state: 'requested',
                  },
                },
              }),
            }),
          })
          queued()

          return { state: 'queued' }
        }

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
              applyDecision({
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

          const candidate = requestedAgent
          const {
            name: main,
            account,
          } = accountFor({
            effective: effectiveDispatch(),
            harness: candidate.harness,
            prefer: candidate.account,
          })
          const provider = providerIdOf({ harness: candidate.harness })
          const dispatch = account && main ? {
            account: main,
            provider: account.provider,
            folder: loginFolder({ account }),
          } : undefined
          const settings = agentSettings({ agent: candidate })
          const cwd = hydraAgentFolder({ hydraId })
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
              HYDRA_TURN_POLL_MS,
            ))
          }

          if (closing) {
            throw new Error('Pnyx is stopping')
          }

          state = loadHydra({ hydraId }).state
          card = state.cards[HYDRA_CARD]
          const sameIdentity = history && card?.agent?.provider === provider
            && card.agent.account === main
            && state.hydraContext?.previousSession !== sessionId({ agent: card.agent })
            && card.settings?.model === candidate.model
          const agent = sameIdentity ? card?.agent : undefined
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
              ...hydraSession({ history: history && !agent }),
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
              spawned: children.spawned,
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

              applyDecision({
                writer,
                decision: decidePush({
                  state: writer.state,
                  key: HYDRA_CARD,
                  input: {
                    attention: withoutInterrupted({
                      attention: writer.state.cards[HYDRA_CARD]?.attention ?? [],
                    }),
                  },
                  meta,
                }),
              })
              applyDecision({
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
                      observedAt: at(),
                    },
                  },
                  meta,
                }),
              })
              const current = hydraConfig({
                state: writer.state,
                id: hydraId,
              })
              const delivery = hydraEvent({
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
              })

              applyDecision({
                writer,
                decision: delivery,
              })

              applyDecision({
                writer,
                decision: hydraEvent({
                  state: writer.state,
                  cardId: HYDRA_CARD,
                  meta,
                  change: {
                    type: 'hydra.agent-used',
                    data: requestedAgent,
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
          const memoryNote = waking ? await memoryChangeNote() : ''
          const recap = takeRecap({ id })

          const helperState = loadHydra({ hydraId }).state
          const helperLines = outcomeLines({ state: helperState })
          let helperText = ''
          // Main holds the tasks whose outcomes or hand-backs it is given, as it holds a wake's tasks.
          const presentedTasks = [
            ...ownerOutcomes({ state: helperState }).map(outcome => outcome.task),
            ...failedBatches({ state: helperState }).flatMap(batch => batch.tasks),
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

          const pendingBatches = failedBatches({ state: helperState })

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
          readWake({ id })

          return { state: 'queued' }
        } catch (error) {
          prepared?.close()

          if (closing) {
            return { state: 'failed' }
          }

          return startFailed({
            error,
            previous,
            id,
            actor,
            hydra: config.hydra.id,
          })
        }
      })
      hydraTurn = turn.then(
        () => {},
        () => {},
      ).finally(() => queuedHydra.delete(id))

      return Promise.resolve({ state: 'queued' })
    },
    agentExhausted: async ({ agent }) => {
      const { account } = accountFor({
        effective: effectiveDispatch(),
        harness: agent.harness,
        prefer: agent.account,
      })

      return account ? agentExhausted({
        candidate: agent,
        account,
      }) : false
    },
    changeAgent: runAgentChange,

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
      const changing = agentChangeAbort()

      if (changing) {
        changing.abort(new Error('Compaction cancelled by the owner'))

        return { stopped: 'compaction' }
      }

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
    usageViews: usageTracker.usageViews,
    usage: usageTracker.usage,
    refreshUsage: usageTracker.refreshUsage,
    start,

    continue: continueInPnyx,

    send,

    permission,

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

          if (hydraActor({ actor }) && setting === 'mode' && agentPermissionNeedsOwner({
            card,
            value,
          })) {
            throw new HydraError({
              message: 'Only the owner can raise an agent’s permission level',
              code: 'OWNER_ONLY',
            })
          }

          record({
            writer,
            agent: card.agent,
            input: { settings: { [setting]: value } },
            actor,
          })

          const usedAgent = writer.state.hydraAgent

          // Wakes retain this agent, so permission controls must update its saved mode too.
          if (card.id === HYDRA_CARD && setting === 'mode' && usedAgent && usedAgent.mode !== value) {
            applyDecision({
              writer,
              decision: hydraEvent({
                state: writer.state,
                cardId: HYDRA_CARD,
                meta: {
                  at: at(),
                  actor,
                },
                change: {
                  type: 'hydra.agent-used',
                  data: {
                    ...usedAgent,
                    mode: value,
                  },
                },
              }),
            })
          }

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
      stalls.unconfirmedReplies.set(
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

    wake,

    unread,

    queue,

    action: ({
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

      reconcilePermissions({ state })

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
          run: () => host.hydra({
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
      midTurnChecks.delete(midTurn)
      helper.close()
      stopWake()
      stopRetry()
      stalls.close()
      controller.abort()

      compaction.close()

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
