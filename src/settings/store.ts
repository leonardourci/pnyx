import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { HydraEvent, HydraState } from '#app/model.ts'
import type { ViewEvent } from '#preferences/model.ts'
import type { Meta } from '#app/command-meta.ts'
import type { Output } from '#app/cli-support.ts'
import { readLog } from '#app/event-log.ts'
import { hydraDir, hydraIds } from '#app/home-migration.ts'
import { viewFor } from '#preferences/view.ts'
import { HydraError } from '#store/errors.ts'
import { pnyxHome } from '#store/paths.ts'
import { privateDir, withRegistryLock, writeDurably } from '#store/storage.ts'
import { SETTING_KEYS, type Settings, type SettingsEntry } from './model.ts'
import { DEFAULT_SETTINGS, patchSettings, pickView } from './settings.ts'

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

type ConfiguredEvent = HydraEvent & { type: 'board.configured' }

const newest = <T extends { at: string }>({ events }: { events: T[] }) => events
  .toSorted((
    a,
    b,
  ) => a.at.localeCompare(b.at))
  .at(-1)

type Legacy = 'doneAfterHours' | 'reviewMinutes' | 'helper'

// A Hydra's last change to an old value; an old reset removed the value, so a removal counts as a change too.
function lastChange({
  events,
  key,
}: {
  events: ConfiguredEvent[]
  key: Legacy
}): {
  at: string
  value: unknown
} | undefined {
  let previous: unknown
  let change: {
    at: string
    value: unknown
  } | undefined

  for (const event of events) {
    const value = event.data[key]

    if (!isDeepStrictEqual(
      value,
      previous,
    )) {
      change = {
        at: event.at,
        value,
      }
    }

    previous = value
  }

  return change
}

// Old per-Hydra values: each one comes from the Hydra that changed it last, and an old Hide Done 0 meant off.
function migrate(): void {
  if (existsSync(settingsLogPath())) {
    return
  }

  const logs = hydraIds().map(hydraId => readLog({ dir: hydraDir({ hydraId }) })?.events ?? [])
  const views = logs.flat().filter((event): event is ViewEvent => event.type === 'board.view')
  const view = newest({ events: views })
  const changed = ({ key }: { key: Legacy }) => newest({
    events: logs.flatMap(events => lastChange({
      events: events.filter((event): event is ConfiguredEvent => event.type === 'board.configured'),
      key,
    }) ?? []),
  })?.value
  const after = structuredClone(DEFAULT_SETTINGS)

  if (view) {
    Object.assign(
      after,
      pickView({ view: viewFor({ state: { view: view.data.after } }) }),
    )
  }

  const hours = changed({ key: 'doneAfterHours' })

  if (typeof hours === 'number') {
    after.doneAfterHours = hours === 0 ? 'off' : hours
  }

  const minutes = changed({ key: 'reviewMinutes' })

  if (typeof minutes === 'number') {
    after.reviewMinutes = minutes
  }

  const helper = changed({ key: 'helper' }) as Settings['helper'] | false | undefined

  if (helper !== undefined) {
    after.helper = helper === false ? 'off' : helper
  }

  if (isDeepStrictEqual(
    after,
    DEFAULT_SETTINGS,
  )) {
    writeLine({ line: '' })

    return
  }

  append({
    before: DEFAULT_SETTINGS,
    after,
    meta: {
      at: new Date().toISOString(),
      actor: 'pnyx',
      reason: 'Moved from each Hydra when settings became shared by every Hydra',
    },
  })
}

export function readSettings(): SettingsRead {
  if (!existsSync(settingsLogPath()) && hydraIds().length) {
    withRegistryLock({ fn: migrate })
  }

  return readFolded()
}

export type SettingsSave = {
  settings: Settings
  revision: number
} & ({
  skipped: 'duplicate' | 'unchanged'
} | {
  entry: SettingsEntry
})

export function saveSettings({
  patch,
  meta,
}: {
  patch: unknown
  meta: Meta
}): SettingsSave {
  return withRegistryLock({
    fn: () => {
      migrate()
      const current = readFolded()

      if (meta.id && current.ids.has(meta.id)) {
        return {
          skipped: 'duplicate' as const,
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
          skipped: 'unchanged' as const,
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

// A command that also writes a Hydra checks its shared part first and saves it only once that write succeeds.
export function checkSettings({ patch }: { patch: unknown }): void {
  patchSettings({
    current: readSettings().settings,
    input: patch,
  })
}

export function settingsReceipt({ saved }: { saved: SettingsSave }): Output {
  if ('skipped' in saved) {
    return {
      event: `none: ${saved.skipped}`,
      settings: saved.settings,
      revision: saved.revision,
    }
  }

  return {
    changed: saved.entry.after,
    settings: saved.settings,
    revision: saved.revision,
  }
}

export function effectiveView({ state }: { state: Pick<HydraState, 'view' | 'config'> }) {
  return viewFor({
    state,
    settings: pickView({ view: readSettings().settings }),
  })
}
