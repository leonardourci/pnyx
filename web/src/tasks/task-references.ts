import { useEffect, useMemo, useState } from 'react'
import type { HydraState } from '../../../src/app/model.ts'
import { hydraConfig } from '../../../src/hydra/config.ts'
import { HYDRA_CARD } from '../../../src/hydra/identity.ts'
import { cardState } from './view.ts'

export function taskReferences({
  state,
  now,
}: {
  state: HydraState
  now: number
}) {
  const config = hydraConfig({ state })

  return Object.fromEntries(Object.values(state.cards)
    .filter(c => c.id !== HYDRA_CARD && !c.automaticTask)
    .map(c => {
      const column = config.columns.find(column => column.id === c.column)
      const status = cardState({
        card: c,
        hours: state.config?.doneAfterHours,
        now,
      })

      return [
        c.id,
        {
          title: c.title,
          state: status.kind === 'asks' ? 'Needs you' : status.text.replace(
            /^./,
            letter => letter.toUpperCase(),
          ),
          kind: status.kind,
          column: column?.role ?? column?.id ?? 'custom',
        },
      ]
    }))
}

export function useTaskReferences({ state }: { state: HydraState }) {
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

  return useMemo(
    () => taskReferences({
      state,
      now,
    }),
    [
      state.cards,
      state.config,
      now,
    ],
  )
}
