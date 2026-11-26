import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TITAN_ID } from '#titan/identity.ts'
import { COMPONENT, hydraFiles, taskFiles } from '#store/file-home.ts'
import { readLog, type LogEntry } from '#store/log.ts'
import { othrysHome } from '#store/paths.ts'
import { assembleNative, nativeId, nativeReferences, reduceNative, type NativeState } from './native-state.ts'
import type { TitanState } from './model.ts'

function directories({ path }: { path: string }): string[] {
  if (!existsSync(path)) {
    return []
  }

  return readdirSync(
    path,
    { withFileTypes: true },
  ).filter(entry => entry.isDirectory() && COMPONENT.test(entry.name))
    .map(entry => entry.name)
}

export function nativeTitanIds(): string[] {
  const home = othrysHome()

  return directories({
    path: join(
      home,
      'titans',
    ),
  }).filter(hydra => TITAN_ID.test(hydra)
    && existsSync(join(
      hydraFiles({
        home,
        hydra,
      }),
      'titan.log',
    )))
    .sort()
}

export function readNativeTitan({ hydraId }: { hydraId: string }): {
  dir: string
  state: TitanState
} {
  const home = othrysHome()
  const dir = hydraFiles({
    home,
    hydra: hydraId,
  })
  const scopes = [
    {
      id: hydraId,
      path: join(
        dir,
        'titan.log',
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
  const publishedScopes = scopes.filter(scope => lstatSync(
    scope.path,
    { throwIfNoEntry: false },
  )?.isFile())
  const positions = new Map<string, number>()
  const projections = new Map<string, NativeState>()
  const entries: {
    scope: string
    entry: LogEntry
  }[] = []

  for (const scope of publishedScopes) {
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
      positions,
      hydra: hydrated({ id: hydraId }),
      tasks: scopes.slice(1).filter(scope => projections.has(scope.id))
        .map(scope => [
          scope.id,
          hydrated({ id: scope.id }),
        ]),
    }),
  }
}
