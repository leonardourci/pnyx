import { mergeThreadPages } from './thread-history.ts'
import type { TitanState } from '#app/model.ts'
import type { ThreadPage } from './transcripts-read.ts'
import { TITAN_CARD } from './identity.ts'
import { joinMessageParts } from './history.ts'
import { titanConversation } from './conversation.ts'
import { injectedInstructions, quietReply } from './chat-messages.ts'
import { titanChatQueue } from './chat-queue.ts'
import { othrysRunsTitan } from './titan.ts'

export function titanThreadView({
  state,
  page,
  tools,
  thinking,
}: {
  state: TitanState
  page: ThreadPage
  tools: boolean
  thinking: boolean
}): ThreadPage & { conversation: NonNullable<ThreadPage['conversation']> } {
  const card = state.cards[TITAN_CARD]
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
  const messages = page.messages ?? []
  const {
    working,
    held,
  } = titanChatQueue({ state })
  const conversation = titanConversation({
    messages,
    transcript,
    provider: card?.agent?.provider,
    actions: page.actions ?? [],
    working,
    held: new Set(held),
    tools,
    thinking,
    titles: Object.fromEntries(Object.values(state.cards).map(card => [
      card.id,
      card.title,
    ])),
    currentTurn: page.currentTurn,
    receipts: othrysRunsTitan({ state }),
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

export function createTitanThreadView({
  state,
  page: base,
  tools,
  thinking,
}: Parameters<typeof titanThreadView>[0]) {
  let previous: ReturnType<typeof titanThreadView> | undefined
  let identity: string | undefined

  return ({ page }: { page: ThreadPage }): ReturnType<typeof titanThreadView> => {
    const merged = mergeThreadPages({
      before: base,
      latest: page,
    })
    const live = joinMessageParts({
      entries: merged.entries.filter(entry => entry.streaming !== undefined),
    })
    const nextIdentity = JSON.stringify({
      currentTurn: page.currentTurn,
      live: live.map(entry => ({
        ...entry,
        text: '',
        quiet: quietReply({ entry }),
        spoken: entry.text.trim() !== '',
      })),
    })

    if (!previous || nextIdentity !== identity) {
      identity = nextIdentity
      previous = titanThreadView({
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

    const savedEntries = previous.entries.filter(entry => entry.streaming === undefined)
    const saved = new Map(savedEntries.map(entry => [
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
