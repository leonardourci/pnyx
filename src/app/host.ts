import { stopWorkerInputs, unreadOwnerSteering } from '#workers/stop-inputs.ts'
import { stopHydraInputs } from '#hydra/stop-inputs.ts'
import { compactCommand } from '#workers/compact-command.ts'
import { restartCommand, upgradeCommand } from '#upgrade/model.ts'
import { canonical } from '#store/paths.ts'
import { background } from './background.ts'
import { hydraDir } from './home-migration.ts'
import { nativeIdle } from '#workers/native-session.ts'
import { toolInstructions, toolEnvironment } from '#workers/tools.ts'
import { taskLeasePresent } from '#routine-helper/leases.ts'
import { log } from './diagnostics.ts'
import { createAgentSwitch } from '#hydra/agent-switch.ts'
import { accountFor } from '#workers/account-choice.ts'
import { PROVIDERS, harnessOf, knownProvider, providerIdOf, knownHarness } from '#workers/providers.ts'
import { activeCompaction } from '#workers/compaction/state.ts'
import { upgradeQueue } from '#upgrade/queue.ts'
import { requestRestart } from '#upgrade/restart.ts'
import { trackChildren } from '#workers/children.ts'
import { watchAgent } from '#workers/agent-memory.ts'
import { pendingSteering, steeringHeld } from '#workers/steering.ts'
import { createHostedHelper } from '#routine-helper/hosted-helper.ts'
import { agentExhausted, accountEnv } from '#workers/dispatch.ts'
import { effectiveDispatch } from '#workers/dispatch-config.ts'
import { randomUUID } from 'node:crypto'
import { claudeProvider, type QueryFn } from '#workers/claude.ts'
import { codexProvider, type SpawnCodex } from '#workers/codex.ts'
import type { Provider } from '#workers/provider.ts'
import { createUsageTracker } from '#workers/usage-tracker.ts'
import { createPermissionBridge } from '#workers/permission-bridge.ts'
import { terminalPresence, type Presence } from '#workers/presence.ts'
import { MAX_RESENDS } from '#workers/reply-retry.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
import { harvestTranscripts } from '#integrations/hooks/harvest.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { clip } from '#hydra/digest.ts'
import { decidePush } from '#tasks/push.ts'
import { findCard } from '#tasks/push-rules.ts'
import { HYDRA_ACTOR } from './actors.ts'
import { HydraError } from '#store/errors.ts'
import type { Card } from '#tasks/model.ts'
import type { AgentRef, AgentSession, Attention } from '#workers/model.ts'
import type { HydraAgentChange } from '#hydra/model.ts'
import { liveTask } from '#tasks/select.ts'
import { INTERRUPTED, sessionId } from '#workers/session-attachments.ts'
import { loadHydra } from './store.ts'
import { withWriter, type Writer } from './writer.ts'
import { pnyxHome } from '#store/storage.ts'
import type { Host, Live } from './host-types.ts'
import { WAKE_MS, STALL_MS, BUSY_MS, PAUSE_MS, STALL_REPEAT_MAX_MS, UNCONFIRMED_QUOTE_CHARS, INHERITED, untrackedBranches, steeringAssignment, closedTask, closedByWorker, toolApplicationReady } from '#workers/host.ts'
import { isFolder } from '#workers/folders.ts'
import { createCatalogs } from '#workers/model-catalog.ts'
import { createStallChecks } from '#hydra/stalls.ts'
import { createWakeQueue } from '#hydra/wake-queue.ts'
import { createHostRecovery } from './host-recovery.ts'
import { createLiveSessions } from '#workers/live-sessions.ts'
import { createLiveSettings } from '#workers/live-settings.ts'
import { createHydraTurns } from '#hydra/turns.ts'
import { createWorkerStarts } from '#workers/hosted-start.ts'
import { createHostedDelivery } from '#workers/hosted-delivery.ts'
import { createHydraOperations, createHydraOutage } from '#hydra/operations.ts'
import { COMPACTION_DEADLINE_MS, createCompactionControl } from '#workers/compaction/control.ts'
import { createSteeringDelivery } from '#workers/steering-delivery.ts'
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

