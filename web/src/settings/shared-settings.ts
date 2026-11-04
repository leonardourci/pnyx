import { useSyncExternalStore } from 'react'
import type { SettingKey, Settings } from '#settings/model.ts'
import { patchSettings } from '#settings/settings.ts'
import type { Command, Receipt } from '#web-app/connection.ts'
import { createSettingsResource } from '#web-shared/settings-resource.ts'
import { installationScope } from '#web-shared/installation.ts'

interface SharedSettings {
  settings: Settings
  revision: number
}

const resources = new Map<string, ReturnType<typeof createShared>>()

const applied = ({
  settings,
  patch,
}: {
  settings: Settings
  patch: Partial<Settings>
}) => patchSettings({
  current: settings,
  input: patch,
})

function createShared({ scope }: { scope: string }) {
  return createSettingsResource<SharedSettings, Partial<Settings>>({
    scope,
    project: ({
      state,
      patch,
    }) => state && {
      ...state,
      settings: applied({
        settings: state.settings,
        patch,
      }),
    },
    represented: ({
      state,
      patch,
    }) => {
      const after = applied({
        settings: state.settings,
        patch,
      })

      return Object.keys(patch).every(key => JSON.stringify(after[key as SettingKey])
        === JSON.stringify(state.settings[key as SettingKey]))
    },
    read: ({ receipt }) => {
      // view set nests the settings receipt under settings when it also saves the Hydra's own view.
      const nested = receipt.settings as Receipt | undefined
      const saved = nested?.settings ? nested : receipt

      return saved.settings ? {
        settings: saved.settings as Settings,
        revision: saved.revision as number,
      } : undefined
    },
    newer: ({
      current,
      next,
    }) => next.revision > current.revision,
  })
}

// Every Hydra and tab of one install shares these; the server pushes each change.
export function sharedSettings() {
  const scope = installationScope({ resource: 'settings' })
  let resource = resources.get(scope)

  if (!resource) {
    resource = createShared({ scope })
    resources.set(
      scope,
      resource,
    )
  }

  return resource
}

export function useSharedSettings(): Settings | undefined {
  const resource = sharedSettings()

  return useSyncExternalStore(
    resource.subscribe,
    resource.snapshot,
  ).view?.settings
}

export function saveSharedSettings({
  command,
  patch,
  view,
}: {
  command: Command
  patch: Partial<Settings>
  view?: {
    patch: Record<string, unknown>
    revision: number
  }
}) {
  const revisionGuard = view ? [
    '--if-revision',
    String(view.revision),
  ] : []

  return sharedSettings().write({
    command,
    name: view ? 'view' : 'settings',
    args: [
      'set',
      '--json',
      JSON.stringify(view?.patch ?? patch),
      ...revisionGuard,
      '--event-id',
      crypto.randomUUID(),
    ],
    patch,
    targets: Object.keys(patch),
  })
}
