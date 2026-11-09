import type { HydraState } from '#app/model.ts'
import type { ThreadPage } from './transcripts-read.ts'
import { HYDRA_CARD } from './identity.ts'
import { hydraConfig } from './config.ts'
import { joinMessageParts } from './history.ts'
import { hydraConversation } from './conversation.ts'
import { injectedInstructions } from './chat-messages.ts'
import { hydraChatQueue } from './chat-queue.ts'

export function hydraThreadView({
  state,
  page,
  tools,
  thinking,
}: {
  state: HydraState
  page: ThreadPage
  tools: boolean
  thinking: boolean
}): ThreadPage & { conversation: NonNullable<ThreadPage['conversation']> } {
  const config = hydraConfig({ state })
  const card = state.cards[HYDRA_CARD]
  const entries = page.entries.map(entry => injectedInstructions({
    entry,
    provider: card?.agent?.provider,
  }) ? {
      ...entry,
      hidden: true,
      text: '',
    } : entry)
  const transcript = joinMessageParts({ entries })
  const messages = (state.hydraMessages ?? []).filter(message => message.hydra === config.hydra.id)
  const {
    held,
    working,
  } = hydraChatQueue({ state })
  const conversation = hydraConversation({
    messages: messages.filter(message => !held.includes(message.id)),
    transcript,
    provider: card?.agent?.provider,
    actions: page.actions ?? [],
    columns: config.columns,
    working,
    tools,
    thinking,
    titles: Object.fromEntries(Object.values(state.cards).map(card => [
      card.id,
      card.title,
    ])),
    oldest: page.older ? transcript[0]?.at : undefined,
    currentTurn: page.currentTurn,
  })

  return {
    ...page,
    entries,
    conversation: {
      through: state.seq,
      entries: conversation.entries,
      folds: Object.fromEntries(conversation.folds),
      timings: Object.fromEntries(conversation.timings),
      trailing: Object.fromEntries(conversation.trailing),
    },
  }
}
