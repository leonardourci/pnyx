import { useLayoutEffect, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'
import { stored, save } from './connection-storage.ts'
import { kept } from '#web-shared/stable.ts'

export interface SessionView<Value> {
  key: string
  snapshot(): Value
  // eslint-disable-next-line othrys/object-params -- React owns the subscription signature.
  subscribe(changed: () => void): () => void
  set: Dispatch<SetStateAction<Value>>
  remember({ value }: { value: Value }): void
  flush(): void
  bind({ key }: { key: string }): void
}

const views = new Map<string, SessionView<unknown>>()
const dirty = new Set<SessionView<unknown>>()

addEventListener(
  'pagehide',
  () => dirty.forEach(view => view.flush()),
)

export function sessionViewKey({
  scope,
  id,
  field,
}: {
  scope: string
  id: string
  field: string
}) {
  const installation = document.querySelector<HTMLMetaElement>('meta[name=othrys-installation]')?.content

  return `pnyx:view:${JSON.stringify([
    location.origin,
    installation,
    scope,
    id,
    field,
  ])}`
}

export function forgetSessionView({ key }: { key: string }) {
  const view = views.get(key)

  if (view) {
    dirty.delete(view)
    views.delete(key)
  }

  try {
    sessionStorage.removeItem(key)
  } catch { /* The open tab still discards its saved form. */ }
}

export function sessionView<Value>({
  key,
  initial,
}: {
  key: string
  initial: Value
}): SessionView<Value> {
  const existing = views.get(key)

  if (existing) {
    return existing as SessionView<Value>
  }

  let value = stored({
    key,
    fallback: initial,
  })
  const listeners = new Set<() => void>()
  const view: SessionView<Value> = {
    key,
    snapshot: () => value,
    // eslint-disable-next-line othrys/object-params -- useSyncExternalStore owns subscription callbacks.
    subscribe: changed => {
      listeners.add(changed)

      return () => {
        listeners.delete(changed)
      }
    },
    // eslint-disable-next-line othrys/object-params -- React owns the state setter signature.
    set: update => {
      // eslint-disable-next-line othrys/object-params -- React owns functional state updaters.
      const next = typeof update === 'function' ? (update as (value: Value) => Value)(value) : update
      const retained = kept({
        previous: value,
        next,
      })

      if (retained === value) {
        return
      }

      view.remember({ value: retained })
      view.flush()
      listeners.forEach(changed => changed())
    },
    remember: ({ value: next }) => {
      value = next
      dirty.add(view as SessionView<unknown>)
    },
    flush: () => {
      save({
        key: view.key,
        value,
      })
      dirty.delete(view as SessionView<unknown>)
    },
    bind: ({ key: next }) => {
      if (view.key !== next) {
        views.delete(view.key)
        view.key = next
        views.set(
          next,
          view as SessionView<unknown>,
        )
        view.flush()
      }
    },
  }
  views.set(
    key,
    view as SessionView<unknown>,
  )

  return view
}

export function useSessionViewResource<Value>({
  key,
  initial,
}: {
  key: string
  initial: Value
}) {
  const [view] = useState(() => sessionView({
    key,
    initial,
  }))
  useLayoutEffect(
    () => view.bind({ key }),
    [
      key,
      view,
    ],
  )

  return view
}

export function useSessionView<Value>({
  key,
  initial,
}: {
  key: string
  initial: Value
}) {
  const view = useSessionViewResource({
    key,
    initial,
  })
  const value = useSyncExternalStore(
    view.subscribe,
    view.snapshot,
  )

  return [
    value,
    view.set,
    view,
  ] as const
}
