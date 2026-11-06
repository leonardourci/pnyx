import { useEffect, useState } from 'react'
import { sendableComment, type ChatComment } from './chat.ts'

export function savedComments({ comments }: { comments: Record<string, ChatComment[]> }) {
  return Object.fromEntries(Object.entries(comments).map(([
    card,
    items,
  ]) => [
    card,
    items.filter(comment => sendableComment({ comment })),
  ]))
}

export function readComments({ value }: { value: string | null }): Record<string, ChatComment[]> {
  try {
    return savedComments({ comments: JSON.parse(value ?? '{}') as Record<string, ChatComment[]> })
  } catch {
    return {}
  }
}

export function useStoredComments({ commentsKey }: { commentsKey: string }) {
  const [
    comments,
    setComments,
  ] = useState<Record<string, ChatComment[]>>(() => {
    try {
      return readComments({ value: localStorage.getItem(commentsKey) })
    } catch {
      return {}
    }
  })
  // Another tab's edits arrive here, so the next write from this tab doesn't undo them.
  useEffect(
    () => {
      const sync = ({
        key,
        newValue,
      }: StorageEvent) => {
        if (key !== commentsKey || newValue === JSON.stringify(savedComments({ comments }))) {
          return
        }

        setComments(current => {
          const incoming = readComments({ value: newValue })

          for (const [
            card,
            items,
          ] of Object.entries(current)) {
            const pending = items.filter(comment => !sendableComment({ comment })
                && !incoming[card]?.some(item => item.id === comment.id))

            if (pending.length) {
              incoming[card] = [
                ...incoming[card] ?? [],
                ...pending,
              ]
            }
          }

          return incoming
        })
      }

      addEventListener(
        'storage',
        sync,
      )

      return () => removeEventListener(
        'storage',
        sync,
      )
    },
    [
      comments,
      commentsKey,
    ],
  )
  useEffect(
    () => {
      try {
        localStorage.setItem(
          commentsKey,
          JSON.stringify(savedComments({ comments })),
        )
      } catch { /* Storage full or blocked: comments last until the tab closes. */ }
    },
    [
      comments,
      commentsKey,
    ],
  )

  return {
    comments,
    setComments,
  }
}
