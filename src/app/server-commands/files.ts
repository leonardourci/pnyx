import { TitanError } from '#store/errors.ts'
import type { TitanState } from '#app/model.ts'
import type { createFileIndex } from '#projects/file-index.ts'
import type { CommandRequest } from './dispatch.ts'

export async function filesCommand({
  ws,
  id,
  args,
  send,
  state,
  fileIndex,
}: Omit<CommandRequest, 'fail'> & {
  state(): TitanState
  fileIndex: ReturnType<typeof createFileIndex>
}) {
  if (args.length) {
    throw new TitanError({
      message: 'files takes no arguments',
      code: 'VALIDATION_ERROR',
    })
  }

  const attached = (state().projects ?? []).filter(project => !project.detached)
  const projects = await fileIndex.projectFiles({ roots: attached.map(project => project.path) })

  send({
    ws,
    message: {
      type: 'receipt',
      id,
      projects,
    },
  })
}
