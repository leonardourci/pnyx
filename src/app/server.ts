import { discoverableTasks } from '#tasks/delivery/discover.ts'
import { followWorkerLogs } from '#workers/worker-log.ts'
import { captureCpuProfile } from '#diagnostics/cpu-profile.ts'
import { followGit } from '#tasks/delivery/follow-git.ts'
import { findCard } from '#tasks/push-rules.ts'
import { startReviewTimer } from '#hydra/review-timer.ts'
import { FOLLOW_POLL_MS, followedLinks } from '#tasks/delivery/follow.ts'
import { QUEUE_POLL_MS } from '#workers/queue.ts'
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
import { rmSync } from 'node:fs'
import { watchPath, type PathWatch } from './watch.ts'
import { reduce } from './reducer.ts'
import { hydraDir } from './home-migration.ts'
import { heldHydra, holdHydra, loadHydra } from './store.ts'
import { readChanges } from './event-log.ts'
import { createDiagnosticRecovery } from '#diagnostics/recovery.ts'
import { background } from './background.ts'
import { log } from './diagnostics.ts'
import { spoolWrite } from './spool.ts'
import { privateDir, spoolDir } from '#store/storage.ts'
import { hydraIdentity, localToken, offerHost, socketPath } from './server-state.ts'
import { hostRequest } from './host-request.ts'
import { createHost, type QueryFn } from './host.ts'
import type { SpawnCodex } from '#workers/codex.ts'
import { createServerWorkers } from './server-workers.ts'
import { type HydraClient, type HydraSubscription, type MountedHydra } from './server-transport.ts'
import { buildId } from './server-http.ts'
import { listenIngest } from '#integrations/hooks/socket.ts'
import { healthFacts } from '#diagnostics/health.ts'
import { DEBUG_LIMIT, DEBUG_MAX } from '#diagnostics/timeline.ts'
import { HydraError } from '#store/errors.ts'
import { dropCopyLeases } from '#routine-helper/leases.ts'
import { pageInterest, parsePage } from './page-cli.ts'
import { pageState } from './page-state.ts'

export const RETRY_MS = 60_000
export const UPGRADE_CHECK_MS = 24 * 60 * 60_000
export const CREATION_POLL_MS = 1000

