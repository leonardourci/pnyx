import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
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
  let fd: number

  try {
    fd = openSync(
      join(
        dir,
        'snapshot.json',
      ),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code

    if (code === 'ENOENT' || code === 'ELOOP') {
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
    if (error instanceof SyntaxError) {
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
