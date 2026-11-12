import { startReviewTimer } from '#hydra/review-timer.ts'
import { FOLLOW_POLL_MS } from '#tasks/delivery/follow.ts'
import { createSourceRunner } from '#task-sources/runner.ts'
import { systemReminderScheduler, type ReminderScheduler } from '#tasks/reminder-scheduler.ts'
import { createLatestFeed } from './latest-feed.ts'
import { createServerClients } from './server-clients.ts'
import { createCatalog } from '#app/server-commands/catalog.ts'
import { createServerCommands } from '#app/server-commands/dispatch.ts'
import { createServerRoutes } from './server-routes.ts'
import { createServerTick } from './server-tick.ts'
import { createThreadSubscriptions } from './thread-subscriptions.ts'
import type { CatalogLocations } from '#hydra/transcripts-catalog.ts'
import { createCatalogIndex } from '#hydra/transcripts-catalog-index.ts'
import { wakeReasons } from '#hydra/wake-reasons.ts'
import { createIndexSync } from '#oracle/index-sync.ts'
import { watchHomes } from '#integrations/firstmate/cli.ts'
import { resolveHome } from '#integrations/firstmate/home.ts'
import { existsSync, rmSync } from 'node:fs'
import { watchPath, type PathWatch } from './watch.ts'
import { join } from 'node:path'
import type { HydraEvent } from './model.ts'
import { reduce } from './reducer.ts'
import { hydraDir } from './home-migration.ts'
import { heldHydra, holdHydra, loadHydra } from './store.ts'
import { saveSnapshot } from './writer.ts'
import { readEventsFrom } from './event-log.ts'
import { createDiagnosticRecovery } from '#diagnostics/recovery.ts'
import { background } from './background.ts'
import { log } from './diagnostics.ts'
import { spoolWrite } from './spool.ts'
import { privateDir, spoolDir } from '#store/storage.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import { hydraIdentity, localToken, offerHost, socketPath } from './server-state.ts'
import { hostRequest } from './host-request.ts'
import { createHost, type QueryFn } from './host.ts'
import type { SpawnCodex } from '#workers/codex.ts'
import { createServerWorkers } from './server-workers.ts'
import { RESUME_LIMIT, type HydraClient, type HydraSubscription, type MountedHydra } from './server-transport.ts'
import { buildId } from './server-http.ts'
import { listenIngest } from '#integrations/hooks/socket.ts'
import { healthFacts } from '#diagnostics/health.ts'
import { DEBUG_LIMIT, DEBUG_MAX } from '#diagnostics/timeline.ts'
import { HydraError } from '#store/errors.ts'
import { dropCopyLeases } from '#routine-helper/leases.ts'

export const RETRY_MS = 60_000
export const UPGRADE_CHECK_MS = 24 * 60 * 60_000
export const CREATION_POLL_MS = 1000

