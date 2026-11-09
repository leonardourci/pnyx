import assert from 'node:assert/strict'
import type { HydraState } from '#app/model.ts'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import { hydraConfig } from '#hydra/config.ts'
import { hydraChatQueue } from '#hydra/chat-queue.ts'
import { hydraMessages } from '#hydra/chat-messages.ts'
import { checkConversation } from '#hydra/conversation-check.ts'
import { joinMessageParts } from '#hydra/history.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { threadEntryOrder } from '#hydra/thread-order.ts'

export function assertConversation({
  state,
  page,
}: {
  state: HydraState
  page: ThreadPage
}) {
  assert.ok(page.conversation)
  const conversation = page.conversation
  const config = hydraConfig({ state })
  const { held } = hydraChatQueue({ state })
  const transcript = joinMessageParts({ entries: page.entries })
  const oldest = page.older ? transcript[0]?.at : undefined
  const messages = (state.hydraMessages ?? []).filter(message => message.hydra === config.hydra.id
    && !held.includes(message.id) && (state.eventIds[message.id] ?? 0) <= conversation.through)
  const expected = hydraMessages({
    messages,
    transcript,
    provider: state.cards[HYDRA_CARD]?.agent?.provider,
    boundaries: true,
  })
    .filter(entry => !entry.hidden && entry.role !== 'Pnyx' && entry.text.trim() !== 'NO_REPLY'
      && (oldest === undefined || entry.at === undefined || entry.at >= oldest))
    .sort((
      first,
      second,
    ) => threadEntryOrder({
      first,
      second,
    }))
  assert.deepEqual(
    checkConversation({
      expected,
      conversation,
      ordered: expected.filter(entry => entry.at !== undefined),
    }),
    [],
  )
}
