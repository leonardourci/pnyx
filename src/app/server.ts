import { helperProgress } from '../helper/route.ts'
import { startReviewTimer } from '../review/timer.ts'
import { FOLLOW_POLL_MS, followPullRequests, needsPullRequestFollow } from '../tasks/delivery/follow.ts'
import { createSourceRunner } from '../task-sources/runner.ts'
import { sourceDeadline } from '../task-sources/state.ts'
import { spendInputs, type TaskSpend } from '../spend/tasks.ts'
import { spendCounter } from '../spend/worker.ts'
import { advanceQueues } from '../queue/advance.ts'
import { QUEUE_POLL_MS } from '../queue/state.ts'
import { steeringToFollow } from '../task-inbox/follow-up.ts'
import { followUpReplies, repliesToFollow } from '../cli/reply-retry.ts'
import { candidates, effectiveDispatch } from '../dispatch/config.ts'
import { saveEventId, savedReceipt, type SaveCommand } from './save-receipts.ts'
import { ATTACHMENT_NAME, IMAGE_TYPES, MAX_IMAGE_BYTES, imageExtension, imageLine, imageType } from '../attachments/images.ts'
import { systemReminderScheduler, type ReminderScheduler } from '../tasks/reminder-scheduler.ts'
import { fireReminders } from '../tasks/fire-reminders.ts'
import { reminderDeadline, waitingReminders } from '../tasks/reminders.ts'
import { listFolders } from '../projects/folders.ts'
import { doneDeadline } from '../tasks/retention-rules.ts'
import { hideDone } from '../tasks/retention.ts'
import { settleDone, settles } from '../projects/copies.ts'
import { execFile, type ChildProcess } from 'node:child_process'
import { latestMessage, readThread, threadPath, THREAD_CURSOR, type LatestMessage, type LatestRead, type ThreadPage } from '../thread/read.ts'
import type { CurrentAction } from '../thread/calls.ts'
import type { Catalog, CatalogLocations } from '../thread/catalog.ts'
import { createCatalogIndex } from '../thread/catalog-index.ts'
import { HYDRA_CARD, hydraConfig, hydraEvent } from '../core/hydra.ts'
import { wakeReasons } from '../core/wake-reasons.ts'
import { paseoHistory, PASEO_HISTORY_CURSOR } from '../integrations/paseo/history.ts'
import { findCard } from '../tasks/push-rules.ts'
import { search as oracleSearch, updateIndex } from '../oracle/index.ts'
import { replyRoute } from '../core/route.ts'
import { paseoConversation, type PaseoConversation } from '../integrations/paseo/thread.ts'
import { watchHomes } from '../integrations/firstmate/cli.ts'
import { resolveHome } from '../integrations/firstmate/home.ts'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { watchPath, type PathWatch } from './watch.ts'
import { background } from './background.ts'
import { basename, dirname, join } from 'node:path'
import { AxiError } from 'axi-sdk-js'
import { ingestSpool } from '../integrations/hooks/ingest.ts'
import { integrationsCommand } from '../integrations/cli.ts'
import { browserCommand } from './server-browser.ts'
import type { HydraEvent } from './model.ts'
import { HydraError } from '../store/errors.ts'
import type { ViewPreferences } from '../preferences/model.ts'
import type { Card } from '../tasks/model.ts'
import { type ReplyState } from '../core/model.ts'
import { reduce } from './reducer.ts'
import { traces, viewFor } from '../preferences/view.ts'
import { hydraDir, hydraIds } from './home-migration.ts'
import { loadHydra } from './store.ts'
import { withWriter } from './writer.ts'
import { readEvents, readEventsFrom } from './event-log.ts'
import { spoolWrite } from './spool.ts'
import { privateDir, spoolDir, spoolFiles } from '../store/storage.ts'
import { UPGRADE_SUGGESTION, type UpgradeStatus } from '../upgrade/model.ts'
import { hydraIdentity, infoPath, localToken, readServer, socketPath, type ServerInfo } from './server-state.ts'
import { createHydra, listHydras, renameHydra } from './server-hydras.ts'
import { hostRequest } from './host-request.ts'
import { createHost, type QueryFn } from './host.ts'
import type { SpawnCodex } from '../server/codex.ts'
import { commands, RESUME_LIMIT, MAX_BUFFERED, MAX_BODY, CLI_COMMANDS, type ServerMessage, type HydraClient, type HydraSubscription, type MountedHydra, type HydraRequest } from './server-transport.ts'
import { readBytes, readBody, buildId, reply, serveStatic } from './server-http.ts'
import { listenIngest } from '../integrations/hooks/socket.ts'

const ORACLE_LIMIT = 100

const shownTraces = ({
  view,
  card,
}: {
  view: ViewPreferences
  card: string
}) => {
  const {
    tools,
    thinking,
  } = traces({
    view: viewFor({ state: { view } }),
    card,
  })

  return `${tools}:${thinking}`
}

const LATEST_DELAY_MS = 200

