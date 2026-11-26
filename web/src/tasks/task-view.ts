import { useLayoutEffect, type RefObject } from 'react'
import { sessionView, useSessionView, useSessionViewResource, sessionViewKey } from '#web-app/session-view.ts'

export function taskViewKey({
  titanId,
  id,
  field,
}: {
  titanId: string
  id: string
  field: string
}) {
  return sessionViewKey({
    scope: 'task',
    id: `${titanId}:${id}`,
    field,
  })
}

export function useTaskEditorFocus({
  titanId,
  id,
  kind,
  version,
  field,
}: {
  titanId: string
  id: string
  kind: 'edit' | 'reminder'
  version: number
  field: RefObject<HTMLTextAreaElement | null>
}) {
  const focused = useSessionViewResource({
    key: taskViewKey({
      titanId,
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

      input.setSelectionRange(
        input.value.length,
        input.value.length,
      )

      focused.set(version)
    },
    [
      field,
      focused,
      version,
    ],
  )
}

function familyViewKey({ titanId }: { titanId: string }) {
  return sessionViewKey({
    scope: 'families',
    id: titanId,
    field: 'folds',
  })
}

export function useFamilyFolds({ titanId }: { titanId: string }) {
  return useSessionView<Record<string, boolean>>({
    key: familyViewKey({ titanId }),
    initial: {},
  })
}

export function openTaskFamily({
  titanId,
  id,
}: {
  titanId: string
  id: string
}) {
  const view = sessionView<Record<string, boolean>>({
    key: familyViewKey({ titanId }),
    initial: {},
  })
  // eslint-disable-next-line othrys/object-params -- React owns functional state updaters.
  view.set(current => ({
    ...current,
    [id]: true,
  }))
}
