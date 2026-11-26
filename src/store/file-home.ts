import { existsSync, lstatSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, type Dirent } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { TitanError } from './errors.ts'
import { appendLog, readLog, type LogEntry, type LogFact, type LogPosition } from './log.ts'
import { readSnapshot, type FileSnapshot } from './snapshot.ts'
import { privateDir, syncDirectory } from './storage.ts'
import { TITAN_ID } from '#titan/identity.ts'

export const COMPONENT = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
const EMPTY: LogPosition = {
  bytes: 0,
  n: 0,
}

interface TitanLocation {
  home: string
  titan: string
}

interface TaskLocation extends TitanLocation {
  task: string
}

type SnapshotCheck = ({ snapshot }: { snapshot: FileSnapshot }) => boolean
type MoveCheck = ({
  task,
  log,
  path,
  snapshot,
}: {
  task: string
  log: FileLog
  path: string
  snapshot?: FileSnapshot
}) => TitanError | undefined

interface RecoveryChecks {
  checkSnapshot?: SnapshotCheck
  checkMove?: MoveCheck
}

export interface FileLog {
  entries: LogEntry[]
  position: LogPosition
  fromStart: boolean
  issue?: TitanError
}

export interface TitanFiles {
  dir: string
  snapshot?: FileSnapshot
  titan: FileLog
  tasks: Record<string, FileLog>
  relocated: string[]
}

function component({
  id,
  rule = COMPONENT,
}: {
  id: string
  rule?: RegExp
}): string {
  if (!rule.test(id)) {
    throw new TitanError({
      message: `invalid file-store id: ${id}`,
      code: 'INVALID_ID',
    })
  }

  return id
}

export const titanFiles = ({
  home,
  titan,
}: TitanLocation) => join(
  resolve(home),
  'titans',
  component({
    id: titan,
    rule: TITAN_ID,
  }),
)

export const taskFiles = ({
  home,
  titan,
  task,
}: TaskLocation) => join(
  titanFiles({
    home,
    titan,
  }),
  'tasks',
  component({ id: task }),
)

function requireDirectory({
  dir,
  allowMissing = false,
}: {
  dir: string
  allowMissing?: boolean
}): void {
  const found = lstatSync(
    dir,
    { throwIfNoEntry: false },
  )

  if (!found && allowMissing) {
    return
  }

  if (!found?.isDirectory()) {
    throw new TitanError({
      message: `not a file-store directory: ${dir}`,
      code: 'LOG_CORRUPT',
    })
  }
}

function privateNativeDirectory({ dir }: { dir: string }): void {
  requireDirectory({
    dir,
    allowMissing: true,
  })

  privateDir({
    dir,
    durable: true,
  })
}

function publishFolder({
  parent,
  id,
  log,
  entries,
}: {
  parent: string
  id: string
  log: 'titan.log' | 'task.log'
  entries: readonly LogFact[]
}): LogPosition {
  const destination = join(
    parent,
    id,
  )

  if (lstatSync(
    destination,
    { throwIfNoEntry: false },
  )) {
    throw new TitanError({
      message: `file-store folder already exists: ${destination}`,
      code: 'CONFLICT',
    })
  }

  privateNativeDirectory({ dir: parent })
  const stage = mkdtempSync(join(
    parent,
    `.${id}-`,
  ))

  try {
    const position = appendLog({
      path: join(
        stage,
        log,
      ),
      after: EMPTY,
      entries,
    })
    renameSync(
      stage,
      destination,
    )
    syncDirectory({ dir: parent })

    return position
  } finally {
    if (existsSync(stage)) {
      rmSync(
        stage,
        {
          recursive: true,
          force: true,
        },
      )
    }
  }
}

export function createTitanFiles({
  home,
  titan,
  entries,
}: TitanLocation & {
  entries: readonly LogFact[]
}): LogPosition {
  if (entries[0]?.t !== 'config') {
    throw new TitanError({
      message: 'a Titan starts with its config fact',
      code: 'INVALID_EVENT',
    })
  }

  return publishFolder({
    parent: dirname(titanFiles({
      home,
      titan,
    })),
    id: titan,
    log: 'titan.log',
    entries,
  })
}

export function createTaskFiles({
  home,
  titan,
  task,
  entries,
}: TaskLocation & {
  entries: readonly LogFact[]
}): LogPosition {
  if (entries[0]?.t !== 'created') {
    throw new TitanError({
      message: 'a task starts with its created fact',
      code: 'INVALID_EVENT',
    })
  }

  requireDirectory({
    dir: titanFiles({
      home,
      titan,
    }),
  })

  return publishFolder({
    parent: dirname(taskFiles({
      home,
      titan,
      task,
    })),
    id: task,
    log: 'task.log',
    entries,
  })
}

