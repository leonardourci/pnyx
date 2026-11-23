import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fchmodSync, fdatasyncSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pnyxHome } from './paths.ts'

export { pnyxHome } from './paths.ts'

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

interface RegistryOwner {
  dir: string
  active: boolean
  pending: Set<Promise<unknown>>
}
const registryContext = new AsyncLocalStorage<RegistryOwner>()
const registryQueue = new Map<string, Promise<void>>()

export async function withAsyncRegistryLock<T>({ fn }: {
  fn(): T | Promise<T>
  timeout?: number
}): Promise<T> {
  const dir = resolve(pnyxHome())
  const owner = registryContext.getStore()

  if (owner?.active && owner.dir === dir) {
    const decision = Promise.resolve().then(fn)
    owner.pending.add(decision)
    const settled = () => owner.pending.delete(decision)
    decision.then(
      settled,
      settled,
    )

    return decision
  }

  const previous = registryQueue.get(dir)
  const done = Promise.withResolvers<void>()
  registryQueue.set(
    dir,
    done.promise,
  )

  try {
    await previous
    const active: RegistryOwner = {
      dir,
      active: true,
      pending: new Set(),
    }

    try {
      return await registryContext.run(
        active,
        fn,
      )
    } finally {
      while (active.pending.size) {
        await Promise.allSettled(active.pending)
      }

      active.active = false
    }
  } finally {
    done.resolve()

    if (registryQueue.get(dir) === done.promise) {
      registryQueue.delete(dir)
    }
  }
}

export const withRegistryLock = <T>({ fn }: {
  fn(): T
  timeout?: number
}): T => fn()

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
