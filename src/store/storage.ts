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
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { HydraError } from './errors.ts'
import { pnyxHome } from './paths.ts'

export { pnyxHome } from './paths.ts'

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
export const snapshotPath = ({ dir }: { dir: string }) => join(
  dir,
  'snapshot.json',
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
