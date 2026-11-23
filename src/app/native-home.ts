import { randomUUID } from 'node:crypto'
import { recordEventId } from './command-meta.ts'
import { existsSync, linkSync, lstatSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { openFileStore } from '#store/file-store.ts'
import { hydraFiles, taskFiles } from '#store/file-home.ts'
import { canonical, pnyxHome, taskRuntimeDir } from '#store/paths.ts'
import { privateDir, writeDurably } from '#store/storage.ts'
import { HydraError } from '#store/errors.ts'
import type { HydraEvent, HydraState } from './model.ts'
import type { Card } from '#tasks/model.ts'
import { assembleNative, reduceNative, nativeReferences, nativeId, type NativeState } from './native-state.ts'
import { log } from './diagnostics.ts'
import type { Output } from './cli-support.ts'

const SNAPSHOT_MS = 5 * 60_000

export interface NativeHeld {
  dir: string
  state: HydraState
  committed: number
  changes: HydraEvent[]
  pending: HydraEvent[]
  stale?: boolean
  changed(): void
}

type NativeFiles = ReturnType<typeof openFileStore<NativeState, NativeState>>
type NativeView = NonNullable<ReturnType<NativeFiles['read']>>

const homes = new Map<string, NativeHome>()

function errorCard({
  id,
  issue,
}: {
  id: string
  issue: HydraError
}): Card {
  return {
    id,
    key: id,
    title: `Unreadable task ${id}`,
    workspace: '',
    tags: [],
    attention: [
      {
        kind: 'storage',
        key: 'native-log',
        blocking: true,
        text: `${issue.code}: ${issue.message}`,
      },
    ],
    links: [],
    sourceRefs: [],
    column: 'queued',
    revision: 0,
    createdSeq: 0,
    updatedSeq: 0,
    updatedAt: '',
    workerLog: {
      latest: {
        identity: 'native-log',
        off: 0,
        at: '',
        code: 'invalid',
        text: `${issue.code}: ${issue.message}`,
      },
    },
  }
}

function loadedState({
  view,
  positions,
}: {
  view: NativeView
  positions: ReadonlyMap<string, number>
}): HydraState {
  if (view.issue) {
    throw view.issue
  }

  const state = assembleNative({
    positions,
    hydra: nativeReferences({
      value: view.state,
      ids: positions,
      restore: true,
    }) as NativeState,
    tasks: [...view.tasks].flatMap(([
      id,
      value,
    ]) => value.state ? [
      [
        id,
        nativeReferences({
          value: value.state,
          ids: positions,
          restore: true,
        }) as NativeState,
      ] as [string, NativeState],
    ] : []),
  })

  for (const [
    id,
    value,
  ] of view.tasks) {
    if (value.issue) {
      state.cards[id] = errorCard({
        id,
        issue: value.issue,
      })
      state.keys[id] = id
    }
  }

  return state
}

function linkFile({
  source,
  destination,
}: {
  source: string
  destination: string
}): void {
  const target = lstatSync(
    destination,
    {
      throwIfNoEntry: false,
      bigint: true,
    },
  )
  const original = lstatSync(
    source,
    { bigint: true },
  )

  if (!original.isFile()) {
    throw new HydraError({
      code: 'LOG_CORRUPT',
      message: `native task file is not a regular file: ${source}`,
    })
  }

  if (target?.isFile() && target.dev === original.dev && target.ino === original.ino) {
    return
  }

  if (target) {
    unlinkSync(destination)
  }

  linkSync(
    source,
    destination,
  )
}

export function bindNativeTask({
  home,
  hydra,
  card,
}: {
  home: string
  hydra: string
  card: Card
}): void {
  const task = taskFiles({
    home,
    hydra,
    task: card.id,
  })
  const runtime = card.workerLogDir ?? taskRuntimeDir({ task: card.id })
  privateDir({ dir: runtime })
  const report = join(
    runtime,
    'worker.log',
  )
  const taskReport = join(
    task,
    'worker.log',
  )

  if (!existsSync(report)) {
    if (existsSync(taskReport)) {
      linkFile({
        source: taskReport,
        destination: report,
      })
    } else {
      writeFileSync(
        report,
        '',
        {
          flag: 'wx',
          mode: 0o600,
        },
      )
    }
  }

  linkFile({
    source: report,
    destination: taskReport,
  })
  linkFile({
    source: join(
      task,
      'task.log',
    ),
    destination: join(
      runtime,
      'task.log',
    ),
  })
  const brief = join(
    task,
    'brief.md',
  )
  const text = card.brief ?? ''

  if (!existsSync(brief) || readFileSync(
    brief,
    'utf8',
  ) !== text) {
    writeDurably({
      path: brief,
      data: text,
      flag: 'w',
    })
  }

  linkFile({
    source: brief,
    destination: join(
      runtime,
      'brief.md',
    ),
  })
}

export class NativeHome {
  readonly epoch = randomUUID()
  readonly path: string
  readonly files: NativeFiles
  readonly records = new Map<string, NativeHeld>()
  readonly held = new Set<string>()
  private readonly timelines = new Map<string, Map<string, number>>()
  private readonly clocks = new Map<string, number>()
  readonly receipts = new Map<string, Map<string, {
    digest: string
    value: Output
  }>>()

  private tail: Promise<unknown> = Promise.resolve()
  private closing?: Promise<void>
  private snapshotTimer: ReturnType<typeof setInterval>
  private dirty = false

  constructor({ path }: { path: string }) {
    this.path = path
    this.files = openFileStore({
      home: path,
      reduceHydra: reduceNative,
      reduceTask: reduceNative,
    })
    const timelines = new Map<string, {
      scope: string
      id: string
      at: string
      n: number
    }[]>()

    const add = ({
      hydra,
      scope,
      entries,
    }: {
      hydra: string
      scope: string
      entries: {
        id: string
        at: string
        n: number
      }[]
    }) => {
      timelines.set(
        hydra,
        [
          ...timelines.get(hydra) ?? [],
          ...entries.map(entry => ({
            ...entry,
            scope,
          })),
        ],
      )
    }

    for (const hydra of this.files.hydras()) {
      const view = this.files.read({ hydra })!
      add({
        hydra,
        scope: hydra,
        entries: [...view.accepted.values()],
      })

      for (const [
        task,
        stored,
      ] of view.tasks) {
        const accepted = [...stored.accepted.values()].sort((
          a,
          b,
        ) => a.n - b.n)
        add({
          hydra,
          scope: task,
          entries: accepted,
        })
        const moves = stored.state?.moves ?? []
        let owner = moves[0]?.from ?? hydra

        for (const entry of accepted) {
          if (owner !== hydra) {
            add({
              hydra: owner,
              scope: task,
              entries: [entry],
            })
          }

          const move = moves.find(move => move.n === entry.n)

          if (move) {
            owner = move.to
          }
        }
      }
    }

    for (const [
      hydra,
      entries,
    ] of timelines) {
      entries.sort((
        a,
        b,
      ) => a.at.localeCompare(b.at) || a.n - b.n || a.id.localeCompare(b.id))

      for (const entry of entries) {
        this.position({
          hydra,
          scope: entry.scope,
          id: entry.id,
        })
      }
    }

    for (const hydra of this.files.hydras()) {
      rmSync(
        join(
          hydraFiles({
            home: path,
            hydra,
          }),
          'harvest.json',
        ),
        { force: true },
      )
    }

    this.snapshotTimer = setInterval(
      () => {
        if (this.dirty) {
          void this.run({
            fn: async () => {
              await this.files.snapshot()
              this.dirty = false
            },
          }).catch(error => log({
            level: 'error',
            operation: 'native.snapshot',
            error,
          }))
        }
      },
      SNAPSHOT_MS,
    ).unref()
  }

  references({ hydra }: { hydra: string }): Map<string, number> {
    const known = this.timelines.get(hydra)

    if (known) {
      return known
    }

    const positions = new Map<string, number>()
    this.timelines.set(
      hydra,
      positions,
    )

    return positions
  }

  position({
    hydra,
    id,
    scope,
    seq,
  }: {
    hydra: string
    id: string
    scope: string
    seq?: number
  }): number {
    const positions = this.references({ hydra })
    const key = nativeId({
      scope,
      id,
    })
    const known = positions.get(key)
    const clock = this.clocks.get(hydra) ?? 0
    const position = seq ?? known ?? clock + 1
    this.clocks.set(
      hydra,
      Math.max(
        clock,
        position,
      ),
    )
    positions.set(
      key,
      position,
    )

    return position
  }

  cardForMove({
    from,
    to,
    card,
    state,
  }: {
    from: string
    to: string
    card: Card
    state: HydraState
  }): Card {
    const source = this.references({ hydra: from })
    const destination = this.references({ hydra: to })
    let through = Math.max(
      this.clocks.get(to) ?? 0,
      state.seq,
    )
    state.eventIds = { ...state.eventIds }

    for (const [key] of source) {
      if (!destination.has(key)) {
        destination.set(
          key,
          ++through,
        )
      }

      if (key.startsWith(`${card.id}\0`)) {
        recordEventId({
          state,
          id: key.slice(card.id.length + 1),
          seq: destination.get(key)!,
        })
      }
    }

    this.clocks.set(
      to,
      through,
    )
    state.seq = through
    const saved = nativeReferences({
      kind: 'card',
      value: card,
      ids: source,
    })

    return nativeReferences({
      kind: 'card',
      value: saved,
      ids: destination,
      restore: true,
    }) as Card
  }

  run<Value>({ fn }: { fn(): Promise<Value> | Value }): Promise<Value> {
    const pending = this.tail.then(fn)
    this.tail = pending.then(
      () => undefined,
      () => undefined,
    )

    return pending
  }

  read({ hydra }: { hydra: string }): NativeHeld {
    const current = this.records.get(hydra)

    if (current && !current.stale) {
      return current
    }

    const view = this.files.read({ hydra })
    const state = view ? loadedState({
      view,
      positions: this.references({ hydra }),
    }) : assembleNative({ tasks: [] })
    const receipts = this.receipts.get(hydra) ?? new Map<string, {
      digest: string
      value: Output
    }>()

    const scopes = [
      view?.state,
      ...[...view?.tasks.values() ?? []].map(task => task.state),
    ]

    for (const scope of scopes) {
      const hydrated = nativeReferences({
        value: scope,
        ids: this.references({ hydra }),
        restore: true,
      }) as NativeState | undefined

      for (const [
        id,
        receipt,
      ] of Object.entries(hydrated?.receipts ?? {})) {
        receipts.set(
          id,
          receipt,
        )
      }
    }

    this.receipts.set(
      hydra,
      receipts,
    )
    const record: NativeHeld = {
      dir: hydraFiles({
        home: this.path,
        hydra,
      }),
      state,
      committed: state.seq,
      pending: [],
      changes: [],
      changed: current?.changed ?? (() => {}),
    }

    if (current) {
      Object.assign(
        current,
        record,
        { stale: false },
      )

      return current
    }

    this.records.set(
      hydra,
      record,
    )

    return record
  }

  async ensure({ hydra }: { hydra: string }): Promise<void> {
    if (this.files.hydras().includes(hydra)) {
      return
    }

    if (existsSync(hydraFiles({
      home: this.path,
      hydra,
    }))) {
      throw new HydraError({
        code: 'FRESH_HOME_REQUIRED',
        message: 'this release needs an empty PNYX_HOME; existing Hydra data is left untouched',
      })
    }

    await this.files.createHydra({
      hydra,
      facts: [
        {
          at: new Date().toISOString(),
          by: 'daemon',
          t: 'config',
          id: `native-create:${hydra}`,
          hydra,
          change: [
            {
              path: ['fields'],
              value: { v: 1 },
            },
          ],
        },
      ],
    })
  }

  remember({
    hydra,
    state,
    events,
    dirty,
  }: {
    hydra: string
    state: HydraState
    events: HydraEvent[]
    dirty: boolean
  }): void {
    const record = this.read({ hydra })
    record.state = state
    record.committed = state.seq
    record.pending = record.pending.concat(events)
    this.dirty = this.dirty || dirty
  }

  reload({ hydra }: { hydra: string }): void {
    const record = this.records.get(hydra)

    if (record) {
      record.stale = true
    }

    this.read({ hydra })
  }

  restoreMoves(): void {
    for (const owner of this.files.hydras()) {
      const view = this.files.read({ hydra: owner })

      for (const [
        task,
        stored,
      ] of view?.tasks ?? []) {
        const moves = stored.state?.moves ?? []
        let ownerAt = moves[0]?.from ?? owner

        for (const accepted of [...stored.accepted.values()].sort((
          a,
          b,
        ) => a.n - b.n)) {
          if (ownerAt !== owner && !this.files.positions({ hydra: ownerAt })?.issue) {
            const original = this.read({ hydra: ownerAt }).state
            recordEventId({
              state: original,
              id: accepted.id,
              seq: this.references({ hydra: ownerAt }).get(nativeId({
                scope: task,
                id: accepted.id,
              })) ?? 0,
            })
          }

          const move = moves.find(move => move.n === accepted.n)

          if (move) {
            ownerAt = move.to
          }
        }

        for (const move of moves) {
          if (move.from === owner || this.files.positions({ hydra: move.from })?.issue) {
            continue
          }

          const source = this.read({ hydra: move.from }).state
          source.movedOut ??= {}
          source.movedOut[task] = {
            to: move.to,
            at: move.at,
            move: move.id,
            key: move.key ?? task,
          }
          recordEventId({
            state: source,
            id: move.id,
            seq: this.references({ hydra: move.from }).get(nativeId({
              scope: task,
              id: move.id,
            })) ?? 0,
          })
        }
      }
    }
  }

  close(): Promise<void> {
    if (!this.closing) {
      clearInterval(this.snapshotTimer)
      this.closing = this.run({
        fn: () => this.files.close(),
      }).finally(() => homes.delete(this.path))
    }

    return this.closing
  }
}

export const closeNativeHomes = (): Promise<void[]> =>
  Promise.all([...homes.values()].map(home => home.close()))

export function openedNativeHome(): NativeHome | undefined {
  const requested = resolve(pnyxHome())

  return homes.get(canonical({ path: requested }) ?? requested)
}

export function nativeHome(): NativeHome {
  const requested = resolve(pnyxHome())
  privateDir({ dir: dirname(requested) })
  privateDir({ dir: requested })
  const path = canonical({ path: requested })!
  const known = homes.get(path)

  if (known) {
    return known
  }

  const home = new NativeHome({ path })
  homes.set(
    path,
    home,
  )
  home.restoreMoves()

  return home
}
