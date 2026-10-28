import { HOST_LABEL, replyRoute } from '../../core/route.ts'
import { HydraError } from '../../store/errors.ts'
import type { Card } from '../../tasks/model.ts'
import { localPaseoUrl } from './url.ts'
import { cardSessionId } from '../../core/tasks.ts'
import { replyEntryId, splitEntry, type ThreadEntry, type ThreadPage } from '../../thread/read.ts'
import { openPaseo, type Connect } from './client.ts'

// An older page's cursor: p, then Paseo's own {epoch, seq} as base64url JSON.
export const PASEO_CURSOR = /^p[A-Za-z0-9_-]{1,190}$/
const PAGE = 50

export interface PaseoConversation {
  read({ before }: { before?: string }): Promise<ThreadPage>
  close(): void
}

export async function paseoConversation({
  card,
  changed,
  connect = ({ url }) => openPaseo({
    url,
    reconnect: true,
  }),
}: {
  card: Card
  changed(): void
  connect?: Connect
}): Promise<PaseoConversation> {
  const {
    paseoUrl: url,
    paseoAgentId: id,
  } = card.agent ?? {}

  if (!url || !id) {
    throw new HydraError({
      message: 'this task has no Paseo agent',
      code: 'NOT_FOUND',
    })
  }

  const client = await connect({ url: localPaseoUrl({ url }) })
  const agent = client.agents.ref(id)
  const live = agent.timeline.subscribe(() => changed())

  try {
    await live.ready
  } catch (error) {
    await client.close().catch(() => undefined)
    throw error
  }

  const found = replyRoute({
    card,
    homes: [],
  })

  return {
    async read({ before }) {
      const cursor = before ? JSON.parse(Buffer.from(
        before.slice(1),
        'base64url',
      ).toString()) as {
        epoch: string
        seq: number
      } : undefined
      const page = await agent.timeline.refetch({
        direction: cursor ? 'before' : 'tail',
        ...(cursor ? { cursor } : {}),
        limit: PAGE,
        projection: 'projected',
      })
      const entries = page.entries.flatMap(({
        item,
        seqStart,
        timestamp,
      }) => {
        const entry = timelineEntry({
          item: item as Item,
          id: `paseo:${page.epoch}:${seqStart}`,
          at: timestamp,
        })

        return entry ? splitEntry({ entry }) : []
      })

      return {
        card: card.id,
        ...(cardSessionId({ card }) ? { session: cardSessionId({ card }) } : {}),
        entries,
        route: 'route' in found,
        ...('route' in found ? { via: HOST_LABEL[found.route.kind] } : { noRoute: found.reason }),
        watching: 'unknown',
        ...(page.hasOlder && page.startCursor ? { older: `p${Buffer.from(JSON.stringify(page.startCursor)).toString('base64url')}` } : {}),
        ...(page.staleCursor || page.gap ? { unavailable: 'Paseo replaced part of this conversation; reload the latest messages.' } : {}),
      }
    },
    close() {
      void live.release().finally(() => client.close())
    },
  }
}

type Item = {
  type: string
  text?: unknown
  message?: unknown
  name?: unknown
  detail?: unknown
  clientMessageId?: unknown
}

function timelineEntry({
  item,
  id,
  at,
}: {
  item: Item
  id: string
  at: string
}): ThreadEntry | undefined {
  const text = ({ value }: { value: unknown }) => (typeof value === 'string' ? value : '')

  const replyId = typeof item.clientMessageId === 'string' ? item.clientMessageId : undefined

  switch (item.type) {
    case 'user_message': return {
      id: replyId ? replyEntryId({ reply: replyId }) : id,
      at,
      kind: 'message',
      role: 'user',
      text: text({ value: item.text }),
      ...(typeof item.clientMessageId === 'string' ? { replyId: item.clientMessageId } : {}),
    }
    case 'assistant_message': return {
      id,
      at,
      kind: 'message',
      role: 'assistant',
      text: text({ value: item.text }),
    }
    case 'reasoning': return {
      id,
      at,
      kind: 'thinking',
      role: 'assistant',
      text: text({ value: item.text }),
    }
    case 'tool_call': return {
      id,
      at,
      kind: 'tool',
      role: text({ value: item.name }) || 'tool',
      text: item.detail === undefined ? 'Recorded details unavailable' : JSON.stringify(item.detail),
    }
    case 'error': return {
      id,
      at,
      kind: 'message',
      role: 'error',
      text: text({ value: item.message }),
    }
    default: return undefined
  }
}
