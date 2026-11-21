import { hash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { join } from 'node:path'
import { HydraError } from './errors.ts'
import { readHomeFiles, type FileLog, type HydraFiles } from './file-home.ts'
import { prepareLog, type LogEntry, type LogFact, type LogPosition } from './log.ts'
import type { FileSnapshot } from './snapshot.ts'

export interface AcceptedFact {
  id: string
  n: number
  at: string
  digest: string
}

export interface FileSegment<Value> {
  value?: Value
  position: LogPosition
  accepted: Map<string, AcceptedFact>
  worker: number
  issue?: HydraError
}

export interface HydraMemory<Hydra, Task> {
  hydra: FileSegment<Hydra>
  tasks: Map<string, FileSegment<Task>>
}

export type FileFold<Value> = ({
  state,
  entry,
  id,
}: {
  state?: Value
  entry: LogEntry
  id: string
}) => Value

export interface FileReducers<Hydra, Task> {
  reduceHydra: FileFold<Hydra>
  reduceTask: FileFold<Task>
}

interface CachedSegment<Value> {
  value: Value
  accepted: AcceptedFact[]
}

interface CachedMemory<Hydra, Task> {
  v: 1
  content: {
    hydra: CachedSegment<Hydra>
    tasks: Record<string, CachedSegment<Task>>
  }
  digest: string
}

function fileJson<Value>({ value }: { value: Value }): Value {
  try {
    const encoded = JSON.stringify(value)

    if (encoded === undefined) {
      throw new Error('undefined is not a JSON value')
    }

    const decoded = JSON.parse(encoded) as Value

    if (!isDeepStrictEqual(
      value,
      decoded,
    )) {
      throw new Error('the value changes when encoded as JSON')
    }

    return decoded
  } catch (cause) {
    throw new HydraError({
      code: 'INVALID_EVENT',
      message: 'file-store values must be plain JSON',
      cause,
    })
  }
}

function orderedJson({ value }: { value: unknown }): unknown {
  if (Array.isArray(value)) {
    return value.map(item => orderedJson({ value: item }))
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const fields = value as Record<string, unknown>

  return Object.fromEntries(Object.keys(fields).sort()
    .map(key => [
      key,
      orderedJson({ value: fields[key] }),
    ]))
}

function digest({ value }: { value: unknown }): string {
  const encoded = JSON.stringify(orderedJson({ value }))

  return hash(
    'sha256',
    encoded,
  )
}

function factDigest({ entry }: { entry: LogFact }): string {
  const intent = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'at' && key !== 'n'))

  return digest({ value: intent })
}

export function emptyFileSegment<Value>(): FileSegment<Value> {
  return {
    position: {
      bytes: 0,
      n: 0,
    },
    accepted: new Map(),
    worker: 0,
  }
}

function workerOffset({
  entry,
  after,
}: {
  entry: LogEntry
  after: number
}): number {
  if (entry.by !== 'worker' || (entry.t !== 'worker' && entry.t !== 'link') || entry.off === undefined) {
    return after
  }

  if (!Number.isSafeInteger(entry.off) || Number(entry.off) <= after) {
    throw new HydraError({
      code: 'INVALID_EVENT',
      message: 'worker offsets must advance in order',
    })
  }

  return Number(entry.off)
}

export function applyFileFacts<Value>({
  segment,
  facts,
  reduce,
  path,
  id,
}: {
  segment: FileSegment<Value>
  facts: readonly LogFact[]
  reduce: FileFold<Value>
  path: string
  id: string
}): {
  segment: FileSegment<Value>
  appended: LogFact[]
  receipts: (AcceptedFact & { duplicate: boolean })[]
} {
  if (segment.issue) {
    throw segment.issue
  }

  const next = {
    ...segment,
    accepted: new Map(segment.accepted),
  }
  const appended: LogFact[] = []
  const receipts: (AcceptedFact & { duplicate: boolean })[] = []

  for (const fact of fileJson({ value: facts })) {
    const fingerprint = factDigest({ entry: fact })
    const known = next.accepted.get(fact.id)

    if (known) {
      if (known.digest !== fingerprint) {
        throw new HydraError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: `native id ${fact.id} was used for different contents`,
        })
      }

      receipts.push({
        ...known,
        duplicate: true,
      })
      continue
    }

    const prepared = prepareLog({
      path,
      after: next.position,
      entries: [fact],
    })
    const entry = prepared.entries[0]!
    const value = reduce({
      state: structuredClone(next.value),
      entry,
      id,
    })
    next.value = fileJson({ value })
    next.position = prepared.position

    next.worker = workerOffset({
      entry,
      after: next.worker,
    })

    const receipt = {
      id: entry.id,
      n: entry.n,
      at: entry.at,
      digest: fingerprint,
    }
    next.accepted.set(
      entry.id,
      receipt,
    )
    appended.push(fact)
    receipts.push({
      ...receipt,
      duplicate: false,
    })
  }

  return {
    segment: next,
    appended,
    receipts,
  }
}

function cacheDigest({
  snapshot,
  content,
}: {
  snapshot: Pick<FileSnapshot, 'hydra' | 'tasks'>
  content: unknown
}): string {
  return digest({
    value: {
      hydra: snapshot.hydra,
      tasks: snapshot.tasks,
      content,
    },
  })
}

