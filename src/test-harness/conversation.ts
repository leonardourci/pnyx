import assert from 'node:assert/strict'
import type { HydraState } from '#app/model.ts'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import { hydraConfig } from '#hydra/config.ts'
import { hydraChatQueue } from '#hydra/chat-queue.ts'
import { hydraMessages } from '#hydra/chat-messages.ts'
import { checkConversation, ownerSendOrder } from '#hydra/conversation-check.ts'
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
  const shown = hydraMessages({
    messages,
    transcript,
    provider: state.cards[HYDRA_CARD]?.agent?.provider,
    boundaries: true,
  })
  const {
    late,
    sent,
  } = ownerSendOrder({
    messages,
    expected: shown,
  })
  const expected = shown.filter(entry => {
    // A late owner message is on the page when the place it takes is.
    const shownAt = late.get(entry)?.at ?? entry.at

    return (!entry.hidden || entry.role === 'Pnyx') && entry.text.trim() !== 'NO_REPLY'
      && (oldest === undefined || shownAt === undefined || shownAt >= oldest)
  })
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
      ordered: expected.filter(entry => entry.at !== undefined && !late.has(entry)),
      sent: sent.filter(entry => expected.includes(entry)),
    }),
    [],
  )
}
