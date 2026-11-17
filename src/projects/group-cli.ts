import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { parse, meta, WRITE, required } from '#app/cli-support.ts'
import type { Meta } from '#app/command-meta.ts'
import { withWriter } from '#app/writer.ts'
import { withRegistryLock } from '#store/storage.ts'
import { HydraError } from '#store/errors.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import type { HydraProject } from './model.ts'
import { findProject, projectFolder, sharingHydras } from './read.ts'

export function childRepositories({ path }: { path: string }) {
  if (existsSync(join(
    path,
    '.git',
  ))) {
    return []
  }

  return readdirSync(
    path,
    { withFileTypes: true },
  )
    .filter(entry => entry.isDirectory() && existsSync(join(
      path,
      entry.name,
      '.git',
    )))
    .map(entry => join(
      path,
      entry.name,
    ))
    .sort()
}

export function attachProjectGroup({
  hydraId,
  paths,
  name,
  groupId,
  meta: commandMeta,
  attach,
  landing,
  merge,
}: {
  hydraId: string
  paths: string[]
  name: string
  groupId?: string
  meta: Meta
  attach: boolean
  landing?: HydraProject['landing']
  merge?: HydraProject['merge']
}) {
  return withRegistryLock({
    fn: () => withWriter({
      hydraId,
      fn: ({ writer }) => {
        const state = writer.state

        if (state.config?.hydra.kind === 'firstmate') {
          throw new HydraError({
            message: 'Firstmate manages this Hydra’s projects',
            code: 'READ_ONLY',
          })
        }

        if (commandMeta.id && Object.hasOwn(
          state.eventIds,
          commandMeta.id,
        )) {
          return { skipped: 'duplicate' }
        }

        const revision = state.projectsRevision ?? 0

        if (commandMeta.ifRevision !== undefined && commandMeta.ifRevision !== revision) {
          throw new HydraError({
            message: `revision ${revision}, not ${commandMeta.ifRevision}`,
            code: 'REVISION_CONFLICT',
          })
        }

        const canonical = [...new Set(paths.map(path => projectFolder({ path })))]
        const knownGroup = state.projects?.find(project => project.group?.name === name)?.group
        const group = {
          id: groupId ?? knownGroup?.id ?? `group:${randomUUID()}`,
          name,
        }
        const after = canonical.map(path => {
          const before = state.projects?.find(project => project.path === path)

          if (!attach && (!before || before.detached)) {
            findProject({
              state,
              ref: path,
              attached: true,
            })
          }

          const others = sharingHydras({
            hydraId,
            path,
          })

          if ((!before || before.detached) && others.length) {
            throw new HydraError({
              message: `${path} belongs to Hydra ${others.map(hydra => hydra.id).join(', ')}`,
              code: 'CONFLICT',
            })
          }

          if (before?.group && before.group.id !== group.id) {
            throw new HydraError({
              message: `${path} already belongs to project ${before.group.name}`,
              code: 'CONFLICT',
            })
          }

          return {
            before: before ?? null,
            after: {
              ...before,
              path,
              name: before?.name ?? basename(path),
              landing: landing ?? before?.landing,
              merge: merge ?? before?.merge,
              detached: false,
              group,
            },
          }
        })

        const changes = after.filter(change =>
          JSON.stringify(change.before) !== JSON.stringify(change.after))

        if (!changes.length && commandMeta.id && after[0]) {
          changes.push(after[0])
        }

        const attempt = commandMeta.id ?? randomUUID()

        for (const [
          index,
          change,
        ] of changes.entries()) {
          const event = hydraEvent({
            state: writer.state,
            meta: {
              ...commandMeta,
              ifRevision: undefined,
              id: index === changes.length - 1 ? attempt : `${attempt}:${index}`,
            },
            cardId: '$projects',
            change: {
              type: 'hydra.project',
              data: {
                ...change,
                sharedWith: [],
              },
            },
          })

          if ('event' in event) {
            writer.append({ event: event.event })
          }
        }

        return {
          project: group,
          repositories: canonical,
        }
      },
    }),
  })
}

export function projectGroupCommand({ args }: { args: string[] }) {
  const {
    values,
    positionals,
    hydraId,
  } = parse({
    args,
    options: WRITE,
    positionals: Number.MAX_SAFE_INTEGER,
  })
  const name = required({
    value: positionals[1],
    what: 'project name',
  })
  const paths = positionals.slice(2)

  if (!paths.length) {
    throw new HydraError({
      message: 'Use project group <name> <repo-path>...',
      code: 'VALIDATION_ERROR',
    })
  }

  return attachProjectGroup({
    hydraId,
    paths,
    name,
    meta: meta({ values }),
    attach: false,
  })
}
