import { useEffect, useSyncExternalStore } from 'react'
import type { HydraProject } from '../../../src/core/model.ts'
import type { Command } from '../app/connection.ts'
import { argument } from './optimistic.ts'
import { DEFAULT_LANDING, type LandingChoice } from './landing-fields.tsx'
import { createSettingsResource } from '../shared/settings-resource.ts'
import { CommandFailure } from '../shared/pending-intents.ts'

export interface ProjectRow {
  name: string
  path: string
  state: string
  landing: LandingChoice['landing']
  merge: LandingChoice['merge']
  startCommand?: HydraProject['startCommand']
  pending?: string
}
interface ProjectsState {
  rows: ProjectRow[]
  readonly: boolean
  revision: number
}
interface ProjectPatch {
  args: string[]
  path: string
}

function pendingProject({
  action,
  clone,
}: {
  action?: string
  clone: boolean
}): string {
  if (action === 'remove') {
    return 'Detaching…'
  }

  if (action === 'set') {
    return 'Saving project settings…'
  }

  return clone ? 'Cloning and checking attachment…' : 'Checking attachment…'
}

const resources = new WeakMap<Command, ReturnType<typeof createProjects>>()

function createProjects() {
  return createSettingsResource<ProjectsState, ProjectPatch>({
    scope: `projects:${crypto.randomUUID()}`,
    newer: ({
      current,
      next,
    }) => next.revision >= current.revision,
    project: ({
      state,
      patch,
    }) => {
      const [action] = patch.args
      const clone = patch.args.includes('--clone')
      const previous = state?.rows.find(row => row.path === patch.path)
      const option = ({ flag }: { flag: string }) => argument({
        args: patch.args,
        flag,
      })
      const landing = option({ flag: '--landing' }) as LandingChoice['landing'] | undefined
      const merge = option({ flag: '--merge' }) as LandingChoice['merge'] | undefined
      const row: ProjectRow = {
        name: previous?.name ?? patch.path.split('/').filter(Boolean)
          .at(-1) ?? patch.path,
        path: patch.path,
        ...DEFAULT_LANDING,
        ...previous,
        state: action === 'remove' ? 'detached' : 'attached',

        pending: pendingProject({
          action,
          clone,
        }),
      }

      if (landing) {
        row.landing = landing
      }

      if (merge) {
        row.merge = merge
      }

      const shell = option({ flag: '--command' })

      if (shell !== undefined && !shell.trim()) {
        row.startCommand = undefined
      } else if (shell !== undefined) {
        row.startCommand = {
          name: option({ flag: '--command-name' }) ?? previous?.startCommand?.name ?? '',
          command: shell,
          bringsOwnFolder: option({ flag: '--brings-own-folder' }) === 'true',
        }
      }

      return {
        rows: [
          ...(state?.rows ?? []).filter(row => row.path !== patch.path),
          row,
        ],
        readonly: state?.readonly ?? false,
        revision: state?.revision ?? 0,
      }
    },
    represented: ({
      state,
      patch,
    }) => {
      const row = state.rows.find(row => row.path === patch.path)

      if (patch.args[0] === 'remove') {
        return row?.state === 'detached'
      }

      if (patch.args[0] === 'add') {
        return row?.state === 'attached'
      }

      if (!row) {
        return false
      }

      const option = ({ flag }: { flag: string }) => argument({
        args: patch.args,
        flag,
      })
      const landing = option({ flag: '--landing' }), merge = option({ flag: '--merge' })
      const shell = option({ flag: '--command' })

      if ((landing !== undefined && row.landing !== landing)
        || (merge !== undefined && row.merge !== merge)) {
        return false
      }

      if (shell === undefined) {
        return true
      }

      if (!shell.trim()) {
        return !row.startCommand
      }

      return row.startCommand?.command === shell
        && row.startCommand.name === option({ flag: '--command-name' })
        && row.startCommand.bringsOwnFolder === (option({ flag: '--brings-own-folder' }) === 'true')
    },
    read: ({ receipt }) => receipt.confirmation === 'needed' ? undefined : {
      rows: Array.isArray(receipt.projects) ? receipt.projects as ProjectRow[] : [],
      readonly: receipt.readonly === true,
      revision: Number(receipt.revision ?? 0),
    },
  })
}

function projectResource({ command }: { command: Command }) {
  let resource = resources.get(command)

  if (!resource) {
    resource = createProjects()
    resources.set(
      command,
      resource,
    )
  }

  return resource
}

export function useProjectsResource({
  command,
  connected,
  revision,
}: {
  command: Command
  connected: boolean
  revision?: number | string
}) {
  const resource = projectResource({ command })
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.snapshot,
  )
  useEffect(
    () => {
      if (connected) {
        void resource.refresh({
          command,
          name: 'project',
          args: ['list'],
        })
      }
    },
    [
      resource,
      command,
      connected,
      revision,
    ],
  )

  const mutate = ({ args }: { args: string[] }) => {
    const path = args.includes('--clone') ? argument({
      args,
      flag: '--into',
    }) ?? '' : args[1] ?? ''

    const execute: Command = async () => {
      const receipt = await command({
        name: 'project',
        args,
      })

      if (receipt.confirmation === 'needed') {
        return receipt
      }

      try {
        const canonical = await command({
          name: 'project',
          args: ['list'],
        })

        return {
          ...receipt,
          ...canonical,
        }
      } catch (error) {
        throw new CommandFailure({
          message: 'The project request completed, but its current state could not be refreshed. Check before retrying.',
          code: error instanceof CommandFailure ? error.code : 'REFRESH_FAILED',
          outcome: 'unknown',
        })
      }
    }

    execute.retain = command.retain

    return resource.write({
      command: execute,
      name: 'project',
      args,
      patch: {
        path,
        args,
      },
      targets: [path],
      serial: path,
    })
  }

  return {
    projects: snapshot.view?.rows ?? [],
    readonly: snapshot.view?.readonly ?? false,
    loaded: snapshot.confirmed !== null,
    error: snapshot.error,
    intents: snapshot.intents,
    mutate,
    refresh: () => resource.refresh({
      command,
      name: 'project',
      args: ['list'],
    }),
  }
}
