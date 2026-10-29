import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
import { withRegistryLock } from '#store/storage.ts'
import { appendJournal, readJournal } from '#store/journal.ts'
import { SETTING_KEYS, type Settings, type SettingsEntry } from './model.ts'
import { DEFAULT_SETTINGS, patchSettings, pickView } from './settings.ts'

export const settingsLogPath = () => join(
  pnyxHome(),
  'settings',
  'events.jsonl',
)

const readEntries = () => readJournal<SettingsEntry>({
  path: settingsLogPath(),
  readable: ({ entry }) => entry?.v === 1 && typeof entry.after === 'object' && entry.after !== null,
})

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
    revision: entries.filter(entry => Object.keys(entry.after).length > 0).length,
    ids: new Set(entries.map(entry => entry.id)),
  }
}

let folded: {
  entries: SettingsEntry[]
  read: SettingsRead
} | undefined

// The journal returns the same entries until the log changes, so their fold is reused until then.
function readFolded(): SettingsRead {
  const entries = readEntries()

  if (folded?.entries !== entries) {
    folded = {
      entries,
      read: fold({ entries }),
    }
  }

  return folded.read
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

  appendJournal({
    path: settingsLogPath(),
    entry,
  })

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
function lastChange<K extends Legacy>({
  events,
  key,
}: {
  events: ConfiguredEvent[]
  key: K
}): {
  at: string
  value: ConfiguredEvent['data'][K]
} | undefined {
  let previous: ConfiguredEvent['data'][K] | undefined
  let change: {
    at: string
    value: ConfiguredEvent['data'][K]
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
  const changed = <K extends Legacy>({ key }: { key: K }) => newest({
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

  const helper = changed({ key: 'helper' })

  if (helper !== undefined) {
    after.helper = helper === false ? 'off' : helper
  }

  if (isDeepStrictEqual(
    after,
    DEFAULT_SETTINGS,
  )) {
    appendJournal({ path: settingsLogPath() })

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
        // An attempt that changed nothing keeps its id, so its retry after a newer edit is not applied again.
        if (meta.id) {
          append({
            before: current.settings,
            after,
            meta,
          })
        }

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

// A caller about to take a Hydra writer passes settings it read first, so the shared lock is never taken inside it.
export function effectiveView({
  state,
  settings = readSettings().settings,
}: {
  state: Pick<HydraState, 'view' | 'config'>
  settings?: Settings
}) {
  return viewFor({
    state,
    settings: pickView({ view: settings }),
  })
}
