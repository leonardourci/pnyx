import { dispatchDocument, dispatchSettings } from './dispatch-resource.ts'
import { useEffect, useSyncExternalStore } from 'react'
import type { AgentConfig } from '#workers/model.ts'
import type { Command } from '#web-app/connection.ts'

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

type Readable = Pick<ReturnType<typeof dispatchSettings>, 'refresh'>

// Reads again whenever a dispatch change lands or the window comes back.
function useRefreshed({
  resource,
  command,
  action,
}: {
  resource: Readable
  command: Command
  action: 'list' | 'show'
}) {
  useEffect(
    () => {
      const refresh = () => {
        void resource.refresh({
          command,
          name: 'rule',
          args: [action],
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
      action,
      command,
      resource,
    ],
  )
}

// The editable document and its revision, for Settings' heads dispatch.
export function useDispatchDocument({ command }: { command: Command }) {
  const resource = dispatchDocument()
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.snapshot,
  )
  useRefreshed({
    resource,
    command,
    action: 'show',
  })

  return {
    snapshot,
    resource,
  }
}

export function useHeadsDispatch({ command }: { command: Command }) {
  const resource = dispatchSettings()
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.snapshot,
  )
  useRefreshed({
    resource,
    command,
    action: 'list',
  })

  const saveHydra = async ({ patch }: { patch: Partial<AgentConfig> }) => {
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

    await resource.write({
      command,
      name: 'rule',
      args,
      patch,
      targets: Object.keys(patch),
    })
    // A rule change answers with what changed, so the whole dispatch is read again.
    window.dispatchEvent(new Event(DISPATCH_CHANGED))
  }

  return {
    effective: snapshot.view ?? undefined,
    error: snapshot.error,
    saveHydra,
  }
}
