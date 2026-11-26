import { execFile } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)
// The most files one project offers to mention; a bigger repository lists its first ones by path.
const FILE_LIMIT = 20_000
const LIST_BUFFER = 64 * 1024 * 1024

interface Entry {
  files?: Promise<string[]>
  watcher?: FSWatcher
}

// Git's tracked and untracked files, without the ignored ones, as paths inside the project.
async function listFiles({ root }: { root: string }): Promise<string[]> {
  try {
    const { stdout } = await run(
      'git',
      [
        '-C',
        root,
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
      ],
      { maxBuffer: LIST_BUFFER },
    )

    return [...new Set(stdout.split('\0').filter(Boolean))].sort().slice(
      0,
      FILE_LIMIT,
    )
  } catch {
    // A folder outside Git, or one Git cannot read, offers no files.
    return []
  }
}

// Each project's file list is read once and read again only after something under it changed.
export function createFileIndex() {
  const entries = new Map<string, Entry>()
  let closed = false

  const entryFor = ({ root }: { root: string }) => {
    const known = entries.get(root)

    if (known) {
      return known
    }

    const entry: Entry = {}
    entries.set(
      root,
      entry,
    )

    try {
      entry.watcher = watch(
        root,
        { recursive: true },
        () => {
          entry.files = undefined
        },
      )
      // ponytail: a watcher that fails stops caching, so every read lists the files again.
      entry.watcher.on(
        'error',
        () => {
          entry.watcher?.close()
          entry.watcher = undefined
          entry.files = undefined
        },
      )
    } catch { /* Without a watcher every read lists the files again. */ }

    return entry
  }

  const files = ({ root }: { root: string }): Promise<string[]> => {
    if (closed) {
      return Promise.resolve([])
    }

    const entry = entryFor({ root })
    const listing = entry.files ?? listFiles({ root })
    entry.files = entry.watcher ? listing : undefined

    return listing
  }

  const close = () => {
    closed = true

    for (const entry of entries.values()) {
      entry.watcher?.close()
    }

    entries.clear()
  }

  return {
    files,
    close,
  }
}
