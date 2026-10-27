import { watchFile, unwatchFile } from 'node:fs'
import { watchPath, type PathWatch } from '../app/watch.ts'
import { background } from '../app/background.ts'
import { HYDRA_CARD } from '../core/hydra.ts'
import type { Card, HydraProject } from '../core/model.ts'
import { readCatalog, type Catalog, type CatalogLocations } from './catalog.ts'

const STAT_INTERVAL_MS = 1000
const REFRESH_DELAY_MS = 25

type Scope = {
  card: Card
  projects?: HydraProject[]
}
type Entry = {
  scope: Scope
  identity: string
  paths: Set<string>
  active: boolean
  value?: Catalog
  pending?: Promise<Catalog>
  dirty?: boolean
}

export function createCatalogIndex({
  locations,
  scan = readCatalog,
}: {
  locations?: CatalogLocations
  scan?: typeof readCatalog
}) {
  const entries = new Map<string, Entry>()
  const watches = new Map<string, {
    file?: PathWatch
    users: Set<Entry>
    poll(): void
    stat(): void
  }>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  const refresh = ({ entry }: { entry: Entry }): Promise<Catalog> => {
    if (entry.pending) {
      return entry.pending
    }

    const read = async () => {
      try {
        entry.dirty = false
        const paths = new Set<string>()
        const value = await scan({
          ...entry.scope,
          locations,
          observe: ({ path }) => observe({
            path,
            entry,
            paths,
          }),
        })

        for (const path of entry.paths) {
          if (!paths.has(path)) {
            releasePath({
              path,
              entry,
            })
          }
        }

        entry.value = value

        return value
      } finally {
        entry.pending = undefined

        if (entry.dirty && entry.active && !closed) {
          changed({ affected: [entry] })
        }
      }
    }

    entry.pending = read()

    return entry.pending
  }

  const changed = ({ affected }: { affected: Iterable<Entry> }) => {
    for (const entry of affected) {
      entry.dirty = true
    }

    if (closed || timer) {
      return
    }

    timer = setTimeout(
      () => background({
        name: 'catalog refresh',
        run: () => {
          timer = undefined

          for (const entry of entries.values()) {
            if (!entry.dirty || !entry.active) {
              continue
            }

            refresh({ entry }).catch(error => console.error(
              'pnyx catalog refresh:',
              error,
            ))
          }
        },
      }),
      REFRESH_DELAY_MS,
    )
    timer.unref()
  }

  const releasePath = ({
    path,
    entry,
  }: {
    path: string
    entry: Entry
  }) => {
    entry.paths.delete(path)
    const record = watches.get(path)
    record?.users.delete(entry)

    if (record && record.users.size === 0) {
      record.file?.close()
      unwatchFile(
        path,
        record.stat,
      )
      watches.delete(path)
    }
  }

  const observe = ({
    path,
    entry,
    paths,
  }: {
    path: string
    entry: Entry
    paths: Set<string>
  }) => {
    if (closed || !entry.active) {
      return
    }

    paths.add(path)
    entry.paths.add(path)
    const existing = watches.get(path)

    if (existing) {
      existing.users.add(entry)

      return
    }

    const record: {
      file?: PathWatch
      users: Set<Entry>
      poll(): void
      stat(): void
    } = {
      users: new Set([entry]),
      stat: () => background({
        name: 'catalog poll',
        run: () => record.poll(),
      }),
      poll: () => {
        if (closed || record.users.size === 0) {
          return
        }

        record.file?.close()
        record.file = undefined

        try {
          record.file = watchPath({
            path,
            changed: () => record.poll(),
            interval: STAT_INTERVAL_MS,
          })
        } catch { /* A missing file is followed by the stat watcher until it appears. */ }

        changed({ affected: record.users })
      },
    }
    watches.set(
      path,
      record,
    )
    watchFile(
      path,
      {
        persistent: false,
        interval: STAT_INTERVAL_MS,
      },
      record.stat,
    )

    try {
      record.file = watchPath({
        path,
        changed: () => record.poll(),
        interval: STAT_INTERVAL_MS,
      })
    } catch { /* Stat watching also detects newly created skill folders. */ }
  }

  return {
    read({
      card,
      projects,
    }: Scope): Promise<Catalog> {
      const scope = {
        card,
        projects,
      }

      if (closed) {
        throw new Error('Catalog index is closed')
      }

      const identity = JSON.stringify([
        card.id === HYDRA_CARD,
        card.agent?.provider,
        card.agent?.cwd,
      ])
      const key = JSON.stringify([
        identity,
        projects?.map(project => [
          project.path,
          project.name,
          project.detached,
        ]),
      ])

      for (const [
        previousKey,
        previous,
      ] of entries) {
        if (previous.identity === identity && previousKey !== key) {
          previous.active = false

          for (const path of previous.paths) {
            releasePath({
              path,
              entry: previous,
            })
          }

          entries.delete(previousKey)
        }
      }

      let entry = entries.get(key)

      if (!entry) {
        entry = {
          scope,
          identity,
          paths: new Set(),
          active: true,
        }
        entries.set(
          key,
          entry,
        )
      }

      if (entry.value) {
        return Promise.resolve(entry.value)
      }

      if (entry.pending) {
        return entry.pending
      }

      return refresh({ entry })
    },
    close() {
      closed = true
      clearTimeout(timer)

      for (const entry of entries.values()) {
        entry.active = false
      }

      for (const [
        path,
        record,
      ] of watches) {
        record.file?.close()
        unwatchFile(
          path,
          record.stat,
        )
      }

      watches.clear()
      entries.clear()
    },
  }
}
