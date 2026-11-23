import { useCallback } from 'react'
import type { HydraState } from '#app/model.ts'
import { resizeViewPatch } from '#preferences/view.ts'
import { isSettingKey } from '#settings/model.ts'
import { saveSharedSettings } from '#web-settings/shared-settings.ts'
import type { Command } from '#web-app/connection.ts'

export function useSaveView({
  state,
  command,
  notify,
}: {
  state: HydraState
  command: Command
  notify({ text }: { text: string }): void
}) {
  return useCallback(
    async ({ patch }: { patch: Record<string, unknown> }) => {
      const resize = 'defaultHydraWidth' in patch
      const applied = resize ? resizeViewPatch({
        state,
        patch,
      }) : patch
      const entries = Object.entries(applied)
      const sharedPatch = Object.fromEntries(entries.filter(([key]) => isSettingKey({ key })))
      const boardPatch = Object.fromEntries(entries.filter(([key]) => !isSettingKey({ key })))

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

      const workspace = boardPatch.workspace
      const foldOnly = Object.keys(boardPatch).length === 1 && workspace
        && typeof workspace === 'object'
        && Object.keys(workspace).every(key => key === 'foldedProjects')

      if (!resize && Object.keys(boardPatch).length) {
        writes.push(command({
          name: 'view',
          args: [
            'set',
            '--json',
            JSON.stringify(boardPatch),
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
