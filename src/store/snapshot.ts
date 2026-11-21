import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validLogPosition, type LogPosition } from './log.ts'
import { privateDir, replaceFile } from './storage.ts'

export interface FileSnapshot {
  v: 1
  at: string
  hydra: LogPosition
  tasks: Record<string, {
    task: LogPosition
    worker: number
  }>
  state: unknown
}

export function readSnapshot({ dir }: { dir: string }): FileSnapshot | undefined {
  const path = join(
    dir,
    'snapshot.json',
  )
  let fd: number

  try {
    if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) {
      return undefined
    }

    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code

    if (code === 'ENOENT' || code === 'ELOOP' || code === 'EACCES') {
      return undefined
    }

    throw error
  }

  let snapshot: Partial<FileSnapshot> | null

  try {
    if (!fstatSync(fd).isFile()) {
      return undefined
    }

    snapshot = JSON.parse(readFileSync(
      fd,
      'utf8',
    ))
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'EACCES') {
      return undefined
    }

    throw error
  } finally {
    closeSync(fd)
  }

  if (!snapshot || snapshot.v !== 1 || typeof snapshot.at !== 'string'
    || !validLogPosition({ position: snapshot.hydra })
    || !snapshot.tasks || typeof snapshot.tasks !== 'object' || Array.isArray(snapshot.tasks)
    || !Object.hasOwn(
      snapshot,
      'state',
    )) {
    return undefined
  }

  for (const task of Object.values(snapshot.tasks)) {
    if (!task || !validLogPosition({ position: task.task })
      || !Number.isSafeInteger(task.worker) || task.worker < 0) {
      return undefined
    }
  }

  return snapshot as FileSnapshot
}

export function writeSnapshot({
  dir,
  snapshot,
}: {
  dir: string
  snapshot: FileSnapshot
}): void {
  privateDir({ dir })
  replaceFile({
    path: join(
      dir,
      'snapshot.json',
    ),
    text: `${JSON.stringify(snapshot)}\n`,
  })
}
