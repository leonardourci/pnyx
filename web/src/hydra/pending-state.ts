import { commandBytes, MAX_MESSAGE_BYTES } from '../../../src/app/server-protocol.ts'
import type { HydraState } from '../../../src/app/model.ts'
import { argument, optimisticState, type Edit } from './optimistic.ts'
import { CommandFailure, createPendingResource } from './pending-intents.ts'

function createHydraResource({
  scope,
  confirmed,
}: {
  scope: string
  confirmed: HydraState
}) {
  return createPendingResource<HydraState, Edit>({
    scope,
    confirmed,
    adapter: {
      project: ({
        state,
        patch,
      }) => {
        const projected = optimisticState({
          state,
          edit: patch,
        })

        if (projected === state) {
          throw new CommandFailure({
            message: 'This edit no longer has an available target.',
            code: 'TARGET_UNAVAILABLE',
          })
        }

        return projected
      },
      represented: ({
        state,
        intent,
      }) => {
        const event = argument({
          args: intent.patch.args,
          flag: '--event-id',
        })

        const saved = intent.patch.name === 'hydra-agent' ? intent.id : event

        return !!saved && state.eventIds[saved] !== undefined
      },
    },
  })
}

export type HydraResource = ReturnType<typeof createHydraResource>
const resources = new Map<string, HydraResource>()

export function pendingHydra({
  scope,
  confirmed,
}: {
  scope: string
  confirmed: HydraState
}): HydraResource {
  let resource = resources.get(scope)

  if (!resource) {
    resource = createHydraResource({
      scope,
      confirmed,
    })
    resources.set(
      scope,
      resource,
    )
  }

  return resource
}

export function editTargets({ edit }: { edit: Edit }): string[] {
  if (edit.name === 'task' && edit.args[0] === 'create') {
    return [
      argument({
        args: edit.args,
        flag: '--key',
      })
      ?? `task:${argument({
        args: edit.args,
        flag: '--event-id',
      })}`,
    ]
  }

  if (edit.name === 'column' && edit.args[0] === 'create') {
    return [
      argument({
        args: edit.args,
        flag: '--id',
      }) ?? 'columns',
    ]
  }

  if (edit.name === 'view' || edit.name === 'hydra') {
    return [edit.name]
  }

  return [edit.args[edit.name === 'move' ? 0 : 1] ?? edit.name]
}

export function commandArguments({
  id,
  edit,
  persisted,
  scope,
}: {
  id: string
  edit: Edit
  persisted: boolean
  scope?: string
}): string[] {
  const hasEvent = argument({
    args: edit.args,
    flag: '--event-id',
  }) !== undefined
  const args = persisted && edit.name !== 'hydra-agent' && !hasEvent ? [
    ...edit.args,
    '--event-id',
    id,
  ] : edit.args

  if (commandBytes({
    id,
    name: edit.name,
    args,
    scope,
  }) > MAX_MESSAGE_BYTES) {
    throw new CommandFailure({
      message: 'Message exceeds the 64 KiB limit. Shorten the draft or file contents. Draft kept.',
      code: 'MESSAGE_TOO_LARGE',
    })
  }

  return args
}
