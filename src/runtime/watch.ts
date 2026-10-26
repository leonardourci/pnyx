import { watch, statSync, readdirSync, type FSWatcher } from 'node:fs'
import { join, resolve } from 'node:path'
import { background } from './background.ts'

// Native watchers share the daemon's descriptors with agent pipes and open requests.
const NATIVE_LIMIT = 64
const native = new Set<FSWatcher>()
type Changed = ({ filename }: { filename?: string }) => unknown
type SharedWatch = {
  users: Map<symbol, Changed>
  close(): void
}
const shared = new Map<string, SharedWatch>()

export interface PathWatch {
  close(): void
}

function follow({
  path,
  interval,
}: {
  path: string
  interval: number
}): SharedWatch {
  const users = new Map<symbol, Changed>()
  let closed = false
  let file: FSWatcher | undefined
  let polling: ReturnType<typeof setInterval> | undefined
  let previous: string | undefined

  const notify = ({ filename }: { filename?: string } = {}) => {
    if (!closed) {
      for (const [
        id,
        changed,
      ] of [...users]) {
        if (users.has(id)) {
          background({
            name: `watch ${path}`,
            run: () => changed({ filename }),
          })
        }
      }
    }
  }

  const release = () => {
    if (file) {
      native.delete(file)
      file.close()
      file = undefined
    }
  }

  const fingerprint = ({ target }: { target: string }): string => {
    try {
      const stat = statSync(target)

      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
    } catch (error) {
      if ([
        'ENOENT',
        'ENOTDIR',
      ].includes((error as NodeJS.ErrnoException).code ?? '')) {
        return ''
      }

      throw error
    }
  }

  const pollChanged = () => {
    let current = fingerprint({ target: path })

    try {
      // Directory timestamps do not change when an existing child is edited in place.
      current += readdirSync(path).sort()
        .map(filename => `\n${filename}:${fingerprint({
          target: join(
            path,
            filename,
          ),
        })}`)
        .join('')
    } catch (error) {
      if (![
        'ENOENT',
        'ENOTDIR',
      ].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw error
      }
    }

    const changed = previous !== undefined && current !== previous
    previous = current

    if (changed) {
      notify()
    }
  }

  const poll = () => {
    if (closed || polling) {
      return
    }

    polling = setInterval(
      () => background({
        name: `watch poll ${path}`,
        run: pollChanged,
      }),
      interval,
    )
    polling.unref()
    pollChanged()
  }

  if (native.size < NATIVE_LIMIT) {
    try {
      file = watch(
        path,
        (
          _event,
          filename,
        ) => notify({ filename: filename?.toString() }),
      )
      native.add(file)
      file.unref()
      file.on(
        'error',
        error => background({
          name: `watch fallback ${path}`,
          run: () => {
            console.error(
              `pnyx-axi watch ${path}:`,
              error,
            )
            release()
            poll()
          },
        }),
      )
    } catch (error) {
      if (![
        'ENOENT',
        'ENOTDIR',
      ].includes((error as NodeJS.ErrnoException).code ?? '')) {
        console.error(
          `pnyx-axi watch ${path}:`,
          error,
        )
      }
    }
  }

  if (!file) {
    background({
      name: `watch fallback ${path}`,
      run: poll,
    })
  }

  return {
    users,
    close() {
      closed = true
      release()
      clearInterval(polling)
    },
  }
}

export function watchPath({
  path,
  changed,
  interval = 500,
}: {
  path: string
  changed: Changed
  interval?: number
}): PathWatch {
  path = resolve(path)
  let record = shared.get(path)

  if (!record) {
    record = follow({
      path,
      interval,
    })
    shared.set(
      path,
      record,
    )
  }

  const id = Symbol()
  record.users.set(
    id,
    changed,
  )

  return {
    close() {
      if (!record.users.delete(id)) {
        return
      }

      if (record.users.size === 0) {
        record.close()
        shared.delete(path)
      }
    },
  }
}