export async function mountOwnedHydra({
  hydraId,
  url,
  homes: given,
  catalogLocations,
  query,
  spawnCodex,
  wakeDelay,
  stallDelay,
  busyDelay,
  stallRepeatMax,
  pauseDelay,
  retryDelays,
  followDelay = FOLLOW_POLL_MS,
  recoveryPause,
  reviewClock,
  reminderScheduler = systemReminderScheduler,
  open,
  hydrasChanged,
  upgradeRoot,
  restart,
  upgradeStatus,
}: {
  hydraId: string
  url: string
  homes?: string[]
  catalogLocations?: CatalogLocations
  query?: QueryFn
  spawnCodex?: SpawnCodex
  wakeDelay?: number
  stallDelay?: number
  busyDelay?: number
  stallRepeatMax?: number
  pauseDelay?: number
  retryDelays?: number[]
  followDelay?: number
  recoveryPause?: number
  reminderScheduler?: ReminderScheduler
  reviewClock?: Pick<Parameters<typeof startReviewTimer>[0], 'now' | 'interval'>
  open({ id }: { id: string }): Promise<string>
  hydrasChanged(): void
  upgradeRoot?: string
  restart?(): void | Promise<void>
  upgradeStatus(): UpgradeStatus | undefined
}): Promise<MountedHydra> {
  let homes = (given ?? []).map(path => resolveHome({ path }))
  // Set by close(): work already scheduled then must not open new watchers or timers.
  let closed = false
  // Until recovery has stopped the previous server's agents, nothing may reopen a session.
  let recovered = false

  const dir = hydraDir({ hydraId })
  privateDir({ dir: spoolDir({ dir }) })
  const token = Buffer.from(localToken())
  const identity = hydraIdentity({ hydraId })
  // The server holds the Hydra in memory; its own writes call kick in the same step.
  const releaseHold = holdHydra({
    hydraId,
    changed: () => kick(),
  })
  dropCopyLeases({ hydraId })
  let {
    state,
    offset,
  } = loadHydra({ hydraId })
  const catalogIndex = createCatalogIndex({ locations: catalogLocations })
  const {
    threadSubscriptions,
    subscriptionMap,
    threadTimers,
    liveThreadTimers,
    threadDelivery,
    refreshLiveThread,
    refreshThread,
    threadPage,
    bindThread,
  } = createThreadSubscriptions({
    hydraId,
    state: () => state,
    homes: () => homes,
    closed: () => closed,
    send: ({
      ws,
      message,
    }) => send({
      ws,
      message,
    }),
    agents: () => agents,
  })

  // The recorded Firstmate home is watched, and followed when it changes; given homes stay fixed.
  let firstmate: ReturnType<typeof watchHomes> | undefined
  let watchedHome: string | undefined

  const followHome = () => {
    const hydra = state.config?.hydra
    // A recorded home that has since moved is skipped, so the Hydra still opens.
    const home = hydra?.kind === 'firstmate' && hydra.home && existsSync(join(
      hydra.home,
      'state',
    )) ? hydra.home : undefined

    if (given || closed || home === watchedHome) {
      return
    }

    firstmate?.close()
    watchedHome = home
    homes = home ? [resolveHome({ path: home })] : []
    firstmate = home ? watchHomes({
      hydraId,
      list: homes,
    }) : undefined
  }

  let recent: HydraEvent[] = []
  const tabs = createServerClients({
    hydraId,
    state: () => state,
    recent: () => recent,
    agents: () => agents,
    threadSubscriptions,
    bindThread,
    refreshThread,
    feed: () => feed,
  })
  const {
    clients,
    hydraSubscribers,
    send,
    queueMessage,
    sendQueue,
    sendSnapshot,
    broadcast,
    spend,
    sendSettings,
    resume,
  } = tabs

  const reload = () => {
    ({
      state,
      offset,
    } = loadHydra({ hydraId }))
    recent = []

    if (recovered) {
      agents.reconcile({ state })
    }

    followHome()

    for (const ws of clients) {
      sendSnapshot({ ws })
    }

    touchLatest({ ids: Object.keys(state.cards) })
    hydrasChanged()
  }

  const feed = createLatestFeed({
    state: () => state,
    closed: () => closed,
    clients,
    send,
    threadSubscriptions,
    refreshThread,
    refreshLiveThread,
    historyIndex: () => historyIndex,
    agents: () => agents,
    spend,
  })
  const {
    folders,
    transcripts,
    transcriptPolls,
    touchLatest,
    streamed,
  } = feed

  const pump = () => {
    const read = readEventsFrom({
      hydraId,
      offset,
    })

    if (!read) {
      return reload()
    }

    const live = heldHydra({ hydraId })

    for (const event of read.events) {
      // A held Hydra's writer has already applied the event to the state this server reads.
      if (live) {
        state = live.state

        if (event.seq > state.seq) {
          return reload()
        }
      } else if (event.seq !== state.seq + 1) {
        return reload()
      } else {
        state = reduce({
          state,
          event,
        })
      }

      recent.push(event)

      if (event.type === 'hydra.project') {
        background({
          name: 'catalog warmup',
          context: { hydraId },
          run: warmCatalog,
        })
      }

      broadcast({ event })
      touchLatest({ ids: [event.cardId] })

      const reasons = wakeReasons({
        state,
        events: [event],
      })

      if (reasons.length) {
        agents.wake({
          seq: event.seq,
          card: event.cardId,
          reasons,
          event,
        })
      } else if (event.type === 'hydra.message' && event.data.kind === 'progress') {
        agents.unread({ seq: event.seq })
      }
    }

    offset = read.end

    if (read.events.length) {
      historyIndex.changed()
    }

    hydrasChanged()

    if (recovered) {
      agents.reconcile({ state })
    }

    followHome()

    if (recent.length > RESUME_LIMIT) {
      recent = recent.slice(-RESUME_LIMIT)
    }
  }

  const {
    startWorker,
    runWorker,
    joinWorkers,
    triedResends,
    resendReply,
  } = createServerWorkers({
    hydraId,
    closed: () => closed,
  })

  const historyIndex = createIndexSync({
    hydraId,
    startWorker,
  })
  historyIndex.changed()

  const tick = createServerTick({
    hydraId,
    dir,
    state: () => state,
    closed: () => closed,
    pump,
    followDelay,
    reminderScheduler,
    runWorker,
    triedResends,
    resendReply,
    agents: () => agents,
    sources: () => sources,
    review: () => review,
    recover: () => recovery.reconcile(),
  })
  const { kick } = tick

  const agents = createHost({
    hydraId,
    query,
    spawnCodex,
    wakeDelay,
    stallDelay,
    busyDelay,
    stallRepeatMax,
    pauseDelay,
    retryDelays,
    upgradeRoot,
    restart,
    changed: () => kick(),
    queued: () => {
      const queue = queueMessage()

      for (const ws of clients) {
        sendQueue({
          ws,
          queue,
        })
      }
    },
    streamed,
  })

  const recovery = createDiagnosticRecovery({
    hydraId,
    sessions: () => agents.diagnostics().sessions,
    enabled: () => agents.diagnostics().helper.enabled === true,
    changed: kick,
    pause: recoveryPause,
  })

  const withdrawHost = offerHost({
    hydraId,
    ask: async ({ body }) => {
      if (body.action === 'debug-health') {
        const limit = typeof body.limit === 'number' ? body.limit : DEBUG_LIMIT

        if (!Number.isInteger(limit) || limit < 1 || limit > DEBUG_MAX) {
          throw new HydraError({
            code: 'VALIDATION_ERROR',
            message: 'Invalid health limit',
          })
        }

        return healthFacts({
          blocked: recovery.blocked(),
          state,
          events: recovery.originals(),
          dir,
          now: Date.now(),
          limit,
          runtime: {
            ...agents.diagnostics(),
            scheduler: tick.health(),
          },
        })
      }

      return hostRequest({
        host: agents,
        body,
        usage: {
          spend: tabs.spendNow.spend,
          readings: tabs.readingsNow,
        },
      })
    },
  })

  const sources = createSourceRunner({
    hydraId,
    changed: kick,
    state: () => state,
  })

  const review = startReviewTimer({
    hydraId,
    now: reviewClock?.now,
    interval: reviewClock?.interval,
    wake: kick,
    busy: () => agents.queue().waiting.length > 0 || agents.queue().reading.length > 0,
    state: () => state,
  })

  const request = createServerRoutes({
    hydraId,
    dir,
    url,
    token,
    identity,
  })

  const {
    warmCatalog,
    catalogReads,
    catalogCommand,
  } = createCatalog({
    dir,
    state: () => state,
    catalogIndex,
    agents,
  })

  setImmediate(() => {
    if (!closed) {
      background({
        name: 'catalog warmup',
        context: { hydraId },
        run: warmCatalog,
      })
    }
  })

  const { runCommand } = createServerCommands({
    hydraId,
    url,
    open,
    state: () => state,
    homes: () => homes,
    closed: () => closed,
    send,
    kick,
    agents,
    catalogCommand,
    historyIndex,
    hydraSubscribers,
    subscriptionMap,
    bindThread,
    threadPage,
    startWorker,
  })

  const connect = ({
    ws,
    after,
  }: {
    ws: HydraClient
    after: string | null
  }): HydraSubscription => {
    clients.add(ws)
    send({
      ws,
      message: {
        type: 'hello',
        build: buildId(),
        hydraId: identity,
        installation: hydraIdentity({ hydraId: '' }),
      },
    })
    const upgrade = upgradeStatus()

    if (upgrade) {
      send({
        ws,
        message: {
          type: 'upgrade',
          upgrade,
        },
      })
    }

    sendSettings({ ws })
    resume({
      ws,
      after,
    })

    return {
      receive({ message }) {
        if (message?.type === 'resync') {
          sendSnapshot({ ws })
          refreshThread({
            ws,
            resync: true,
          })
        } else if (message?.type === 'command') {
          runCommand({
            ws,
            message,
          })
        } else {
          send({
            ws,
            message: {
              type: 'error',
              id: null,
              error: 'unknown message',
              code: 'VALIDATION_ERROR',
              help: ['Send a command or resync message'],
            },
          })
        }
      },
      close() {
        tabs.closeClient({ ws })
        clients.delete(ws)
        hydraSubscribers.delete(ws)
        catalogReads.delete(ws)
        clearTimeout(threadTimers.get(ws))
        threadTimers.delete(ws)
        threadDelivery.removeClient({ ws })

        for (const map of threadSubscriptions) {
          const sub = map.get(ws)

          if (sub) {
            sub.watcher?.close()
            clearTimeout(liveThreadTimers.get(sub))
            liveThreadTimers.delete(sub)
          }

          map.delete(ws)
        }
      },
    }
  }

  const ingest = await listenIngest({
    hydraId,
    onLine: ({ line }) => {
      try {
        const entry = JSON.parse(line) as { id?: unknown }

        if (typeof entry === 'object' && entry !== null && typeof entry.id === 'string') {
          spoolWrite({
            hydraId,
            entry: entry as { id: string },
          })
        }
      } catch {
      // Not JSON: dropped, as a hook never waits for an answer.
      }

      kick()
    },
  })

  const watchers: PathWatch[] = []

  const stop = async () => {
    closed = true
    await recovery.close()
    withdrawHost()
    historyIndex.stop()

    await Promise.all([
      tick.queueRun,
      tick.replyRun,
      tick.followRun,
      tick.settling,
      joinWorkers(),
    ])
    await sources.close()
    firstmate?.close()
    review.close()
    catalogIndex.close()
    agents.close()
    await spend.close()
    const live = heldHydra({ hydraId })

    // The log holds every change; a snapshot that cannot be written only makes the next start slower,
    // so the rest of shutdown runs regardless.
    if (live) {
      try {
        saveSnapshot({ live })
      } catch (error) {
        log({
          level: 'error',
          operation: 'snapshot',
          hydraId,
          error,
        })
      }
    }

    releaseHold()

    const threads = threadSubscriptions.flatMap(map =>
      [...map.values()].flatMap(sub => sub.watcher ?? []))

    for (const w of [
      ...watchers,
      ...folders.values(),
      ...transcripts.values(),
      ...transcriptPolls.values(),
      ...threads,
    ]) {
      w.close()
    }

    folders.clear()
    transcripts.clear()
    transcriptPolls.clear()
    threadDelivery.close()
    tabs.close()
    threadSubscriptions.forEach(map => map.clear())
    clearTimeout(feed.latestTimer)
    clearTimeout(tick.expiryTimer)
    tick.cancelReminder()

    for (const timer of threadTimers.values()) {
      clearTimeout(timer)
    }

    threadTimers.clear()

    for (const timer of liveThreadTimers.values()) {
      clearTimeout(timer)
    }

    liveThreadTimers.clear()

    for (const ws of clients) {
      ws.terminate()
    }

    clients.clear()
    await (ingest && new Promise(r => ingest.close(r)))

    if (ingest) {
      rmSync(
        socketPath({ hydraId }),
        { force: true },
      )
    }
  }

  // A mount that fails partway stops what it started.
  try {
    watchers.push(
      watchPath({
        path: dir,
        changed: kick,
      }),
      watchPath({
        path: spoolDir({ dir }),
        changed: kick,
      }),
    )
    followHome()
  } catch (error) {
    await stop()
    throw error
  }

  try {
    await agents.recover()
  } catch (error) {
    log({
      level: 'error',
      operation: 'recover',
      hydraId,
      error,
    })
  } finally {
    recovered = true
  }

  kick()
  touchLatest({ ids: Object.keys(state.cards) })

  return {
    url,
    socket: ingest && socketPath({ hydraId }),
    request,
    connect,
    summaries({ hydras }) {
      for (const ws of clients) {
        if (hydraSubscribers.has(ws)) {
          send({
            ws,
            message: {
              type: 'hydras',
              hydraId,
              hydras,
            },
          })
        }
      }
    },
    settings() {
      for (const ws of clients) {
        sendSettings({ ws })

        // Focus mode and the detail switches decide what a thread page shows.
        for (const map of threadSubscriptions) {
          if (map.has(ws)) {
            refreshThread({ ws })
          }
        }
      }

      // The Done deadline follows the shared hours.
      kick()
    },
    upgrade() {
      const upgrade = upgradeStatus()

      for (const ws of clients) {
        if (upgrade) {
          send({
            ws,
            message: {
              type: 'upgrade',
              upgrade,
            },
          })
        }
      }
    },
    async close() {
      if (closed) {
        return
      }

      await stop()
    },
  }
}

export const SERVE_OPTIONS = {
  hydra: { type: 'string' },
  port: { type: 'string' },
  home: {
    type: 'string',
    multiple: true,
  },
} as const
