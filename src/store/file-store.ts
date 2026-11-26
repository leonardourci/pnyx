import { lstatSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { TitanError } from './errors.ts'
import { createTitanFiles, createTaskFiles, titanFiles, moveTaskFiles, taskFiles } from './file-home.ts'
import { appendLog, plainJson, type LogFact, type LogPosition } from './log.ts'
import { writeSnapshot } from './snapshot.ts'
import { privateDir } from './storage.ts'
import { applyFileFacts, emptyFileSegment, fileMemorySnapshot, loadFileMemory, type AcceptedFact, type FileReducers, type FileSegment, type TitanMemory } from './file-memory.ts'

const GROUP_COMMIT_MS = 5
const openHomes = new Set<string>()
interface Scope {
  titan: string
  task?: string
}
interface Receipt {
  id: string
  n: number
  at: string
  duplicate: boolean
}
interface View<Titan, Task> {
  state?: Titan
  position: LogPosition
  accepted: Map<string, AcceptedFact>
  worker: number
  issue?: TitanError
  tasks: Map<string, {
    state?: Task
    position: LogPosition
    accepted: Map<string, AcceptedFact>
    worker: number
    issue?: TitanError
  }>
}
type Read<Titan, Task> = ({ titan }: { titan: string }) => View<Titan, Task> | undefined
type Decide<Value, Titan, Task> = ({
  state,
  read,
}: {
  state: Value
  read: Read<Titan, Task>
}) => readonly LogFact[]
interface Write<Titan, Task> extends Pick<PromiseWithResolvers<Receipt[]>, 'resolve' | 'reject'> {
  kind: 'write'
  scope: Scope
  create: boolean
  decide({
    state,
    read,
  }: {
    state: unknown
    read: Read<Titan, Task>
  }): readonly LogFact[]
}
interface ScopeChange {
  titan: string
  task?: string
  create?: boolean
  facts: readonly LogFact[]
}
interface Batch<Titan, Task> extends Pick<PromiseWithResolvers<Receipt[]>, 'resolve' | 'reject'> {
  kind: 'batch'
  decide({ read }: { read: Read<Titan, Task> }): readonly ScopeChange[]
}
interface Control extends Pick<PromiseWithResolvers<void>, 'reject'> {
  kind: 'control'
  run(): void
}
interface Pending {
  scope: Scope
  create: boolean
  after: LogPosition
  facts: LogFact[]
}

function receiptOf({ accepted }: { accepted: AcceptedFact & { duplicate: boolean } }): Receipt {
  const {
    id,
    n,
    at,
    duplicate,
  } = accepted

  return {
    id,
    n,
    at,
    duplicate,
  }
}

function copyAccepted({ accepted }: {
  accepted: ReadonlyMap<string, AcceptedFact>
}): Map<string, AcceptedFact> {
  return new Map([...accepted].map(([
    id,
    receipt,
  ]) => [
    id,
    { ...receipt },
  ]))
}

export function openFileStore<Titan, Task>({
  home: requestedHome,
  reduceTitan,
  reduceTask,
}: {
  home: string
} & FileReducers<Titan, Task>) {
  const requestedPath = resolve(requestedHome)
  const parent = statSync(
    dirname(requestedPath),
    { throwIfNoEntry: false },
  )

  if (!parent?.isDirectory()) {
    throw new TitanError({
      code: 'INVALID_HOME',
      message: 'the native home parent must already be a directory',
    })
  }

  const existing = lstatSync(
    requestedPath,
    { throwIfNoEntry: false },
  )

  if (!existing) {
    privateDir({
      dir: requestedPath,
      durable: true,
    })
  }

  const home = realpathSync(requestedPath)

  if (openHomes.has(home)) {
    throw new TitanError({
      code: 'STORE_OPEN',
      message: `native home is already open: ${home}`,
    })
  }

  if (!lstatSync(home).isDirectory()) {
    throw new TitanError({
      code: 'INVALID_HOME',
      message: `native home must be a directory: ${home}`,
    })
  }

  openHomes.add(home)
  const reducers = {
    reduceTitan,
    reduceTask,
  }
  let memory: Map<string, TitanMemory<Titan, Task>>

  try {
    privateDir({ dir: home })
    memory = loadFileMemory({
      home,
      reducers,
    })
  } catch (error) {
    openHomes.delete(home)
    throw error
  }

  let closing: Promise<void> | undefined
  let unavailable: TitanError | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const queue: (Write<Titan, Task> | Batch<Titan, Task> | Control)[] = []

  function view({
    source,
    titan,
  }: {
    source: Map<string, TitanMemory<Titan, Task>>
    titan: string
  }): View<Titan, Task> | undefined {
    const current = source.get(titan)

    if (!current) {
      return undefined
    }

    return {
      state: structuredClone(current.titan.value),
      position: { ...current.titan.position },
      accepted: copyAccepted({ accepted: current.titan.accepted }),
      worker: current.titan.worker,
      issue: current.titan.issue,
      tasks: new Map([...current.tasks].map(([
        id,
        task,
      ]) => [
        id,
        {
          state: structuredClone(task.value),
          position: { ...task.position },
          accepted: copyAccepted({ accepted: task.accepted }),
          worker: task.worker,
          issue: task.issue,
        },
      ])),
    }
  }

  const read: Read<Titan, Task> = ({ titan }) => view({
    source: memory,
    titan,
  })
  const pathOf = ({ scope }: { scope: Scope }) => scope.task === undefined
    ? join(
      titanFiles({
        home,
        titan: scope.titan,
      }),
      'titan.log',
    )
    : join(
      taskFiles({
        home,
        titan: scope.titan,
        task: scope.task,
      }),
      'task.log',
    )

  function findTask({
    source,
    task,
  }: {
    source: Map<string, TitanMemory<Titan, Task>>
    task: string
  }) {
    return [...source].find(([
      , titan,
    ]) => titan.tasks.has(task))
  }

  function snapshot(): void {
    for (const [
      titan,
      current,
    ] of memory) {
      if (current.titan.issue) {
        continue
      }

      writeSnapshot({
        dir: titanFiles({
          home,
          titan,
        }),
        snapshot: fileMemorySnapshot({
          memory: current,
          at: new Date().toISOString(),
        }),
      })
    }
  }

  function recover(): void {
    try {
      memory = loadFileMemory({
        home,
        reducers,
      })
    } catch (cause) {
      unavailable = new TitanError({
        code: 'STORE_UNAVAILABLE',
        message: 'file-store recovery failed',
        cause,
      })
    }
  }

  function flush(): void {
    timer = undefined
    let working = new Map(memory)
    let pending = new Map<string, Pending>()
    let waiting: {
      job: Write<Titan, Task> | Batch<Titan, Task>
      receipts: Receipt[]
    }[] = []

    function commit(): TitanError | undefined {
      let failure: TitanError | undefined

      try {
        for (const write of pending.values()) {
          const {
            scope,
            facts,
          } = write

          if (write.create && scope.task === undefined) {
            createTitanFiles({
              home,
              titan: scope.titan,
              entries: facts,
            })
          } else if (write.create && scope.task !== undefined) {
            createTaskFiles({
              home,
              titan: scope.titan,
              task: scope.task,
              entries: facts,
            })
          } else {
            appendLog({
              path: pathOf({ scope }),
              after: write.after,
              entries: facts,
            })
          }
        }

        memory = working

        for (const {
          job,
          receipts,
        } of waiting) {
          job.resolve(receipts)
        }
      } catch (cause) {
        const error = new TitanError({
          code: 'WRITE_FAILED',
          message: 'file write was not acknowledged; retry with the same native ids',
          cause,
        })

        failure = error
        recover()

        for (const { job } of waiting) {
          job.reject(error)
        }
      }

      working = new Map(memory)
      pending = new Map()
      waiting = []

      return failure
    }

    function stageWrite({ job }: { job: Pick<Write<Titan, Task>, 'scope' | 'create' | 'decide'> }): Receipt[] {
      const { scope } = job
      const parent = working.get(scope.titan)

      if (!parent && (scope.task !== undefined || !job.create)) {
        throw new TitanError({
          code: 'NOT_FOUND',
          message: `Titan not found: ${scope.titan}`,
        })
      }

      if (parent?.titan.issue) {
        throw parent.titan.issue
      }

      const current = scope.task === undefined ? parent?.titan : parent?.tasks.get(scope.task)

      if (current?.issue) {
        throw current.issue
      }

      if (!current && !job.create) {
        throw new TitanError({
          code: 'NOT_FOUND',
          message: `task not found: ${scope.task}`,
        })
      }

      if (!current && scope.task !== undefined && findTask({
        source: working,
        task: scope.task,
      })) {
        throw new TitanError({
          code: 'CONFLICT',
          message: `task already exists: ${scope.task}`,
        })
      }

      let dependencyFailure: TitanError | undefined
      const decision = job.decide({
        state: structuredClone(current?.value),
        read: ({ titan }) => {
          if (dependencyFailure) {
            throw dependencyFailure
          }

          if (pending.size) {
            dependencyFailure = commit()

            if (dependencyFailure) {
              throw dependencyFailure
            }
          }

          return view({
            source: working,
            titan,
          })
        },
      })

      if (dependencyFailure) {
        throw dependencyFailure
      }

      const facts = plainJson({ value: decision })

      if (facts.some(fact => fact.t === 'moved')) {
        throw new TitanError({
          code: 'INVALID_EVENT',
          message: 'folder moves must use moveTask',
        })
      }

      if (job.create && !current && facts[0]?.t !== (scope.task === undefined ? 'config' : 'created')) {
        throw new TitanError({
          code: 'INVALID_EVENT',
          message: 'a new scope must start with its creation fact',
        })
      }

      const before = current ?? emptyFileSegment()
      const applied = scope.task === undefined
        ? applyFileFacts({
          segment: before as FileSegment<Titan>,
          facts,
          reduce: reduceTitan,
          path: pathOf({ scope }),
          id: scope.titan,
        })
        : applyFileFacts({
          segment: before as FileSegment<Task>,
          facts,
          reduce: reduceTask,
          path: pathOf({ scope }),
          id: scope.task,
        })

      if (job.create && current && applied.appended.length) {
        throw new TitanError({
          code: 'CONFLICT',
          message: 'the file-store scope already exists',
        })
      }

      if (scope.task === undefined) {
        working.set(
          scope.titan,
          {
            titan: applied.segment as FileSegment<Titan>,
            tasks: parent?.tasks ?? new Map(),
          },
        )
      } else {
        const tasks = new Map(parent!.tasks)
        tasks.set(
          scope.task,
          applied.segment as FileSegment<Task>,
        )
        working.set(
          scope.titan,
          {
            titan: parent!.titan,
            tasks,
          },
        )
      }

      if (applied.appended.length) {
        const key = JSON.stringify(scope)
        const previous = pending.get(key)

        if (previous) {
          for (const fact of applied.appended) {
            previous.facts.push(fact)
          }
        } else {
          pending.set(
            key,
            {
              scope,
              create: !current,
              after: before.position,
              facts: applied.appended,
            },
          )
        }
      }

      return applied.receipts.map(accepted => receiptOf({ accepted }))
    }

    for (const job of queue.splice(0)) {
      if (unavailable) {
        job.reject(unavailable)
        continue
      }

      if (job.kind === 'control') {
        const failure = commit()

        try {
          if (unavailable) {
            throw unavailable
          }

          if (failure) {
            throw failure
          }

          job.run()
        } catch (error) {
          job.reject(error)
        }

        working = new Map(memory)
        continue
      }

      try {
        if (job.kind === 'batch') {
          const failure = commit()

          if (failure) {
            throw failure
          }

          if (unavailable) {
            throw unavailable
          }

          const changes = job.decide({ read })
          const before = new Map(working)
          const receipts: Receipt[] = []

          try {
            for (const change of changes) {
              const accepted = stageWrite({
                job: {
                  scope: {
                    titan: change.titan,
                    task: change.task,
                  },
                  create: change.create ?? false,
                  decide: () => change.facts,
                },
              })

              for (const receipt of accepted) {
                receipts.push(receipt)
              }
            }
          } catch (error) {
            working = before
            pending = new Map()
            throw error
          }

          waiting.push({
            job,
            receipts,
          })
        } else {
          const receipts = stageWrite({ job })
          waiting.push({
            job,
            receipts,
          })
        }
      } catch (error) {
        job.reject(error)
      }
    }

    commit()
  }

  function schedule({
    job,
    stopping = false,
  }: {
    job: Write<Titan, Task> | Batch<Titan, Task> | Control
    stopping?: boolean
  }): void {
    if (closing && !stopping) {
      job.reject(new TitanError({
        code: 'STORE_CLOSED',
        message: 'the file store is closing or closed',
      }))

      return
    }

    queue.push(job)

    if (!timer) {
      timer = setTimeout(
        flush,
        GROUP_COMMIT_MS,
      )
    }
  }

  const change = ({
    scope,
    create = false,
    decide,
  }: {
    scope: Scope
    create?: boolean
    decide: Write<Titan, Task>['decide']
  }): Promise<Receipt[]> => new Promise((
    resolve,
    reject,
  ) => schedule({
    job: {
      kind: 'write',
      scope,
      create,
      decide,
      resolve,
      reject,
    },
  }))
  const control = <Value>({
    run,
    stopping,
  }: {
    run(): Value
    stopping?: boolean
  }): Promise<Value> =>
    new Promise((
      resolve,
      reject,
    ) => schedule({
      job: {
        kind: 'control',
        run: () => resolve(run()),
        reject,
      },
      stopping,
    }))

  return {
    read,
    has: ({
      titan,
      task,
      id,
    }: {
      titan: string
      task?: string
      id: string
    }): boolean => {
      const current = memory.get(titan)
      const segment = task === undefined ? current?.titan : current?.tasks.get(task)

      return segment?.accepted.has(id) ?? false
    },
    value: ({
      titan,
      task,
    }: {
      titan: string
      task?: string
    }) => {
      const current = memory.get(titan)
      const segment = task === undefined ? current?.titan : current?.tasks.get(task)

      return segment ? {
        state: structuredClone(segment.value),
        issue: segment.issue,
      } : undefined
    },
    positions: ({ titan }: { titan: string }) => {
      const current = memory.get(titan)

      if (!current) {
        return undefined
      }

      const position = <Value>({ segment }: { segment: FileSegment<Value> }) => ({
        position: { ...segment.position },
        accepted: copyAccepted({ accepted: segment.accepted }),
        issue: segment.issue,
      })

      return {
        ...position({ segment: current.titan }),
        tasks: new Map([...current.tasks].map(([
          task,
          segment,
        ]) => [
          task,
          position({ segment }),
        ])),
      }
    },
    titans: () => [...memory.keys()],
    locateTask: ({ task }: { task: string }) => {
      const found = findTask({
        source: memory,
        task,
      })

      return found ? {
        titan: found[0],
        dir: taskFiles({
          home,
          titan: found[0],
          task,
        }),
      } : undefined
    },
    createTitan: async ({
      titan,
      facts,
    }: {
      titan: string
      facts: readonly LogFact[]
    }) => {
      const submitted = plainJson({ value: facts })

      return change({
        scope: { titan },
        create: true,
        decide: () => submitted,
      })
    },
    createTask: async ({
      titan,
      task,
      facts,
    }: {
      titan: string
      task: string
      facts: readonly LogFact[]
    }) => {
      const submitted = plainJson({ value: facts })

      return change({
        scope: {
          titan,
          task,
        },
        create: true,
        decide: () => submitted,
      })
    },
    changeTitan: ({
      titan,
      decide,
    }: {
      titan: string
      decide: Decide<Titan, Titan, Task>
    }) =>
      change({
        scope: { titan },
        decide: ({
          state,
          read,
        }) => decide({
          state: state as Titan,
          read,
        }),
      }),
    changeTask: ({
      titan,
      task,
      decide,
    }: {
      titan: string
      task: string
      decide: Decide<Task, Titan, Task>
    }) =>
      change({
        scope: {
          titan,
          task,
        },
        decide: ({
          state,
          read,
        }) => decide({
          state: state as Task,
          read,
        }),
      }),
    change: ({ decide }: { decide: Batch<Titan, Task>['decide'] }): Promise<Receipt[]> =>
      new Promise((
        resolve,
        reject,
      ) => schedule({
        job: {
          kind: 'batch',
          decide,
          resolve,
          reject,
        },
      })),
    moveTask: ({
      from,
      to,
      task,
      id,
      at,
      by,
      data = {},
    }: {
      from: string
      to: string
      task: string
      id: string
      at: string
      by: LogFact['by']
      data?: Record<string, unknown>
    }) => control({
      run: (): Receipt[] => {
        const located = findTask({
          source: memory,
          task,
        })
        const destination = memory.get(to)

        if (!located || !destination) {
          throw new TitanError({
            code: 'NOT_FOUND',
            message: 'task or destination Titan not found',
          })
        }

        const [
          holder,
          source,
        ] = located
        const current = source.tasks.get(task)!
        const fact: LogFact = {
          ...plainJson({ value: data }),
          id,
          at,
          by,
          t: 'moved',
          from,
          to,
        }
        const applied = applyFileFacts({
          segment: current,
          facts: [fact],
          reduce: reduceTask,
          path: pathOf({
            scope: {
              titan: holder,
              task,
            },
          }),
          id: task,
        })

        if (!applied.appended.length) {
          return applied.receipts.map(accepted => receiptOf({ accepted }))
        }

        if (holder !== from || from === to) {
          throw new TitanError({
            code: 'CONFLICT',
            message: `task is held by Titan ${holder}`,
          })
        }

        if (destination.titan.issue || source.titan.issue) {
          throw destination.titan.issue ?? source.titan.issue
        }

        try {
          moveTaskFiles({
            home,
            from,
            to,
            task,
            fact,
            after: current.position,
          })
        } catch (error) {
          recover()

          if (error instanceof TitanError) {
            throw error
          }

          throw new TitanError({
            code: 'WRITE_FAILED',
            message: 'task move was not acknowledged; retry with the same native id',
            cause: error,
          })
        }

        const sourceTasks = new Map(source.tasks)
        const destinationTasks = new Map(destination.tasks)
        sourceTasks.delete(task)
        destinationTasks.set(
          task,
          applied.segment,
        )
        memory.set(
          from,
          {
            ...source,
            tasks: sourceTasks,
          },
        )
        memory.set(
          to,
          {
            ...destination,
            tasks: destinationTasks,
          },
        )

        return applied.receipts.map(accepted => receiptOf({ accepted }))
      },
    }),
    snapshot: () => control({ run: snapshot }),
    close: (): Promise<void> => {
      if (!closing) {
        closing = control({
          stopping: true,
          run: snapshot,
        }).finally(() => {
          openHomes.delete(home)
        })
      }

      return closing
    },
  }
}
