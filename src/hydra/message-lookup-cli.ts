import { integer, type Output, type Options } from '#app/cli-support.ts'
import { eventPositions, eventSeq, replySeq, seqsAround } from '#app/event-log.ts'
import { loadHydra } from '#app/store.ts'
import { findCard } from '#tasks/push-rules.ts'
import type { HydraState } from '#app/model.ts'
import { HYDRA_CARD } from './identity.ts'
import { lookupMessages, type LookupThread } from './message-lookup.ts'
import { messageRecords } from './message-records.ts'
import { messageWindow } from './message-window.ts'
import { nativeRecord, nativeSources } from './native-window.ts'

export const MESSAGE_LOOKUP_OPTIONS: Options = {
  id: { type: 'string' },
  seq: { type: 'string' },
  at: { type: 'string' },
  before: { type: 'string' },
  after: { type: 'string' },
  direction: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  cursor: { type: 'string' },
  budget: { type: 'string' },
  limit: { type: 'string' },
}

const NATIVE_ID = /^(.+):(\d+):m\d+$/

function lookupThread({
  hydraId,
  state,
  card,
}: {
  hydraId: string
  state: HydraState
  card: string
}): LookupThread {
  const sources = nativeSources({
    state,
    card,
  })
  const types = [card === HYDRA_CARD ? 'hydra.message' : 'card.replied']

  return {
    window: ({
      lo,
      hi,
    }) => {
      const {
        events,
        native,
        positions,
      } = messageWindow({
        hydraId,
        sources,
        cardId: card,
        types,
        lo,
        hi,
      })

      return messageRecords({
        positions,
        events,
        entries: native,
        card,
      })
    },
    locate: ({ id }) => {
      if (id.startsWith('reply:')) {
        return replySeq({
          hydraId,
          card,
          reply: id.slice('reply:'.length),
        })
      }

      const [
        , session,
        offset,
      ] = NATIVE_ID.exec(id) ?? []
      const source = sources.find(candidate => candidate.session === session)
      const entry = source && nativeRecord({
        source,
        offset: Number(offset),
      }).find(candidate => candidate.reference === id)

      if (entry) {
        return eventPositions({
          hydraId,
          entries: [
            {
              id,
              at: entry.at,
            },
          ],
        }).get(id)
      }

      return eventSeq({
        hydraId,
        id,
      })
    },
    around: ({ time }) => seqsAround({
      hydraId,
      time,
    }),
  }
}

export function messageLookup({
  values,
  hydraId,
  task,
}: {
  values: Record<string, string | boolean | undefined>
  hydraId: string
  task?: string
}): Output {
  const state = loadHydra({ hydraId }).state
  const card = task === undefined ? HYDRA_CARD : findCard({
    state,
    ref: task,
  }).id
  const page = lookupMessages({
    thread: lookupThread({
      hydraId,
      state,
      card,
    }),
    hydraId,
    card,
    snapshot: state.seq,
    selection: {
      id: values.id as string | undefined,
      seq: integer({
        value: values.seq,
        flag: '--seq',
      }),
      at: values.at as string | undefined,
      before: integer({
        value: values.before,
        flag: '--before',
      }),
      after: integer({
        value: values.after,
        flag: '--after',
      }),
      budget: integer({
        value: values.budget,
        flag: '--budget',
      }),
      limit: integer({
        value: values.limit,
        flag: '--limit',
      }),
      from: values.from as string | undefined,
      to: values.to as string | undefined,
      direction: values.direction as string | undefined,
      cursor: values.cursor as string | undefined,
    },
  })
  const command = card === HYDRA_CARD ? [
    'hydra',
    'message',
  ] : [
    'task',
    'messages',
    card,
  ]
  const continuation = ({ cursor }: { cursor: string }) =>
    `pnyx-axi ${command.join(' ')} --hydra ${hydraId} --cursor ${cursor} --budget ${page.budget} --limit ${page.limit}`
  const help: string[] = []

  if (page.older) {
    help.push(`Older: \`${continuation({ cursor: page.older })}\``)
  }

  if (page.newer) {
    help.push(`Newer: \`${continuation({ cursor: page.newer })}\``)
  }

  return {
    ...page,
    help,
  }
}