export const RETRY_MS = 60_000
export const UPGRADE_CHECK_MS = 24 * 60 * 60_000
export const CREATION_POLL_MS = 1000
const EVENT_POLL_MS = 500
// How often replies a route could not confirm are checked for a resend.
const REPLY_POLL_MS = 30_000
// A worker mid-write gets this long to finish on shutdown before it is killed.
const WORKER_GRACE_MS = 5000
// The CLI owns reply writes and delivery; a child keeps slow native sends off the server event loop.
const REPLY_WORKER = join(
  import.meta.dirname,
  '..',
  'cli',
  import.meta.url.endsWith('.ts') ? 'reply-worker.ts' : 'reply-worker.js',
)
const REPLY_WORKER_TIMEOUT_MS = 130_000

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
  reviewClock,
  reminderScheduler = systemReminderScheduler,
  open,
  release,
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
  reminderScheduler?: ReminderScheduler
  reviewClock?: Pick<Parameters<typeof startReviewTimer>[0], 'now' | 'interval'>
  open({ id }: { id: string }): Promise<string>
  release(): void
  hydrasChanged(): void
  upgradeRoot?: string
  restart?(): void
  upgradeStatus(): UpgradeStatus | undefined
}): Promise<MountedHydra> {
  if (await readServer({ hydraId })) {
    throw new HydraError({
      message: `a server is already running for Hydra ${hydraId}`,
      code: 'ALREADY_RUNNING',
      help: ['Run `pnyx-axi` to see its address'],
    })
  }

  let homes = (given ?? []).map(path => resolveHome({ path }))
  type Subscription = {
    card: string
    path?: string
    paseo?: string
    watcher?: { close(): unknown }
    native?: Promise<PaseoConversation>
  }
  const clients = new Set<HydraClient>()
  const subscriptions = new Map<HydraClient, Subscription>()
  const hydraSubscriptions = new Map<HydraClient, Subscription>()
  const threadSubscriptions = [
    subscriptions,
    hydraSubscriptions,
  ]
  const hydraSubscribers = new WeakSet<HydraClient>()
  const subscriptionMap = ({ card }: { card: string }) =>
    card === HYDRA_CARD ? hydraSubscriptions : subscriptions
  const threadTimers = new Map<HydraClient, ReturnType<typeof setTimeout>>()
  // Set by close(): work already scheduled then must not open new watchers or timers.
  let closed = false

  const refreshThread = ({ ws }: { ws: HydraClient }) => {
    if (closed || threadTimers.has(ws)) {
      return
    }

    threadTimers.set(
      ws,
      setTimeout(
        () => background({
          name: 'conversation refresh',
          run: () => {
            threadTimers.delete(ws)

            if (ws.readyState !== ws.OPEN) {
              return
            }

            for (const map of threadSubscriptions) {
              const sub = map.get(ws), card = sub && state.cards[sub.card]

              if (!card) {
                continue
              }

              const unavailable = () => send({
                ws,
                message: {
                  type: 'error',
                  id: null,
                  code: 'THREAD_UNAVAILABLE',
                  error: 'Conversation could not be refreshed',
                },
              })

              if (sub.native) {
                const native = sub.native
                background({
                  name: 'native conversation refresh',
                  run: () => paseoHistory({
                    card: card.id,
                    conversation: { read: async ({ before }) => (await native).read({ before }) },
                    readSaved: ({ before }) => readThread({
                      hydraId,
                      state,
                      card,
                      homes,
                      before,
                    }),
                  }).then(
                    thread => {
                      if (map.get(ws) === sub && ws.readyState === ws.OPEN) {
                        send({
                          ws,
                          message: {
                            type: 'thread',
                            thread,
                          },
                        })
                      }
                    },
                    unavailable,
                  ),
                })

                continue
              }

              try {
                send({
                  ws,
                  message: {
                    type: 'thread',
                    thread: agents.thread({
                      card,
                      page: readThread({
                        hydraId,
                        state,
                        card,
                        homes,
                      }),
                    }),
                  },
                })
              } catch {
                unavailable()
              }
            }
          },
        }),
        LATEST_DELAY_MS,
      ),
    )
  }

  const threadPage = async ({
    sub,
    card,
    before,
  }: {
    sub: Subscription
    card: Card
    before?: string
  }): Promise<ThreadPage> => {
    const native = sub.native

    if (!native) {
      const page = readThread({
        hydraId,
        state,
        card,
        homes,
        before,
      })

      return before ? page : agents.thread({
        card,
        page,
      })
    }

    return paseoHistory({
      card: card.id,
      conversation: { read: async ({ before }) => (await native).read({ before }) },
      readSaved: ({ before }) => readThread({
        hydraId,
        state,
        card,
        homes,
        before,
      }),
      before,
    })
  }

  const bindThread = ({
    ws,
    card,
  }: {
    ws: HydraClient
    card: Card
  }) => {
    const map = subscriptionMap({ card: card.id })
    map.get(ws)?.watcher?.close()
    const path = threadPath({ card })
    const sub: Subscription = {
      card: card.id,
      path,
    }
    const paseo = card.agent?.paseoAgentId

    if (paseo) {
      const native = paseoConversation({
        card,
        changed: () => refreshThread({ ws }),
      })
      native.catch(() => undefined)
      const watcher = {
        close: () => void native.then(
          n => n.close(),
          () => undefined,
        ),
      }
      Object.assign(
        sub,
        {
          paseo,
          native,
          watcher,
        },
      )
    } else if (path) {
      let file: PathWatch | undefined

      const followFile = () => {
        file?.close()
        file = undefined

        try {
          file = watchPath({
            path,
            changed: () => refreshThread({ ws }),
          })
        } catch { /* The folder watcher retries when the transcript appears. */ }
      }

      try {
        const folder = watchPath({
          path: dirname(path),
          changed: ({ filename }) => {
            if (!filename || String(filename) === basename(path)) {
              followFile()
              refreshThread({ ws })
            }
          },
        })
        sub.watcher = {
          close: () => {
            folder.close()
            file?.close()
          },
        }
        followFile()
      } catch { /* Missing transcript remains explicit. */ }
    }

    map.set(
      ws,
      sub,
    )
  }

  const dir = hydraDir({ hydraId })
  const eventsPath = join(
    dir,
    'events.jsonl',
  )
  privateDir({ dir: spoolDir({ dir }) })
  const token = Buffer.from(localToken())
  const identity = hydraIdentity({ hydraId })
  let {
    state,
    offset,
  } = loadHydra({ hydraId })
  const catalogIndex = createCatalogIndex({ locations: catalogLocations })

  const catalogCard = ({
    card,
    provider,
  }: {
    card: Card
    provider?: string
  }): Card => {
    if (card.id !== HYDRA_CARD) {
      return card
    }

    const cwd = card.agent?.cwd ?? join(
      dir,
      'agent',
    )

    if (!card.agent?.cwd) {
      mkdirSync(
        cwd,
        { recursive: true },
      )
    }

    return {
      ...card,
      agent: {
        ...card.agent,
        sessionId: card.agent?.sessionId ?? '',
        cwd,
        provider: provider ?? card.agent?.provider ?? 'claude',
      },
    }
  }

  const warmCatalog = async () => {
    const card = state.cards[HYDRA_CARD]

    if (!card) {
      return
    }

    await Promise.all([
      'claude',
      'codex',
    ].map(provider => catalogIndex.read({
      card: catalogCard({
        card,
        provider,
      }),
      projects: state.projects,
    })))
  }

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
  let derivedThrough = -1
  let derivedHistory: HydraEvent[] = []

  const derivationEvents = () => {
    if (state.seq !== derivedThrough) {
      derivedHistory = readEvents({ hydraId })
      derivedThrough = state.seq
    }

    return derivedHistory
  }

  const resyncing = new WeakSet<HydraClient>()

  const send = ({
    ws,
    message,
  }: {
    ws: HydraClient
    message: ServerMessage
  }) => {
    if (ws.bufferedAmount > MAX_BUFFERED) {
      resyncing.add(ws)

      return
    }

    if (ws.readyState === ws.OPEN) {
      ws.send({ message })
    }
  }

  const sendQueue = ({ ws }: { ws: HydraClient }) => send({
    ws,
    message: {
      type: 'hydraQueue',
      queue: agents.queue(),
    },
  })

  const sendSnapshot = ({ ws }: { ws: HydraClient }) => {
    resyncing.delete(ws)
    send({
      ws,
      message: {
        type: 'snapshot',
        seq: state.seq,
        state,
      },
    })
    ws.send({
      message: {
        type: 'latest',
        ...spendNow,
        messages: latest,
        actions,
      },
    })

    // A tab starts every snapshot with an empty queue.
    const queue = agents.queue()

    if (queue.waiting.length || queue.reading.length) {
      sendQueue({ ws })
    }

    if (hydraSubscribers.has(ws)) {
      ws.send({
        message: {
          type: 'hydras',
          hydraId,
          hydras: listHydras(),
        },
      })
    }
  }

  // ponytail: a lagging tab gets its snapshot on the next change, not when its buffer drains.
  const broadcast = ({ event }: { event: HydraEvent }) => {
    for (const ws of clients) {
      if (!resyncing.has(ws)) {
        send({
          ws,
          message: {
            type: 'event',
            event,
          },
        })
      } else if (ws.bufferedAmount <= MAX_BUFFERED) {
        sendSnapshot({ ws })
      }

      for (const map of threadSubscriptions) {
        const sub = map.get(ws)

        // A view change that switches this card's traces on or off changes its page.
        if (sub && (sub.card === event.cardId
        || (event.type === 'task.session' && sub.card === event.data.before)
        || (event.type === 'board.view' &&
          shownTraces({
            view: event.data.before,
            card: sub.card,
          })
          !== shownTraces({
            view: event.data.after,
            card: sub.card,
          })))) {
          const card = state.cards[sub.card]

          if (card && (sub.path !== threadPath({ card })
            || sub.paseo !== card.agent?.paseoAgentId)) {
            bindThread({
              ws,
              card,
            })
          }

          refreshThread({ ws })
        }
      }
    }
  }

  const reload = () => {
    ({
      state,
      offset,
    } = loadHydra({ hydraId }))
    recent = []
    agents.reconcile({ state })
    followHome()

    for (const ws of clients) {
      sendSnapshot({ ws })
    }

    touchLatest({ ids: Object.keys(state.cards) })
    hydrasChanged()
  }

  // Each card's last conversation message, read from its transcript tail and pushed
  // to every tab. A card is read again when it gets an event or its transcript
  // changes: transcript folders are watched, as a live session writes between hook events.
  // File watches and stat polling cover content writes a native folder watch does not report.
  // ponytail: one watcher per transcript folder, never released while the server runs; release ended sessions' folders if that grows.
  // Task tokens, counted off the event loop; tabs get them once the first count is in.
  let spendNow: { spend?: Record<string, TaskSpend> } = {}
  const spend = spendCounter({
    inputs: () => spendInputs({
      state,
      events: derivationEvents(),
    }),
    onSpend: ({ spend }) => {
      if (JSON.stringify(spend) === JSON.stringify(spendNow.spend)) {
        return
      }

      spendNow = { spend }

      for (const ws of clients) {
        send({
          ws,
          message: {
            type: 'latest',
            spend,
            messages: {},
            actions: {},
          },
        })
      }
    },
  })
  const latest: Record<string, LatestMessage> = {}
  const actions: Record<string, CurrentAction> = {}
  const reads = new Map<string, LatestRead>()
  const folders = new Map<string, PathWatch>()
  const transcripts = new Map<string, PathWatch>()
  const transcriptPolls = new Map<string, { close(): void }>()
  const unread = new Set<string>()
  let latestTimer: ReturnType<typeof setTimeout> | undefined

  const touchPath = ({ path }: { path: string }) => touchLatest({
    ids: Object.values(state.cards).filter(c => threadPath({ card: c }) === path)
      .map(c => c.id),
  })

  const unwatchTranscript = ({ path }: { path: string }) => {
    transcripts.get(path)?.close()
    transcripts.delete(path)
  }

  const transcriptChanged = ({ path }: { path: string }) => {
    touchPath({ path })

    for (const map of threadSubscriptions) {
      for (const [
        ws,
        sub,
      ] of map) {
        if (sub.path === path) {
          refreshThread({ ws })
        }
      }
    }
  }

  const watchTranscript = ({ path }: { path: string }) => {
    if (closed || transcripts.has(path)) {
      return
    }

    try {
      const watcher = watchPath({
        path,
        changed: () => transcriptChanged({ path }),
      })
      transcripts.set(
        path,
        watcher,
      )
    } catch {
      // A missing file is watched once the card's next event reads it again.
    }
  }

  const watchWorkingTranscripts = () => {
    const working = new Set(Object.values(state.cards).flatMap(c => (c.sessionActivity ?? c.activity) === 'working' ? threadPath({ card: c }) ?? [] : []))

    for (const path of transcripts.keys()) {
      if (!working.has(path)) {
        unwatchTranscript({ path })
      }
    }

    for (const path of working) {
      watchTranscript({ path })
    }
  }

  const watchFolder = ({ dir }: { dir: string }) => {
    if (closed || folders.has(dir)) {
      return
    }

    try {
      const watcher = watchPath({
        path: dir,
        changed: ({ filename }) => {
          if (filename) {
            touchPath({
              path: join(
                dir,
                String(filename),
              ),
            })

            return
          }

          touchLatest({
            ids: Object.values(state.cards).filter(c => {
              const path = threadPath({ card: c })

              return path && dirname(path) === dir
            })
              .map(c => c.id),
          })
        },
      })
      folders.set(
        dir,
        watcher,
      )
    } catch {
      // A missing folder is watched once the card's next event reads it again.
    }
  }

  const pollTranscripts = () => {
    const wanted = new Set(Object.values(state.cards).flatMap(c => threadPath({ card: c }) ?? []))

    for (const [
      path,
      poll,
    ] of transcriptPolls) {
      if (!wanted.has(path)) {
        poll.close()
        transcriptPolls.delete(path)
      }
    }

    for (const path of wanted) {
      if (transcriptPolls.has(path)) {
        continue
      }

      const changed = () => transcriptChanged({ path })
      // Native notices can miss content writes; stat polling follows replaced and recreated paths.
      watchFile(
        path,
        {
          interval: EVENT_POLL_MS,
          persistent: false,
        },
        changed,
      )
      transcriptPolls.set(
        path,
        {
          close: () => unwatchFile(
            path,
            changed,
          ),
        },
      )
    }
  }

  // Keeps a card's value and notes it in changes when it differs from the one last sent.
  const track = <Value>({
    store,
    changes,
    id,
    value,
  }: {
    store: Record<string, Value>
    changes: Record<string, Value | null>
    id: string
    value: Value | null
  }) => {
    if (JSON.stringify(value) === JSON.stringify(store[id] ?? null)) {
      return
    }

    if (value) {
      store[id] = value
    } else {
      delete store[id]
    }

    changes[id] = value
  }

  const readLatest = () => {
    latestTimer = undefined
    const changed: Record<string, LatestMessage | null> = {}
    const changedActions: Record<string, CurrentAction | null> = {}

    for (const id of unread) {
      const card = state.cards[id], path = card && threadPath({ card })

      if (path) {
        watchFolder({ dir: dirname(path) })
      }

      const read = path ? latestMessage({
        path,
        prev: reads.get(id),
      }) : undefined

      if (read) {
        reads.set(
          id,
          read,
        )
      } else {
        reads.delete(id)
      }

      track({
        store: latest,
        changes: changed,
        id,
        value: read?.message ?? null,
      })
      track({
        store: actions,
        changes: changedActions,
        id,
        value: card ? agents.action({
          card,
          action: read?.action ?? null,
        }) : null,
      })
    }

    unread.clear()
    watchWorkingTranscripts()
    pollTranscripts()
    spend.count()

    if (Object.keys(changed).length || Object.keys(changedActions).length) {
      for (const ws of clients) {
        send({
          ws,
          message: {
            type: 'latest',
            messages: changed,
            actions: changedActions,
          },
        })
      }
    }
  }

  function touchLatest({ ids }: { ids: Iterable<string> }) {
    if (closed) {
      return
    }

    for (const id of ids) {
      unread.add(id)
    }

    if (unread.size) {
      latestTimer ??= setTimeout(
        () => background({
          name: 'latest messages',
          run: readLatest,
        }),
        LATEST_DELAY_MS,
      )
    }
  }

  const pump = () => {
    const read = readEventsFrom({
      hydraId,
      offset,
    })

    if (!read) {
      return reload()
    }

    for (const event of read.events) {
      if (event.seq !== state.seq + 1) {
        return reload()
      }

      state = reduce({
        state,
        event,
      })
      recent.push(event)

      if (event.type === 'hydra.project') {
        void warmCatalog().catch(error => console.error(
          'pnyx catalog warmup:',
          error,
        ))
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
        const task = helperProgress({
          state,
          event,
        })

        if (task) {
          agents.wake({
            seq: event.seq,
            card: task,
            reasons: [],
            event,
          })
        } else {
          agents.unread({ seq: event.seq })
        }
      }
    }

    offset = read.end
    hydrasChanged()
    agents.reconcile({ state })
    followHome()

    if (recent.length > RESUME_LIMIT) {
      recent = recent.slice(-RESUME_LIMIT)
    }
  }

  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let cancelReminder = () => {}
  let queueRun: Promise<void> | undefined
  let queueCheckedAt = 0
  let queueNeedsRetry = false
  let followRun: Promise<void> | undefined
  let followCheckedAt = 0
  let replyRun: Promise<void> | undefined
  let replyCheckedAt = 0
  let scheduled = false

  // Reply workers write the Hydra's files, so shutdown must outlast every one of them.
  // The value says whether shutdown may kill the worker: only a follow, which the next run repeats.
  const workers = new Map<ChildProcess, boolean>()

  const startWorker = ({
    args,
    done,
  }: {
    args: string[]
    done: ({
      error,
      stdout,
    }: {
      error: Error | null
      stdout: string
    }) => void
  }) => {
    const child = execFile(
      process.execPath,
      [
        REPLY_WORKER,
        ...args,
      ],
      {
        timeout: REPLY_WORKER_TIMEOUT_MS,
        maxBuffer: MAX_BODY,
      },
      (
        error,
        stdout,
      ) => done({
        error,
        stdout,
      }),
    )
    workers.set(
      child,
      args[0] === 'inbox-follow',
    )
    child.once(
      'close',
      () => workers.delete(child),
    )
  }

  const runWorker = ({ args }: { args: string[] }) => new Promise<{ stdout: string }>((
    resolve,
    reject,
  ) => {
    if (closed) {
      return reject(new Error('Pnyx is shutting down'))
    }

    startWorker({
      args,
      done: ({
        error,
        stdout,
      }) => error ? reject(error) : resolve({ stdout }),
    })
  })

  // No worker starts once closed is set, so the map only shrinks while this waits.
  // A send is never killed here: its receipt is written after the send, and a queued reply without one stays stuck.
  const joinWorkers = async () => {
    const killer = setTimeout(
      () => workers.forEach((
        killable,
        child,
      ) => killable && child.kill('SIGKILL')),
      WORKER_GRACE_MS,
    )

    while (workers.size > 0) {
      await new Promise(resolve => [...workers.keys()][0]!.once(
        'close',
        resolve,
      ))
    }

    clearTimeout(killer)
  }

  // Resends tried so far, by retry id and time, so one that failed before its receipt still counts.
  const triedResends = new Map<string, number>()

  // A resend goes through the reply command in a child, like a send from the page.
  const resendReply = async ({
    card,
    text,
    retry,
  }: {
    card: string
    text: string
    retry: string
  }): Promise<ReplyState> => {
    try {
      const { stdout } = await runWorker({
        args: [
          'reply',
          card,
          // A text starting with a dash would otherwise read as an option.
          `--text=${text}`,
          '--idempotency-key',
          retry,
          '--hydra',
          hydraId,
          '--actor',
          'pnyx',
        ],
      })
      const receipt = JSON.parse(stdout) as { reply?: { state?: ReplyState } }
      const state = receipt.reply?.state

      if (!state) {
        return 'delivery_unknown'
      }

      return state
    } catch (error) {
      console.error(`pnyx-axi replies: resend ${retry} failed: ${(error as Error).message}`)

      return 'delivery_unknown'
    }
  }

  const kick = () => {
    if (closed || scheduled) {
      return
    }

    scheduled = true
    setImmediate(() => {
      scheduled = false

      if (closed) {
        return
      }

      let repliesPending = false

      try {
        if (spoolFiles({ dir }).length > 0) {
          ingestSpool({ hydraId })
        }

        pump()

        if (!queueRun && Date.now() - queueCheckedAt >= QUEUE_POLL_MS) {
          queueCheckedAt = Date.now()
          queueRun = (async () => {
            try {
              queueNeedsRetry = await advanceQueues({
                hydraId,
                active: () => !closed,
              })
            } catch (error) {
              queueNeedsRetry = true
              console.error(`pnyx-axi queue: ${(error as Error).message}`)
            } finally {
              queueRun = undefined
              kick()
            }
          })()
        }

        const following = needsPullRequestFollow({ state })

        if (following && !followRun && Date.now() - followCheckedAt >= followDelay) {
          followCheckedAt = Date.now()
          followRun = (async () => {
            try {
              await followPullRequests({
                hydraId,
                active: () => !closed,
              })
            } catch (error) {
              console.error(`pnyx-axi follow: ${(error as Error).message}`)
            } finally {
              followRun = undefined
              kick()
            }
          })()
        }

        const replyCheckDue = Date.now() - replyCheckedAt >= REPLY_POLL_MS
        repliesPending = repliesToFollow({ state }) || steeringToFollow({ state })

        if (!replyRun && repliesPending && replyCheckDue) {
          replyCheckedAt = Date.now()
          replyRun = (async () => {
            try {
              if (steeringToFollow({ state })) {
                await runWorker({
                  args: [
                    'inbox-follow',
                    hydraId,
                  ],
                })
              }

              if (closed) {
                return
              }

              await followUpReplies({
                hydraId,
                tried: triedResends,
                resend: resendReply,
                unconfirmed: agents.unconfirmed,
              })
            } catch (error) {
              if (!closed) {
                console.error(`pnyx-axi replies: ${(error as Error).message}`)
              }
            } finally {
              replyRun = undefined
              kick()
            }
          })()
        }

        sources.reconcile()
        review.check()
        fireReminders({
          hydraId,
          at: new Date(reminderScheduler.now()).toISOString(),
        })
        pump()
        const deadline = doneDeadline({ state })

        if (deadline !== undefined && deadline <= Date.now()) {
          hideDone({ hydraId })
          pump()
        }

        // ponytail: git runs synchronously here; move it off the event loop if copies get slow to settle.
        if (Object.values(state.cards).some(card => settles({ card }))) {
          settleDone({ hydraId })
          pump()
        }
      } catch (error) {
        // A held lock or a damaged log; the next change retries.
        console.error(`pnyx-axi serve: ${(error as Error).message}`)
      } finally {
        clearTimeout(expiryTimer)
        cancelReminder()
        const reminder = reminderDeadline({ state })

        if (reminder !== undefined) {
          cancelReminder = reminderScheduler.schedule({
            at: reminder,
            fire: kick,
          })
        }

        const deadlines = [
          sourceDeadline({ state }),
          sources.deadline(),
          doneDeadline({ state }),
          ...(!queueRun && (queueNeedsRetry || Object.values(state.cards).some(c => c.queue))
            ? [queueCheckedAt + QUEUE_POLL_MS] : []),
        ]
          .filter((at): at is number => at !== undefined)

        if (!followRun && needsPullRequestFollow({ state })) {
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

  const authorized = ({ given }: { given: string | null }) => {
    const bytes = Buffer.from(given ?? '')

    return token.length > 0 && bytes.length === token.length && timingSafeEqual(
      bytes,
      token,
    )
  }

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
      for (const ws of clients) {
        sendQueue({ ws })
      }
    },
    streamed: ({ session }) => {
      touchLatest({
        ids: Object.values(state.cards).filter(card => card.agent && `${card.agent.provider}:${card.agent.sessionId}` === session)
          .map(card => card.id),
      })

      for (const map of threadSubscriptions) {
        for (const [
          ws,
          sub,
        ] of map) {
          const agent = state.cards[sub.card]?.agent

          if (agent && `${agent.provider}:${agent.sessionId}` === session) {
            refreshThread({ ws })
          }
        }
      }
    },
  })

  const sources = createSourceRunner({
    hydraId,
    changed: kick,
  })

  const review = startReviewTimer({
    hydraId,
    now: reviewClock?.now,
    interval: reviewClock?.interval,
    wake: kick,
    busy: () => agents.queue().waiting.length > 0 || agents.queue().reading.length > 0,
  })

  // The server has already checked Host and Origin.
  const request = ({
    req,
    res,
    path,
    search,
  }: HydraRequest) => {
    // The CLI asks here to start or message an agent this server runs. A page cannot
    // send this header cross-origin without a preflight, which this server never answers.
    if (req.method === 'POST' && path === '/host') {
      if (!authorized({
        given: req.headers.authorization?.replace(
          /^Bearer /,
          '',
        ) ?? null,
      })) {
        return reply({
          res,
          status: 401,
          body: {
            error: 'missing or wrong token',
            code: 'UNAUTHORIZED',
          },
        })
      }

      return readBody({ req }).then(body => hostRequest({
        host: agents,
        body,
      }))
        .then(
          answer => reply({
            res,
            status: 200,
            body: answer,
          }),
          (error: Error) => reply({
            res,
            status: 400,
            body: {
              error: error.message,
              code: error instanceof HydraError ? error.code : 'UNKNOWN',
              help: error instanceof HydraError ? error.help : [],
            },
          }),
        )
    }

    // An image dropped or pasted into a composer; the message then carries its path.
    if (req.method === 'POST' && path === '/attachments') {
      if (!authorized({
        given: req.headers.authorization?.replace(
          /^Bearer /,
          '',
        ) ?? null,
      })) {
        return reply({
          res,
          status: 401,
          body: {
            error: 'missing or wrong token',
            code: 'UNAUTHORIZED',
          },
        })
      }

      const extension = imageExtension({ type: req.headers['content-type'] ?? '' })

      if (!extension) {
        return reply({
          res,
          status: 415,
          body: {
            error: `images only: ${Object.values(IMAGE_TYPES).join(', ')}`,
            code: 'VALIDATION_ERROR',
          },
        })
      }

      return readBytes({
        req,
        limit: MAX_IMAGE_BYTES,
      }).then(
        bytes => {
          const folder = join(
              dir,
              'attachments',
            ), file = join(
              folder,
              `${randomUUID()}${extension}`,
            )

          try {
            privateDir({ dir: folder })
            writeFileSync(
              file,
              bytes,
              { mode: 0o600 },
            )
          } catch (error) {
            return reply({
              res,
              status: 500,
              body: {
                error: `could not store the image: ${(error as Error).message}`,
                code: 'UNKNOWN',
              },
            })
          }

          reply({
            res,
            status: 200,
            body: {
              path: file,
              line: imageLine({ path: file }),
            },
          })
        },
        (error: Error) => reply({
          res,
          status: 413,
          body: {
            error: error.message,
            code: 'VALIDATION_ERROR',
          },
        }),
      )
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reply({
        res,
        status: 405,
        body: {
          error: 'method not allowed',
          code: 'METHOD_NOT_ALLOWED',
        },
      })
    }

    const attachment = /^\/attachments\/([^/]+)$/.exec(path)?.[1]

    // An <img> cannot send a header, so the page passes its token in the query, as for the WebSocket.
    if (attachment !== undefined) {
      if (!authorized({
        given: new URL(
          req.url ?? '/',
          'http://localhost',
        ).searchParams.get('token'),
      })) {
        return reply({
          res,
          status: 401,
          body: {
            error: 'missing or wrong token',
            code: 'UNAUTHORIZED',
          },
        })
      }

      try {
        if (!ATTACHMENT_NAME.test(attachment)) {
          throw new Error('not an attachment')
        }

        const body = readFileSync(join(
          dir,
          'attachments',
          attachment,
        ))

        return void res.writeHead(
          200,
          {
            'content-type': imageType({ path: attachment })!,
            'x-content-type-options': 'nosniff',
            'cache-control': 'private, max-age=31536000, immutable',
          },
        )
          .end(body)
      } catch {
        return reply({
          res,
          status: 404,
          body: {
            error: 'attachment not found',
            code: 'NOT_FOUND',
          },
        })
      }
    }

    if (path === '/folders') {
      const query = new URL(
        req.url ?? '/',
        'http://localhost',
      ).searchParams

      return listFolders({
        path: query.get('path') ?? '',
        repository: query.get('repository') ?? '',
      }).then(
        body => reply({
          res,
          status: 200,
          body,
        }),
        (error: Error) => reply({
          res,
          status: 400,
          body: {
            error: error.message,
            code: 'FOLDER_UNAVAILABLE',
          },
        }),
      )
    }

    if (path === '/reminders') {
      const reminders = waitingReminders({ state })

      return reply({
        res,
        status: 200,
        body: {
          count: reminders.length,
          reminders,
        },
      })
    }

    if (path === '/health') {
      return reply({
        res,
        status: 200,
        body: {
          hydraId,
          pid: process.pid,
          build: buildId(),
        },
      })
    }

    const page = {
      token: token.toString(),
      identity,
      base: new URL(url).pathname,
    }
    serveStatic({
      res,
      path,
      home: `${page.base}${search}`,
      page,
    })
  }

  setImmediate(() => {
    if (!closed) {
      void warmCatalog().catch(error => console.error(
        'pnyx catalog warmup:',
        error,
      ))
    }
  })

  const catalogReads = new WeakMap<HydraClient, {
    scope: string
    read: Promise<Catalog>
  }>()

  const runCommand = ({
    ws,
    message,
  }: {
    ws: HydraClient
    message: {
      id?: unknown
      name?: unknown
      args?: unknown
    }
  }) => {
    const id = typeof message.id === 'string' ? message.id : null

    const fail = ({
      error,
      code,
      help,
    }: {
      error: string
      code: string
      help?: string[]
    }) => {
      let saved: boolean | undefined

      if (id && typeof message.name === 'string' && Array.isArray(message.args) && message.args.every(arg => typeof arg === 'string')) {
        const command: SaveCommand = {
          type: 'command',
          id,
          name: message.name,
          args: message.args,
        }

        if (saveEventId({ command })) {
          try {
            const receipt = savedReceipt({
              command,
              state: loadHydra({ hydraId }).state,
            })

            if (receipt) {
              send({
                ws,
                message: {
                  ...receipt,
                  type: 'receipt',
                  id,
                },
              })

              return
            }

            // A concurrent request may still commit after a lock or I/O failure.
            saved = code === 'VALIDATION_ERROR' || code === 'NO_ROUTE' ? false : undefined
          } catch { /* An unreadable log cannot establish whether the save committed. */ }
        }
      }

      send({
        ws,
        message: {
          type: 'error',
          id,
          error,
          code,
          help,
          saved,
        },
      })
    }

    const {
      name,
      args,
    } = message

    if (id === null) {
      return fail({
        error: 'command needs a string id',
        code: 'VALIDATION_ERROR',
      })
    }

    if ([
      'thread',
      'oracle',
      'reply',
      'task-message',
      'answer',
      'agent',
      'catalog',
      'hydras',
      'hydra-agent',
      'models',
      'compact',
    ].includes(String(name))) {
      if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) {
        return fail({
          error: 'args must be strings',
          code: 'VALIDATION_ERROR',
        })
      }

      try {
        if (name === 'compact') {
          if (args.length < 1 || args.length > 2) {
            throw new HydraError({
              message: 'compact expects a card and an optional queued message ID',
              code: 'VALIDATION_ERROR',
            })
          }

          void agents.compact({
            card: args[0]!,
            sendNow: args[1],
          }).then(
            result => send({
              ws,
              message: {
                type: 'receipt',
                id,
                ...result,
              },
            }),
            (error: Error) => fail({
              error: error.message,
              code: error instanceof HydraError ? error.code : 'UNKNOWN',
            }),
          )
        } else if (name === 'models') {
          const harness = args[0]

          if (args.length !== 1 || (harness !== 'claude' && harness !== 'codex')) {
            throw new HydraError({
              message: 'models expects claude or codex',
              code: 'VALIDATION_ERROR',
            })
          }

          void agents.models({ harness })
            .then(models => send({
              ws,
              message: {
                type: 'receipt',
                id,
                models,
              },
            }))
            .catch(() => fail({
              error: 'Harness model catalog unavailable. Reopen the picker to retry.',
              code: 'CATALOG_UNAVAILABLE',
            }))
        } else if (name === 'catalog') {
          if (args.length !== 1) {
            throw new HydraError({
              message: 'catalog expects a card',
              code: 'VALIDATION_ERROR',
            })
          }

          const card = findCard({
            state,
            ref: args[0],
          })
          const config = hydraConfig({ state })
          const effective = effectiveDispatch({
            hydraId,
            state,
          })
          const receiving = card.id === HYDRA_CARD
            ? config.hydra.agent?.harness
              ?? effective.dispatch.rules.hydra?.candidates[0]?.harness
              ?? effective.dispatch.default[0]?.harness
            : card.agent?.provider
          const currentCard = catalogCard({
            card,
            provider: receiving,
          })
          const scope = JSON.stringify([
            card.id,
            receiving,
            state.projectsRevision,
          ])
          let entry = catalogReads.get(ws)

          if (entry?.scope !== scope) {
            const previous = entry?.read.catch(() => undefined)
            const next = {
              scope,
              read: Promise.resolve(previous).then(async () => {
                const native = await agents.catalogCommands({
                  card,
                  provider: receiving,
                })
                const catalog = await catalogIndex.read({
                  card: currentCard,
                  projects: state.projects,
                })

                return {
                  ...catalog,
                  suggestions: [
                    ...card.id === HYDRA_CARD ? [UPGRADE_SUGGESTION] : [],
                    ...catalog.suggestions,
                    ...native,
                  ],
                  provider: receiving,
                }
              }),
            }
            catalogReads.set(
              ws,
              entry = next,
            )
            void next.read.catch(() => undefined).finally(() => {
              if (catalogReads.get(ws) === next) {
                catalogReads.delete(ws)
              }
            })
          }

          void entry.read.then(catalog => send({
            ws,
            message: {
              type: 'receipt',
              id,
              catalog,
            },
          })).catch(() => fail({
            error: 'Local catalog unavailable',
            code: 'CATALOG_UNAVAILABLE',
          }))
        } else if (name === 'oracle') {
          if (args.length > 3 || (args[2] !== undefined && args[2] !== 'hydra')) {
            throw new HydraError({
              message: 'oracle expects text, optional workspace and optional Hydra scope',
              code: 'VALIDATION_ERROR',
            })
          }

          const query = {
            text: args[0] ?? '',
            ...(args[1] ? { workspace: args[1] } : {}),
            ...(args[2] === 'hydra' ? { live: true } : {}),
            limit: ORACLE_LIMIT,
            highlight: false,
          }

          updateIndex({ hydraId })
          send({
            ws,
            message: {
              type: 'receipt',
              id,
              ...oracleSearch({
                hydraId,
                query,
              }),
            },
          })
        } else if (name === 'hydra-agent') {
          if (args.length !== 1) {
            throw new HydraError({
              message: 'hydra-agent expects one agent configuration',
              code: 'VALIDATION_ERROR',
            })
          }

          const agent = candidates({ value: [JSON.parse(args[0]!)] })[0]!
          const {
            previous,
            running,
          } = withWriter({
            hydraId,
            fn: ({ writer }) => {
              const config = hydraConfig({
                state: writer.state,
                id: hydraId,
              })

              if (Object.hasOwn(
                writer.state.eventIds,
                id,
              )) {
                return {
                  previous: config.hydra.agent,
                  running: undefined,
                }
              }

              if (config.hydra.kind === 'firstmate') {
                throw new HydraError({
                  message: 'Firstmate manages this Hydra’s agent',
                  code: 'NO_ROUTE',
                })
              }

              const decision = hydraEvent({
                state: writer.state,
                cardId: HYDRA_CARD,
                meta: {
                  id,
                  at: new Date().toISOString(),
                  actor: 'web',
                },
                change: {
                  type: 'board.configured',
                  data: {
                    ...config,
                    hydra: {
                      ...config.hydra,
                      agent,
                    },
                  },
                },
              })

              if ('event' in decision) {
                writer.append({ event: decision.event })
              }

              const running = writer.state.cards[HYDRA_CARD]?.agent

              return {
                previous: config.hydra.agent,
                running,
              }
            },
          })
          kick()

          // A new permission mode reaches Hydra's running turn at once; other settings wait for the next message.
          if (agent.mode && agent.mode !== previous?.mode && running?.host === 'pnyx'
            && running.provider === (agent.harness === 'codex' ? 'codex' : 'claude-code')) {
            void agents.set({
              card: HYDRA_CARD,
              setting: 'mode',
              value: agent.mode,
              actor: 'web',
            })
              .catch((error: Error) => console.error(`pnyx-axi serve: Hydra kept its mode: ${error.message}`))
          }

          send({
            ws,
            message: {
              type: 'receipt',
              id,
              saved: true,
            },
          })
        } else if (name === 'hydras') {
          hydraSubscribers.add(ws)
          const [
            action,
            first,
            second,
          ] = args
          const reply = ({
            open,
            creation,
          }: {
            open?: string
            creation?: {
              attempt: string
              hydraId: string
              status: 'saved'
              mount: 'pending'
            }
          } = {}) => send({
            ws,
            message: {
              type: 'receipt',
              id,
              hydraId,
              hydras: listHydras(),
              ...(open ? { url: open } : {}),
              ...(creation ? { creation } : {}),
            },
          })

          if (action === 'create') {
            if (args.length > 3 || (second !== undefined && !/^[a-zA-Z0-9._:-]{1,128}$/.test(second))) {
              throw new HydraError({
                message: 'Invalid Hydra creation attempt',
                code: 'VALIDATION_ERROR',
              })
            }

            const created = createHydra({
              name: first?.trim().slice(
                0,
                100,
              ) ?? '',
              attempt: second,
            })
            const opening = open({ id: created })

            if (second) {
              reply({
                open: new URL(
                  `/hydra/${created}/`,
                  url,
                ).href,
                creation: {
                  attempt: second,
                  hydraId: created,
                  status: 'saved',
                  mount: 'pending',
                },
              })
              void opening.catch(() => {})
            } else {
              void opening.then(
                open => reply({ open }),
                (error: Error) => fail({
                  error: error.message,
                  code: error instanceof HydraError ? error.code : 'UNKNOWN',
                }),
              )
            }
          } else if (action === 'open' && first) {
            void open({ id: first }).then(
              open => reply({ open }),
              (error: Error) => fail({
                error: error.message,
                code: error instanceof HydraError ? error.code : 'UNKNOWN',
              }),
            )
          } else if (action === 'rename' && first && second?.trim() && listHydras().some(b => b.id === first)) {
            renameHydra({
              id: first,
              name: second.trim().slice(
                0,
                100,
              ),
            })
            reply()
          } else if (action === undefined) {
            reply()
          } else {
            throw new HydraError({
              message: 'Hydras expects nothing, open <id>, create <name> or rename <id> <name>',
              code: 'VALIDATION_ERROR',
            })
          }
        } else if (name === 'thread') {
          const map = subscriptionMap({ card: args[0] ?? '' })
          const old = map.get(ws); old?.watcher?.close(); map.delete(ws)

          if (!args[0]) {
            send({
              ws,
              message: {
                type: 'receipt',
                id,
              },
            })

            return
          }

          const card = findCard({
            state,
            ref: args[0],
          })

          const cursor = card.agent?.paseoAgentId ? PASEO_HISTORY_CURSOR : THREAD_CURSOR
          const cursorLimit = card.agent?.paseoAgentId ? 600 : 200

          if (args[1] !== undefined && (args[1].length > cursorLimit || !cursor.test(args[1]))) {
            throw new HydraError({
              message: 'invalid thread cursor',
              code: 'VALIDATION_ERROR',
            })
          }

          bindThread({
            ws,
            card,
          })
          const sub = map.get(ws)!
          void threadPage({
            sub,
            card,
            before: args[1],
          }).then(
            thread => {
              if (ws.readyState === ws.OPEN) {
                send({
                  ws,
                  message: {
                    type: 'receipt',
                    id,
                    thread,
                  },
                })
              }
            },
            (error: Error) => fail({
              error: error.message,
              code: error instanceof HydraError ? error.code : 'UNKNOWN',
            }),
          )
        } else {
          const agent = name === 'agent'
          const answering = name === 'answer'

          const valid = agent
            ? args.length === 4 && !!args[3]
            : answering
              ? args.length === 5 && args.every(Boolean) && args[2].length <= 32000
              : args.length === 3 && !!args[2] && args[1].length <= 32000

          if (!valid) {
            throw new HydraError({
              message: agent
                ? 'agent expects card, setting, value and idempotency key'
                : answering ? 'answer expects card, request key, answer, idempotency key and request id' : 'reply expects card, text and idempotency key',
              code: 'VALIDATION_ERROR',
            })
          }

          const card = findCard({
            state,
            ref: args[0],
          })

          const found = replyRoute({
            card,
            homes,
          })

          if ('reason' in found && name !== 'task-message') {
            throw new HydraError({
              message: `${found.reason}${agent ? '' : ' Your draft stays here.'}`,
              code: 'NO_ROUTE',
            })
          }

          // A setting change is sent like a reply: `pnyx-axi agent` picks the harness's command and reads
          // it back. Its setting and value come last, after --, so neither can read as a flag.
          // An answer's values are passed as --name=value, so none can read as a flag.
          const [
            command,
            rest,
          ] = agent
            ? [
              [
                'agent',
                card.id,
                '--idempotency-key',
                args[3]!,
              ],
              [
                '--',
                args[1]!,
                args[2]!,
              ],
            ]
            : answering
              ? [
                [
                  'reply',
                  card.id,
                  `--answer=${args[1]}`,
                  `--json=${args[2]}`,
                  `--idempotency-key=${args[3]}`,
                  `--seen=${args[4]}`,
                ],
                [],
              ]
              : [
                [
                  'reply',
                  card.id,
                  '--text',
                  args[1],
                  '--idempotency-key',
                  args[2],
                  ...(name === 'task-message' ? ['--task-message'] : []),
                ],
                [],
              ]

          if (closed) {
            return fail({
              error: 'Pnyx is shutting down',
              code: 'UNAVAILABLE',
            })
          }

          startWorker({
            args: [
              ...command,
              '--hydra',
              hydraId,
              '--actor',
              'web',
              ...homes.flatMap(h => [
                '--home',
                h,
              ]),
              ...rest,
            ],
            done: ({
              error,
              stdout,
            }) => {
              kick()

              if (ws.readyState !== ws.OPEN) {
                return
              }

              if (error) {
                let known: {
                  message?: unknown
                  code?: unknown
                  help?: string[]
                } | undefined

                try {
                  known = JSON.parse(stdout).error
                } catch {
                  known = undefined
                }

                if (typeof known?.message === 'string' && typeof known.code === 'string') {
                  fail({
                    error: known.message,
                    code: known.code,
                    help: known.help,
                  })
                } else {
                  fail({
                    error: 'Reply could not be confirmed; check receipts before sending again',
                    code: 'DELIVERY_UNKNOWN',
                  })
                }
              } else {
                try {
                  send({
                    ws,
                    message: {
                      type: 'receipt',
                      id,
                      ...JSON.parse(stdout),
                    },
                  })
                } catch {
                  fail({
                    error: 'Reply receipt unavailable; check history',
                    code: 'DELIVERY_UNKNOWN',
                  })
                }
              }
            },
          })
        }
      } catch (error) {
        fail({
          error: (error as Error).message,
          code: error instanceof HydraError ? error.code : 'UNKNOWN',
        })
      }

      return
    }

    if (typeof name !== 'string' || !(CLI_COMMANDS as readonly string[]).includes(name)) {
      return fail({
        error: `unknown command: ${String(name)}`,
        code: 'NOT_FOUND',
        help: [`Use one of ${CLI_COMMANDS.join(', ')}`],
      })
    }

    if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) {
      return fail({
        error: 'args must be [string, ...]',
        code: 'VALIDATION_ERROR',
      })
    }

    if (args.some(a => a === '--hydra' || a.startsWith('--hydra='))) {
      return fail({
        error: `--hydra is not allowed; this server writes Hydra ${hydraId}`,
        code: 'VALIDATION_ERROR',
      })
    }

    const actor = name === 'history' || name === 'card' || name === 'integrations' || args.some(a => a === '--actor' || a.startsWith('--actor=')) ? [] : [
      '--actor',
      'web',
    ]

    const failed = ({ error }: { error: unknown }) => error instanceof AxiError
      ? fail({
        error: error.message,
        code: error.code,
        help: error.suggestions,
      })
      : fail({
        error: (error as Error).message,
        code: 'UNKNOWN',
      })

    try {
      const handler = name === 'integrations' ? integrationsCommand : commands[name as Exclude<(typeof CLI_COMMANDS)[number], 'integrations'>]
      void Promise.resolve(browserCommand.run(
        true,
        () => handler([
          ...args,
          ...actor,
          '--hydra',
          hydraId,
        ]),
      )).then(
        result => {
          try {
            pump()
          } catch {
            kick()
          }

          send({
            ws,
            message: {
              ...result,
              type: 'receipt',
              id,
            },
          })
        },
        error => failed({ error }),
      )
    } catch (error) {
      failed({ error })
    }
  }

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

    resume({
      ws,
      after,
    })

    return {
      receive({ message }) {
        if (message?.type === 'resync') {
          sendSnapshot({ ws })
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
        clients.delete(ws)
        hydraSubscribers.delete(ws)
        catalogReads.delete(ws)
        clearTimeout(threadTimers.get(ws))
        threadTimers.delete(ws)

        for (const map of threadSubscriptions) {
          map.get(ws)?.watcher?.close()
          map.delete(ws)
        }
      },
    }
  }

  // A cursor this server can continue from gets only the events after it; any
  // other cursor (ahead of the Hydra, older than the kept events, or none) gets a snapshot.
  // Either way the tab then gets every card's last message.
  const resume = ({
    ws,
    after,
  }: {
    ws: HydraClient
    after: string | null
  }) => {
    const seq = after !== null && /^\d+$/.test(after) ? Number(after) : undefined
    const first = recent[0]?.seq ?? state.seq + 1

    if (seq === undefined || seq > state.seq || seq < first - 1) {
      return sendSnapshot({ ws })
    }

    for (const event of recent) {
      if (event.seq > seq) {
        send({
          ws,
          message: {
            type: 'event',
            event,
          },
        })
      }
    }

    send({
      ws,
      message: {
        type: 'latest',
        ...spendNow,
        messages: latest,
        actions,
      },
    })
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
    unwatchFile(
      eventsPath,
      kick,
    )
    await Promise.all([
      queueRun,
      replyRun,
      followRun,
      joinWorkers(),
    ])
    await sources.close()
    firstmate?.close()
    review.close()
    catalogIndex.close()
    agents.close()
    await spend.close()

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
    threadSubscriptions.forEach(map => map.clear())
    clearTimeout(latestTimer)
    clearTimeout(expiryTimer)
    cancelReminder()

    for (const timer of threadTimers.values()) {
      clearTimeout(timer)
    }

    threadTimers.clear()

    for (const ws of clients) {
      ws.terminate()
    }

    clients.clear()
    await (ingest && new Promise(r => ingest.close(r)))
    rmSync(
      infoPath({ hydraId }),
      { force: true },
    )

    if (ingest) {
      rmSync(
        socketPath({ hydraId }),
        { force: true },
      )
    }
  }

  const info: ServerInfo = {
    pid: process.pid,
    port: Number(new URL(url).port),
    url,
    socket: ingest && socketPath({ hydraId }),
  }

  // A mount that fails partway stops what it started; the caller releases the claim.
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
    // Directory notifications can coalesce rapid appends; stat polling recovers the missed tail.
    watchFile(
      eventsPath,
      {
        interval: EVENT_POLL_MS,
        persistent: false,
      },
      kick,
    )
    followHome()
    const tmp = `${infoPath({ hydraId })}.tmp-${process.pid}`
    writeFileSync(
      tmp,
      JSON.stringify(info),
    )
    renameSync(
      tmp,
      infoPath({ hydraId }),
    )
  } catch (error) {
    await stop()
    throw error
  }

  try {
    await agents.recover()
  } catch (error) {
    console.error(`pnyx-axi serve: ${(error as Error).message}`)
  }

  kick()
  touchLatest({ ids: Object.keys(state.cards) })

  return {
    url,
    socket: info.socket,
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
      release()
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

// A fixed default keeps every Hydra at one address, so an open tab finds a restarted server again.
export { DEFAULT_PORT } from './server-state.ts'

// Usually one process; a server an older version started for a single Hydra counts too.
export async function serverPids(): Promise<number[]> {
  const found = await Promise.all(hydraIds().map(hydraId => readServer({ hydraId })))

  return [...new Set(found.flatMap(info => info ? [info.pid] : []))]
}
