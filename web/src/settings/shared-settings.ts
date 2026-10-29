import { useSyncExternalStore } from 'react'
import type { Settings } from '#settings/model.ts'
import { patchSettings } from '#settings/settings.ts'
import type { Command } from '#web-app/connection.ts'
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
    }) => JSON.stringify(applied({
      settings: state.settings,
      patch,
    })) === JSON.stringify(state.settings),
    read: ({ receipt }) => receipt.settings ? {
      settings: receipt.settings as Settings,
      revision: receipt.revision as number,
    } : undefined,
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
}: {
  command: Command
  patch: Partial<Settings>
}) {
  return sharedSettings().write({
    command,
    name: 'settings',
    args: [
      'set',
      '--json',
      JSON.stringify(patch),
      '--event-id',
      crypto.randomUUID(),
    ],
    patch,
    targets: Object.keys(patch),
  })
}
