import { lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { HydraError } from './errors.ts'
import { createHydraFiles, createTaskFiles, hydraFiles, moveTaskFiles, taskFiles } from './file-home.ts'
import { appendLog, type LogFact, type LogPosition } from './log.ts'
import { writeSnapshot } from './snapshot.ts'
import { privateDir } from './storage.ts'
import { applyFileFacts, emptyFileSegment, fileMemorySnapshot, loadFileMemory, type AcceptedFact, type FileReducers, type FileSegment, type HydraMemory } from './file-memory.ts'

const GROUP_COMMIT_MS = 5
interface Scope {
  hydra: string
  task?: string
}
interface Receipt {
  id: string
  n: number
  at: string
  duplicate: boolean
}
interface View<Hydra, Task> {
  state?: Hydra
  issue?: HydraError
  tasks: Map<string, {
    state?: Task
    worker: number
    issue?: HydraError
  }>
}
type Read<Hydra, Task> = ({ hydra }: { hydra: string }) => View<Hydra, Task> | undefined
type Decide<Value, Hydra, Task> = ({
  state,
  read,
}: {
  state: Value
  read: Read<Hydra, Task>
}) => readonly LogFact[]
interface Write<Hydra, Task> extends Pick<PromiseWithResolvers<Receipt[]>, 'resolve' | 'reject'> {
  kind: 'write'
  scope: Scope
  create: boolean
  decide({
    state,
    read,
  }: {
    state: unknown
    read: Read<Hydra, Task>
  }): readonly LogFact[]
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

export function openFileStore<Hydra, Task>({
  home,
  reduceHydra,
  reduceTask,
}: {
  home: string
} & FileReducers<Hydra, Task>) {
  const parent = lstatSync(
    dirname(resolve(home)),
    { throwIfNoEntry: false },
  )

  if (!parent?.isDirectory()) {
    throw new HydraError({
      code: 'INVALID_HOME',
      message: 'the native home parent must already be a directory',
    })
  }

  privateDir({
    dir: home,
    durable: true,
  })
  const reducers = {
    reduceHydra,
    reduceTask,
  }
  let memory = loadFileMemory({
    home,
    reducers,
  })
  let closing: Promise<void> | undefined
  let unavailable: HydraError | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const queue: (Write<Hydra, Task> | Control)[] = []

  function view({
    source,
    hydra,
  }: {
    source: Map<string, HydraMemory<Hydra, Task>>
    hydra: string
  }): View<Hydra, Task> | undefined {
    const current = source.get(hydra)

    if (!current) {
      return undefined
    }

    return {
      state: structuredClone(current.hydra.value),
      issue: current.hydra.issue,
      tasks: new Map([...current.tasks].map(([
        id,
        task,
      ]) => [
        id,
        {
          state: structuredClone(task.value),
          worker: task.worker,
          issue: task.issue,
        },
      ])),
    }
  }

  const read: Read<Hydra, Task> = ({ hydra }) => view({
    source: memory,
    hydra,
  })
  const pathOf = ({ scope }: { scope: Scope }) => scope.task === undefined
    ? join(
      hydraFiles({
        home,
        hydra: scope.hydra,
      }),
      'hydra.log',
    )
    : join(
      taskFiles({
        home,
        hydra: scope.hydra,
        task: scope.task,
      }),
      'task.log',
    )

  function findTask({
    source,
    task,
  }: {
    source: Map<string, HydraMemory<Hydra, Task>>
    task: string
  }) {
    return [...source].find(([
      , hydra,
    ]) => hydra.tasks.has(task))
  }

  function snapshot(): void {
    for (const [
      hydra,
      current,
    ] of memory) {
      if (current.hydra.issue) {
        continue
      }

      writeSnapshot({
        dir: hydraFiles({
          home,
          hydra,
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
      unavailable = new HydraError({
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
      job: Write<Hydra, Task>
      receipts: Receipt[]
    }[] = []

    function commit(): HydraError | undefined {
      let failure: HydraError | undefined

      try {
        for (const write of pending.values()) {
          const {
            scope,
            facts,
          } = write

          if (write.create && scope.task === undefined) {
            createHydraFiles({
              home,
              hydra: scope.hydra,
              entries: facts,
            })
          } else if (write.create && scope.task !== undefined) {
            createTaskFiles({
              home,
              hydra: scope.hydra,
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
        const error = new HydraError({
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

    for (const job of queue.splice(0)) {
      if (unavailable) {
        job.reject(unavailable)
        continue
      }

      if (job.kind === 'control') {
        commit()

        try {
          if (unavailable) {
            throw unavailable
          }

          job.run()
        } catch (error) {
          job.reject(error)
        }

        working = new Map(memory)
        continue
      }

      try {
        const { scope } = job
        const parent = working.get(scope.hydra)

        if (!parent && (scope.task !== undefined || !job.create)) {
          throw new HydraError({
            code: 'NOT_FOUND',
            message: `Hydra not found: ${scope.hydra}`,
          })
        }

        if (parent?.hydra.issue) {
          throw parent.hydra.issue
        }

        const current = scope.task === undefined ? parent?.hydra : parent?.tasks.get(scope.task)

        if (current?.issue) {
          throw current.issue
        }

        if (!current && !job.create) {
          throw new HydraError({
            code: 'NOT_FOUND',
            message: `task not found: ${scope.task}`,
          })
        }

        if (!current && scope.task !== undefined && findTask({
          source: working,
          task: scope.task,
        })) {
          throw new HydraError({
            code: 'CONFLICT',
            message: `task already exists: ${scope.task}`,
          })
        }

        let dependencyFailure: HydraError | undefined
        const facts = job.decide({
          state: structuredClone(current?.value),
          read: ({ hydra }) => {
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
              hydra,
            })
          },
        })

        if (dependencyFailure) {
          throw dependencyFailure
        }

        if (facts.some(fact => fact.t === 'moved')) {
          throw new HydraError({
            code: 'INVALID_EVENT',
            message: 'folder moves must use moveTask',
          })
        }

        if (job.create && !current && facts[0]?.t !== (scope.task === undefined ? 'config' : 'created')) {
          throw new HydraError({
            code: 'INVALID_EVENT',
            message: 'a new scope must start with its creation fact',
          })
        }

        const before = current ?? emptyFileSegment()
        const applied = scope.task === undefined
          ? applyFileFacts({
            segment: before as FileSegment<Hydra>,
            facts,
            reduce: reduceHydra,
            path: pathOf({ scope }),
            id: scope.hydra,
          })
          : applyFileFacts({
            segment: before as FileSegment<Task>,
            facts,
            reduce: reduceTask,
            path: pathOf({ scope }),
            id: scope.task,
          })

        if (job.create && current && applied.appended.length) {
          throw new HydraError({
            code: 'CONFLICT',
            message: 'the file-store scope already exists',
          })
        }

        if (scope.task === undefined) {
          working.set(
            scope.hydra,
            {
              hydra: applied.segment as FileSegment<Hydra>,
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
            scope.hydra,
            {
              hydra: parent!.hydra,
              tasks,
            },
          )
        }

        if (applied.appended.length) {
          const key = JSON.stringify(scope)
          const previous = pending.get(key)

          if (previous) {
            previous.facts.push(...applied.appended)
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

        waiting.push({
          job,
          receipts: applied.receipts.map(accepted => receiptOf({ accepted })),
        })
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
    job: Write<Hydra, Task> | Control
    stopping?: boolean
  }): void {
    if (closing && !stopping) {
      job.reject(new HydraError({
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
    decide: Write<Hydra, Task>['decide']
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
    hydras: () => [...memory.keys()],
    locateTask: ({ task }: { task: string }) => {
      const found = findTask({
        source: memory,
        task,
      })

      return found ? {
        hydra: found[0],
        dir: taskFiles({
          home,
          hydra: found[0],
          task,
        }),
      } : undefined
    },
    createHydra: ({
      hydra,
      facts,
    }: {
      hydra: string
      facts: readonly LogFact[]
    }) =>
      change({
        scope: { hydra },
        create: true,
        decide: () => facts,
      }),
    createTask: ({
      hydra,
      task,
      facts,
    }: {
      hydra: string
      task: string
      facts: readonly LogFact[]
    }) =>
      change({
        scope: {
          hydra,
          task,
        },
        create: true,
        decide: () => facts,
      }),
    changeHydra: ({
      hydra,
      decide,
    }: {
      hydra: string
      decide: Decide<Hydra, Hydra, Task>
    }) =>
      change({
        scope: { hydra },
        decide: ({
          state,
          read,
        }) => decide({
          state: state as Hydra,
          read,
        }),
      }),
    changeTask: ({
      hydra,
      task,
      decide,
    }: {
      hydra: string
      task: string
      decide: Decide<Task, Hydra, Task>
    }) =>
      change({
        scope: {
          hydra,
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
    moveTask: ({
      from,
      to,
      task,
      id,
      at,
      by,
    }: {
      from: string
      to: string
      task: string
      id: string
      at: string
      by: LogFact['by']
    }) => control({
      run: (): Receipt[] => {
        const located = findTask({
          source: memory,
          task,
        })
        const destination = memory.get(to)

        if (!located || !destination) {
          throw new HydraError({
            code: 'NOT_FOUND',
            message: 'task or destination Hydra not found',
          })
        }

        const [
          holder,
          source,
        ] = located
        const current = source.tasks.get(task)!
        const applied = applyFileFacts({
          segment: current,
          facts: [
            {
              id,
              at,
              by,
              t: 'moved',
              from,
              to,
            },
          ],
          reduce: reduceTask,
          path: pathOf({
            scope: {
              hydra: holder,
              task,
            },
          }),
          id: task,
        })

        if (!applied.appended.length) {
          return applied.receipts.map(accepted => receiptOf({ accepted }))
        }

        if (holder !== from || from === to) {
          throw new HydraError({
            code: 'CONFLICT',
            message: `task is held by Hydra ${holder}`,
          })
        }

        if (destination.hydra.issue || source.hydra.issue) {
          throw destination.hydra.issue ?? source.hydra.issue
        }

        try {
          moveTaskFiles({
            home,
            from,
            to,
            task,
            id,
            at,
            by,
            after: current.position,
          })
        } catch (error) {
          recover()

          if (error instanceof HydraError) {
            throw error
          }

          throw new HydraError({
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
        })
      }

      return closing
    },
  }
}