function failedLog({ issue }: { issue: TitanError }): FileLog {
  return {
    entries: [],
    position: EMPTY,
    fromStart: true,
    issue,
  }
}

function readFileLog({
  path,
  after = EMPTY,
}: {
  path: string
  after?: LogPosition
}): FileLog {
  const entries: LogEntry[] = []

  try {
    const position = readLog({
      path,
      after,
      accept: ({ entry }) => entries.push(entry),
    })

    return {
      entries,
      position,
      fromStart: after.bytes === 0,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EACCES') {
      return failedLog({
        issue: new TitanError({
          code: 'LOG_UNREADABLE',
          message: `cannot open canonical log for recovery: ${path}`,
          cause: error,
        }),
      })
    }

    if (error instanceof TitanError && error.code === 'LOG_POSITION' && after.bytes) {
      return readFileLog({ path })
    }

    if (!(error instanceof TitanError) || error.code !== 'LOG_CORRUPT') {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        return failedLog({
          issue: new TitanError({
            message: `canonical log must be a regular file: ${path}`,
            code: 'LOG_CORRUPT',
            cause: error,
          }),
        })
      }

      throw error
    }

    return failedLog({ issue: error })
  }
}

function prepareMove({
  home,
  from,
  to,
  task,
}: {
  home: string
  from: string
  to: string
  task: string
}): {
  source: string
  destination: string
} {
  const source = taskFiles({
    home,
    titan: from,
    task,
  })
  const destination = taskFiles({
    home,
    titan: to,
    task,
  })
  requireDirectory({ dir: source })
  const targetTitan = titanFiles({
    home,
    titan: to,
  })
  requireDirectory({ dir: targetTitan })
  const targetLog = lstatSync(
    join(
      targetTitan,
      'titan.log',
    ),
    { throwIfNoEntry: false },
  )

  if (!targetLog?.isFile()) {
    throw new TitanError({
      message: `destination Titan has no regular native log: ${targetTitan}`,
      code: 'INVALID_MOVE',
    })
  }

  if (source === destination) {
    return {
      source,
      destination,
    }
  }

  if (lstatSync(
    destination,
    { throwIfNoEntry: false },
  )) {
    throw new TitanError({
      message: `task folder already exists: ${destination}`,
      code: 'CONFLICT',
    })
  }

  privateNativeDirectory({ dir: dirname(destination) })

  if (statSync(source).dev !== statSync(dirname(destination)).dev) {
    throw new TitanError({
      message: 'task folders must share one filesystem',
      code: 'INVALID_MOVE',
    })
  }

  return {
    source,
    destination,
  }
}

function moveFolder({
  source,
  destination,
}: {
  source: string
  destination: string
}): void {
  renameSync(
    source,
    destination,
  )
  syncDirectory({ dir: dirname(destination) })
  syncDirectory({ dir: dirname(source) })
}

export function moveTaskFiles({
  home,
  from,
  to,
  task,
  after,
  fact,
}: {
  home: string
  from: string
  to: string
  task: string
  after: LogPosition
  fact: LogFact
}): LogPosition {
  const placement = prepareMove({
    home,
    from,
    to,
    task,
  })

  if (placement.source === placement.destination) {
    return after
  }

  const position = appendLog({
    path: join(
      placement.source,
      'task.log',
    ),
    after,
    entries: [fact],
  })
  moveFolder(placement)

  return position
}

