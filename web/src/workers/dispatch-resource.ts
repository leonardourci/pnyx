import { useSyncExternalStore } from 'react'
import type { AgentConfig } from '#workers/model.ts'
import type { EffectiveDispatch } from '#workers/dispatch-config.ts'
import type { ProposalStatus } from '#workers/dispatch-apply.ts'
import { canonical, mergePatch, type DispatchDocument } from '#workers/dispatch-check.ts'
import { createSettingsResource } from '#web-shared/settings-resource.ts'
import { installationScope } from '#web-shared/installation.ts'

export type DispatchView = EffectiveDispatch & { proposals?: ProposalStatus[] }

const dispatches = new Map<string, ReturnType<typeof createDispatch>>()

function createDispatch({ scope }: { scope: string }) {
  return createSettingsResource<DispatchView, Partial<AgentConfig>>({
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
              candidates: [
                candidate,
                ...rule?.candidates.slice(1) ?? [],
              ],
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
    read: ({ receipt }) => 'dispatch' in receipt ? receipt as unknown as DispatchView : undefined,
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

// The editable document as rule show prints it; a write is the merge patch rule apply takes.
export interface SavedDispatch {
  document: DispatchDocument
  revision: number
}

type DispatchPatch = Record<string, unknown>

const documents = new Map<string, ReturnType<typeof createDocument>>()

function createDocument({ scope }: { scope: string }) {
  return createSettingsResource<SavedDispatch, DispatchPatch>({
    scope,
    project: ({
      state,
      patch,
    }) => state && {
      document: mergePatch({
        target: state.document,
        patch,
      }) as DispatchDocument,
      revision: state.revision + 1,
    },
    represented: ({
      state,
      patch,
    }) => canonical({
      value: mergePatch({
        target: state.document,
        patch,
      }),
    }) === canonical({ value: state.document }),
    read: ({ receipt }) => typeof receipt.revision === 'number' && 'document' in receipt ? {
      document: receipt.document as DispatchDocument,
      revision: receipt.revision,
    } : undefined,
    newer: ({
      current,
      next,
    }) => next.revision >= current.revision,
  })
}

export function dispatchDocument() {
  const scope = installationScope({ resource: 'dispatch-document' })
  let resource = documents.get(scope)

  if (!resource) {
    resource = createDocument({ scope })
    documents.set(
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
