import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, readdir, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { git } from '#projects/git.ts'
import { hydraPool } from '#projects/remove-pool.ts'
import { loadHydra } from '#app/store.ts'
import { HydraError } from '#store/errors.ts'

export async function removalWork({ id }: { id: string }): Promise<Record<string, string>> {
  const state = loadHydra({ hydraId: id }).state
  const pool = await hydraPool({ hydraId: id })
  const copies = Object.values(state.cards).flatMap(card => card.copy && card.copy.state !== 'removed' ? [card.copy.path] : [])
  const paths = new Set([
    ...copies,
    ...pool.slots.map(slot => slot.path),
  ])
  const work: Record<string, string> = {}

  for (const path of paths) {
    const fingerprint = await copyFingerprint({ path })

    if (fingerprint !== undefined) {
      work[path] = fingerprint
    }
  }

  return work
}

export async function copyFingerprint({ path }: { path: string }): Promise<string | undefined> {
  let root

  try {
    root = await lstat(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }

    throw error
  }

  const hash = createHash('sha256')
  const entries = root.isDirectory() ? await readdir(path) : []

  if (entries.includes('.git')) {
    const status = await git({
      cwd: path,
      args: [
        'status',
        '--porcelain=v2',
        '--branch',
        '--untracked-files=no',
      ],
    })
    const index = await git({
      cwd: path,
      args: [
        'ls-files',
        '--stage',
        '-z',
      ],
    })

    if (!status.ok || !index.ok) {
      const reason = status.ok ? index.err : status.err

      throw new HydraError({
        message: `Cannot verify checkout at ${path}: ${reason}`,
        code: 'CONFLICT',
      })
    }

    hash.update(JSON.stringify([
      status.out,
      index.out,
    ]))
  }

  async function visit({
    name,
    stat,
  }: {
    name: string
    stat: Stats
  }) {
    const full = join(
      path,
      name,
    )
    hash.update(JSON.stringify([
      name,
      stat.mode,
      stat.dev,
      stat.ino,
    ]))

    if (stat.isSymbolicLink()) {
      hash.update(JSON.stringify(await readlink(full)))
    } else if (stat.isFile()) {
      const content = createHash('sha256')
      const file = await open(
        full,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )

      try {
        const opened = await file.stat()

        if (opened.isFile() && opened.dev === stat.dev && opened.ino === stat.ino) {
          for await (const chunk of file.createReadStream({ autoClose: false })) {
            content.update(chunk)
          }

          const read = await file.stat()

          const unchanged = read.size === opened.size
            && read.mtimeMs === opened.mtimeMs && read.ctimeMs === opened.ctimeMs

          if (unchanged) {
            hash.update(content.digest())

            return
          }
        }
      } finally {
        await file.close()
      }

      throw new HydraError({
        message: `Checkout file changed while reading it: ${full}`,
        code: 'CONFLICT',
      })
    } else if (stat.isDirectory()) {
      const children = name === '.' ? entries : await readdir(full)

      for (const child of children.sort()) {
        const childName = join(
          name,
          child,
        )
        const childStat = await lstat(join(
          path,
          childName,
        ))

        // Git updates its checkout metadata while commands read it.
        if (name === '.' && child === '.git' && childStat.isDirectory()) {
          continue
        }

        await visit({
          name: childName,
          stat: childStat,
        })
      }
    }
  }

  await visit({
    name: '.',
    stat: root,
  })

  return hash.digest('hex')
}
