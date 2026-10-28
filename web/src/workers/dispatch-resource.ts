import { useSyncExternalStore } from 'react'
import type { AgentConfig } from '../../../src/workers/model.ts'
import type { EffectiveDispatch } from '../../../src/workers/dispatch-config.ts'
import { createSettingsResource } from '../shared/settings-resource.ts'

const dispatches = new Map<string, ReturnType<typeof createDispatch>>()

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

export function useInstallationPending() {
  const dispatch = dispatchSettings()

  return useSyncExternalStore(
    dispatch.subscribe,
    dispatch.snapshot,
  ).intents
}
