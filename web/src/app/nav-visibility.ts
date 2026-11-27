import { useEffect, useSyncExternalStore } from 'react'

const NAV_KEY = 'othrys:nav-hidden'
const NAV_CHANGED = 'othrys:nav-hidden-changed'
// The phone starts with its nav hidden; wide screens start with it shown.
const HIDDEN_BY_DEFAULT = {
  wide: false,
  phone: true,
}

type Layout = keyof typeof HIDDEN_BY_DEFAULT

export const NAV_SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘.' : 'Ctrl+.'

// eslint-disable-next-line othrys/object-params -- React owns the subscription callback signature.
const subscribe = (changed: () => void) => {
  addEventListener(
    NAV_CHANGED,
    changed,
  )
  addEventListener(
    'storage',
    changed,
  )

  return () => {
    removeEventListener(
      NAV_CHANGED,
      changed,
    )
    removeEventListener(
      'storage',
      changed,
    )
  }
}

function readSaved() {
  try {
    return localStorage.getItem(NAV_KEY)
  } catch {
    return null
  }
}

function savedLayouts({ snapshot }: { snapshot: string | null }): Partial<Record<Layout, boolean>> {
  try {
    return JSON.parse(snapshot ?? '{}') ?? {}
  } catch {
    return {}
  }
}

// Each layout keeps its own hidden flag, so hiding the nav on the phone leaves the wide layout's nav shown.
export function useNavHidden({
  phone,
  shortcut,
}: {
  phone: boolean
  // Only the shown Titan listens for the shortcut, so one press toggles once.
  shortcut: boolean
}) {
  const snapshot = useSyncExternalStore(
    subscribe,
    readSaved,
  )
  const layout: Layout = phone ? 'phone' : 'wide'
  const saved = savedLayouts({ snapshot })
  const hidden = saved[layout] ?? HIDDEN_BY_DEFAULT[layout]

  const setHidden = ({ value }: { value: boolean }) => {
    try {
      localStorage.setItem(
        NAV_KEY,
        JSON.stringify({
          ...savedLayouts({ snapshot: readSaved() }),
          [layout]: value,
        }),
      )
    } catch { /* Blocked browser storage leaves the nav as it is. */ }

    dispatchEvent(new Event(NAV_CHANGED))
  }

  const toggle = () => setHidden({ value: !hidden })

  useEffect(
    () => {
      if (!shortcut) {
        return
      }

      const key = (event: KeyboardEvent) => {
        const command = event.metaKey || event.ctrlKey

        if (command && event.key === '.' && !event.altKey && !event.shiftKey) {
          event.preventDefault()
          toggle()
        }
      }

      window.addEventListener(
        'keydown',
        key,
      )

      return () => window.removeEventListener(
        'keydown',
        key,
      )
    },
  )

  return {
    hidden,
    toggle,
  }
}
