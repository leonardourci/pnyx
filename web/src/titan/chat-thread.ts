import type { ThreadPage } from '#titan/transcripts-read.ts'
import type { Command } from '#web-app/connection.ts'
import { CommandFailure } from '#web-shared/pending-intents.ts'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChatComment } from './chat.ts'
import type { ChatScroll } from './chat-scroll.ts'
import type { OlderRows } from './chat-view.tsx'
import { loadEarlierMessages, threadArgs } from './conversation-history.ts'

const replacedByNewerRead = ({ error }: { error: unknown }) =>
  error instanceof CommandFailure && error.code === 'THREAD_SUPERSEDED'

export function useChatThread({
  card,
  session,
  page,
  command,
  connected,
  scroll,
}: {
  card: string
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
  const openingRead = useRef<Promise<void>>(Promise.resolve())

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
          const failedHere = !replacedByNewerRead({ error: failure })

          if (!cancelled) {
            setError(failedHere ? (failure as Error).message : '')
          }
        } finally {
          if (!cancelled) {
            setOpened(true)
          }
        }
      }

      openingRead.current = open()

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

  const older: OlderRows | undefined = connected && opened ? {
    cursor: page?.older,
    load: async ({ cursor }) => {
      try {
        await read({ before: cursor })
      } catch (error) {
        if (!replacedByNewerRead({ error })) {
          throw error
        }
      }
    },
  } : undefined

  const loadEarlier = async ({
    until,
    message,
  }: {
    until?: string
    message?: string
  }) => {
    setLoadingEarlier(true)

    try {
      await openingRead.current
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
    scroll.stopFollowing()
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
