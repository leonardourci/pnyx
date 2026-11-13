import { integer, type Output, type Options } from '#app/cli-support.ts'
import { readEvents } from '#app/event-log.ts'
import { loadHydra } from '#app/store.ts'
import { findCard } from '#tasks/push-rules.ts'
import { cardSessionId } from '#workers/session-attachments.ts'
import type { HydraState } from '#app/model.ts'
import { HYDRA_CARD } from './identity.ts'
import { lookupMessages } from './message-lookup.ts'
import { hydraEntries, sessionEntries, threadPath, type SessionEntry } from './transcripts-read.ts'

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

function threadEntries({
  state,
  card,
}: {
  state: HydraState
  card: string
}): SessionEntry[] {
  if (card === HYDRA_CARD) {
    return hydraEntries({ state })
  }

  const task = state.cards[card]!
  const path = threadPath({ card: task })
  const session = cardSessionId({ card: task })

  return path && session ? sessionEntries({
    path,
    session,
    boundaries: false,
  }) : []
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
    hydraId,
    card,
    events: readEvents({ hydraId }),
    entries: threadEntries({
      state,
      card,
    }),
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
