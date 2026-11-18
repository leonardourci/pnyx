import { createHash } from 'node:crypto'
import { ownerRevision } from './owner-memory-log.ts'
import { sharesWithMore } from './access-changes.ts'
import { hydraIds } from '#app/home-migration.ts'
import { hydraActor, requestEnv } from '#app/request-context.ts'
import { proposeOwnerCommand } from '#app/confirmations.ts'
import { findProject, projectsFor } from '#projects/read.ts'
import { projectIdentity } from '#projects/sources.ts'
import type { HydraState } from '#app/model.ts'
import { loadHydra } from '#app/store.ts'
import { readSettings } from '#settings/store.ts'
import type { Settings } from '#settings/model.ts'
import { HydraError } from '#store/errors.ts'

import { canRead, canWrite, hydraPolisConfig } from './polis-policy.ts'

export { canRead, canWrite, DEFAULT_POLIS_ACCESS, hydraPolisConfig, POLIS_NAME } from './polis-policy.ts'

export function memoryAgent(): boolean {
  const env = requestEnv()
  const actor = env.PNYX_ACTOR ?? ''

  return actor === 'hydra' || actor.startsWith('worker:') || actor.startsWith('helper:') || Boolean(env.PNYX_TASK)
}

export function memoryCaller({ hydraId }: { hydraId: string }): boolean {
  return !memoryAgent() || requestEnv().PNYX_HYDRA === hydraId
}

export function polisAccess({
  hydraId,
  state = loadHydra({ hydraId }).state,
  settings = readSettings().settings,
}: {
  hydraId: string
  state?: Pick<HydraState, 'config'>
  settings?: Settings
}) {
  const input = {
    hydraId,
    state,
    poleis: settings.poleis,
  }
  const access = hydraPolisConfig({ state })
  const allowed = memoryCaller({ hydraId })
  const reads = access.readPoleis.filter(polis => allowed && canRead({
    ...input,
    polis,
  }))
  const writablePolis = allowed && canWrite({
    ...input,
    polis: access.polis,
  }) ? access.polis : undefined

  return {
    reads,
    writablePolis,
    write: () => {
      if (writablePolis === undefined) {
        throw new HydraError({
          message: 'Memory is unavailable',
          code: 'NOT_FOUND',
        })
      }

      return writablePolis
    },
  }
}

export function canReadProject({
  hydraId,
  state,
  id,
  settings = readSettings().settings,
}: {
  hydraId: string
  state: Pick<HydraState, 'config'>
  id: string
  settings?: Settings
}): boolean {
  return memoryCaller({ hydraId }) && canRead({
    hydraId,
    state,
    poleis: settings.poleis,
    polis: settings.projectPoleis[id] ?? 'shared',
  })
}

export function requireProjectMemory({
  hydraId,
  id,
}: {
  hydraId: string
  id: string
}): void {
  const state = loadHydra({ hydraId }).state

  if (!canReadProject({
    hydraId,
    state,
    id,
  })) {
    throw new HydraError({
      message: 'project not found',
      code: 'NOT_FOUND',
    })
  }
}

export async function readableProjects({
  hydraId,
  state,
}: {
  hydraId: string
  state: HydraState
}) {
  if (!memoryCaller({ hydraId })) {
    return []
  }

  const projects = projectsFor({ state })
  const identities = await Promise.all(projects.map(project => projectIdentity(project)))
  const current = loadHydra({ hydraId }).state
  const currentProjects = new Map(projectsFor({ state: current }).map(project => [
    project.path,
    project,
  ]))
  const settings = readSettings().settings

  return identities.flatMap((
    { id },
    index,
  ) => {
    const original = projects[index]
    const project = original && currentProjects.get(original.path)

    if (!project || !canReadProject({
      hydraId,
      state: current,
      settings,
      id,
    })) {
      return []
    }

    return [project]
  })
}

export async function findReadableProject({
  hydraId,
  state,
  ref,
  attached = false,
}: {
  hydraId: string
  state: HydraState
  ref: string
  attached?: boolean
}) {
  return findProject({
    state,
    ref,
    attached,
    projects: await readableProjects({
      hydraId,
      state,
    }),
  })
}

export function memoryHydras() {
  return hydraIds().map(id => ({
    id,
    state: loadHydra({ hydraId: id }).state,
  }))
}

export function memoryAccessRevision(): string {
  const read = readSettings()
  const settings = read.settings
  const hydras = memoryHydras()
  const readLists = hydras.map(({
    id,
    state,
  }) => {
    const access = hydraPolisConfig({ state })

    return {
      id,
      ...access,
      configRevision: state.configRevision ?? 0,
      projectsRevision: state.projectsRevision ?? 0,
      attachments: projectsFor({ state }),
    }
  }).sort((
    left,
    right,
  ) => left.id.localeCompare(right.id))

  return createHash('sha256').update(JSON.stringify({
    settings,
    settingsRevision: read.revision,
    readLists,
  }))
    .digest('hex')
}

export function checkMemoryApproval(): void {
  const expected = requestEnv().PNYX_MEMORY_ACCESS

  if (expected && expected !== memoryAccessRevision()) {
    throw new HydraError({
      message: 'Memory access changed; propose the action again',
      code: 'CONFLICT',
    })
  }
}

export function memoryPermission({
  hydraId,
  name,
  args,
  propose,
  widening,
  actor,
}: {
  hydraId: string
  name: string
  args: string[]
  propose: boolean
  widening: boolean
  actor: string
}) {
  if (!memoryCaller({ hydraId })) {
    throw new HydraError({
      message: 'Memory is unavailable',
      code: 'NOT_FOUND',
    })
  }

  checkMemoryApproval()

  if (propose) {
    return proposeOwnerCommand({
      hydraId,
      name,
      args: args.filter(arg => arg !== '--propose'),
    })
  }

  if (widening && (memoryAgent() || hydraActor({ actor }))) {
    throw new HydraError({
      message: 'Widening memory access needs the owner’s Confirm',
      code: 'OWNER_ONLY',
      help: ['Repeat with --propose'],
    })
  }

  return undefined
}

export function memoryMovePermission({
  destinationRevision,
  revision,
  hydraId,
  destination,
  args,
  propose,
  actor,
}: {
  destinationRevision: number
  revision: number
  hydraId: string
  destination: string
  args: string[]
  propose: boolean
  actor: string
}) {
  const settings = readSettings().settings
  const state = loadHydra({ hydraId }).state
  const source = polisAccess({
    hydraId,
    state,
    settings,
  }).write()

  if (!canRead({
    hydraId,
    state,
    poleis: settings.poleis,
    polis: destination,
  })) {
    throw new HydraError({
      message: 'Memory is unavailable',
      code: 'NOT_FOUND',
    })
  }

  const pinned = args.some(arg => arg === '--if-revision' || arg.startsWith('--if-revision='))
  const sourceArgs = pinned ? args : [
    ...args,
    '--if-revision',
    String(ownerRevision({
      polis: source,
      revision,
    })),
  ]

  const destinationPinned = args.some(arg => arg === '--if-destination-revision' || arg.startsWith('--if-destination-revision='))
  const proposalArgs = destinationPinned ? sourceArgs : [
    ...sourceArgs,
    '--if-destination-revision',
    String(destinationRevision),
  ]

  return memoryPermission({
    hydraId,
    name: 'owner',
    args: proposalArgs,
    propose,
    actor,
    widening: sharesWithMore({
      source,
      destination,
      before: settings,
      hydras: memoryHydras(),
    }),
  })
}
