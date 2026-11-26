import { useCallback } from 'react'
import type { TitanState } from '#app/model.ts'
import { resizeViewPatch } from '#preferences/view.ts'
import { isSettingKey } from '#settings/model.ts'
import { saveSharedSettings } from '#web-settings/shared-settings.ts'
import type { Command } from '#web-app/connection.ts'

export function useSaveView({
  state,
  command,
  notify,
}: {
  state: TitanState
  command: Command
  notify({ text }: { text: string }): void
}) {
  return useCallback(
    async ({ patch }: { patch: Record<string, unknown> }) => {
      const resize = 'defaultTitanWidth' in patch
      const applied = resize ? resizeViewPatch({
        patch,
      }) : patch
      const entries = Object.entries(applied)
      const sharedPatch = Object.fromEntries(entries.filter(([key]) => isSettingKey({ key })))
      const titanPatch = Object.fromEntries(entries.filter(([key]) => !isSettingKey({ key })))

      const writes = []

      if (Object.keys(sharedPatch).length) {
        writes.push(saveSharedSettings({
          command,
          patch: sharedPatch,
          view: resize ? {
            patch: applied,
            revision: state.viewRevision ?? 0,
          } : undefined,
        }))
      }

      const workspace = titanPatch.workspace
      const foldOnly = Object.keys(titanPatch).length === 1 && workspace
        && typeof workspace === 'object'
        && Object.keys(workspace).every(key => key === 'foldedProjects')

      if (!resize && Object.keys(titanPatch).length) {
        writes.push(command({
          name: 'view',
          args: [
            'set',
            '--json',
            JSON.stringify(titanPatch),
            ...(!foldOnly ? [
              '--if-revision',
              String(state.viewRevision ?? 0),
            ] : []),
            '--event-id',
            crypto.randomUUID(),
          ],
        }))
      }

      try {
        await Promise.all(writes)

        return true
      } catch (error) {
        notify({ text: (error as Error).message })

        return false
      }
    },
    [
      command,
      notify,
      state,
    ],
  )
}
