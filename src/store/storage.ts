import { AsyncLocalStorage } from 'node:async_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fchmodSync, fdatasyncSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { HydraError } from './errors.ts'
import { pnyxHome } from './paths.ts'

export { pnyxHome } from './paths.ts'

const LOCK_TIMEOUT_MS = 5000
export const nonblockingLocks = new AsyncLocalStorage<true>()
const STALE_EMPTY_LOCK_MS = 10_000
const LOCK_POLL_MS = 25

// A Hydra's folder holds its spool, caches and agent files, which can quote transcripts and are as private.
export function privateDir({
  dir,
  durable = false,
}: {
  dir: string
  durable?: boolean
}): void {
  const firstCreated = mkdirSync(
    dir,
    {
      recursive: true,
      mode: 0o700,
    },
  )

  // On Linux, chmod notifies watchers of the parent folder even when the mode is unchanged.
  // The server's Hydras-folder watcher retries Hydras that failed to load, which calls this again.
  if ((statSync(dir).mode & 0o777) !== 0o700) {
    chmodSync(
      dir,
      0o700,
    )
  }

  if (durable) {
    const parent = dirname(resolve(firstCreated ?? dir))

    for (let current = resolve(dir); current !== parent; current = dirname(current)) {
      syncDirectory({ dir: current })
    }

    syncDirectory({ dir: parent })
  }
}

export const logPath = ({ dir }: { dir: string }) => join(
  dir,
  'events.jsonl',
)
export const spoolDir = ({ dir }: { dir: string }) => join(
  dir,
  'spool',
)

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
    writeOpenFile({
      fd,
      path,
      data,
    })
  } finally {
    closeSync(fd)
  }
}

// Writes all of data to an open file and syncs it; the caller closes the file.
export function writeOpenFile({
  fd,
  path,
  data,
  dataOnly = false,
}: {
  fd: number
  path: string
  data: string | Buffer
  dataOnly?: boolean
}): void {
  fchmodSync(
    fd,
    0o600,
  )
  const buffer = typeof data === 'string' ? Buffer.from(data) : data
  let written = 0

  while (written < buffer.length) {
    const bytes = writeSync(
      fd,
      buffer,
      written,
      buffer.length - written,
    )

    if (bytes === 0) {
      throw new Error(`write made no progress: ${path}`)
    }

    written += bytes
  }

  if (dataOnly) {
    fdatasyncSync(fd)
  } else {
    fsyncSync(fd)
  }
}

// Writes the whole file beside the old one and renames it into place, so a reader sees one or the other.
export function replaceFile({
  path,
  text,
}: {
  path: string
  text: string
}): void {
  const stage = `${path}.${randomUUID()}.next`
  const fd = openSync(
    stage,
    'wx',
    0o600,
  )

  try {
    try {
      writeOpenFile({
        fd,
        path: stage,
        data: text,
      })
    } finally {
      closeSync(fd)
    }

    renameSync(
      stage,
      path,
    )
  } finally {
    rmSync(
      stage,
      { force: true },
    )
  }

  syncDirectory({ dir: dirname(path) })
}

export function syncDirectory({ dir }: { dir: string }): void {
  const fd = openSync(
    dir,
    'r',
  )

  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function lockIsStale({ path }: { path: string }): boolean {
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
  timeout = nonblockingLocks.getStore() ? 0 : LOCK_TIMEOUT_MS,
}: {
  dir: string
  timeout?: number
}): () => void {
  const path = join(
    dir,
    'writer.lock',
  )
  const takeover = `${path}.takeover`
  let deadline = Date.now() + timeout
  const emptyLockDeadline = deadline + STALE_EMPTY_LOCK_MS
  let retrying = false

  const createLock = (): (() => void) | undefined => {
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

      return undefined
    }
  }

  do {
    if (retrying) {
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        Math.min(
          LOCK_POLL_MS,
          Math.max(
            0,
            deadline - Date.now(),
          ),
        ),
      )
    }

    const release = createLock()

    if (release) {
      return release
    }

    if (timeout > 0) {
      try {
        const owner = Number(readFileSync(
          path,
          'utf8',
        ))

        if (!Number.isInteger(owner) || owner <= 0) {
          deadline = Math.max(
            deadline,
            Math.min(
              emptyLockDeadline,
              statSync(path).mtimeMs + STALE_EMPTY_LOCK_MS + timeout,
            ),
          )
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }

    if (lockIsStale({ path }) && takeOver({
      path,
      takeover,
    })) {
      const reclaimed = createLock()

      if (reclaimed) {
        return reclaimed
      }
    }

    retrying = true
  } while (Date.now() < deadline)

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

interface RegistryOwner {
  dir: string
  active: boolean
}
const registryContext = new AsyncLocalStorage<RegistryOwner>()
const registryOwners = new Set<string>()
const registryQueue = new Map<string, Promise<void>>()

function ownsRegistry({ dir }: {dir: string}): boolean {
  const owner = registryContext.getStore()

  return owner?.active === true && owner.dir === dir
}

export async function withAsyncRegistryLock<T>({
  fn,
  timeout = nonblockingLocks.getStore() ? 0 : LOCK_TIMEOUT_MS,
}: {
  fn(): T | Promise<T>
  timeout?: number
}): Promise<T> {
  const dir = pnyxHome()

  if (ownsRegistry({dir})) {
    return await fn()
  }

  const previous = registryQueue.get(dir)
  const done = Promise.withResolvers<void>()
  registryQueue.set(
    dir,
    done.promise,
  )

  try {
    await previous
    privateDir({dir})
    const deadline = Date.now() + timeout
    let release: (() => void) | undefined

    while (!release) {
      try {
        release = acquireLock({
          dir,
          timeout: 0,
        })
      } catch (error) {
        if (!(error instanceof HydraError) || error.code !== 'LOCKED' || Date.now() >= deadline) {
          throw error
        }

        await sleep(Math.min(
          LOCK_POLL_MS,
          Math.max(
            0,
            deadline - Date.now(),
          ),
        ))
      }
    }

    const owner: RegistryOwner = {
      dir,
      active: true,
    }
    registryOwners.add(dir)

    try {
      return await registryContext.run(
        owner,
        fn,
      )
    } finally {
      owner.active = false
      registryOwners.delete(dir)
      release()
    }
  } finally {
    done.resolve()

    if (registryQueue.get(dir) === done.promise) {
      registryQueue.delete(dir)
    }
  }
}

export function withRegistryLock<T>({
  fn,
  timeout,
}: {
  fn(): T
  timeout?: number
}): T {
  const dir = pnyxHome()

  if (ownsRegistry({dir})) {
    return fn()
  }

  privateDir({ dir })
  const heldInThisProcess = registryOwners.has(dir)
  const release = acquireLock({
    dir,
    timeout: heldInThisProcess ? 0 : timeout,
  })

  try {
    return fn()
  } finally {
    release()
  }
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
