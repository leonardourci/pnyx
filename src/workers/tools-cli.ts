import { BROWSER_TOOL, recordTools, requireConfigured, requireToolAuthority } from './tools.ts'
import { harnessOf } from './providers.ts'
import { loadHydra } from '#app/store.ts'
import { findCard } from '#tasks/push-rules.ts'
import { askHost } from '#app/server-state.ts'
import { required } from '#app/cli-support.ts'
import { HydraError } from '#store/errors.ts'
import type { Meta } from '#app/command-meta.ts'

export async function toolsCommand({
  hydraId,
  ref,
  values,
  meta,
}: {
  hydraId: string
  ref?: string
  values: Record<string, unknown>
  meta: Meta
}) {
  const task = required({
    value: ref,
    what: 'task id',
  })
  const state = loadHydra({ hydraId }).state
  const card = findCard({
    state,
    ref: task,
  })

  if (values.grant || values.revoke) {
    requireToolAuthority({ meta })
  }

  const workerHarness = card.agent ? harnessOf({ provider: card.agent.provider }) : undefined
  const wrongHarness = values.harness && values.harness !== workerHarness
  const wrongAccount = values.account && values.account !== card.agent?.account

  if (card.agent && values.grant && (wrongHarness || wrongAccount)) {
    throw new HydraError({
      message: 'Grant tools for the worker’s current harness and account',
      code: 'VALIDATION_ERROR',
    })
  }

  if (values.available || values.grant) {
    const catalog = await askHost({
      hydraId,
      body: {
        action: 'tool-catalog',
        task: card.id,
        harness: values.harness,
        account: values.account,
        actor: meta.actor,
      },
    })

    if (values.available && !values.grant && !values.revoke) {
      return catalog
    }

    requireConfigured({
      names: grants ?? [],
      offered: catalog.tools as string[],
    })
  }

  if (!values.grant && !values.revoke) {
    let selection = 'default'

    if (card.toolsRevision) {
      selection = card.toolsRevision === card.toolsApplied ? 'applied' : 'pending'
    }

    return {
      task: card.id,
      selection,
      tools: card.tools ?? [],
      help: ['Ask Hydra with task ask for another configured tool'],
    }
  }

  const result = recordTools({
    hydraId,
    task: card.id,
    grant: values.grant as string[] | undefined,
    revoke: values.revoke as string[] | undefined,
    meta,
  })

  const delivery = result.changed && card.agent?.host === 'pnyx' ? await askHost({
    hydraId,
    body: {
      action: 'tools-changed',
      task: card.id,
      actor: meta.actor,
    },
  }) : {}

  return {
    task: card.id,
    ...result,
    ...delivery,
  }
}
