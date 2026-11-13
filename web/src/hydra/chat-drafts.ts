import { HYDRA_CARD } from '#hydra/identity.ts'
import { taskMentions } from '#hydra/mentions.ts'
import { useEffect, useRef, useState } from 'react'
import { createStore, useStore } from 'zustand'
import type { ChatComment } from './chat.ts'
import { commentChanges, commentPrefix, loadCommentRecords, readCommentRecord, saveCommentRecords } from './comment-storage.ts'

const SAVE_PAUSE_MS = 500

const mentionedTasks = ({ text }: { text: string }) =>
  [...new Set(taskMentions({ text }).map(mention => mention.id))].sort().join('\n')

function mergeComments({
  current,
  previous,
  incoming,
}: {
  current: ChatComment[]
  previous: ChatComment[]
  incoming: ChatComment[]
}): ChatComment[] {
  const {
    changed: dirty,
    removed,
  } = commentChanges({
    comments: current,
    previous,
  })
  const merged = incoming.filter(item => !removed.some(saved => saved.id === item.id))
    .map(item => dirty.find(comment => comment.id === item.id) ?? item)
  const added = dirty.filter(comment => !incoming.some(item => item.id === comment.id))

  return [
    ...merged,
    ...added,
  ]
}

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
    previous: ChatComment[]
  }): ChatComment[] | false
}) {
  // The live draft changes on every key; the settled copy, which renders the chat, only at a pause or a structural edit.
  const live = createStore(() => ({
    text,
    comments,
  }))
  const settled = createStore(() => live.getState())
  let persistedComments = comments
  let timer: ReturnType<typeof setTimeout> | undefined

  const publish = () => settled.setState(
    live.getState(),
    true,
  )

  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    publish()
    const current = live.getState()
    const saved = save({
      ...current,
      previous: persistedComments,
    })

    if (saved !== false) {
      const comments = mergeComments({
        current: current.comments,
        previous: persistedComments,
        incoming: saved,
      })
      persistedComments = saved

      if (JSON.stringify(comments) !== JSON.stringify(current.comments)) {
        live.setState({ comments })
        publish()
      }
    }
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
    live.setState({
      text,
      comments,
    })

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
    read: live.getState,
    readSettled: settled.getState,
    subscribe: live.subscribe,
    subscribeSettled: settled.subscribe,
    settled,
    flush,
    // The chat shows the questions of the tasks a draft mentions, so a change to which tasks it names publishes at once.
    setDraft: ({ text }: { text: string }) => write({
      text,
      comments: live.getState().comments,
      structural: mentionedTasks({ text }) !== mentionedTasks({ text: live.getState().text }),
    }),
    setComments: ({ items }: { items: ChatComment[] }) => write({
      text: live.getState().text,
      comments: items,
      structural: true,
    }),
    syncComment: ({
      id,
      comment,
    }: {
      id: string
      comment: ChatComment | null
    }) => {
      const incoming = persistedComments.filter(saved => saved.id !== id)

      if (comment) {
        const index = persistedComments.findIndex(saved => saved.id === id)
        incoming.splice(
          index < 0 ? incoming.length : index,
          0,
          comment,
        )
      }

      const comments = mergeComments({
        current: live.getState().comments,
        previous: persistedComments,
        incoming,
      })
      persistedComments = incoming
      write({
        text: live.getState().text,
        comments,
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
      text: live.getState().text,
      comments: live.getState().comments.map(comment => comment.id === id ? {
        ...comment,
        text,
      } : comment),
    }),
  }
}

export type ChatDrafts = ReturnType<typeof createChatDrafts>

export function useDraftSnapshot({ drafts }: { drafts: ChatDrafts }) {
  return useStore(drafts.settled)
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

    try {
      comments = loadCommentRecords({
        storage: localStorage,
        key: commentsKey,
      })
    } catch { /* Blocked storage starts with an empty draft. */ }

    return createChatDrafts({
      text,
      comments,
      save: ({
        text,
        comments,
        previous,
      }) => {
        const {
          commentsKey,
          saveText,
        } = persistence.current
        saveText({ text })

        try {
          return saveCommentRecords({
            storage: localStorage,
            key: commentsKey,
            comments,
            previous,
          })
        } catch {
          // Keep unsaved edits dirty when storage is full or blocked.
          return false
        }
      },
    })
  })
  useEffect(
    () => {
      const prefix = commentPrefix({
        key: commentsKey,
        card: HYDRA_CARD,
      })

      const sync = ({ key }: StorageEvent) => {
        if (key === null || !key.startsWith(prefix)) {
          return
        }

        const record = readCommentRecord({
          storage: localStorage,
          key,
          prefix,
        })

        if (record) {
          drafts.syncComment(record)
        }
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
