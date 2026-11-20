import type { ThreadPage } from '#hydra/transcripts-read.ts'
import type { Command } from '#web-app/connection.ts'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChatComment } from './chat.ts'
import type { ChatScroll } from './chat-scroll.ts'
import type { OlderRows } from './chat-view.tsx'
import { loadEarlierMessages, threadArgs } from './conversation-history.ts'

// How a chat reads its conversation, the same for Hydra's and each task's: one read when it connects, which restores
// the rows it had loaded, then older rows as the owner reads up or opens a comment on an older message. Pages arrive
// through the connection's thread store.
export function useChatThread({
  card,
  session,
  page,
  command,
  connected,
  scroll,
}: {
  card: string
  // A new session starts the conversation over.
  session?: string
  page: ThreadPage | null | undefined
  command: Command
  connected: boolean
  scroll: ChatScroll
}) {
  const [
    opened,
    setOpened,
  ] = useState(false)
  const [
    error,
    setError,
  ] = useState('')
  const [
    loadingEarlier,
    setLoadingEarlier,
  ] = useState(false)
  const loaded = useRef(page)
  useLayoutEffect(() => {
    loaded.current = page
  })

  useEffect(
    () => {
      setOpened(false)

      if (!connected) {
        return
      }

      let cancelled = false

      const open = async () => {
        try {
          await command({
            name: 'thread',
            args: threadArgs({
              card,
              page: loaded.current,
            }),
          })

          if (!cancelled) {
            setError('')
          }
        } catch (failure) {
          if (!cancelled) {
            setError((failure as Error).message)
          }
        } finally {
          if (!cancelled) {
            setOpened(true)
          }
        }
      }

      open()

      return () => {
        cancelled = true
      }
    },
    [
      card,
      session,
      connected,
      command,
    ],
  )

  const read = async ({ before }: { before: string }) => {
    const result = await command({
      name: 'thread',
      args: [
        card,
        before,
      ],
    })

    return result.thread as ThreadPage
  }

  // Until the opening read settles, an older read would race it on the server.
  const older: OlderRows | undefined = connected && opened ? {
    cursor: page?.older,
    load: async ({ cursor }) => {
      await read({ before: cursor })
    },
  } : undefined

  const loadEarlier = async ({
    until,
    message,
  }: {
    until?: string
    message?: string
  }) => {
    scroll.read()
    setLoadingEarlier(true)

    try {
      await loadEarlierMessages({
        page: loaded.current,
        until,
        message,
        load: read,
      })
    } finally {
      setLoadingEarlier(false)
    }
  }

  const loadComment = async ({ comment }: { comment: ChatComment }) => {
    scroll.read()
    const selector = `[data-comment-id="${CSS.escape(comment.id)}"] textarea`

    if (scroll.content.current?.querySelector(selector)) {
      return
    }

    await loadEarlier({
      until: comment.at,
      message: comment.messageId,
    })
  }

  return {
    older,
    error,
    loadingEarlier,
    loadEarlier,
    loadComment,
  }
}
