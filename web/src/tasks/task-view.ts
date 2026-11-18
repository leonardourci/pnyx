import { useLayoutEffect, type RefObject } from 'react'
import { sessionView, useSessionView, useSessionViewResource, sessionViewKey } from '#web-app/session-view.ts'

export function taskViewKey({
  hydraId,
  id,
  field,
}: {
  hydraId: string
  id: string
  field: string
}) {
  return sessionViewKey({
    scope: 'task',
    id: `${hydraId}:${id}`,
    field,
  })
}

export function useTaskEditorFocus({
  hydraId,
  id,
  kind,
  version,
  field,
}: {
  hydraId: string
  id: string
  kind: 'edit' | 'reminder'
  version: number
  field: RefObject<HTMLInputElement | null>
}) {
  const focused = useSessionViewResource({
    key: taskViewKey({
      hydraId,
      id,
      field: `${kind}.focus`,
    }),
    initial: -1,
  })
  useLayoutEffect(
    () => {
      const input = field.current

      if (!input || focused.snapshot() === version) {
        return
      }

      input.focus({ preventScroll: true })

      if (input.type === 'text') {
        input.setSelectionRange(
          input.value.length,
          input.value.length,
        )
      }

      focused.set(version)
    },
    [
      field,
      focused,
      version,
    ],
  )
}

function familyViewKey({ hydraId }: { hydraId: string }) {
  return sessionViewKey({
    scope: 'families',
    id: hydraId,
    field: 'folds',
  })
}

export function useFamilyFolds({ hydraId }: { hydraId: string }) {
  return useSessionView<Record<string, boolean>>({
    key: familyViewKey({ hydraId }),
    initial: {},
  })
}

export function openTaskFamily({
  hydraId,
  id,
}: {
  hydraId: string
  id: string
}) {
  const view = sessionView<Record<string, boolean>>({
    key: familyViewKey({ hydraId }),
    initial: {},
  })
  // eslint-disable-next-line pnyx/object-params -- React owns functional state updaters.
  view.set(current => ({
    ...current,
    [id]: true,
  }))
}
