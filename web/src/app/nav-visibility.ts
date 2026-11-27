import { useEffect, useState } from 'react'

const NAV_KEY = 'othrys:nav-hidden'
const NAV_CHANGED = 'othrys:nav-hidden-changed'
const HIDDEN_BY_DEFAULT = {
  wide: false,
  phone: true,
}

type Layout = keyof typeof HIDDEN_BY_DEFAULT

export const NAV_SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘.' : 'Ctrl+.'

let sessionSnapshot: string | undefined

function readSaved() {
  if (sessionSnapshot !== undefined) {
    return sessionSnapshot
  }

  try {
    return localStorage.getItem(NAV_KEY)
  } catch (error) {
    console.warn(
      'Cannot read navigation preferences',
      error,
    )
    sessionSnapshot = '{}'

    return sessionSnapshot
  }
}

function savedLayouts({ snapshot }: { snapshot: string | null }) {
  let saved: unknown

  try {
    saved = JSON.parse(snapshot ?? '{}')
  } catch (error) {
    console.warn(
      'Cannot read saved navigation layouts',
      error,
    )
  }

  const wide = saved && typeof saved === 'object' && 'wide' in saved ? saved.wide : undefined
  const phone = saved && typeof saved === 'object' && 'phone' in saved ? saved.phone : undefined

  return {
    wide: typeof wide === 'boolean' ? wide : HIDDEN_BY_DEFAULT.wide,
    phone: typeof phone === 'boolean' ? phone : HIDDEN_BY_DEFAULT.phone,
  }
}

export function useNavHidden({
  phone,
  active,
}: {
  phone: boolean
  active: boolean
}) {
  const [
    snapshot,
    setSnapshot,
  ] = useState(readSaved)
  useEffect(
    () => {
      const refresh = () => setSnapshot(readSaved())
      const listeners = new AbortController()
      const options = { signal: listeners.signal }
      addEventListener(
        NAV_CHANGED,
        refresh,
        options,
      )
      addEventListener(
        'storage',
        refresh,
        options,
      )
      refresh()

      return () => listeners.abort()
    },
    [],
  )
  const layout: Layout = phone ? 'phone' : 'wide'
  const hidden = savedLayouts({ snapshot })[layout]

  const toggle = () => {
    const saved = savedLayouts({ snapshot: readSaved() })
    const next = JSON.stringify({
      ...saved,
      [layout]: !saved[layout],
    })

    if (sessionSnapshot !== undefined) {
      sessionSnapshot = next
    } else {
      try {
        localStorage.setItem(
          NAV_KEY,
          next,
        )
      } catch (error) {
        console.warn(
          'Cannot save navigation preferences',
          error,
        )
        sessionSnapshot = next
      }
    }

    dispatchEvent(new Event(NAV_CHANGED))
  }

  useEffect(
    () => {
      if (!active) {
        return
      }

      const key = (event: KeyboardEvent) => {
        const command = event.metaKey || event.ctrlKey

        if (command && event.key === '.' && !event.altKey && !event.shiftKey && !event.repeat) {
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
