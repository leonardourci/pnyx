import { useEffect, useState } from 'react'
import type { AgentConfig } from '../../../src/core/model.ts'
import type { EffectiveDispatch } from '../../../src/dispatch/config.ts'
import type { Command } from './connection.ts'

export const DISPATCH_CHANGED = 'pnyx-dispatch-changed'

export function useHeadsDispatch({ command }: { command: Command }) {
  const [
    confirmed,
    setEffective,
  ] = useState<EffectiveDispatch>()
  const [
    pending,
    setPending,
  ] = useState<Record<string, Partial<AgentConfig>>>({})
  const patches = Object.values(pending)
  const rule = confirmed?.dispatch.rules.hydra
  const candidate = Object.assign(
    { harness: 'claude' as const },
    rule?.candidates[0],
    ...patches,
  )
  const effective = confirmed && patches.length ? {
    ...confirmed,
    dispatch: {
      ...confirmed.dispatch,
      rules: {
        ...confirmed.dispatch.rules,
        hydra: {
          when: rule?.when ?? 'Hydra',
          candidates: [candidate],
        },
      },
    },
  } : confirmed
  const [
    error,
    setError,
  ] = useState('')
  useEffect(
    () => {
      let active = true

      const refresh = () => {
        void command({
          name: 'rule',
          args: ['list'],
        }).then(
          receipt => {
            if (active) {
              setEffective(receipt as unknown as EffectiveDispatch); setError('')
            }
          },
          (e: Error) => {
            if (active) {
              setError(e.message)
            }
          },
        )
      }

      refresh()
      window.addEventListener(
        DISPATCH_CHANGED,
        refresh,
      )
      window.addEventListener(
        'focus',
        refresh,
      )

      return () => {
        active = false
        window.removeEventListener(
          DISPATCH_CHANGED,
          refresh,
        )
        window.removeEventListener(
          'focus',
          refresh,
        )
      }
    },
    [command],
  )

  const saveHydra = ({ patch }: { patch: Partial<AgentConfig> }) => {
    const id = crypto.randomUUID()
    setPending(pending => ({
      ...pending,
      [id]: patch,
    }))
    const args = [
      'set',
      'hydra',
    ]

    for (const field of [
      'harness',
      'model',
      'effort',
      'mode',
      'fast',
    ] as const) {
      if (field in patch) {
        const value = patch[field]
        args.push(
          `--${field}`,
          field === 'fast'
            ? value === undefined ? 'default' : value ? 'on' : 'off' : String(value ?? ''),
        )
      }
    }

    const saving = command({
      name: 'rule',
      args,
    }).then(receipt => {
      if ('dispatch' in receipt) {
        setEffective(receipt as unknown as EffectiveDispatch)
      }
    })
      .finally(() => setPending(pending => {
        const next = { ...pending }; delete next[id]

        return next
      }))

    return saving
  }

  return {
    effective,
    error,
    saveHydra,
  }
}
