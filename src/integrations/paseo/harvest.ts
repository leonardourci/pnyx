import { noteId } from '../../core/decide.ts'
import { EVENT_VERSION, type SessionEvent } from '../../core/model.ts'
import { localPaseoUrl } from '../../core/paseo.ts'
import { taskForMessage } from '../../core/tasks.ts'
import { splitEntry, type ThreadEntry } from '../../thread/read.ts'
import { loadHydra, readEvents, withWriter } from '../../store/hydra-store.ts'
import { openPaseo, type Connect } from './client.ts'

const PAGE_SIZE = 100
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

async function collect({
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

    for (;;) {
      const page = await agent.timeline.refetch({
        direction: cursor ? 'before' : 'tail',
        ...(cursor ? { cursor } : {}),
        limit: PAGE_SIZE,
        projection: 'projected',
      })
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
  } finally {
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
      const entries = await collect({
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
        error: (error as Error).message.slice(
          0,
          200,
        ),
      })
    }
  }))

  return failures
}
