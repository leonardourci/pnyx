import { readFileSync } from 'node:fs'
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
  let text: string

  try {
    text = readFileSync(
      join(
        dir,
        'snapshot.json',
      ),
      'utf8',
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }

    throw error
  }

  let snapshot: Partial<FileSnapshot> | null

  try {
    snapshot = JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined
    }

    throw error
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
