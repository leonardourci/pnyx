import { dirname, join } from 'node:path'
import type { CurrentAction } from '#hydra/calls.ts'
import { latestMessage, threadPath, type LatestMessage, type LatestRead } from '#hydra/transcripts-read.ts'
import { background } from './background.ts'
import type { createHost } from './host.ts'
import type { HydraState } from './model.ts'
import type { HydraClient, ServerMessage } from './server-transport.ts'
import type { Subscription } from './thread-subscriptions.ts'
import { pollPath, watchPath, type PathWatch } from './watch.ts'

export const LATEST_DELAY_MS = 200
const EVENT_POLL_MS = 500

// Each card's last conversation message, read from its transcript tail and pushed
// to every tab. A card is read again when it gets an event or its transcript
// changes: transcript folders are watched, as a live session writes between hook events.
// File watches and stat polling cover content writes a native folder watch does not report.
// ponytail: one watcher per transcript folder, never released while the server runs; release ended sessions' folders if that grows.
export function createLatestFeed({
  state,
  closed,
  clients,
  send,
  threadSubscriptions,
  refreshThread,
  historyIndex,
  agents,
  spend,
}: {
  state(): HydraState
  closed(): boolean
  clients: Set<HydraClient>
  send({
    ws,
    message,
  }: {
    ws: HydraClient
    message: ServerMessage
  }): void
  threadSubscriptions: Map<HydraClient, Subscription>[]
  refreshThread({ ws }: { ws: HydraClient }): void
  historyIndex(): { changed(): void }
  agents(): Pick<ReturnType<typeof createHost>, 'action'>
  spend: { count(): void }
}) {
  const latest: Record<string, LatestMessage> = {}
  const actions: Record<string, CurrentAction> = {}
  const reads = new Map<string, LatestRead>()
  const folders = new Map<string, PathWatch>()
  const transcripts = new Map<string, PathWatch>()
  const transcriptPolls = new Map<string, { close(): void }>()
  const unread = new Set<string>()
  let latestTimer: ReturnType<typeof setTimeout> | undefined

  const touchPath = ({ path }: { path: string }) => touchLatest({
    ids: Object.values(state().cards).filter(c => threadPath({ card: c }) === path)
      .map(c => c.id),
  })

  const unwatchTranscript = ({ path }: { path: string }) => {
    transcripts.get(path)?.close()
    transcripts.delete(path)
  }

  const transcriptChanged = ({ path }: { path: string }) => {
    touchPath({ path })
    historyIndex().changed()

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
    if (closed() || transcripts.has(path)) {
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
    const working = new Set(Object.values(state().cards).flatMap(c => (c.sessionActivity ?? c.activity) === 'working' ? threadPath({ card: c }) ?? [] : []))

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
    if (closed() || folders.has(dir)) {
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
            ids: Object.values(state().cards).filter(c => {
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
    const wanted = new Set(Object.values(state().cards).flatMap(c => threadPath({ card: c }) ?? []))

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

      // Native notices can miss content writes; stat polling follows replaced and recreated paths.
      transcriptPolls.set(
        path,
        pollPath({
          path,
          interval: EVENT_POLL_MS,
          changed: () => transcriptChanged({ path }),
        }),
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
      const card = state().cards[id], path = card && threadPath({ card })

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
        value: card ? agents().action({
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
    if (closed()) {
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

  // A session Pnyx runs streamed: its cards' latest messages and open thread pages are read again.
  const streamed = ({ session }: { session: string }) => {
    touchLatest({
      ids: Object.values(state().cards).filter(card => card.agent && `${card.agent.provider}:${card.agent.sessionId}` === session)
        .map(card => card.id),
    })

    for (const map of threadSubscriptions) {
      for (const [
        ws,
        sub,
      ] of map) {
        const agent = state().cards[sub.card]?.agent

        if (agent && `${agent.provider}:${agent.sessionId}` === session) {
          refreshThread({ ws })
        }
      }
    }
  }

  return {
    latest,
    actions,
    folders,
    transcripts,
    transcriptPolls,
    touchLatest,
    streamed,
    get latestTimer() {
      return latestTimer
    },
  }
}
