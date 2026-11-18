import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { CARD_SIZING } from '#web-shared/card-sizing.ts'

const PRESENTATION_KEY = 'pnyx:task-presentation'
export const TASK_MODAL_CHANGED = 'pnyx:task-modal-changed'
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

interface TaskPresentation {
  chatOnly?: boolean
  modalSize?: {
    width: number
    height: number
  }
}

function readPresentation() {
  try {
    return localStorage.getItem(PRESENTATION_KEY)
  } catch {
    return null
  }
}

function useTaskPresentation() {
  const snapshot = useSyncExternalStore(
    subscribeChatOnly,
    readPresentation,
  )
  const preferences = useMemo(
    (): TaskPresentation => {
      try {
        return JSON.parse(snapshot ?? '{}') ?? {}
      } catch {
        return {}
      }
    },
    [snapshot],
  )

  return {
    preferences,
    change: ({ patch }: { patch: Partial<TaskPresentation> }) => {
      try {
        localStorage.setItem(
          PRESENTATION_KEY,
          JSON.stringify({
            ...preferences,
            ...patch,
          }),
        )
      } catch { /* The current page remains usable when browser storage is blocked. */ }

      dispatchEvent(new Event(CHAT_ONLY_CHANGED))
    },
  }
}

export function useTaskChatOnly() {
  const {
    preferences,
    change,
  } = useTaskPresentation()
  const chatOnly = preferences.chatOnly === true

  return {
    chatOnly,
    toggleChatOnly: () => change({ patch: { chatOnly: !chatOnly } }),
  }
}

export function useTaskModalSize() {
  const {
    preferences,
    change,
  } = useTaskPresentation()
  const [
    viewport,
    setViewport,
  ] = useState(() => ({
    width: innerWidth,
    height: innerHeight,
  }))
  useEffect(
    () => {
      const resize = () => setViewport({
        width: innerWidth,
        height: innerHeight,
      })
      addEventListener(
        'resize',
        resize,
      )

      return () => removeEventListener(
        'resize',
        resize,
      )
    },
    [],
  )
  const [
    preview,
    setPreview,
  ] = useState<{
    width?: number
    height?: number
  }>({})
  const margin = CARD_SIZING.modal.margin * 2
  const maximum = {
    width: viewport.width - margin,
    height: viewport.height - margin,
  }
  const minimum = {
    width: Math.min(
      CARD_SIZING.open.minWidth,
      maximum.width,
    ),
    height: Math.min(
      CARD_SIZING.open.minHeight,
      maximum.height,
    ),
  }
  const saved = preferences.modalSize
  const size = {
    width: Math.min(
      maximum.width,
      Math.max(
        minimum.width,
        preview.width ?? saved?.width ?? viewport.width * CARD_SIZING.modal.widthFraction,
      ),
    ),
    height: Math.min(
      maximum.height,
      Math.max(
        minimum.height,
        preview.height ?? saved?.height ?? maximum.height,
      ),
    ),
  }

  return {
    size,
    minimum,
    maximum,
    preview: ({
      axis,
      value,
    }: {
      axis: 'width' | 'height'
      value: number | null
    }) => setPreview(current => ({
      ...current,
      [axis]: value ?? undefined,
    })),
    commit: ({
      axis,
      value,
    }: {
      axis: 'width' | 'height'
      value: number
    }) => change({
      patch: {
        modalSize: {
          ...size,
          [axis]: value,
        },
      },
    }),
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
      dispatchEvent(new Event(TASK_MODAL_CHANGED))
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
        dispatchEvent(new Event(TASK_MODAL_CHANGED))
      }
    },
  }
}
