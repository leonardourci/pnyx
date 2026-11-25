import { permissionCommand } from '#workers/permission-rules.ts'
import type { PermissionRequest } from '#workers/model.ts'
import type { PermissionDecision } from '#workers/provider.ts'

export const readCommand = ({ path }: { path: string }) => `cat -- '${path.replace(
  /'/g,
  "'\\''",
)}'`

export function readGrant({
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
    message: 'Only the supplied record and transcript files may be read.',
  }
}