export async function mountOwnedHydra({
  hydraId,
  url,
  catalogLocations,
  query,
  spawnCodex,
  wakeDelay,
  stallDelay,
  busyDelay,
  stallRepeatMax,
  pauseDelay,
  compactionDelay,
  retryDelays,
  followDelay = FOLLOW_POLL_MS,
  queueDelay = QUEUE_POLL_MS,
  recoveryPause,
  reviewClock,
  reminderScheduler = systemReminderScheduler,
  open,
  hydrasChanged,
  upgradeRoot,
  restart,
}: {
  hydraId: string
  url: string
  catalogLocations?: CatalogLocations
  query?: QueryFn
  spawnCodex?: SpawnCodex
  wakeDelay?: number
  stallDelay?: number
  busyDelay?: number
  stallRepeatMax?: number
  pauseDelay?: number
  compactionDelay?: number
  retryDelays?: number[]
  followDelay?: number
  queueDelay?: number
  recoveryPause?: number
  reminderScheduler?: ReminderScheduler
  reviewClock?: Pick<Parameters<typeof startReviewTimer>[0], 'now' | 'interval'>
  open({ id }: { id: string }): Promise<string>
  hydrasChanged(): void
  upgradeRoot?: string
  restart?(): void | Promise<void>
}): Promise<MountedHydra> {
  let failedRelease: (() => Promise<void>) | undefined

  try {
    let permanentClose: Promise<void> | undefined
    let closed = false
    let recovered = false
    let notifyChange: (() => void) | undefined

    const dir = hydraDir({ hydraId })
    const releaseHold = await holdHydra({
      hydraId,
      changed: () => notifyChange?.(),
    })
    failedRelease = releaseHold
    privateDir({ dir: spoolDir({ dir }) })
    const token = Buffer.from(localToken())
    const identity = hydraIdentity({ hydraId })
    dropCopyLeases({ hydraId })
    let { state } = loadHydra({ hydraId })
    let handledThrough = state.seq
    const catalogIndex = createCatalogIndex({ locations: catalogLocations })
    const {
      threadSubscriptions,
      retainThreads,
      subscriptionMap,
      threadTimers,
      liveThreadTimers,
      retireThreadClient,
      refreshLiveThread,
      refreshThread,
      threadPage,
      bindThread,
    } = createThreadSubscriptions({
      hydraId,
      state: () => loadHydra({ hydraId }).state,
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

    const tabs = createServerClients({
      hydraId,
      state: () => state,
      agents: () => agents,
      threadSubscriptions,
      bindThread,
      refreshThread,
      feed: () => feed,
    })
    const {
      clients,
      send,
      queue,
      sendLatest,
      broadcast,
      spend,
    } = tabs

    const reload = () => {
      ({ state } = loadHydra({ hydraId }))
      handledThrough = state.seq

      if (recovered) {
        background({
          name: 'reconcile agents',
          run: async () => await agents.reconcile({ state }),
        })
      }

      background({
        name: 'follow git refs',
        run: () => gitFollow.reconcile({ state }),
      })
      workerLogs.reconcile({ state })

      for (const ws of clients) {
        sendLatest({ ws })
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

    const observedWork = new Map<string, boolean>(Object.entries(state.cards).map(([
      task,
      card,
    ]) => [
      task,
      (card.sessionActivity ?? card.activity) === 'working',
    ]))

    const workChanged = ({ task }: { task: string }) => {
      const card = state.cards[task]
      const working = (card?.sessionActivity ?? card?.activity) === 'working'
      const changed = observedWork.get(task) !== working
      observedWork.set(
        task,
        working,
      )

      return changed
    }

    const pump = () => {
      const read = readChanges({
        hydraId,
        after: handledThrough,
      })

      const live = heldHydra({ hydraId })

      if (live) {
        state = live.state
      }

      for (const event of read) {
        if (live) {
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

        const discoveredLink = event.type === 'card.linked' && event.data.before === null
        && event.data.after?.src === 'branch'
        const linkedByOthers = event.type === 'card.linked' && (event.actor !== 'pnyx' || discoveredLink)
        const changedTask = event.cardId
        const activityChanged = workChanged({ task: changedTask })

        const discoveryChanged = [
          'task.copy',
          'task.launched',
          'task.session',
          'task.worker-line',
        ].includes(event.type)

        if (linkedByOthers || activityChanged || discoveryChanged) {
          tick.refreshLinks({ task: changedTask })
        }

        if (event.type === 'hydra.project') {
          background({
            name: 'catalog warmup',
            context: { hydraId },
            run: warmCatalog,
          })
        }

        broadcast({ event })
        touchLatest({ ids: [changedTask] })

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

      handledThrough = read.at(-1)?.seq ?? handledThrough

      if (live) {
        live.pending = live.pending.filter(event => event.seq > handledThrough)
      }

      hydrasChanged()

      if (recovered) {
        background({
          name: 'reconcile agents',
          run: async () => await agents.reconcile({ state }),
        })
      }

      background({
        name: 'follow git refs',
        run: () => gitFollow.reconcile({ state }),
      })
      workerLogs.reconcile({ state })
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
    const tick = createServerTick({
      hydraId,
      state: () => state,
      closed: () => closed || !recovered,
      pump,
      followDelay,
      queueDelay,
      reminderScheduler,
      runWorker,
      triedResends,
      resendReply,
      agents: () => agents,
      sources: () => sources,
      review: () => review,
      recover: async () => await recovery.reconcile(),
    })
    const workerLogs = followWorkerLogs({
      hydraId,
      changed: tick.kick,
    })
    const gitFollow = followGit({ changed: tick.refreshLinks })
    background({
      name: 'follow git refs',
      run: () => gitFollow.reconcile({ state }),
    })

    const { kick } = tick
    notifyChange = kick
    workerLogs.reconcile({ state })

    const agents = createHost({
      hydraId,
      query,
      spawnCodex,
      wakeDelay,
      stallDelay,
      busyDelay,
      stallRepeatMax,
      pauseDelay,
      compactionDelay,
      retryDelays,
      upgradeRoot,
      restart,
      changed: () => kick(),
      queued: kick,
      streamed,
      usageChanged: () => spend.count(),
    })

    const recovery = createDiagnosticRecovery({
      hydraId,
      sessions: () => agents.diagnostics().sessions,
      enabled: () => agents.diagnostics().helper.enabled === true,
      changed: kick,
      pause: recoveryPause,
    })

    const profileAbort = new AbortController()
    const withdrawHost = offerHost({
      hydraId,
      ask: async ({ body }) => {
        if (body.action === 'cpu-profile') {
          if (typeof body.seconds !== 'number' || typeof body.path !== 'string') {
            throw new HydraError({
              code: 'VALIDATION_ERROR',
              message: 'CPU profile needs seconds and output path',
            })
          }

          return captureCpuProfile({
            seconds: body.seconds,
            path: body.path,
            signal: profileAbort.signal,
          })
        }

        if (body.action === 'refresh-links') {
          if (typeof body.task !== 'string') {
            throw new HydraError({
              code: 'VALIDATION_ERROR',
              message: 'task is required',
            })
          }

          const card = findCard({
            state,
            ref: body.task,
          })
          const followed = followedLinks({ state })
            .some(({ card: linked }) => linked.id === card.id)

          const discovering = discoverableTasks({ state }).some(task => task.id === card.id)

          if (!followed && !discovering) {
            return {
              refreshing: 'none: task has no open pull request links',
              task: card.id,
            }
          }

          tick.refreshLinks({
            task: card.id,
            restart: true,
          })

          return {
            refreshing: 'pull requests',
            task: card.id,
            help: [`Run \`pnyx task show ${card.id} --hydra ${hydraId}\` for the links once read`],
          }
        }

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

    const {
      runCommand,
      closeClient: closeCommands,
    } = createServerCommands({
      hydraId,
      url,
      open,
      state: () => state,
      closed: () => closed,
      send,
      kick,
      agents,
      catalogCommand,
      showPage: ({
        ws,
        interest,
      }) => {
        retainThreads({
          ws,
          cards: interest.cards,
        })
        tabs.show({
          ws,
          interest,
        })
      },
      subscriptionMap,
      retainThreads,
      bindThread,
      threadPage,
      startWorker,
    })

    const openPageWithInitialInterest = ({
      ws,
      page,
    }: {
      ws: HydraClient
      page?: string[]
    }) => {
      if (!page) {
        return
      }

      try {
        tabs.open({
          ws,
          interest: pageInterest({
            state,
            values: parsePage({ args: page }).values,
          }).interest,
        })
      } catch (error) {
        if (!(error instanceof HydraError)) {
          throw error
        }
      }
    }

    const connect = ({
      ws,
      page,
    }: {
      ws: HydraClient
      page?: string[]
    }): HydraSubscription => {
      clients.add(ws)
      openPageWithInitialInterest({
        ws,
        page,
      })
      send({
        ws,
        message: {
          type: 'hello',
          stateSeq: state.seq,
          build: buildId(),
          hydraId: identity,
          installation: hydraIdentity({ hydraId: '' }),
        },
      })
      sendLatest({ ws })

      return {
        receive({ message }) {
          if (message?.type === 'resync') {
            sendLatest({ ws })
            refreshThread({
              ws,
              resync: true,
            })
          } else if (message?.type === 'command') {
            background({
              name: 'page command',
              context: {hydraId},
              run: () => runCommand({
                ws,
                message,
              }),
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
          closeCommands({ ws })
          tabs.closeClient({ ws })
          clients.delete(ws)
          catalogReads.delete(ws)
          clearTimeout(threadTimers.get(ws))
          threadTimers.delete(ws)
          retireThreadClient({ ws })

          for (const map of threadSubscriptions()) {
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

    let ingest: Awaited<ReturnType<typeof listenIngest>> | undefined
    const watchers: PathWatch[] = []

    const stop = async () => {
      closed = true
      profileAbort.abort()
      workerLogs.close()
      gitFollow.close()
      await recovery.close()
      withdrawHost()

      await Promise.all([
        tick.queueRun,
        tick.replyRun,
        tick.followRun,
        tick.discoveryRun,
        tick.settling,
        joinWorkers(),
      ])
      await sources.close()
      review.close()
      catalogIndex.close()
      agents.close()
      await spend.close()

      await releaseHold()
      failedRelease = undefined

      const threads = threadSubscriptions().flatMap(map =>
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
      tabs.close()
      threadSubscriptions().forEach(map => map.clear())
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
        closeCommands({ ws })
        ws.terminate()
      }

      clients.clear()
      const listener = ingest

      if (listener) {
        await new Promise(resolve => listener.close(resolve))
        rmSync(
          socketPath({ hydraId }),
          { force: true },
        )
      }
    }

    try {
      ingest = await listenIngest({
        hydraId,
        onLine: ({ line }) => {
          let entry: unknown

          try {
            entry = JSON.parse(line)
          } catch (error) {
            if (error instanceof SyntaxError) {
              return
            }

            throw error
          }

          if (typeof entry !== 'object' || entry === null || !('id' in entry) || typeof entry.id !== 'string') {
            return
          }

          try {
            spoolWrite({
              hydraId,
              entry: {
                ...entry,
                id: entry.id,
              },
            })
            tick.spooled()
          } catch (error) {
            log({
              level: 'error',
              operation: 'ingest.spool',
              hydraId,
              error,
            })
          }
        },
      })
      watchers.push(watchPath({
        path: dir,
        changed: kick,
      }))
      watchers.push(watchPath({
        path: spoolDir({ dir }),
        changed: tick.spooled,
      }))
      workerLogs.reconcile({ state })
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
      view: () => ({
        state: pageState({
          state,
          interest: {
            cards: [],
            hidden: true,
          },
        }),
        queue: queue(),
      }),
      request,
      connect,
      settings() {
        for (const ws of clients) {
        // Focus mode and the detail switches decide what a thread page shows.
          for (const map of threadSubscriptions()) {
            if (map.has(ws)) {
              refreshThread({ ws })
            }
          }
        }

        kick()
      },
      async close({ permanent = false } = {}) {
        if (permanentClose) {
          return permanentClose
        }

        if (permanent) {
          permanentClose = (async () => {
            try {
              agents.close()
              await agents.stopTools()
            } finally {
              if (!closed) {
                await stop()
              }
            }
          })()

          try {
            await permanentClose
          } finally {
            permanentClose = undefined
          }

          return
        }

        if (closed) {
          return
        }

        await stop()
      },
    }
  } catch (error) {
    await failedRelease?.()
    throw error
  }
}

export const SERVE_OPTIONS = {
  hydra: { type: 'string' },
  port: { type: 'string' },
} as const
