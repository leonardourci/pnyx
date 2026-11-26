import { TitanError } from '#store/errors.ts'
import type { TitanState } from '#app/model.ts'
import type { createFileIndex } from '#projects/file-index.ts'
import type { CommandRequest } from './dispatch.ts'

// `files`: the files of each attached project, as paths inside it, for the @ picker.
export function filesCommand({
  ws,
  id,
  args,
  fail,
  send,
  state,
  fileIndex,
}: CommandRequest & {
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
  const roots = attached.map(project => project.path)

  void Promise.all(roots.map(async path => ({
    path,
    files: await fileIndex.files({ root: path }),
  })))
    .then(projects => send({
      ws,
      message: {
        type: 'receipt',
        id,
        projects,
      },
    }))
    .catch((error: Error) => fail({
      error: error.message,
      code: 'FILES_UNAVAILABLE',
    }))
}
