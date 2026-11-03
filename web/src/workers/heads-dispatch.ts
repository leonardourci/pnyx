import { dispatchDocument, dispatchSettings } from './dispatch-resource.ts'
import { useEffect, useSyncExternalStore } from 'react'
import type { AgentConfig } from '#workers/model.ts'
import type { EffectiveDispatch } from '#workers/dispatch-config.ts'
import { harnessAccount } from '#workers/account-choice.ts'
import type { Command } from '#web-app/connection.ts'

export const DISPATCH_CHANGED = 'pnyx-dispatch-changed'

// rule apply answers with what changed; reading the document in the same step lets the preview become the saved state without a gap.
export const showingAfter = ({ command }: { command: Command }): Command => Object.assign(
  async ({
    name,
    args,
    onChecking,
  }: Parameters<Command>[0]) => {
    const applied = await command({
      name,
      args,
      onChecking,
    })

    // The change is saved; a failed read only leaves the next refresh to show it.
    return command({
      name: 'rule',
      args: ['show'],
    }).catch(() => applied)
  },
  { retain: command.retain },
)

// The account an agent runs on: the one it names, or its harness's first registered account.
export const resolvedAccount = ({
  effective,
  agent,
}: {
  effective?: EffectiveDispatch
  agent: Pick<AgentConfig, 'harness' | 'account'>
}) => agent.account ?? (effective ? harnessAccount({
  effective,
  harness: agent.harness,
}) : undefined)

export const hydraDefault = ({
  rule,
  next,
}: {
  rule?: AgentConfig
  next: AgentConfig
}): Partial<AgentConfig> => {
  const sameAccount = rule?.harness === next.harness && rule?.account === next.account

  return {
    harness: next.harness,
    account: next.account,
    model: next.model,
    effort: sameAccount ? rule?.effort : undefined,
    mode: sameAccount ? rule?.mode : undefined,
    fast: sameAccount ? rule?.fast : undefined,
  }
}

type Readable = Pick<ReturnType<typeof dispatchSettings>, 'refresh'>

function useRefreshed({
  resource,
  command,
  action,
}: {
  resource: Readable
  command: Command
  action: 'list' | 'show'
}) {
  useEffect(
    () => {
      const refresh = () => {
        void resource.refresh({
          command,
          name: 'rule',
          args: [action],
        })
      }

      refresh()
      window.addEventListener(
        DISPATCH_CHANGED,
        refresh,
      )
      window.addEventListener(
        'focus',
        refresh,
      )

      return () => {
        window.removeEventListener(
          DISPATCH_CHANGED,
          refresh,
        )
        window.removeEventListener(
          'focus',
          refresh,
        )
      }
    },
    [
      action,
      command,
      resource,
    ],
  )
}

export function useDispatchDocument({ command }: { command: Command }) {
  const resource = dispatchDocument()
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.snapshot,
  )
  useRefreshed({
    resource,
    command,
    action: 'show',
  })

  return {
    snapshot,
    resource,
  }
}

export function useHeadsDispatch({ command }: { command: Command }) {
  const resource = dispatchSettings()
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.snapshot,
  )
  const document = dispatchDocument()
  const saved = useSyncExternalStore(
    document.subscribe,
    document.snapshot,
  ).view
  useRefreshed({
    resource,
    command,
    action: 'list',
  })

  const saveHydra = async ({ patch }: { patch: Partial<AgentConfig> }) => {
    const args = [
      'set',
      'hydra',
    ]

    for (const field of [
      'harness',
      'account',
      'model',
      'effort',
      'mode',
      'fast',
    ] as const) {
      if (field in patch) {
        const value = patch[field]
        args.push(
          `--${field}`,
          field === 'fast'
            ? value === undefined ? 'default' : value ? 'on' : 'off' : String(value ?? ''),
        )
      }
    }

    await resource.write({
      command,
      name: 'rule',
      args,
      patch,
      targets: Object.keys(patch),
    })
    // A rule change answers with what changed, so the whole dispatch is read again.
    window.dispatchEvent(new Event(DISPATCH_CHANGED))
  }

  const listed = snapshot.view
  let effective = listed ?? undefined

  const newerAccounts = listed && saved && saved.revision >= (listed.revision ?? 0)
    && Object.keys(saved.document.accounts).length > 0

  if (listed && saved && newerAccounts) {
    effective = {
      ...listed,
      accounts: saved.document.accounts,
      fallback: undefined,
    }
  }

  return {
    effective,
    error: snapshot.error,
    saveHydra,
  }
}
