import type { CurrentAction } from '#hydra/calls.ts'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { HydraState } from '#app/model.ts'
import { hydraConfig } from '#hydra/config.ts'
import { cardState } from './view.ts'
import { statusLabel } from '#tasks/card-status.ts'
import type { DoneAfterHours } from '#settings/model.ts'
import { useSharedSettings } from '#web-settings/shared-settings.ts'
import { isManagedTask, knownCards } from '#tasks/select.ts'

export function taskReferences({
  state,
  hours,
  now,
  actions,
  connected,
}: {
  state: HydraState
  hours?: DoneAfterHours
  actions?: Record<string, CurrentAction>
  connected?: boolean
  now: number
}) {
  const config = hydraConfig({ state })

  return Object.fromEntries(Object.values(knownCards({ state }))
    .filter(c => !isManagedTask({ card: c }))
    .map(c => {
      const column = config.columns.find(column => column.id === c.column)
      const status = cardState({
        card: c,
        hours,
        state,
        action: actions?.[c.id],
        connected,
        now,
      })

      return [
        c.id,
        {
          title: c.title,
          state: statusLabel({ status }),
          kind: status.kind,
          column: column?.role ?? column?.id ?? 'custom',
        },
      ]
    }))
}

export function useTaskReferences({
  state,
  actions,
  connected,
}: {
  state: HydraState
  actions?: Record<string, CurrentAction>
  connected?: boolean
}) {
  const [
    now,
    setNow,
  ] = useState(Date.now)
  useEffect(
    () => {
      const timer = setInterval(
        () => setNow(Date.now()),
        30_000,
      )

      return () => clearInterval(timer)
    },
    [],
  )

  const hours = useSharedSettings()?.doneAfterHours

  const previous = useRef<ReturnType<typeof taskReferences> | undefined>(undefined)

  return useMemo(
    () => {
      const next = taskReferences({
        state,
        hours,
        actions,
        connected,
        now,
      })
      const saved = previous.current
      const entries = Object.entries(next)
      const same = saved && Object.keys(saved).length === entries.length && entries.every(([
        id,
        value,
      ]) => JSON.stringify(saved[id]) === JSON.stringify(value))

      if (same) {
        return saved
      }

      previous.current = next

      return next
    },
    [
      state.cards,
      connected,
      actions,
      state.config,
      hours,
      now,
    ],
  )
}
