import { noteId } from '../../tasks/notes.ts'
import { EVENT_VERSION } from '../../store/events.ts'
import type { SessionEvent } from '../../workers/model.ts'
import { localPaseoUrl } from './url.ts'
import { taskForMessage } from '../../workers/session-attachments.ts'
import { splitEntry, type ThreadEntry } from '../../hydra/transcripts-read.ts'
import { loadHydra } from '../../app/store.ts'
import { readEvents } from '../../app/event-log.ts'
import { withWriter } from '../../app/writer.ts'
import { openPaseo, type Connect } from './client.ts'

const PAGE_SIZE = 100
const HISTORY_TIMEOUT_MS = 30_000
const chatId = ({
  session,
  nativeId,
}: {
  session: string
  nativeId: string
}) =>
  noteId({
    cardKey: session,
    ref: `chat:${nativeId}`,
  })

async function collectPaseoHistory({
  session,
  url,
  id,
  known,
  connect,
}: {
  session: string
  url: string
  id: string
  known: Record<string, number>
  connect: Connect
}): Promise<ThreadEntry[]> {
  const client = await connect({ url: localPaseoUrl({ url }) })

  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    const agent = client.agents.ref(id)
    await agent.refresh()
    const entries: {
      seq: number
      entry: ThreadEntry
    }[] = []
    let cursor: {
      epoch: string
      seq: number
    } | undefined

    const deadline = Date.now() + HISTORY_TIMEOUT_MS
    const recent: {
      epoch: string
      seq?: number
      entries: number
    }[] = []
    const timedOut = () => new Error(`timed out waiting for Paseo history after ${HISTORY_TIMEOUT_MS}ms: ${JSON.stringify({
      session,
      cursor,
      collected: entries.length,
      recent,
    })}`)
    const expired = new Promise<never>((
      _,
      reject,
    ) => {
      timer = setTimeout(
        () => reject(timedOut()),
        HISTORY_TIMEOUT_MS,
      )
    })

    while (Date.now() < deadline) {
      const page = await Promise.race([
        agent.timeline.refetch({
          direction: cursor ? 'before' : 'tail',
          ...(cursor ? { cursor } : {}),
          limit: PAGE_SIZE,
          projection: 'projected',
        }),
        expired,
      ])
      recent.push({
        epoch: page.epoch,
        seq: page.startCursor?.seq,
        entries: page.entries.length,
      })
      recent.splice(
        0,
        Math.max(
          0,
          recent.length - 10,
        ),
      )
      let reachedSavedReply = false

      for (const {
        item,
        seqStart,
        timestamp,
      } of page.entries) {
        if (item.type !== 'user_message' && item.type !== 'assistant_message') {
          continue
        }

        const role = item.type === 'user_message' ? 'user' : 'assistant'

        if (role === 'assistant' && agent.activeTurn) {
          continue
        }

        const parts = splitEntry({
          entry: {
            id: `paseo:${page.epoch}:${seqStart}`,
            kind: 'message',
            role,
            text: item.text,
            at: timestamp,
          },
        })
        const saved = parts.every(part => chatId({
          session,
          nativeId: part.id,
        }) in known)
        reachedSavedReply ||= saved && role === 'assistant'
        entries.push(...parts.map(entry => ({
          seq: seqStart,
          entry,
        })))
      }

      const repeatedCursor = JSON.stringify(page.startCursor) === JSON.stringify(cursor)

      if (reachedSavedReply || !page.hasOlder || !page.startCursor || repeatedCursor) {
        return entries.sort((
          a,
          b,
        ) => a.seq - b.seq || (a.entry.part ?? 0) - (b.entry.part ?? 0))
          .map(row => row.entry)
      }

      cursor = page.startCursor
    }

    throw timedOut()
  } finally {
    clearTimeout(timer)
    await client.close().catch(() => undefined)
  }
}

export async function harvestPaseoChats({
  hydraId,
  connect = openPaseo,
}: {
  hydraId: string
  connect?: Connect
}): Promise<{
  task: string
  error: string
}[]> {
  const state = loadHydra({ hydraId }).state
  const attachments = readEvents({ hydraId }).filter((e): e is SessionEvent => e.type === 'task.session')
  const cards = Object.values(state.sessions ?? {}).flatMap(session => {
    const url = session.agent.paseoUrl, id = session.agent.paseoAgentId
    const last = attachments.findLast(e => e.data.session === session.id && e.data.after)
    const taskId = session.taskId ?? last?.data.after
    const task = taskId ? state.cards[taskId] : undefined

    return task && task.id !== '$hydra' && !task.automaticTask && session.id !== state.config?.hydra.session && url && id
      ? [
        {
          task: task.id,
          session: session.id,
          url,
          id,
          agent: `${session.agent.provider}:${session.agent.agentId ?? session.agent.sessionId}`,
        },
      ] : []
  })
  const failures: {
    task: string
    error: string
  }[] = []
  await Promise.all(cards.map(async card => {
    try {
      const entries = await collectPaseoHistory({
        ...card,
        known: state.eventIds,
        connect,
      })
      const { session } = card
      withWriter({
        hydraId,
        fn: ({ writer }) => {
          const memberships = readEvents({ hydraId }).filter((e): e is SessionEvent => e.type === 'task.session' && e.data.session === session)

          for (const entry of entries) {
            const id = chatId({
              session,
              nativeId: entry.id,
            })
            const task = taskForMessage({
              memberships,
              at: entry.at,
              fallback: card.task,
            })

            if (!(id in writer.state.eventIds) && writer.state.cards[task]) {
              writer.append({
                event: {
                  v: EVENT_VERSION,
                  seq: writer.state.seq + 1,
                  id,
                  at: entry.at ?? new Date().toISOString(),
                  actor: `session:${session}`,
                  cardId: task,
                  agentId: card.agent,
                  type: 'chat.message',
                  sessionId: session,
                  messageId: id,
                  data: {
                    session,
                    nativeId: entry.id,
                    role: entry.role,
                    text: entry.text,
                  },
                },
              })
            }
          }
        },
      })
    } catch (error) {
      failures.push({
        task: card.task,
        error: (error as Error).message,
      })
    }
  }))

  return failures
}
