import { mergeThreadPages } from './thread-history.ts'
import type { HydraState } from '#app/model.ts'
import type { ThreadPage } from './transcripts-read.ts'
import { HYDRA_CARD } from './identity.ts'
import { hydraConfig } from './config.ts'
import { hydraMessagesOf } from './message-window.ts'
import { joinMessageParts } from './history.ts'
import { hydraConversation } from './conversation.ts'
import { injectedInstructions, quietReply } from './chat-messages.ts'
import { hydraChatQueue } from './chat-queue.ts'
import { pnyxRunsHydra } from './hydra.ts'

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
  // An earlier session's entries may come from another provider.
  const provider = ({ session }: { session?: string }) => (session === undefined
    ? undefined
    : state.sessions?.[session]?.agent.provider) ?? card?.agent?.provider
  const entries = page.entries.map(entry => injectedInstructions({
    entry,
    provider: provider({ session: entry.session }),
  }) ? {
      ...entry,
      hidden: true,
      text: '',
    } : entry)
  const transcript = joinMessageParts({ entries })
  const messages = hydraMessagesOf({ state })
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
    oldest: page.messagesFrom ?? (page.older ? transcript[0]?.at : undefined),
    currentTurn: page.currentTurn,
    receipts: pnyxRunsHydra({ state }),
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

export function createHydraThreadView({
  state,
  page: base,
  tools,
  thinking,
}: Parameters<typeof hydraThreadView>[0]) {
  let previous: ReturnType<typeof hydraThreadView> | undefined
  let identity: string | undefined

  return ({ page }: { page: ThreadPage }): ReturnType<typeof hydraThreadView> => {
    const live = joinMessageParts({ entries: page.entries.filter(entry => entry.id.startsWith('live:')) })
    const nextIdentity = JSON.stringify({
      currentTurn: page.currentTurn,
      live: live.map(entry => ({
        ...entry,
        text: '',
        quiet: quietReply({ entry }),
        spoken: entry.text.trim() !== '',
      })),
    })
    const merged = mergeThreadPages({
      before: base,
      latest: page,
    })

    if (!previous || nextIdentity !== identity) {
      identity = nextIdentity
      previous = hydraThreadView({
        state,
        page: merged,
        tools,
        thinking,
      })

      return previous
    }

    const texts = new Map(live.map(entry => [
      entry.id,
      entry.text,
    ]))

    const replace = ({ entry }: { entry: typeof live[number] }) => {
      const text = texts.get(entry.id)

      return text === undefined || text === entry.text ? entry : {
        ...entry,
        text,
      }
    }

    const saved = new Map(previous.entries.filter(entry => !entry.id.startsWith('live:')).map(entry => [
      entry.id,
      entry,
    ]))
    const conversation = previous.conversation
    previous = {
      ...merged,
      entries: merged.entries.map(entry => saved.get(entry.id) ?? entry),
      conversation: {
        ...conversation,
        through: state.seq,
        entries: conversation.entries.map(entry => replace({ entry })),
        folds: Object.fromEntries(Object.entries(conversation.folds).map(([
          id,
          fold,
        ]) => [
          id,
          {
            ...fold,
            notes: fold.notes.map(entry => replace({ entry })),
          },
        ])),
        trailing: Object.fromEntries(Object.entries(conversation.trailing).map(([
          id,
          entries,
        ]) => [
          id,
          entries.map(entry => replace({ entry })),
        ])),
        timings: Object.fromEntries(Object.entries(conversation.timings).map(([
          id,
          timing,
        ]) => [
          id,
          {
            ...timing,
            reply: texts.get(id) ?? timing.reply,
          },
        ])),
      },
    }

    return previous
  }
}
