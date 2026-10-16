import { useEffect, useState } from 'react'
import type { EffectiveDispatch } from '../../../src/dispatch/config.ts'
import type { Command } from './connection.ts'

export const DISPATCH_CHANGED = 'pnyx-dispatch-changed'

export function useHeadsDispatch({ command, seq }: { command: Command; seq: number }) {
  const [effective, setEffective] = useState<EffectiveDispatch>()
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true

    const refresh = () => {
      void command({ name: 'rule', args: ['list'] }).then(receipt => {
        if (active) {
          setEffective(receipt as unknown as EffectiveDispatch); setError('')
        }
      }, (e: Error) => {
        if (active) {
          setError(e.message)
        }
      })
    }

    refresh()
    window.addEventListener(DISPATCH_CHANGED, refresh)
    window.addEventListener('focus', refresh)

    return () => {
      active = false
      window.removeEventListener(DISPATCH_CHANGED, refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [command, seq])

  return { effective, error }
}
