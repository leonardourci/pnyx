import { existsSync, lstatSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { HydraError } from './errors.ts'
import { appendLog, readLog, type LogEntry, type LogFact, type LogPosition } from './log.ts'
import { readSnapshot, type FileSnapshot } from './snapshot.ts'
import { privateDir, syncDirectory } from './storage.ts'

const COMPONENT = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
const EMPTY: LogPosition = {
  bytes: 0,
  n: 0,
}

interface HydraLocation {
  home: string
  hydra: string
}

interface TaskLocation extends HydraLocation {
  task: string
}

export interface FileLog {
  entries: LogEntry[]
  position: LogPosition
  fromStart: boolean
  issue?: HydraError
}

export interface HydraFiles {
  dir: string
  snapshot?: FileSnapshot
  hydra: FileLog
  tasks: Record<string, FileLog>
  relocated: string[]
}

function component({ id }: { id: string }): string {
  if (!COMPONENT.test(id)) {
    throw new HydraError({
      message: `invalid file-store id: ${id}`,
      code: 'INVALID_ID',
    })
  }

  return id
}

const hydraFiles = ({
  home,
  hydra,
}: HydraLocation) => join(
  resolve(home),
  'hydras',
  component({ id: hydra }),
)

export const taskFiles = ({
  home,
  hydra,
  task,
}: TaskLocation) => join(
  hydraFiles({
    home,
    hydra,
  }),
  'tasks',
  component({ id: task }),
)

function requireDirectory({ dir }: { dir: string }): void {
  const found = lstatSync(
    dir,
    { throwIfNoEntry: false },
  )

  if (!found || !found.isDirectory() || found.isSymbolicLink()) {
    throw new HydraError({
      message: `not a file-store directory: ${dir}`,
      code: 'LOG_CORRUPT',
    })
  }
}

function publishFolder({
  parent,
  id,
  log,
  entries,
}: {
  parent: string
  id: string
  log: 'hydra.log' | 'task.log'
  entries: readonly LogFact[]
}): LogPosition {
  const destination = join(
    parent,
    component({ id }),
  )

  if (existsSync(destination)) {
    throw new HydraError({
      message: `file-store folder already exists: ${destination}`,
      code: 'CONFLICT',
    })
  }

  privateDir({
    dir: parent,
    durable: true,
  })
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

export function createHydraFiles({
  home,
  hydra,
  entries,
}: HydraLocation & {
  entries: readonly LogFact[]
}): LogPosition {
  if (entries[0]?.t !== 'config') {
    throw new HydraError({
      message: 'a Hydra starts with its config fact',
      code: 'INVALID_EVENT',
    })
  }

  return publishFolder({
    parent: dirname(hydraFiles({
      home,
      hydra,
    })),
    id: hydra,
    log: 'hydra.log',
    entries,
  })
}

export function createTaskFiles({
  home,
  hydra,
  task,
  entries,
}: TaskLocation & {
  entries: readonly LogFact[]
}): LogPosition {
  if (entries[0]?.t !== 'created') {
    throw new HydraError({
      message: 'a task starts with its created fact',
      code: 'INVALID_EVENT',
    })
  }

  requireDirectory({
    dir: hydraFiles({
      home,
      hydra,
    }),
  })

  return publishFolder({
    parent: dirname(taskFiles({
      home,
      hydra,
      task,
    })),
    id: task,
    log: 'task.log',
    entries,
  })
}

function failedLog({ issue }: { issue: HydraError }): FileLog {
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
    if (error instanceof HydraError && error.code === 'LOG_POSITION' && after.bytes) {
      return readFileLog({ path })
    }

    if (!(error instanceof HydraError) || error.code !== 'LOG_CORRUPT') {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        return failedLog({
          issue: new HydraError({
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
    hydra: from,
    task,
  })
  const destination = taskFiles({
    home,
    hydra: to,
    task,
  })
  requireDirectory({ dir: source })
  requireDirectory({
    dir: hydraFiles({
      home,
      hydra: to,
    }),
  })

  if (source === destination) {
    return {
      source,
      destination,
    }
  }

  if (existsSync(destination)) {
    throw new HydraError({
      message: `task folder already exists: ${destination}`,
      code: 'CONFLICT',
    })
  }

  privateDir({
    dir: dirname(destination),
    durable: true,
  })

  if (statSync(source).dev !== statSync(dirname(destination)).dev) {
    throw new HydraError({
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
  at,
  by,
  id,
}: {
  home: string
  from: string
  to: string
  task: string
  after: LogPosition
  at: string
  by: LogFact['by']
  id: string
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
    entries: [
      {
        at,
        by,
        t: 'moved',
        id,
        from,
        to,
      },
    ],
  })
  moveFolder(placement)

  return position
}

export function readHydraFiles({
  home,
  hydra,
}: HydraLocation): HydraFiles {
  const dir = hydraFiles({
    home,
    hydra,
  })
  requireDirectory({ dir })
  const snapshot = readSnapshot({ dir })
  const tasksDir = join(
    dir,
    'tasks',
  )

  if (existsSync(tasksDir)) {
    requireDirectory({ dir: tasksDir })
  }

  const directories = existsSync(tasksDir) ? readdirSync(
    tasksDir,
    { withFileTypes: true },
  ) : []
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
          issue: new HydraError({
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
        hydra,
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
        issue: new HydraError({
          message: `task log has no created fact: ${path}`,
          code: 'LOG_CORRUPT',
        }),
      })
    }

    const last = task.entries.at(-1)

    if (last?.t === 'moved' && last.from === hydra && typeof last.to === 'string' && last.to !== hydra) {
      try {
        moveFolder(prepareMove({
          home,
          from: hydra,
          to: last.to,
          task: entry.name,
        }))
      } catch (error) {
        if (!(error instanceof HydraError)) {
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
        hydra,
        last.to,
      )
      continue
    }

    tasks.push([
      entry.name,
      task,
    ])
  }

  const hydraLogPath = join(
    dir,
    'hydra.log',
  )
  let hydraLog = readFileLog({
    path: hydraLogPath,
    after: snapshot?.hydra,
  })

  if (!hydraLog.issue && hydraLog.fromStart && hydraLog.entries[0]?.t !== 'config') {
    hydraLog = failedLog({
      issue: new HydraError({
        message: `Hydra log has no config fact: ${hydraLogPath}`,
        code: 'LOG_CORRUPT',
      }),
    })
  }

  return {
    dir,
    snapshot,
    hydra: hydraLog,
    tasks: Object.fromEntries(tasks),
    relocated,
  }
}

function readKnownHydra({
  home,
  hydra,
}: HydraLocation): HydraFiles {
  try {
    return readHydraFiles({
      home,
      hydra,
    })
  } catch (error) {
    if (!(error instanceof HydraError)) {
      throw error
    }

    return {
      dir: join(
        resolve(home),
        'hydras',
        hydra,
      ),
      hydra: failedLog({ issue: error }),
      tasks: {},
      relocated: [],
    }
  }
}

export function readHomeFiles({ home }: { home: string }): Map<string, HydraFiles> {
  const parent = join(
    resolve(home),
    'hydras',
  )
  const entries = existsSync(parent) ? readdirSync(
    parent,
    { withFileTypes: true },
  ) : []
  const ids = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')
    && existsSync(join(
      parent,
      entry.name,
      'hydra.log',
    ))).map(entry => entry.name)
    .sort()
  const hydras = new Map(ids.map(hydra => [
    hydra,
    readKnownHydra({
      home,
      hydra,
    }),
  ]))
  const relocated = new Set([...hydras.values()].flatMap(hydra => hydra.relocated))

  for (const hydra of relocated) {
    hydras.set(
      hydra,
      readKnownHydra({
        home,
        hydra,
      }),
    )
  }

  return hydras
}
