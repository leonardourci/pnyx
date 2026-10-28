import { HydraError } from '../store/errors.ts'
import { basename, dirname, join } from 'node:path'
import { readdirSync, mkdirSync, existsSync, renameSync, rmdirSync, readFileSync, symlinkSync } from 'node:fs'
import { acquireLock } from '../store/storage.ts'
import { spawnSync } from 'node:child_process'
import { pnyxHome } from '../store/paths.ts'

export const DEFAULT_HYDRA = 'default'

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
