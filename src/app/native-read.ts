import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { HYDRA_ID } from '#hydra/identity.ts'
import { hydraFiles, taskFiles } from '#store/file-home.ts'
import { readLog, type LogEntry } from '#store/log.ts'
import { pnyxHome } from '#store/paths.ts'
import { assembleNative, nativeId, nativeReferences, reduceNative, type NativeState } from './native-state.ts'
import type { HydraState } from './model.ts'

function directories({ path }: { path: string }): string[] {
  if (!existsSync(path)) {
    return []
  }

  return readdirSync(
    path,
    { withFileTypes: true },
  ).filter(entry => entry.isDirectory())
    .map(entry => entry.name)
}

export function nativeHydraIds(): string[] {
  const home = pnyxHome()

  return directories({
    path: join(
      home,
      'hydras',
    ),
  }).filter(hydra => HYDRA_ID.test(hydra)
    && existsSync(join(
      hydraFiles({
        home,
        hydra,
      }),
      'hydra.log',
    )))
    .sort()
}

export function readNativeHydra({ hydraId }: { hydraId: string }): {
  dir: string
  state: HydraState
} {
  const home = pnyxHome()
  const dir = hydraFiles({
    home,
    hydra: hydraId,
  })
  const scopes = [
    {
      id: hydraId,
      path: join(
        dir,
        'hydra.log',
      ),
    },
    ...directories({
      path: join(
        dir,
        'tasks',
      ),
    }).sort()
      .map(task => ({
        id: task,
        path: join(
          taskFiles({
            home,
            hydra: hydraId,
            task,
          }),
          'task.log',
        ),
      })),
  ]
  const positions = new Map<string, number>()
  const projections = new Map<string, NativeState>()
  const entries: {
    scope: string
    entry: LogEntry
  }[] = []

  for (const scope of scopes) {
    let projection: NativeState = {}
    readLog({
      path: scope.path,
      readOnly: true,
      accept: ({ entry }: { entry: LogEntry }) => {
        entries.push({
          scope: scope.id,
          entry,
        })
        projection = reduceNative({
          state: projection,
          entry,
          id: scope.id,
        })
      },
    })
    projections.set(
      scope.id,
      projection,
    )
  }

  entries.sort((
    a,
    b,
  ) => a.entry.at.localeCompare(b.entry.at)
    || a.entry.n - b.entry.n || a.entry.id.localeCompare(b.entry.id))

  for (const {
    scope,
    entry,
  } of entries) {
    positions.set(
      nativeId({
        scope,
        id: entry.id,
      }),
      positions.size + 1,
    )
  }

  const hydrated = ({ id }: { id: string }) => nativeReferences({
    value: projections.get(id),
    ids: positions,
    restore: true,
  }) as NativeState

  return {
    dir,
    state: assembleNative({
      hydra: hydrated({ id: hydraId }),
      tasks: scopes.slice(1).map(scope => [
        scope.id,
        hydrated({ id: scope.id }),
      ]),
    }),
  }
}
