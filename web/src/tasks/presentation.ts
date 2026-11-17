import { useEffect, useState, useSyncExternalStore } from 'react'
import { stored, save } from '#web-app/connection-storage.ts'

const CHAT_ONLY_KEY = 'pnyx:task-chat-only'
const CHAT_ONLY_CHANGED = 'pnyx:task-chat-only-changed'

// eslint-disable-next-line pnyx/object-params -- React owns the subscription callback signature.
const subscribeChatOnly = (changed: () => void) => {
  addEventListener(
    CHAT_ONLY_CHANGED,
    changed,
  )
  addEventListener(
    'storage',
    changed,
  )

  return () => {
    removeEventListener(
      CHAT_ONLY_CHANGED,
      changed,
    )
    removeEventListener(
      'storage',
      changed,
    )
  }
}

export function useTaskChatOnly() {
  const chatOnly = useSyncExternalStore(
    subscribeChatOnly,
    () => stored({
      key: CHAT_ONLY_KEY,
      fallback: false,
    }),
  )

  return {
    chatOnly,
    toggleChatOnly: () => {
      save({
        key: CHAT_ONLY_KEY,
        value: !chatOnly,
      })
      dispatchEvent(new Event(CHAT_ONLY_CHANGED))
    },
  }
}

export function useTaskModal({
  id,
  hydraId,
}: {
  id: string
  hydraId: string
}) {
  const matches = () => location.pathname === `/hydra/${encodeURIComponent(hydraId)}/`
    && new URLSearchParams(location.search).get('task') === id
  const [
    modal,
    setModal,
  ] = useState(matches)
  useEffect(
    () => {
      const read = () => setModal(matches())
      addEventListener(
        'popstate',
        read,
      )

      return () => removeEventListener(
        'popstate',
        read,
      )
    },
    [
      id,
      hydraId,
    ],
  )

  return {
    modal,
    showModal: () => {
      const url = new URL(location.href)
      url.searchParams.set(
        'task',
        id,
      )
      history.pushState(
        {
          ...history.state,
          pnyxTaskModal: id,
        },
        '',
        url,
      )
      setModal(true)
    },
    closeModal: () => {
      if (history.state?.pnyxTaskModal === id) {
        history.back()
      } else {
        const url = new URL(location.href)
        url.searchParams.delete('task')
        history.replaceState(
          history.state,
          '',
          url,
        )
        setModal(false)
      }
    },
  }
}
