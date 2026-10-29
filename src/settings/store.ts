import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { HydraState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { readLog } from '#app/event-log.ts'
import { hydraDir, hydraIds } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { hydraConfig } from '#hydra/config.ts'
import { viewFor } from '#preferences/view.ts'
import { DEFAULT_DONE_HOURS } from '#tasks/retention-rules.ts'
import { HydraError } from '#store/errors.ts'
import { pnyxHome } from '#store/paths.ts'
import { privateDir, withRegistryLock, writeDurably } from '#store/storage.ts'
import { SETTING_KEYS, type Settings, type SettingsEntry } from './model.ts'
import { DEFAULT_REVIEW_MINUTES, DEFAULT_SETTINGS, patchSettings, pickView } from './settings.ts'

export const settingsLogPath = () => join(
  pnyxHome(),
  'settings',
  'events.jsonl',
)

function readEntries(): SettingsEntry[] {
  let text = ''

  try {
    text = readFileSync(
      settingsLogPath(),
      'utf8',
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  // A torn last line is a write cut short; the complete lines before it still count.
  const lines = text.split('\n').slice(
    0,
    -1,
  )
    .filter(Boolean)
  const entries = lines.flatMap(line => {
    try {
      const entry = JSON.parse(line) as SettingsEntry
      const readable = entry?.v === 1 && typeof entry.after === 'object' && entry.after !== null

      return readable ? [entry] : []
    } catch {
      return []
    }
  })
  const skipped = lines.length - entries.length

  if (skipped) {
    console.error(`pnyx-axi: skipped ${skipped} unreadable lines in ${settingsLogPath()}`)
  }

  return entries
}

export interface SettingsRead {
  settings: Settings
  revision: number
  ids: Set<string>
}

function fold({ entries }: { entries: SettingsEntry[] }): SettingsRead {
  const settings = structuredClone(DEFAULT_SETTINGS)

  for (const entry of entries) {
    Object.assign(
      settings,
      structuredClone(entry.after),
    )
  }

  return {
    settings,
    revision: entries.length,
    ids: new Set(entries.map(entry => entry.id)),
  }
}

let cache: {
  key: string
  read: SettingsRead
} | undefined

function readFolded(): SettingsRead {
  const path = settingsLogPath()
  const stat = existsSync(path) ? statSync(path) : undefined
  const key = `${path}:${stat?.size ?? -1}:${stat?.mtimeMs ?? 0}`

  if (cache?.key !== key) {
    cache = {
      key,
      read: fold({ entries: readEntries() }),
    }
  }

  return cache.read
}

function writeLine({ line }: { line: string }): void {
  const path = settingsLogPath()
  privateDir({ dir: dirname(path) })
  const size = existsSync(path) ? statSync(path).size : 0
  // A torn last line keeps its own line, so the new entry is never glued onto it.
  const torn = size > 0 && !readFileSync(
    path,
    'utf8',
  ).endsWith('\n')
  writeDurably({
    path,
    data: `${torn ? '\n' : ''}${line}`,
    flag: 'a',
  })
}

function append({
  before,
  after,
  meta,
}: {
  before: Settings
  after: Settings
  meta: Meta
}): SettingsEntry {
  const changed = SETTING_KEYS.filter(key => !isDeepStrictEqual(
    before[key],
    after[key],
  ))
  const entry: SettingsEntry = {
    v: 1,
    id: meta.id ?? randomUUID(),
    at: meta.at,
    actor: meta.actor,
    before: Object.fromEntries(changed.map(key => [
      key,
      before[key],
    ])),
    after: Object.fromEntries(changed.map(key => [
      key,
      after[key],
    ])),
  }

  if (meta.reason) {
    entry.reason = meta.reason
  }

  writeLine({ line: `${JSON.stringify(entry)}\n` })

  return entry
}

const lastChange = ({ hydraId }: { hydraId: string }) => (readLog({ dir: hydraDir({ hydraId }) })
  ?.events ?? [])
  .filter(event => event.type === 'board.view' || event.type === 'board.configured')
  .map(event => event.at)
  .sort()
  .at(-1) ?? ''

// Settings used to belong to each Hydra; the first read takes the most recently changed Hydra's values.
function migrate(): void {
  if (existsSync(settingsLogPath())) {
    return
  }

  const source = hydraIds()
    .map(hydraId => ({
      hydraId,
      at: lastChange({ hydraId }),
    }))
    .filter(hydra => hydra.at)
    .sort((
      a,
      b,
    ) => b.at.localeCompare(a.at))[0]

  if (!source) {
    return
  }

  const { state } = loadHydra({ hydraId: source.hydraId })
  const config = hydraConfig({ state })
  const done = config.doneAfterHours === 0 ? 'off' : config.doneAfterHours ?? DEFAULT_DONE_HOURS
  let helper: Settings['helper'] = 'auto'

  if (config.helper === false) {
    helper = 'off'
  } else if (config.helper) {
    helper = config.helper
  }

  append({
    before: DEFAULT_SETTINGS,
    after: {
      ...pickView({ view: viewFor({ state }) }),
      doneAfterHours: done,
      reviewMinutes: config.reviewMinutes ?? DEFAULT_REVIEW_MINUTES,
      helper,
    },
    meta: {
      at: new Date().toISOString(),
      actor: 'pnyx',
      reason: `Moved from Hydra ${source.hydraId} when settings became Pnyx-wide`,
    },
  })
}

export function readSettings(): SettingsRead {
  if (!existsSync(settingsLogPath()) && hydraIds().length) {
    withRegistryLock({ fn: migrate })
  }

  return readFolded()
}

export function saveSettings({
  patch,
  meta,
}: {
  patch: unknown
  meta: Meta
}): {
  entry?: SettingsEntry
  skipped?: 'duplicate' | 'unchanged'
  settings: Settings
  revision: number
} {
  return withRegistryLock({
    fn: () => {
      migrate()
      const current = readFolded()

      if (meta.id && current.ids.has(meta.id)) {
        return {
          skipped: 'duplicate',
          settings: current.settings,
          revision: current.revision,
        }
      }

      if (meta.ifRevision !== undefined && meta.ifRevision !== current.revision) {
        throw new HydraError({
          message: 'settings changed; reload and retry',
          code: 'REVISION_CONFLICT',
        })
      }

      const after = patchSettings({
        current: current.settings,
        input: patch,
      })

      if (isDeepStrictEqual(
        after,
        current.settings,
      )) {
        return {
          skipped: 'unchanged',
          settings: current.settings,
          revision: current.revision,
        }
      }

      const entry = append({
        before: current.settings,
        after,
        meta,
      })

      return {
        entry,
        settings: after,
        revision: current.revision + 1,
      }
    },
  })
}

export function effectiveView({ state }: { state: Pick<HydraState, 'view' | 'config'> }) {
  return viewFor({
    state,
    settings: pickView({ view: readSettings().settings }),
  })
}
