import { HYDRA_CARD } from '#hydra/identity.ts'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { sendableComment, type ChatComment } from './chat.ts'

const SAVE_PAUSE_MS = 500

export function createChatDrafts({
  text = '',
  comments = [],
  save,
}: {
  text?: string
  comments?: ChatComment[]
  save({
    text,
    comments,
  }: {
    text: string
    comments: ChatComment[]
  }): void
}) {
  let current = {
    text,
    comments,
  }
  let persistedComments = comments
  let settled = current
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const settledListeners = new Set<() => void>()

  // eslint-disable-next-line pnyx/object-params -- useSyncExternalStore subscription contract.
  const subscribe = (listener: () => void) => {
    listeners.add(listener)

    return () => {
      listeners.delete(listener)
    }
  }

  // eslint-disable-next-line pnyx/object-params -- useSyncExternalStore subscription contract.
  const subscribeSettled = (listener: () => void) => {
    settledListeners.add(listener)

    return () => {
      settledListeners.delete(listener)
    }
  }

  const publish = () => {
    settled = current
    settledListeners.forEach(listener => listener())
  }

  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    publish()
    save(current)
    persistedComments = current.comments.filter(comment => sendableComment({ comment }))
  }

  const write = ({
    text,
    comments,
    structural = false,
  }: {
    text: string
    comments: ChatComment[]
    structural?: boolean
  }) => {
    current = {
      text,
      comments,
    }
    listeners.forEach(listener => listener())

    if (structural) {
      publish()
    }

    clearTimeout(timer)
    timer = setTimeout(
      flush,
      SAVE_PAUSE_MS,
    )
  }

  return {
    read: () => current,
    readSettled: () => settled,
    subscribe,
    subscribeSettled,
    flush,
    setDraft: ({ text }: { text: string }) => write({
      text,
      comments: current.comments,
    }),
    setComments: ({ items }: { items: ChatComment[] }) => write({
      text: current.text,
      comments: items,
      structural: true,
    }),
    syncComments: ({ items }: { items: ChatComment[] }) => {
      const dirty = current.comments.filter(comment => JSON.stringify(comment)
        !== JSON.stringify(persistedComments.find(saved => saved.id === comment.id)))
      const removed = persistedComments.filter(saved =>
        !current.comments.some(comment => comment.id === saved.id))
      const merged = items.filter(item => !removed.some(saved => saved.id === item.id))
        .map(item => dirty.find(comment => comment.id === item.id) ?? item)
      const added = dirty.filter(comment => !items.some(item => item.id === comment.id))
      persistedComments = items
      write({
        text: current.text,
        comments: [
          ...merged,
          ...added,
        ],
        structural: true,
      })
    },
    editComment: ({
      id,
      text,
    }: {
      id: string
      text: string
    }) => write({
      text: current.text,
      comments: current.comments.map(comment => comment.id === id ? {
        ...comment,
        text,
      } : comment),
    }),
  }
}

export type ChatDrafts = ReturnType<typeof createChatDrafts>

export function useDraftSnapshot({
  drafts,
  settled = false,
}: {
  drafts: ChatDrafts
  settled?: boolean
}) {
  return useSyncExternalStore(
    settled ? drafts.subscribeSettled : drafts.subscribe,
    settled ? drafts.readSettled : drafts.read,
  )
}

function storedCards({ value }: { value: string | null }): Record<string, ChatComment[]> {
  try {
    const cards = JSON.parse(value ?? '{}') as Record<string, ChatComment[]>

    if (!cards || typeof cards !== 'object' || Array.isArray(cards)) {
      return {}
    }

    return cards
  } catch {
    return {}
  }
}

function storedComments({ value }: { value: string | null }): ChatComment[] {
  try {
    const comments: ChatComment[] = storedCards({ value })[HYDRA_CARD] ?? []

    return comments.filter(comment => sendableComment({ comment }))
  } catch {
    return []
  }
}

export function useChatDrafts({
  text,
  commentsKey,
  saveText,
}: {
  text: string
  commentsKey: string
  saveText({ text }: { text: string }): void
}) {
  const persistence = useRef({
    commentsKey,
    saveText,
  })
  persistence.current = {
    commentsKey,
    saveText,
  }
  const [drafts] = useState(() => {
    let comments: ChatComment[] = []
    let lastSaved: string | null = null

    try {
      lastSaved = localStorage.getItem(commentsKey)
      comments = storedComments({ value: lastSaved })
    } catch { /* Blocked storage starts with an empty draft. */ }

    const resource = createChatDrafts({
      text,
      comments,
      save: ({
        text,
        comments,
      }) => {
        const {
          commentsKey,
          saveText,
        } = persistence.current
        saveText({ text })

        try {
          const saved = storedCards({ value: localStorage.getItem(commentsKey) })
          saved[HYDRA_CARD] = comments.filter(comment => sendableComment({ comment }))
          const encoded = JSON.stringify(saved)

          if (encoded !== lastSaved) {
            localStorage.setItem(
              commentsKey,
              encoded,
            )
            lastSaved = encoded
          }
        } catch { /* Storage full or blocked: the mounted chat retains its drafts. */ }
      },
    })

    return {
      ...resource,
      remember: ({ value }: { value: string | null }) => {
        lastSaved = value
      },
    }
  })
  useEffect(
    () => {
      const sync = ({
        key,
        newValue,
      }: StorageEvent) => {
        if (key !== commentsKey) {
          return
        }

        try {
          const incoming = storedComments({ value: newValue })
          drafts.remember({ value: newValue })
          drafts.syncComments({ items: incoming })
        } catch { /* Invalid storage events leave the current comments intact. */ }
      }

      addEventListener(
        'storage',
        sync,
      )
      addEventListener(
        'pagehide',
        drafts.flush,
      )

      return () => {
        removeEventListener(
          'storage',
          sync,
        )
        removeEventListener(
          'pagehide',
          drafts.flush,
        )
        drafts.flush()
      }
    },
    [
      drafts,
      commentsKey,
    ],
  )

  return drafts
}
