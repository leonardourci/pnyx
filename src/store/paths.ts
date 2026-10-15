import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { HydraError } from '../core/model.ts'

export function pnyxHome(): string {
  return process.env.PNYX_HOME || join(homedir(), '.pnyx')
}

// Per Pnyx home, the Hydras a server from before the move still runs in boards/.
const held = new Map<string, Set<string>>()

const conflict = ({ id, from, to }: { id: string; from: string; to: string }) => new HydraError({
  message: `Hydra ${id} is in both ${from} and ${to}`,
  code: 'CONFLICT',
  help: [
    'Nothing was moved or deleted',
    `Keep one of them, move the other out of ${dirname(from)}, then rerun`,
  ],
})

const spoolOnly = ({ dir }: { dir: string }) => readdirSync(dir).every(entry => entry === 'spool')

// Hooks spool into whichever folder their installed script names; false on a name clash.
function foldSpool({ from, into }: { from: string; into: string }): boolean {
  const spool = join(from, 'spool')
  const target = join(into, 'spool')
  mkdirSync(target, { recursive: true, mode: 0o700 })

  for (const name of existsSync(spool) ? readdirSync(spool) : []) {
    if (name.startsWith('.')) {
      continue
    }

    if (existsSync(join(target, name))) {
      return false
    }

    renameSync(join(spool, name), join(target, name))
  }

  for (const dir of [spool, from]) {
    try {
      rmdirSync(dir)
    } catch { /* Not empty or already gone: left for the next run. */ }
  }

  return true
}

// Moving a folder under a live older server would split the Hydra, so it waits for that server to exit.
// ponytail: pid-only liveness; a reused pid keeps the Hydra in boards/ until the lock goes.
function liveServer({ dir }: { dir: string }): boolean {
  try {
    const { pid } = JSON.parse(readFileSync(join(dir, 'server.lock'), 'utf8')) as { pid?: unknown }

    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
      return false
    }

    process.kill(pid, 0)

    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Hydras lived in boards/<id>/ before; each moves to hydras/<id>/ once, never over existing data.
function moveBoards({ home }: { home: string }): Set<string> {
  const boards = join(home, 'boards')
  const hydras = join(home, 'hydras')
  const kept = new Set<string>()
  let ids: string[]

  try {
    ids = readdirSync(boards, { withFileTypes: true }).filter(d => d.isDirectory())
      .map(d => d.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return kept
    }

    throw error
  }

  mkdirSync(hydras, { recursive: true })

  for (const id of ids) {
    const from = join(boards, id)
    const to = join(hydras, id)

    if (liveServer({ dir: from })) {
      kept.add(id)
      continue
    }

    if (existsSync(to)) {
      if (spoolOnly({ dir: from })) {
        if (!foldSpool({ from, into: to })) {
          throw conflict({ id, from, to })
        }

        continue
      }

      if (!spoolOnly({ dir: to }) || !foldSpool({ from: to, into: from })) {
        throw conflict({ id, from, to })
      }
    }

    try {
      renameSync(from, to)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code

      // Another process moved it first.
      if (code === 'ENOENT') {
        continue
      }

      if (code === 'ENOTEMPTY' || code === 'EEXIST') {
        throw conflict({ id, from, to })
      }

      throw error
    }

    // Task copies are git worktrees, so their repositories must learn the new folder.
    for (const copy of existsSync(join(to, 'copies')) ? readdirSync(join(to, 'copies')) : []) {
      spawnSync('git', ['-C', join(to, 'copies', copy), 'worktree', 'repair'], { stdio: 'ignore', timeout: 30_000 })
    }
  }

  try {
    rmdirSync(boards)
  } catch { /* A Hydra still held there, or a stray file, keeps it. */ }

  return kept
}

// Moves boards/ once per process, so a long-running server keeps one path per Hydra.
function heldInBoards(): Set<string> {
  const home = pnyxHome()
  let kept = held.get(home)

  if (!kept) {
    kept = moveBoards({ home })
    held.set(home, kept)
  }

  return kept
}

export function hydrasDir(): string {
  heldInBoards()

  return join(pnyxHome(), 'hydras')
}

export function hydraIds(): string[] {
  let ids: string[] = []

  try {
    ids = readdirSync(hydrasDir(), { withFileTypes: true }).filter(d => d.isDirectory())
      .map(d => d.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  return [...new Set([...ids, ...heldInBoards()])].sort()
}

export function hydraDir({ hydraId }: { hydraId: string }): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(hydraId)) {
    throw new HydraError({
      message: `invalid Hydra name: ${hydraId}`,
      code: 'VALIDATION_ERROR',
      help: [
        'Use letters, digits, dot, dash or underscore',
      ],
    })
  }

  return join(heldInBoards().has(hydraId) ? join(pnyxHome(), 'boards') : hydrasDir(), hydraId)
}

export function canonical({ path }: { path: unknown }): string | undefined {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    return undefined
  }

  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
