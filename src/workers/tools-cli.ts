import { BROWSER_TOOL, recordTools, requireToolAuthority } from './tools.ts'
import { loadHydra } from '#app/store.ts'
import { findCard } from '#tasks/push-rules.ts'
import { askHost } from '#app/server-state.ts'
import { required } from '#app/cli-support.ts'
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

  if (values.available && !values.grant && !values.revoke) {
    return {
      task: card.id,
      tools: [BROWSER_TOOL],
    }
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
      help: ['Ask Hydra with task ask for an isolated browser'],
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

  const output = {
    task: card.id,
    ...result,
    ...delivery,
  }

  // Another launch route cannot enforce the selection, so it waits for a Pnyx-hosted start.
  if (result.changed && card.agent && card.agent.host !== 'pnyx') {
    return {
      ...output,
      help: ['This agent runs outside Pnyx, so the selection applies from its next Pnyx-hosted start'],
    }
  }

  return output
}
