import { taskLeasePresent } from '#routine-helper/leases.ts'
import { createAgentSwitch } from '#hydra/agent-switch.ts'
import { accountFor } from '#workers/account-choice.ts'
import { PROVIDERS, harnessOf, knownProvider } from '#workers/providers.ts'
import { activeCompaction } from '#workers/compaction/state.ts'
import { upgradeQueue } from '#upgrade/queue.ts'
import { requestRestart } from '#upgrade/restart.ts'
import { trackChildren } from '#workers/children.ts'
import { pendingSteering, steeringHeld } from '#workers/steering.ts'
import { createHostedHelper } from '#routine-helper/hosted-helper.ts'
import { agentExhausted } from '#workers/dispatch.ts'
import { effectiveDispatch } from '#workers/dispatch-config.ts'
import { randomUUID } from 'node:crypto'
import { claudeProvider, type QueryFn } from '#workers/claude.ts'
import { codexProvider, type SpawnCodex } from '#workers/codex.ts'
import { createUsageTracker } from '#workers/usage-tracker.ts'
import { createPermissionBridge } from '#workers/permission-bridge.ts'
import { terminalPresence, type Presence } from '#workers/presence.ts'
import { MAX_RESENDS } from '#workers/reply-retry.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
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
import { WAKE_MS, STALL_MS, BUSY_MS, PAUSE_MS, STALL_REPEAT_MAX_MS, UNCONFIRMED_QUOTE_CHARS, INHERITED, steeringAssignment } from '#workers/host.ts'
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

  const {
    retire,
    open,
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
    providers,
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

  const { recover } = createHostRecovery({
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

    release: ({ task }) => {
      const entries = [...live].filter(([
        , entry,
      ]) => entry.task === task)

      if (starting({ task })) {
        return { busy: 'starting' }
      }

      if (entries.some(([
        , entry,
      ]) => entry.activity === 'working')) {
        return { busy: 'mid-turn' }
      }

      // A message delivered but not yet taken would be lost with the session.
      const waiting = ({ entry }: { entry: Live }) => entry.pendingDirect.size > 0
        || (entry.session?.snapshot().work.unsettledInputs.length ?? 0) > 0

      if (entries.some(([
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
        })
      }

      return { released: entries.length }
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

    recover,

    close: () => {
      closing = true
      midTurnChecks.delete(midTurn)
      helper.close()
      stopWake()
      stopRetry()
      stalls.close()
      controller.abort()

      compaction.close()

      closeSessions()
    },
  }

  return host
}
