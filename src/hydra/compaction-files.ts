import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { HydraState } from '#app/model.ts'
import { COMPONENT, hydraFiles, taskFiles } from '#store/file-home.ts'
import { pnyxHome } from '#store/paths.ts'
import { nativeSources } from './native-window.ts'
import { HYDRA_CARD } from './identity.ts'
import { permissionCommand } from '#workers/permission-rules.ts'
import type { PermissionRequest } from '#workers/model.ts'
import type { PermissionDecision } from '#workers/provider.ts'

export function compactionFiles({
  hydraId,
  state,
}: {
  hydraId: string
  state: HydraState
}): string[] {
  const home = pnyxHome()
  const dir = hydraFiles({
    home,
    hydra: hydraId,
  })
  const tasks = join(
    dir,
    'tasks',
  )
  const directories = lstatSync(
    tasks,
    { throwIfNoEntry: false },
  )?.isDirectory() ? readdirSync(
      tasks,
      { withFileTypes: true },
    ).filter(entry => entry.isDirectory() && COMPONENT.test(entry.name)) : []

  return [
    ...new Set([
      join(
        dir,
        'hydra.log',
      ),
      join(
        dir,
        'snapshot.json',
      ),
      ...directories.flatMap(entry => {
        const task = taskFiles({
          home,
          hydra: hydraId,
          task: entry.name,
        })

        const taskLog = join(
          task,
          'task.log',
        )

        if (!lstatSync(
          taskLog,
          { throwIfNoEntry: false },
        )?.isFile()) {
          return []
        }

        return [
          taskLog,
          join(
            task,
            'worker.log',
          ),
        ]
      }),
      ...nativeSources({
        state,
        card: HYDRA_CARD,
      }).map(source => source.path),
    ]),
  ].filter(path => lstatSync(
    path,
    { throwIfNoEntry: false },
  )?.isFile())
}

export const readCommand = ({ path }: { path: string }) => `cat -- '${path.replace(
  /'/g,
  "'\\''",
)}'`

export function compactionPermission({
  paths,
  tool,
  input,
}: Pick<PermissionRequest, 'tool' | 'input'> & { paths: string[] }): PermissionDecision {
  const command = permissionCommand({
    tool,
    input,
  })
  const read = (tool === 'Read' && typeof input.file_path === 'string' && paths.includes(input.file_path))
    || paths.some(path => {
      const cat = readCommand({ path })
      const range = command?.match(/^sed -n '[1-9][0-9]*,[1-9][0-9]*p' /)?.[0]

      return command === cat || (range !== undefined && command === range + cat.slice('cat -- '.length))
    })

  return read ? { behavior: 'allow' } : {
    behavior: 'deny',
    message: 'Compaction may only read the supplied record and transcript files.',
  }
}
