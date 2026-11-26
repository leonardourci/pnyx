import { execFile } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { log } from '#app/diagnostics.ts'

const run = promisify(execFile)
const FILES_PER_PROJECT = 20_000
const LIST_BUFFER = 64 * 1024 * 1024

export interface ProjectFiles {
  path: string
  files: string[]
}

interface Entry {
  files?: Promise<string[]>
  watcher?: FSWatcher
}

const warn = ({
  operation,
  root,
  error,
}: {
  operation: string
  root: string
  error: unknown
}) => log({
  level: 'warn',
  operation,
  name: basename(root),
  error,
})

const nestedRepository = ({ path }: { path: string }) => path.endsWith('/')

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
    const listed = stdout.split('\0')
    const files = new Set(listed.filter(path => path !== '' && !nestedRepository({ path })))

    return [...files].sort().slice(
      0,
      FILES_PER_PROJECT,
    )
  } catch (error) {
    const gitRefusedFolder = typeof (error as { code?: unknown }).code === 'number'

    if (!gitRefusedFolder) {
      warn({
        operation: 'files.list',
        root,
        error,
      })
    }

    return []
  }
}

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
      const watcher = watch(
        root,
        { recursive: true },
        () => {
          entry.files = undefined
        },
      )

      const stopCachingAfterWatchFailure = (error: Error) => {
        warn({
          operation: 'files.watch',
          root,
          error,
        })
        watcher.close()
        entry.watcher = undefined
        entry.files = undefined
      }

      watcher.on(
        'error',
        stopCachingAfterWatchFailure,
      )
      entry.watcher = watcher
    } catch (error) {
      warn({
        operation: 'files.watch',
        root,
        error,
      })
    }

    return entry
  }

  const forget = ({ root }: { root: string }) => {
    entries.get(root)?.watcher?.close()
    entries.delete(root)
  }

  const read = ({ root }: { root: string }): Promise<string[]> => {
    if (closed) {
      return Promise.resolve([])
    }

    const entry = entryFor({ root })
    const listing = entry.files ?? listFiles({ root })
    entry.files = entry.watcher ? listing : undefined

    return listing
  }

  const projectFiles = async ({ roots }: { roots: string[] }): Promise<ProjectFiles[]> => {
    for (const root of entries.keys()) {
      if (!roots.includes(root)) {
        forget({ root })
      }
    }

    return await Promise.all(roots.map(async root => ({
      path: root,
      files: await read({ root }),
    })))
  }

  const close = () => {
    closed = true

    for (const root of entries.keys()) {
      forget({ root })
    }
  }

  return {
    projectFiles,
    close,
  }
}
