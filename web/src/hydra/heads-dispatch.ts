import { dispatchSettings } from './installation-resources.ts'
import { useEffect, useSyncExternalStore } from 'react'
import type { AgentConfig } from '../../../src/core/model.ts'
import type { Command } from '../app/connection.ts'

export const DISPATCH_CHANGED = 'pnyx-dispatch-changed'

// A default for another agent drops the rule's settings that belonged to the old one.
export const hydraDefault = ({
  rule,
  harness,
  field,
  value,
}: {
  rule?: AgentConfig
  harness: AgentConfig['harness']
  field: 'model' | 'effort' | 'mode'
  value: string
}): Partial<AgentConfig> => ({
  harness,
  ...(rule?.harness === harness ? {} : {
    model: undefined,
    effort: undefined,
    mode: undefined,
  }),
  [field]: value,
})

export function useHeadsDispatch({ command }: { command: Command }) {
  const resource = dispatchSettings()
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.snapshot,
  )
  useEffect(
    () => {
      const refresh = () => {
        void resource.refresh({
          command,
          name: 'rule',
          args: ['list'],
        })
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
    [
      command,
      resource,
    ],
  )

  const saveHydra = ({ patch }: { patch: Partial<AgentConfig> }) => {
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

    return resource.write({
      command,
      name: 'rule',
      args,
      patch,
      targets: Object.keys(patch),
    })
  }

  return {
    effective: snapshot.view ?? undefined,
    error: snapshot.error,
    saveHydra,
  }
}
