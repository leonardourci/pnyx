import { useSyncExternalStore } from 'react'
import type { AgentConfig } from '../../../src/core/model.ts'
import type { EffectiveDispatch } from '../../../src/dispatch/config.ts'
import { createSettingsResource } from '../shared/settings-resource.ts'

const dispatches = new Map<string, ReturnType<typeof createDispatch>>()
const preferences = new Map<string, ReturnType<typeof createPreferences>>()

function installationScope({ resource }: { resource: string }): string {
  const identity = document.querySelector<HTMLMetaElement>('meta[name=pnyx-installation]')?.content ?? ''

  return `${location.origin}:${identity}/${resource}`
}

function createDispatch({ scope }: { scope: string }) {
  return createSettingsResource<EffectiveDispatch, Partial<AgentConfig>>({
    scope,
    project: ({
      state,
      patch,
    }) => {
      if (!state) {
        return state
      }

      const rule = state.dispatch.rules.hydra
      const base = rule?.candidates[0] ?? { harness: 'claude' as const }
      const candidate = {
        ...base,
        ...patch,
      }

      return {
        ...state,
        dispatch: {
          ...state.dispatch,
          rules: {
            ...state.dispatch.rules,
            hydra: {
              when: rule?.when ?? 'Hydra',
              candidates: [candidate],
            },
          },
        },
      }
    },
    represented: ({
      state,
      patch,
    }) => {
      const candidate: Partial<AgentConfig> | undefined = state.dispatch.rules.hydra?.candidates[0]

      return !!candidate && Object.entries(patch).every(([
        key,
        value,
      ]) =>
        candidate[key as keyof AgentConfig] === value)
    },
    read: ({ receipt }) => receipt as unknown as EffectiveDispatch,
  })
}

function createPreferences({ scope }: { scope: string }) {
  return createSettingsResource<Record<string, string>, Record<string, string>>({
    scope,
    project: ({
      state,
      patch,
    }) => ({
      ...state,
      ...patch,
    }),
    represented: ({
      state,
      patch,
    }) => Object.entries(patch).every(([
      key,
      value,
    ]) => state[key] === value),
    read: ({ receipt }) => receipt.settings as Record<string, string>,
  })
}

export function dispatchSettings() {
  const scope = installationScope({ resource: 'dispatch' })
  let resource = dispatches.get(scope)

  if (!resource) {
    resource = createDispatch({ scope })
    dispatches.set(
      scope,
      resource,
    )
  }

  return resource
}

export function oracleSettings() {
  const scope = installationScope({ resource: 'oracle-settings' })
  let resource = preferences.get(scope)

  if (!resource) {
    resource = createPreferences({ scope })
    preferences.set(
      scope,
      resource,
    )
  }

  return resource
}

export function useInstallationPending() {
  const dispatch = dispatchSettings(), oracle = oracleSettings()
  const dispatchState = useSyncExternalStore(
    dispatch.subscribe,
    dispatch.snapshot,
  )
  const oracleState = useSyncExternalStore(
    oracle.subscribe,
    oracle.snapshot,
  )

  return [
    ...dispatchState.intents,
    ...oracleState.intents,
  ]
}
