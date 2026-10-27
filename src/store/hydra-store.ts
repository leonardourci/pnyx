import { guardTaskLease, isHelper } from '../helper/leases.ts'
import { helperGrant } from '../helper/route.ts'
import { reconcileAsks } from '../core/asks.ts'
import { spawnSync } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { LABEL_COLORS } from '../core/model.ts'
import { labelsForEvent } from '../core/labels.ts'
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { HydraError, EVENT_VERSION, type HydraEvent, type HydraState } from '../core/model.ts'
import { emptyHydra, reduce, replay } from '../core/reducer.ts'
import { agentActor, declareTask, migrateColumns } from '../core/hydra.ts'
import { decideMove } from '../core/decide.ts'
import { lifecycleMoveId, lifecycleMoves, operationDeclarations } from '../core/lifecycle.ts'
import { pnyxHome } from './paths.ts'
import { readLog } from '../app/event-log.ts'
import type { LogRead, RepairMarker } from '../app/event-log.ts'

export { pnyxHome } from './paths.ts'

export const DEFAULT_HYDRA = 'default'
const LOCK_TIMEOUT_MS = 5000
const STALE_EMPTY_LOCK_MS = 10_000

// HydraSnapshot files hold copied transcript text, which is as private as the transcripts.
export function privateDir({ dir }: { dir: string }): void {
  mkdirSync(
    dir,
    {
      recursive: true,
      mode: 0o700,
    },
  )
  chmodSync(
    dir,
    0o700,
  )
}

export const logPath = ({ dir }: { dir: string }) => join(
  dir,
  'events.jsonl',
)
const snapshotPath = ({ dir }: { dir: string }) => join(
  dir,
  'snapshot.json',
)
export const spoolDir = ({ dir }: { dir: string }) => join(
  dir,
  'spool',
)

// Bumped when the reducer derives cards differently, so an older cache is replayed.
const RULES = 15

interface Snapshot {
  v: typeof EVENT_VERSION
  rules?: number
  offset: number
  state: HydraState
}

function readSnapshot({ dir }: { dir: string }): Snapshot | null {
  try {
    const snap = JSON.parse(readFileSync(
      snapshotPath({ dir }),
      'utf8',
    )) as Snapshot

    return snap.v === EVENT_VERSION
      && snap.rules === RULES
      && Number.isInteger(snap.offset)
      && snap.state?.v === EVENT_VERSION
      ? snap
      : null
  } catch {
    return null
  }
}