function cachedSegment({ value }: { value: unknown }): boolean {
  const segment = value as Partial<CachedSegment<unknown>> | null

  return Boolean(segment && Object.hasOwn(
    segment,
    'value',
  ) && Array.isArray(segment.accepted)
    && segment.accepted.every(receipt => receipt && typeof receipt.id === 'string'
      && Number.isSafeInteger(receipt.n) && receipt.n > 0 && typeof receipt.at === 'string'
      && typeof receipt.digest === 'string'))
}

function cachedMemory<Hydra, Task>({
  snapshot,
}: {
  snapshot: FileSnapshot
}): CachedMemory<Hydra, Task> | undefined {
  const cache = snapshot.state as Partial<CachedMemory<Hydra, Task>> | null

  if (!cache || cache.v !== 1 || !cache.content || !cachedSegment({ value: cache.content.hydra })
    || !cache.content.tasks || typeof cache.content.tasks !== 'object' || Array.isArray(cache.content.tasks)
    || !Object.values(cache.content.tasks).every(value => cachedSegment({ value }))
    || cache.digest !== cacheDigest({
      snapshot,
      content: cache.content,
    })) {
    return undefined
  }

  return cache as CachedMemory<Hydra, Task>
}

function replayFile<Value>({
  log,
  cached,
  worker = 0,
  reduce,
  id,
  path,
}: {
  log: FileLog
  cached?: CachedSegment<Value>
  worker?: number
  reduce: FileFold<Value>
  id: string
  path: string
}): FileSegment<Value> {
  if (log.issue) {
    return {
      ...emptyFileSegment<Value>(),
      issue: log.issue,
    }
  }

  const accepted = cached && !log.fromStart ? new Map(cached.accepted.map(receipt => [
    receipt.id,
    receipt,
  ])) : new Map()
  let value = cached && !log.fromStart ? cached.value : undefined
  let offset = cached && !log.fromStart ? worker : 0

  try {
    for (const entry of log.entries) {
      if (accepted.has(entry.id)) {
        throw new Error(`duplicate native id ${entry.id}`)
      }

      value = fileJson({
        value: reduce({
          state: value,
          entry,
          id,
        }),
      })
      accepted.set(
        entry.id,
        {
          id: entry.id,
          n: entry.n,
          at: entry.at,
          digest: factDigest({ entry }),
        },
      )

      offset = workerOffset({
        entry,
        after: offset,
      })
    }

    return {
      value,
      position: log.position,
      accepted,
      worker: offset,
    }
  } catch (cause) {
    return {
      ...emptyFileSegment<Value>(),
      issue: new HydraError({
        code: 'LOG_CORRUPT',
        message: `cannot replay ${path}`,
        cause,
      }),
    }
  }
}

function loadHydraMemory<Hydra, Task>({
  hydra,
  files,
  reducers,
}: {
  hydra: string
  files: HydraFiles
  reducers: FileReducers<Hydra, Task>
}): HydraMemory<Hydra, Task> {
  const cache = files.snapshot ? cachedMemory<Hydra, Task>({ snapshot: files.snapshot }) : undefined

  return {
    hydra: replayFile({
      log: files.hydra,
      cached: cache?.content.hydra,
      reduce: reducers.reduceHydra,
      id: hydra,
      path: join(
        files.dir,
        'hydra.log',
      ),
    }),
    tasks: new Map(Object.entries(files.tasks).map(([
      id,
      log,
    ]) => [
      id,
      replayFile({
        log,
        cached: cache?.content.tasks[id],
        worker: files.snapshot?.tasks[id]?.worker,
        reduce: reducers.reduceTask,
        id,
        path: join(
          files.dir,
          'tasks',
          id,
          'task.log',
        ),
      }),
    ])),
  }
}

export function loadFileMemory<Hydra, Task>({
  home,
  reducers,
}: {
  home: string
  reducers: FileReducers<Hydra, Task>
}): Map<string, HydraMemory<Hydra, Task>> {
  let files = readHomeFiles({ home })

  const invalidSnapshot = [...files.values()].some(({ snapshot }) =>
    snapshot && !cachedMemory({ snapshot }))

  if (invalidSnapshot) {
    files = readHomeFiles({
      home,
      useSnapshot: false,
    })
  }

  return new Map([...files].map(([
    hydra,
    files,
  ]) => [
    hydra,
    loadHydraMemory({
      hydra,
      files,
      reducers,
    }),
  ]))
}

export function fileMemorySnapshot<Hydra, Task>({
  memory,
  at,
}: {
  memory: HydraMemory<Hydra, Task>
  at: string
}): FileSnapshot {
  const cached = <Value>({ segment }: { segment: FileSegment<Value> }): CachedSegment<Value> => ({
    value: segment.value!,
    accepted: [...segment.accepted.values()],
  })
  const tasks = [...memory.tasks].filter(([
    , segment,
  ]) => !segment.issue)
  const content = {
    hydra: cached({ segment: memory.hydra }),
    tasks: Object.fromEntries(tasks.map(([
      id,
      segment,
    ]) => [
      id,
      cached({ segment }),
    ])),
  }
  const positions = {
    hydra: memory.hydra.position,
    tasks: Object.fromEntries(tasks.map(([
      id,
      segment,
    ]) => [
      id,
      {
        task: segment.position,
        worker: segment.worker,
      },
    ])),
  }

  return {
    v: 1,
    at,
    ...positions,
    state: {
      v: 1,
      content,
      digest: cacheDigest({
        snapshot: positions,
        content,
      }),
    },
  }
}
