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

interface SharedSettingsPatch {
  settings: Partial<Settings>
  settingsRevision?: number
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
  return createSettingsResource<SharedSettings, SharedSettingsPatch>({
    scope,
    project: ({
      state,
      patch,
    }) => state && {
      ...state,
      revision: patch.settingsRevision ?? state.revision,
      settings: applied({
        settings: state.settings,
        patch: patch.settings,
      }),
    },
    represented: ({
      state,
      patch,
    }) => {
      const after = applied({
        settings: state.settings,
        patch: patch.settings,
      })

      return Object.keys(patch.settings).every(key => JSON.stringify(after[key as SettingKey])
        === JSON.stringify(state.settings[key as SettingKey]))
    },
    read: ({ receipt }) => {
      // view set nests the settings receipt under settings when it also saves the Titan's own view.
      const nested = receipt.settings as Receipt | undefined
      const saved = nested?.settings ? nested : receipt

      return saved.settings ? {
        settings: saved.settings as Settings,
        revision: saved.revision as number,
      } : undefined
    },
    // A starting server rewrites the settings row at its own revision, so an equal revision replaces what the page holds,
    // such as a cached row an older build wrote.
    newer: ({
      current,
      next,
    }) => next.revision >= current.revision,
  })
}

// Every Titan and tab of one install shares these; the server pushes each change.
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

function useSharedSettingsState(): SharedSettings | undefined {
  const resource = sharedSettings()

  return useSyncExternalStore(
    resource.subscribe,
    resource.snapshot,
  ).view ?? undefined
}

export function useSharedSettings(): Settings | undefined {
  return useSharedSettingsState()?.settings
}

export function saveSharedSettings({
  command,
  patch,
  view,
  revision: settingsRevision,
}: {
  command: Command
  patch: Partial<Settings>
  revision?: number
  view?: {
    patch: Record<string, unknown>
    revision: number
  }
}) {
  const expectedRevision = view ? view.revision : settingsRevision
  const revisionGuard = expectedRevision !== undefined ? [
    '--if-revision',
    String(expectedRevision),
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
    patch: {
      settings: patch,
      settingsRevision: view ? undefined : settingsRevision,
    },
    targets: Object.keys(patch),
  })
}