export function writeDurably({
  path,
  data,
  flag,
}: {
  path: string
  data: string | Buffer
  flag: 'a' | 'w'
}): void {
  const fd = openSync(
    path,
    flag,
    0o600,
  )

  try {
    fchmodSync(
      fd,
      0o600,
    )
    writeSync(
      fd,
      typeof data === 'string' ? Buffer.from(data) : data,
    )
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function writeSnapshot({
  dir,
  state,
  offset,
}: {
  dir: string
  state: HydraState
  offset: number
}): void {
  const tmp = `${snapshotPath({ dir })}.tmp-${process.pid}`
  writeDurably({
    path: tmp,
    data: JSON.stringify({
      v: EVENT_VERSION,
      rules: RULES,
      offset,
      state,
    } satisfies Snapshot),
    flag: 'w',
  })
  renameSync(
    tmp,
    snapshotPath({ dir }),
  )
}

export interface HydraSnapshot {
  dir: string
  state: HydraState
  offset: number
  tornBytes: number
}

export function loadHydra({ hydraId }: { hydraId: string }): HydraSnapshot {
  const dir = hydraDir({ hydraId })
  const snap = readSnapshot({ dir })
  let log = snap ? readLog({
    dir,
    from: snap.offset,
  }) : null
  let start = snap?.state ?? emptyHydra()

  if (!log || (snap && log.events.length > 0 && log.events[0]!.seq !== snap.state.seq + 1)) {
    log = readLog({ dir }) as LogRead
    start = emptyHydra()
  }

  return {
    dir,
    state: replay({
      state: start,
      events: log.events,
    }),
    offset: log.end,
    tornBytes: log.size - log.end,
  }
}

export function lockIsStale({ path }: { path: string }): boolean {
  try {
    const pid = Number(readFileSync(
      path,
      'utf8',
    ))

    if (!Number.isInteger(pid) || pid <= 0) {
      return Date.now() - statSync(path).mtimeMs > STALE_EMPTY_LOCK_MS
    }

    process.kill(
      pid,
      0,
    )

    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

// Re-checks staleness under an O_EXCL takeover file so only one writer can remove a dead lock.
// ponytail: a writer killed inside the takeover leaves the takeover file behind, and every later dead lock then needs the manual removal the LOCKED help names.
function takeOver({
  path,
  takeover,
}: {
  path: string
  takeover: string
}): boolean {
  try {
    closeSync(openSync(
      takeover,
      'wx',
    ))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false
    }

    throw error
  }

  try {
    if (lockIsStale({ path })) {
      rmSync(
        path,
        { force: true },
      )
    }
  } finally {
    rmSync(
      takeover,
      { force: true },
    )
  }

  return true
}

// O_EXCL lock file holding the writer's pid; a lock whose process is gone is taken over.
export function acquireLock({
  dir,
  timeout = LOCK_TIMEOUT_MS,
}: {
  dir: string
  timeout?: number
}): () => void {
  const path = join(
    dir,
    'writer.lock',
  )
  const takeover = `${path}.takeover`
  const deadline = Date.now() + timeout
  let attempts = 0
  let retryTakeover: boolean

  do {
    attempts++
    retryTakeover = false

    try {
      const fd = openSync(
        path,
        'wx',
      )
      writeSync(
        fd,
        String(process.pid),
      )
      closeSync(fd)

      return () => rmSync(
        path,
        { force: true },
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }

    if (lockIsStale({ path }) && takeOver({
      path,
      takeover,
    })) {
      retryTakeover = timeout === 0 && attempts === 1
      continue
    }

    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      Math.min(
        25,
        Math.max(
          0,
          deadline - Date.now(),
        ),
      ),
    )
  } while (retryTakeover || Date.now() < deadline)

  let owner: string

  try {
    owner = readFileSync(
      path,
      'utf8',
    ).trim()
  } catch {
    owner = 'unreadable'
  }

  throw new HydraError({
    message: `Hydra is locked by another pnyx-axi writer after ${timeout}ms: ${path} (owner: ${owner})`,
    code: 'LOCKED',
    help: [`Retry, or remove ${path} and ${takeover} if no pnyx-axi process is running`],
  })
}

export function withRegistryLock<T>({ fn }: { fn(): T }): T {
  const dir = pnyxHome()
  privateDir({ dir })
  const release = acquireLock({ dir })

  try {
    return fn()
  } finally {
    release()
  }
}

export interface Writer {
  readonly state: HydraState
  readonly dir: string
  append({ event }: { event: HydraEvent }): void
}

// A Hydra exists once its log does; a bare folder, such as one a config write made, does not count.
export function requireHydra({ hydraId }: { hydraId: string }): void {
  if (hydraId !== DEFAULT_HYDRA && !existsSync(logPath({ dir: hydraDir({ hydraId }) }))) {
    throw new HydraError({
      message: `unknown Hydra: ${hydraId}`,
      code: 'NOT_FOUND',
      help: ['Run `pnyx-axi hydra list` for the Hydras, or `pnyx-axi hydra create <id>` to add one'],
    })
  }
}

// Runs `fn` as the Hydra's single writer. Each append is flushed to disk before
// the state advances; the snapshot is replaced afterwards.
export function withWriter<T>({
  hydraId,
  fn,
  create = false,
  lockTimeout,
}: {
  hydraId: string
  // Only `hydra create` makes a new Hydra; the default Hydra is made on first use.
  create?: boolean
  lockTimeout?: number
  fn: (
    { writer }: {
      writer: Writer
    },
  ) => T
}): T {
  const dir = hydraDir({ hydraId })

  if (!create) {
    requireHydra({ hydraId })
  }

  privateDir({ dir })
  const release = acquireLock({
    dir,
    timeout: lockTimeout,
  })

  try {
    let {
      state,
      offset,
    } = loadTail({ hydraId })
    let dirty = false

    try {
      const writer: Writer = {
        dir,
        get state() {
          return state
        },
        append({ event }) {
          if (!agentActor({ actor: event.actor }) && (event.type !== 'hydra.message' || isHelper({ actor: event.actor }))) {
            const task = event.type === 'hydra.message' ? event.data.task : event.cardId

            if (task && state.cards[task]) {
              guardTaskLease({
                dir,
                task,
                actor: event.actor,
              })
            }

            if (isHelper({ actor: event.actor }) && (!task || !helperGrant({
              state,
              task,
              actor: event.actor,
            }))) {
              throw new HydraError({
                message: 'Helper mutation is outside its task scope',
                code: 'MAIN_ONLY',
              })
            }
          }

          if (event.seq !== state.seq + 1) {
            throw new Error(`append out of sequence: ${event.seq} after ${state.seq}`)
          }

          const knownLabels = new Set(state.labelColors?.map(entry => entry.label))
          const labelColors = labelsForEvent({
            state,
            event,
          })
            .filter(label => !knownLabels.has(label))
            .map(label => ({
              label,
              color: LABEL_COLORS[randomInt(LABEL_COLORS.length)] ?? 'slate',
            }))

          if (labelColors.length) {
            event = {
              ...event,
              labelColors,
            }
          }

          const card = state.cards[event.cardId]
          const parent = event.type === 'task.created' ? event.data.parentId : card?.parentId
          const session = event.type === 'task.session' ? event.data.session : card?.sessionIds?.[0]
          const agent = event.type === 'card.pushed' && event.data.agent
            ? event.data.agent : session ? state.sessions?.[session]?.agent : card?.agent
          const observedSession = agent
            ? `${agent.provider}:${agent.sessionId}${agent.agentId ? `/${agent.agentId}` : ''}` : session
          event = {
            boardId: hydraId,
            ...(event.cardId !== '$board' ? { taskId: parent ?? event.cardId } : {}),
            ...(parent ? { subtaskId: event.cardId } : {}),
            ...(agent ? { agentId: `${agent.provider}:${agent.agentId ?? agent.sessionId}` } : {}),
            ...(observedSession ? { sessionId: observedSession } : {}),
            commandId: event.id,
            ...(event.type === 'card.replied' ? { messageId: event.data.reply } : {}),
            ...event,
          }
          const line = `${JSON.stringify(event)}\n`
          writeDurably({
            path: logPath({ dir }),
            data: line,
            flag: 'a',
          })
          offset += Buffer.byteLength(line)
          const before = state
          state = reduce({
            state,
            event,
          })
          dirty = true

          for (const question of reconcileAsks({
            state,
            event,
          })) {
            writer.append({ event: question })
          }

          for (const declaration of operationDeclarations({
            before,
            state,
            event,
          })) {
            const declared = declareTask({
              state,
              ref: declaration.cardId,
              status: declaration.status,
              note: declaration.note,
              until: declaration.until,
              waitingFor: declaration.waitingFor,
              restores: declaration.restores,
              meta: {
                id: `${event.id}:${declaration.cardId}:declaration`,
                at: event.at,
                actor: 'pnyx',
              },
            })

            if ('event' in declared) {
              writer.append({ event: declared.event })
            }
          }

          // A task's explicit lifecycle change moves its card, as its own event in the same write.
          for (const move of lifecycleMoves({
            before,
            state,
            event,
          })) {
            const moved = decideMove({
              state,
              ref: move.cardId,
              column: move.column,
              meta: {
                id: lifecycleMoveId({
                  event: event.id,
                  cardId: move.cardId,
                }),
                at: event.at,
                actor: 'pnyx',
                reason: move.reason,
              },
            })

            if ('event' in moved) {
              writer.append({ event: moved.event })
            }
          }
        },
      }
      // A Hydra still on an older layout moves onto the default columns before its next write.
      const migrated = migrateColumns({
        state,
        meta: {
          at: new Date().toISOString(),
          actor: 'pnyx',
        },
      })

      if ('event' in migrated) {
        writer.append({ event: migrated.event })
      }

      return fn({ writer })
    } finally {
      if (dirty) {
        writeSnapshot({
          dir,
          state,
          offset,
        })
      }
    }
  } finally {
    release()
  }
}

function loadTail({ hydraId }: { hydraId: string }): HydraSnapshot {
  const loaded = loadHydra({ hydraId })

  if (loaded.tornBytes > 0) {
    throw new HydraError({
      message: `events.jsonl ends with ${loaded.tornBytes} bytes of a torn append`,
      code: 'TORN_TAIL',
      help: ['Run `pnyx-axi repair` to set them aside and continue'],
    })
  }

  return loaded
}

export interface Repair {
  tornBytes: number
  preserved?: string
  seq: number
}

// Copies a torn tail to a side file, then closes it with a newline and a repair
// marker so readers skip that line; the log itself is never cut. A torn tail was
// never acknowledged as written, so no accepted event is lost.
// ponytail: a crash while appending the marker leaves a corrupt interior line; inspect it by hand.
export function repairHydra({ hydraId }: { hydraId: string }): Repair {
  requireHydra({ hydraId })
  const dir = hydraDir({ hydraId })
  privateDir({ dir })
  const release = acquireLock({ dir })

  try {
    let log = readLog({ dir }) as LogRead
    const tornBytes = log.size - log.end
    let preserved: string | undefined

    if (tornBytes > 0) {
      preserved = `${logPath({ dir })}.torn-${log.end}`
      writeDurably({
        path: preserved,
        data: readFileSync(logPath({ dir })).subarray(log.end),
        flag: 'w',
      })
      const marker: RepairMarker = {
        v: EVENT_VERSION,
        type: 'log.repaired',
        at: new Date().toISOString(),
        data: {
          offset: log.end,
          length: tornBytes,
        },
      }
      writeDurably({
        path: logPath({ dir }),
        data: `\n${JSON.stringify(marker)}\n`,
        flag: 'a',
      })
      log = readLog({ dir }) as LogRead
    }

    const state = replay({
      state: emptyHydra(),
      events: log.events,
    })
    writeSnapshot({
      dir,
      state,
      offset: log.end,
    })

    return {
      tornBytes,
      ...(preserved ? { preserved } : {}),
      seq: state.seq,
    }
  } finally {
    release()
  }
}

// Writes one hook event to the spool without taking the writer lock. The next
// writer ingests it; the spool is a buffer, never a second writer of the log.
export function spoolWrite({
  hydraId,
  entry,
}: {
  hydraId: string
  entry: {
    id: string
  } & Record<string, unknown>
}): string {
  const dir = spoolDir({ dir: hydraDir({ hydraId }) })
  privateDir({ dir })
  // Millisecond time orders files across processes; hrtime keeps same-millisecond writes apart.
  const name = `${String(Date.now()).padStart(
    15,
    '0',
  )}-${process.hrtime.bigint()}-${entry.id.replace(
    /[^A-Za-z0-9._-]/g,
    '_',
  )}.json`
  const tmp = join(
    dir,
    `.tmp-${process.pid}-${name}`,
  )
  writeFileSync(
    tmp,
    JSON.stringify(entry),
    { mode: 0o600 },
  )
  renameSync(
    tmp,
    join(
      dir,
      name,
    ),
  )

  return join(
    dir,
    name,
  )
}

export function spoolFiles({ dir }: { dir: string }): string[] {
  const spool = spoolDir({ dir })

  if (!existsSync(spool)) {
    return []
  }

  return readdirSync(spool)
    .filter(f => f.endsWith('.json') && !f.startsWith('.'))
    .flatMap(name => {
      const file = join(
        spool,
        name,
      )
      const written = statSync(
        file,
        {
          bigint: true,
          throwIfNoEntry: false,
        },
      )

      return written ? [
        {
          file,
          at: written.mtimeNs,
        },
      ] : []
    })
    .sort((
      a,
      b,
    ) => {
      if (a.at === b.at) {
        return a.file.localeCompare(b.file)
      }

      return a.at < b.at ? -1 : 1
    })
    .map(entry => entry.file)
}

// Per Pnyx home, the Hydras an older server still runs in boards/.
const held = new Map<string, Set<string>>()

const conflict = ({
  from,
  to,
}: {
  from: string
  to: string
}) => new HydraError({
  message: `Hydra ${basename(to)} is in both ${from} and ${to}`,
  code: 'CONFLICT',
  help: [
    'Nothing was moved or deleted',
    `Keep one of them, move the other out of ${dirname(from)}, then rerun`,
  ],
})

const spoolOnly = ({ dir }: { dir: string }) => readdirSync(dir).every(entry => entry === 'spool')

// Hooks spool into whichever folder their installed script names; false on a name clash.
function foldSpool({
  from,
  into,
}: {
  from: string
  into: string
}): boolean {
  const spool = join(
    from,
    'spool',
  )
  const target = join(
    into,
    'spool',
  )
  mkdirSync(
    target,
    {
      recursive: true,
      mode: 0o700,
    },
  )

  for (const name of existsSync(spool) ? readdirSync(spool) : []) {
    if (name.startsWith('.')) {
      continue
    }

    if (existsSync(join(
      target,
      name,
    ))) {
      return false
    }

    renameSync(
      join(
        spool,
        name,
      ),
      join(
        target,
        name,
      ),
    )
  }

  for (const dir of [
    spool,
    from,
  ]) {
    try {
      rmdirSync(dir)
    } catch { /* A spool file still being written keeps it for the next run. */ }
  }

  return true
}

// Moving a folder under a live older server would split the Hydra, so it waits for that server to exit.
// ponytail: pid-only liveness; a reused pid keeps the Hydra in boards/ until the lock goes.
function liveServer({ dir }: { dir: string }): boolean {
  try {
    const { pid } = JSON.parse(readFileSync(
      join(
        dir,
        'server.lock',
      ),
      'utf8',
    )) as { pid?: unknown }

    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      return false
    }

    process.kill(
      pid,
      0,
    )

    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Hydras lived in boards/<id>/ before; each moves to hydras/<id>/ without overwriting anything.
function moveBoards({ home }: { home: string }): Set<string> {
  const boards = join(
    home,
    'boards',
  )
  const hydras = join(
    home,
    'hydras',
  )
  const kept = new Set<string>()
  const copies: string[] = []

  if (!existsSync(boards)) {
    return kept
  }

  let release: () => void

  try {
    release = acquireLock({ dir: boards })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code

    // macOS can return EINVAL when a competing migration removes the directory during open.
    if (code === 'ENOENT' || (code === 'EINVAL' && !existsSync(boards))) {
      return kept
    }

    throw error
  }

  try {
    mkdirSync(
      hydras,
      { recursive: true },
    )

    // Symlinks are Hydras already moved.
    for (const id of readdirSync(
      boards,
      { withFileTypes: true },
    ).filter(d => d.isDirectory())
      .map(d => d.name)) {
      const from = join(
        boards,
        id,
      )
      const to = join(
        hydras,
        id,
      )

      if (liveServer({ dir: from })) {
        kept.add(id)
        continue
      }

      if (!existsSync(to)) {
        renameSync(
          from,
          to,
        )
      } else if (spoolOnly({ dir: to }) || spoolOnly({ dir: from })) {
        for (const entry of readdirSync(from).filter(entry => entry !== 'spool')) {
          renameSync(
            join(
              from,
              entry,
            ),
            join(
              to,
              entry,
            ),
          )
        }

        if (!foldSpool({
          from,
          into: to,
        })) {
          throw conflict({
            from,
            to,
          })
        }
      } else {
        throw conflict({
          from,
          to,
        })
      }

      const made = existsSync(join(
        to,
        'copies',
      ))
        ? readdirSync(join(
          to,
          'copies',
        )).map(name => join(
          to,
          'copies',
          name,
        )) : []

      // Task copies are worked in by agents and git through their old absolute paths, so those keep resolving.
      if (made.length > 0 && !existsSync(from)) {
        symlinkSync(
          join(
            '..',
            'hydras',
            id,
          ),
          from,
        )
        copies.push(...made)
      }
    }
  } finally {
    release()
  }

  try {
    rmdirSync(boards)
  } catch { /* Held Hydras, links to moved ones, or a stray file keep it. */ }

  for (const dir of copies) {
    spawnSync(
      'git',
      [
        '-C',
        dir,
        'worktree',
        'repair',
      ],
      {
        stdio: 'ignore',
        timeout: 30_000,
      },
    )
  }

  return kept
}

// Rechecked while any Hydra is held, so a long-running server sees the move once the older server exits.
function heldInBoards(): Set<string> {
  const home = pnyxHome()
  let kept = held.get(home)

  if (!kept || kept.size > 0) {
    kept = moveBoards({ home })
    held.set(
      home,
      kept,
    )
  }

  return kept
}

export function hydrasDir(): string {
  heldInBoards()

  return join(
    pnyxHome(),
    'hydras',
  )
}

export function hydraIds(): string[] {
  let ids: string[] = []

  try {
    ids = readdirSync(
      hydrasDir(),
      { withFileTypes: true },
    ).filter(d => d.isDirectory())
      .map(d => d.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  return [
    ...new Set([
      ...ids,
      ...heldInBoards(),
    ]),
  ].sort()
}

export function hydraDir({ hydraId }: { hydraId: string }): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(hydraId)) {
    throw new HydraError({
      message: `invalid Hydra name: ${hydraId}`,
      code: 'VALIDATION_ERROR',
      help: ['Use letters, digits, dot, dash or underscore'],
    })
  }

  return join(
    heldInBoards().has(hydraId) ? join(
      pnyxHome(),
      'boards',
    ) : hydrasDir(),
    hydraId,
  )
}