const pnyxCommand = ({ text }: { text: string }) => compactCommand({ text })
  || restartCommand({ text }) || upgradeCommand({ text })

export function createHost({
  hydraId,
  query,
  spawnCodex,
  changed,
  streamed = () => {},
  usageChanged = () => {},
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
  streamed?({
    session,
    text,
  }: {
    session: string
    text?: boolean
  }): void
  // A login's plan limits changed, so every session's usage view is rebuilt.
  usageChanged?(): void
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
  const toolRetries = new Map<string, NodeJS.Timeout>()
  const toolApplications = new Map<string, {
    revision: string
    attempted: boolean
    attempts: number
    retryAt: number
  }>()

  const toolApplication = ({
    task,
    revision,
  }: {
    task: string
    revision: string
  }) => {
    let application = toolApplications.get(task)

    if (application?.revision !== revision) {
      application = {
        revision,
        attempted: false,
        attempts: 0,
        retryAt: 0,
      }
      toolApplications.set(
        task,
        application,
      )
    }

    return application
  }

  const canRetryTools = ({
    attempts,
    retryAt,
  }: {
    attempts: number
    retryAt: number
  }) =>
    attempts < retryDelays.length && retryAt <= Date.now()
  const midTurn = () => [...live.values()].some(entry => entry.activity === 'working')
  midTurnChecks.add(midTurn)
  // Closed tasks whose agents were already stopped; their failed stops wait for a permanent release.
  const reaped = new Set<string>()
  const observedAssignments = new Map(Object.values(loadHydra({ hydraId }).state.cards)
    .map(card => [
      card.id,
      steeringAssignment({ card }),
    ]))
  const usageTracker = createUsageTracker({
    hydraId,
    streamed,
    usageChanged,
  })

  let closing = false
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

  const folderOf = ({ card }: { card: Card & { agent: AgentRef } }): string => {
    const { cwd } = card.agent

    const released = card.copy?.state === 'removed' && canonical({ path: card.copy.path }) === canonical({ path: cwd })

    if (!cwd || released || !isFolder({ path: cwd })) {
      throw new HydraError({
        message: released ? `the agent's copy ${cwd} was released, so its session cannot continue` : `the agent's folder ${cwd ?? '(none)'} is gone, so its session cannot continue`,
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
    syncCompactions,
  } = compaction

  const record = ({
    writer,
    agent,
    input,
    actor,
    eventId,
    details,
  }: {
    writer: Writer
    agent: AgentRef
    input: Record<string, unknown>
    actor: string
    eventId?: string
    details?: string
  }) => {
    // Sessions may move between tasks while their process keeps running.
    const session = writer.state.sessions?.[sessionId({ agent })]
    const card = session && writer.state.cards[session.taskId ?? session.originCardId]
    const finished = input.activity === 'finished' && card?.sessionActivity !== 'finished'

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
          details,
        },
      }),
    })

    if (finished && card) {
      harvestTranscripts({
        writer,
        cardIds: [card.id],
        at: at(),
      })
    }
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
      log({
        level: 'error',
        operation: 'host.note',
        hydraId,
        error,
      })
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
      ...untrackedBranches({ env: process.env }),
    } : {}),
  })

  const providerOf = ({
    provider,
    taskId,
  }: {
    provider: string
    // The task whose agent this opens, Hydra's own included, for the agent's log lines.
    taskId?: string
  }): Provider => {
    const known = knownProvider({ name: provider })

    if (!known) {
      throw new HydraError({
        message: `unsupported hosted provider: ${provider}`,
        code: 'VALIDATION_ERROR',
      })
    }

    const chosen = providers[known]

    // Every session the server opens, for Hydra, a worker or the helper, logs how long its provider took to start it,
    // and its agent processes are listed with their memory under its ids.
    return {
      ...chosen,
      // eslint-disable-next-line pnyx/object-params -- the provider owns open's options, which pass through whole.
      open: async options => {
        const opening = performance.now()
        const ids: Parameters<typeof watchAgent>[0]['ids'] = {
          hydraId,
          taskId,
        }
        const spawned = options.spawned

        // Without the caller's hook a provider starts its process itself, and nothing is tracked.
        const tracked: typeof spawned = spawned === undefined ? undefined : ({ child }) => {
          spawned({ child })

          if (child.pid !== undefined && taskId) {
            children.associate({
              pid: child.pid,
              task: taskId,
            })
          }

          watchAgent({
            child,
            ids,
          })
        }

        const toolOwner = taskId ? loadHydra({ hydraId }).state.cards[taskId] : undefined
        const inheritsTools = options.capabilities === undefined
        const toolsRevision = inheritsTools ? toolOwner?.toolsRevision : undefined
        const capabilities = options.capabilities ?? toolOwner?.tools ?? []
        const session = await chosen.open({
          ...options,
          capabilities,
          env: toolEnvironment({
            env: options.env,
            tools: capabilities,
            hydraId,
            task: taskId,
          }),
          instructions: [
            options.instructions,
            taskId && toolInstructions({
              tools: capabilities,
              worker: taskId !== HYDRA_CARD,
            }),
          ].filter(Boolean).join('\n\n'),
          spawned: tracked,
        })
        session.toolsRevision = toolsRevision
        ids.sessionId = `${known}:${session.id}`
        log({
          operation: 'session.open',
          ...ids,
          provider: known,
          ms: performance.now() - opening,
        })

        return session
      },
    }
  }

  // The helper's sessions open through the same wrapper, so they are logged and their memory listed too.
  const helperProviders = {
    [PROVIDERS.claude.provider]: providerOf({ provider: PROVIDERS.claude.provider }),
    [PROVIDERS.codex.provider]: providerOf({ provider: PROVIDERS.codex.provider }),
  }

  const {
    denyForMessage,
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

  const {
    retire,
    open,
    resumeTools,
    action,
    thread,
    close: closeSessions,
  } = createLiveSessions({
    hydraId,
    live,
    closing: () => closing,
    controller,
    children,
    streamed,
    beginTools: ({ task }) => {
      const revision = loadHydra({ hydraId }).state.cards[task]?.toolsRevision

      if (!revision) {
        return false
      }

      const application = toolApplication({
        task,
        revision,
      })

      if (!canRetryTools(application)) {
        return false
      }

      application.attempted = true
      application.attempts++

      return true
    },
    deferTools: ({
      task,
      failed,
    }) => {
      const application = toolApplications.get(task)

      if (!application) {
        return
      }

      application.attempted = false

      if (failed && application.attempts) {
        // beginTools counts an attempt only below the bound, so every attempt has its delay.
        const delay = retryDelays[application.attempts - 1]!
        application.retryAt = Date.now() + delay
        // A quiet Hydra may see no event before then, so the retry has its own timer.
        clearTimeout(toolRetries.get(task))
        toolRetries.set(
          task,
          setTimeout(
            () => background({
              name: 'tool grant retry',
              run: () => {
                // Node may fire a timer a millisecond before Date.now reaches its mark, so the wait counts as done.
                application.retryAt = 0

                return host.toolsChanged({ task })
              },
            }),
            delay,
          ).unref(),
        )
      }
    },
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
    // Defined below, once the delivery that opens sessions exists; each is read when a receipt arrives or a session ends.
    settleDirect: ({ ...input }) => settleDirect(input),
    directReply: ({ ...input }) => directReply(input),
    turns: () => turns,
  })

  const { set } = createLiveSettings({
    live,
    at,
    write,
    hosted,
    record,
    retire,
  })

  const {
    directReply,
    settleDirect,
    send,
  } = createHostedDelivery({
    hydraId,
    fenced: () => fenced(),
    live,
    at,
    write,
    note,
    hosted,
    folderOf,
    record,
    holdCompact,
    denyForMessage,
    open,
    ringSteering,
    unnotifiedSteering,
  })

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

  const {
    helper,
    helperPending,
    helperOpen,
  } = createHostedHelper({
    hydraId,
    providers: helperProviders,
    children,
    helperBound,
    changed,
    environment,
    // Defined below; each is read only when the helper runs.
    digest: ({ ...input }) => digest(input),
    armWake: () => armWake(),
    host: () => host,
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

  const turns = createHydraTurns({
    hydraId,
    live,
    queuedHydra,
    closing: () => closing,
    changed,
    queued,
    controller,
    children,
    upgrades,
    at,
    write,
    note,
    record,
    stoppedFor,
    denyForMessage,
    helperPending,
    providerOf,
    environment,
    sessionKey,
    open,
    retire,
    back,
    takeRecap,
    startFailed,
    mainTasks,
    wakeTasks,
    readWake,
    finishReading,
    turnEnded,
    readThrough,
    handBack,
    armWake,
    models: ({
      harness,
      account,
    }) => catalogs.models({
      harness,
      account,
    }),
  })
  const {
    hydraTurn,
    digest,
    hydra,
  } = turns

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
    agentChosen,
    agentChangeAbort,
  } = createAgentSwitch({
    hydraId,
    controller,
    children,
    live,
    closing: () => closing,
    hydraTurn,
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
    starting,
  } = createWorkerStarts({
    hydraId,
    closing: () => closing,
    at,
    write,
    changed,
    presence,
    providerOf,
    environment,
    controller,
    children,
    open,
    folderOf,
    sessionKey,
  })

  const {
    recover,
    fenced,
  } = createHostRecovery({
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
    host: () => host,
  })

  // The agent's turn stops at once; the inputs it had not taken are cancelled by the provider's receipts.
  const interruptEntry = async ({ entry }: { entry: Live }) => {
    entry.stopping = true

    try {
      await entry.session?.interrupt({ cancelQueued: true })
    } catch (error) {
      entry.stopping = false

      throw error
    }
  }

  const turnRunning = ({ entry }: { entry?: Live }) => Boolean(entry?.session
    && (entry.activity === 'working' || entry.session.snapshot().work.runningTurns.length))

  const markHydraInterrupted = () => {
    const card = loadHydra({ hydraId }).state.cards[HYDRA_CARD]

    write({
      fn: ({ writer }) => {
        if (card?.agent?.host === 'pnyx') {
          record({
            writer,
            agent: card.agent,
            input: { activity: 'interrupted' },
            actor: 'pnyx',
          })

          return
        }

        applyDecision({
          writer,
          decision: decidePush({
            state: writer.state,
            key: HYDRA_CARD,
            input: { activity: 'interrupted' },
            meta: {
              at: at(),
              actor: 'pnyx',
            },
          }),
        })
      },
    })
  }

  // A stop that ends a compaction, an upgrade or an agent change cancels what waited behind it; the commands Pnyx itself handles are not messages to Hydra.
  const stopHeldInputs = () => {
    turns.cancel()
    note({
      fn: ({ writer }) => stopHydraInputs({
        writer,
        ids: (writer.state.hydraMessages ?? [])
          .filter(message => !pnyxCommand({ text: message.text }))
          .map(message => message.id),
        at: at(),
      }),
    })
    markHydraInterrupted()
  }

  const stopHydra = async () => {
    const card = loadHydra({ hydraId }).state.cards[HYDRA_CARD]
    const changing = agentChangeAbort()

    if (changing) {
      stopHeldInputs()
      changing.abort(new Error('Compaction cancelled by the owner'))

      return { stopped: 'compaction' }
    }

    if (activeCompaction({ card })) {
      stopHeldInputs()

      return host.compact({ card: HYDRA_CARD })
    }

    const upgrade = upgrades.stop()

    if (upgrade === 'restarting') {
      return { stopped: 'none: Pnyx is restarting after the upgrade and comes back in a few seconds' }
    }

    if (upgrade) {
      stopHeldInputs()

      return { stopped: 'upgrade' }
    }

    const entry = card?.agent?.host === 'pnyx' ? live.get(sessionId({ agent: card.agent })) : undefined
    const running = turnRunning({ entry })

    if (!running && !queuedHydra.size && !entry?.input.pending()) {
      return { stopped: 'none: Hydra is not working on a turn' }
    }

    // Messages already in the agent's hands are settled by its own receipts, not here.
    const cleared = entry?.input.clear() ?? []
    turns.cancel()
    note({
      fn: ({ writer }) => stopHydraInputs({
        writer,
        ids: [
          ...queuedHydra,
          ...cleared.flatMap(item => [
            item.id ?? '',
            ...item.carried ?? [],
          ]),
        ],
        at: at(),
      }),
    })
    markHydraInterrupted()

    if (!entry?.session) {
      return { stopped: 'hydra' }
    }

    expireEntry({ entry })

    if (running) {
      await interruptEntry({ entry })
    } else {
      entry.activity = 'interrupted'
    }

    return { stopped: 'hydra' }
  }

  const stopWorker = async ({ ref }: { ref: string }) => {
    const card = findCard({
      state: loadHydra({ hydraId }).state,
      ref,
    })

    if (card.agent?.host !== 'pnyx') {
      throw new HydraError({
        code: 'NO_ROUTE',
        message: 'Pnyx does not run this task’s agent',
      })
    }

    const entry = live.get(sessionId({ agent: card.agent }))
    const handed = new Set([...entry?.delivered.values() ?? []].flat())
    const unread = unreadOwnerSteering({ card }).map(message => message.id)
      .filter(id => !handed.has(id))
    const running = turnRunning({ entry })

    if (!running && !unread.length && !entry?.input.pending()) {
      return { stopped: 'none: this task’s agent is not working on a turn' }
    }

    const cleared = entry?.input.clear() ?? []
    const clearedSteering = cleared.flatMap(item => item.steeringIds ?? [])

    write({
      fn: ({ writer }) => {
        stopWorkerInputs({
          writer,
          card: writer.state.cards[card.id]!,
          ids: [
            ...unread,
            ...clearedSteering,
          ],
          at: at(),
        })

        if (running || cleared.length) {
          interrupt({
            writer,
            agent: card.agent!,
            note: 'The owner stopped this agent',
          })
        }
      },
    })

    if (!entry) {
      return { stopped: card.id }
    }

    expireEntry({ entry })

    // Steering that was not the owner's stays pending and rings again with the next delivery.
    for (const id of clearedSteering) {
      entry.steering.delete(id)
    }

    for (const item of cleared) {
      const pending = item.id && entry.pendingDirect.get(item.id)

      if (pending && item.id) {
        directReply({
          card: pending.card,
          inputId: item.id,
          state: 'failed',
          detail: 'stopped',
        })
        entry.pendingDirect.delete(item.id)
      }
    }

    if (!entry.session) {
      retire({
        key: sessionId({ agent: card.agent }),
        entry,
      })
    } else if (running) {
      await interruptEntry({ entry })
    } else {
      entry.activity = 'interrupted'
    }

    return { stopped: card.id }
  }

  const host: Host = {
    diagnostics: () => ({
      helper: {
        ...helper.inspect(),
        enabled: helperOpen({ state: loadHydra({ hydraId }).state }),
      },
      sessions: [...live].map(([
        sessionId,
        entry,
      ]) => ({
        sessionId,
        taskId: entry.task,
        attached: entry.session !== undefined,
        stale: entry.stale,
        generation: entry.generation,
        leased: taskLeasePresent({
          hydraId,
          task: entry.task,
        }),
        work: entry.session?.snapshot().work,
        inputs: [...entry.pendingDirect].map(([
          id,
          input,
        ]) => ({
          id,
          taskId: input.card,
          taken: input.taken,
        })),
      })),
    }),
    catalogCommands: catalogs.commands,
    toolCatalog: async ({
      task,
      harness,
      account: selectedAccount,
      folder,
    }) => {
      const state = loadHydra({ hydraId }).state
      const card = state.cards[task]
      const savedHarness = card?.agent ? harnessOf({ provider: card.agent.provider }) : undefined
      const selected = knownHarness({ name: harness ?? savedHarness })

      if (!card || !selected) {
        throw new HydraError({
          message: 'Name a task and --harness claude|codex to list its configured tools',
          code: 'VALIDATION_ERROR',
        })
      }

      const sameHarness = !harness || harness === savedHarness
      const { account } = accountFor({
        effective: effectiveDispatch(),
        harness: selected,
        prefer: selectedAccount ?? (sameHarness ? card.agent?.account : undefined),
      })
      const sameAccount = !selectedAccount || selectedAccount === card.agent?.account
      const sameLogin = sameHarness && sameAccount
      const login = sameLogin && card.agent?.loginFolder
        ? {
          provider: selected,
          folder: card.agent.loginFolder,
        } : account
      const env = accountEnv({
        account: login,
        env: environment({ task }),
      })

      return providers[providerIdOf({ harness: selected })].toolCatalog({
        // An earlier agent's folder may be a removed copy, whose project scopes are gone.
        cwd: folder ?? [
          card.agent?.cwd,
          card.folder,
          card.project,
        ].find(path => path !== undefined && isFolder({ path })) ?? hydraDir({ hydraId }),
        env,
      })
    },
    toolsChanged: ({ task }) => {
      if (!fenced()) {
        return
      }

      const state = loadHydra({ hydraId }).state
      const card = state.cards[task]

      if (!card?.agent || !card.toolsRevision || !toolApplicationReady({
        state,
        card,
      })) {
        toolApplications.delete(task)

        return
      }

      const application = toolApplication({
        task: card.id,
        revision: card.toolsRevision,
      })

      if (application.attempted || !canRetryTools(application)) {
        return
      }

      application.attempted = true
      const entry = live.get(sessionId({ agent: card.agent }))
      const text = toolInstructions({
        tools: card.tools ?? [],
        worker: card.id !== HYDRA_CARD,
      })

      if (entry) {
        const scheduled = entry.toolsRevision === card.toolsRevision
        const loaded = entry.session?.toolsRevision === card.toolsRevision

        if (scheduled || loaded) {
          return
        }

        entry.toolsRevision = card.toolsRevision
        entry.stale = true
        entry.toolResume = text
        const settled = entry.activity === 'finished' && !entry.input.pending({ includes: () => true })
          && entry.session && nativeIdle({ work: entry.session.snapshot().work })

        if (!settled) {
          return
        }

        retire({
          key: sessionId({ agent: card.agent }),
          entry,
        })
      }

      // The grant stays pending and retries on the host's delays, so a failed reopen is reported, not thrown.
      try {
        resumeTools({
          task,
          text,
        })
      } catch (error) {
        log({
          level: 'warn',
          operation: 'tools.apply',
          hydraId,
          taskId: task,
          error,
        })

        return error as Error
      }
    },
    models: catalogs.models,
    hydraId,
    hydra,
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
    agentChosen,

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

      await interruptEntry({ entry })

      return { stopped: 'compaction' }
    },
    upgrade: ({
      id,
      now,
    }) => {
      const operation = upgrades.request({ id })

      if (now) {
        upgrades.sendNow({ id: operation.id })
      }

      return { operation }
    },
    stop: async ({
      card: ref = HYDRA_CARD,
      sendNow,
    } = {}) => {
      if (sendNow) {
        const state = loadHydra({ hydraId }).state
        const card = findCard({
          state,
          ref,
        })
        const entry = card.agent && live.get(sessionId({ agent: card.agent }))
        const hydraMessage = state.hydraMessages?.find(message =>
          message.id === sendNow && !message.stopped)
        const message = ref === HYDRA_CARD ? hydraMessage : undefined
        const steering = card.steering?.find(message => {
          const matchesId = message.id === sendNow || message.reply === sendNow

          return matchesId && !message.stopped && !message.ack
        })
        const pending = entry?.session?.snapshot().work.unsettledInputs.includes(sendNow)

        const queued = pending || message && !message.received || steering

        if (!entry?.session || entry.stopping || !queued) {
          throw new HydraError({
            code: 'NO_ROUTE',
            message: 'This message is no longer queued in a running session',
          })
        }

        // With no turn running the message already opens the next one.
        if (turnRunning({ entry })) {
          await entry.session.interrupt({ cancelQueued: false })
        }

        return { sentNow: sendNow }
      }

      return ref === HYDRA_CARD ? stopHydra() : stopWorker({ ref })
    },
    usageViews: usageTracker.usageViews,
    usage: usageTracker.usage,
    refreshUsage: usageTracker.refreshUsage,
    start,

    continue: continueInPnyx,

    send,

    permission,

    set,

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

    action,

    thread,

    release: async ({
      task,
      permanent,
    }) => {
      const entries = [...live].filter(([
        , entry,
      ]) => entry.task === task)

      if (starting({ task }) || entries.some(([
        , entry,
      ]) => entry.session === undefined)) {
        return { busy: 'starting' }
      }

      if (!permanent && entries.some(([
        , entry,
      ]) => entry.activity === 'working')) {
        return { busy: 'mid-turn' }
      }

      // A message delivered but not yet taken would be lost with the session.
      const waiting = ({ entry }: { entry: Live }) => entry.pendingDirect.size > 0
        || (entry.session?.snapshot().work.unsettledInputs.length ?? 0) > 0

      if (!permanent && entries.some(([
        , entry,
      ]) => waiting({ entry }))) {
        return { busy: 'taking a message' }
      }

      for (const [
        key,
        entry,
      ] of entries) {
        retire({
          key,
          entry,
          permanent,
        })
      }

      if (permanent) {
        await children.stop({ task })
      }

      return { released: entries.length }
    },

    reconcile: ({ state }) => {
      syncCompactions({ state })

      reconcilePermissions({ state })

      for (const card of Object.values(state.cards)) {
        const application = toolApplications.get(card.id)
        const attempted = application !== undefined && application.revision === card.toolsRevision
          && (application.attempted || !canRetryTools(application))

        if (fenced() && !attempted && toolApplicationReady({
          state,
          card,
        })) {
          background({
            name: 'tool grant application',
            run: () => host.toolsChanged({ task: card.id }),
          })
        }
      }

      const owned = children.tasks()

      for (const card of Object.values(state.cards)) {
        if (card.id === HYDRA_CARD || !closedTask({
          state,
          card,
        })) {
          reaped.delete(card.id)
          continue
        }

        // A later reply reopens a closed task's worker; the end of that turn reaps it again.
        if (reaped.has(card.id)) {
          continue
        }

        const entries = [...live].filter(([
          , entry,
        ]) => entry.task === card.id)

        // A worker that declares its own task done finishes that turn; its end reaps the worker.
        if (closedByWorker({ card }) && entries.some(([
          , entry,
        ]) => entry.activity === 'working')) {
          continue
        }

        for (const [
          key,
          entry,
        ] of entries) {
          retire({
            key,
            entry,
            permanent: true,
          })
        }

        reaped.add(card.id)

        if (owned.has(card.id)) {
          background({
            name: 'closed agent cleanup',
            run: () => children.stop({ task: card.id }),
          })
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
          log({
            level: 'error',
            operation: 'inbox resume',
            hydraId,
            taskId: card.id,
            correlationId: oldest.id,
            error,
          })
        }
      }
    },

    recover,

    close: () => {
      closing = true
      usageTracker.close()
      midTurnChecks.delete(midTurn)
      helper.close()
      stopWake()
      stopRetry()

      for (const timer of toolRetries.values()) {
        clearTimeout(timer)
      }

      stalls.close()
      controller.abort()

      compaction.close()

      closeSessions()
    },
  }

  return host
}