export function readTitanFiles({
  home,
  titan,
  checkSnapshot,
  checkMove,
}: TitanLocation & RecoveryChecks): TitanFiles {
  const dir = titanFiles({
    home,
    titan,
  })
  requireDirectory({ dir })
  syncDirectory({ dir: dirname(dir) })
  syncDirectory({ dir })
  let snapshot = readSnapshot({ dir })

  if (snapshot && checkSnapshot && !checkSnapshot({ snapshot })) {
    snapshot = undefined
  }

  const tasksDir = join(
    dir,
    'tasks',
  )

  let directories: Dirent[] = []

  if (lstatSync(
    tasksDir,
    { throwIfNoEntry: false },
  )) {
    requireDirectory({ dir: tasksDir })
    syncDirectory({ dir: tasksDir })
    directories = readdirSync(
      tasksDir,
      { withFileTypes: true },
    )
  }

  const tasks: [string, FileLog][] = []
  const relocated: string[] = []

  for (const entry of directories) {
    if (entry.name.startsWith('.')) {
      continue
    }

    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue
    }

    if (entry.isSymbolicLink() || !COMPONENT.test(entry.name)) {
      tasks.push([
        entry.name,
        failedLog({
          issue: new TitanError({
            message: `invalid task folder: ${join(
              tasksDir,
              entry.name,
            )}`,
            code: 'LOG_CORRUPT',
          }),
        }),
      ])
      continue
    }

    const path = join(
      taskFiles({
        home,
        titan,
        task: entry.name,
      }),
      'task.log',
    )
    const previous = snapshot && Object.hasOwn(
      snapshot.tasks,
      entry.name,
    )
      ? snapshot.tasks[entry.name]?.task : undefined
    let task = readFileLog({
      path,
      after: previous,
    })

    if (!task.issue && task.fromStart && task.entries[0]?.t !== 'created') {
      task = failedLog({
        issue: new TitanError({
          message: `task log has no created fact: ${path}`,
          code: 'LOG_CORRUPT',
        }),
      })
    }

    const last = task.entries.at(-1)

    if (last?.t === 'moved' && last.from === titan && typeof last.to === 'string' && last.to !== titan) {
      try {
        const issue = checkMove?.({
          task: entry.name,
          log: task,
          path,
          snapshot,
        })

        if (issue) {
          throw issue
        }

        moveFolder(prepareMove({
          home,
          from: titan,
          to: last.to,
          task: entry.name,
        }))
      } catch (error) {
        if (!(error instanceof TitanError)) {
          throw error
        }

        tasks.push([
          entry.name,
          {
            ...task,
            entries: [],
            issue: error,
          },
        ])
        continue
      }

      relocated.push(
        titan,
        last.to,
      )
      continue
    }

    tasks.push([
      entry.name,
      task,
    ])
  }

  const titanLogPath = join(
    dir,
    'titan.log',
  )
  let titanLog = readFileLog({
    path: titanLogPath,
    after: snapshot?.titan,
  })

  if (!titanLog.issue && titanLog.fromStart && titanLog.entries[0]?.t !== 'config') {
    titanLog = failedLog({
      issue: new TitanError({
        message: `Titan log has no config fact: ${titanLogPath}`,
        code: 'LOG_CORRUPT',
      }),
    })
  }

  return {
    dir,
    snapshot,
    titan: titanLog,
    tasks: Object.fromEntries(tasks),
    relocated,
  }
}

function readKnownTitan({
  home,
  titan,
  checkSnapshot,
  checkMove,
}: TitanLocation & RecoveryChecks): TitanFiles {
  try {
    return readTitanFiles({
      home,
      titan,
      checkSnapshot,
      checkMove,
    })
  } catch (error) {
    if (!(error instanceof TitanError)) {
      throw error
    }

    return {
      dir: join(
        resolve(home),
        'titans',
        titan,
      ),
      titan: failedLog({ issue: error }),
      tasks: {},
      relocated: [],
    }
  }
}

export function readHomeFiles({
  home,
  checkSnapshot,
  checkMove,
}: {
  home: string
} & RecoveryChecks): Map<string, TitanFiles> {
  if (existsSync(home)) {
    syncDirectory({ dir: dirname(resolve(home)) })
    syncDirectory({ dir: resolve(home) })
  }

  const parent = join(
    resolve(home),
    'titans',
  )

  if (!lstatSync(
    parent,
    { throwIfNoEntry: false },
  )) {
    return new Map()
  }

  requireDirectory({ dir: parent })
  syncDirectory({ dir: parent })
  const entries = readdirSync(
    parent,
    { withFileTypes: true },
  )
  const ids = entries.filter(entry => entry.isDirectory() && TITAN_ID.test(entry.name)
    && existsSync(join(
      parent,
      entry.name,
      'titan.log',
    ))).map(entry => entry.name)
    .sort()
  const titans = new Map(ids.map(titan => [
    titan,
    readKnownTitan({
      home,
      titan,
      checkSnapshot,
      checkMove,
    }),
  ]))
  const relocated = new Set([...titans.values()].flatMap(titan => titan.relocated))

  for (const titan of relocated) {
    titans.set(
      titan,
      readKnownTitan({
        home,
        titan,
        checkSnapshot,
        checkMove,
      }),
    )
  }

  return titans
}
