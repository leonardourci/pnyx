import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { HydraEvent, HydraState } from '#app/model.ts'
import type { ViewEvent } from '#preferences/model.ts'
import type { Meta } from '#app/command-meta.ts'
import type { Output } from '#app/cli-support.ts'
import { readEvents } from '#app/event-log.ts'
import { readLog } from '#app/legacy-log.ts'
import { hydraExists } from '#app/store.ts'
import { hydraDir, hydraIds } from '#app/home-migration.ts'
import { viewFor } from '#preferences/view.ts'
import { HydraError } from '#store/errors.ts'
import { pnyxHome } from '#store/paths.ts'
import { withRegistryLock } from '#store/storage.ts'
import { appendJournal, readJournal } from '#store/journal.ts'
import { SETTING_KEYS, type PageSettings, type Settings, type SettingsEntry } from './model.ts'
import { DEFAULT_SETTINGS, patchSettings, pickView } from './settings.ts'
import { effectiveDispatch, lockedDocument, savedDocument } from '#workers/dispatch-config.ts'
import { harnessAccount } from '#workers/account-choice.ts'
import { settingsNotice } from '#hydra/settings-notice.ts'
import { query } from '#store/postgres.ts'

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

  // A Hydra not yet imported still keeps these values in its events.jsonl.
  const logs = hydraIds().map(hydraId => hydraExists({ hydraId })
    ? readEvents({ hydraId })
    : readLog({ dir: hydraDir({ hydraId }) })?.events ?? [])
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
    const migrated = pickView({ view: viewFor({ state: { view: view.data.after } }) })
    migrated.defaultColumnWidths = Object.fromEntries(Object.entries(migrated.defaultColumnWidths)
      .filter(([
        , width,
      ]) => width !== migrated.defaultColumnWidth))
    Object.assign(
      after,
      migrated,
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

// A helper account the patch changes must be registered for the helper's harness.
function checkHelperAccount({
  current,
  after,
  document,
}: {
  current: Settings
  after: Settings
  document(): unknown
}): void {
  const helper = after.helper
  const changed = !isDeepStrictEqual(
    current.helper,
    helper,
  )

  if (!changed || typeof helper !== 'object' || !helper.account) {
    return
  }

  // Refuses an account not registered for this harness.
  harnessAccount({
    effective: effectiveDispatch({ document: document() }),
    harness: helper.harness,
    prefer: helper.account,
  })
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
  beforeSave,
  hydraId,
}: {
  patch: unknown
  meta: Meta
  // Runs inside the settings lock once the patch is valid or a repeat, before it is written, so a combined command changes its Hydra only when the shared write goes ahead.
  beforeSave?(): void
  hydraId?: string
}): SettingsSave {
  return withRegistryLock({
    fn: () => {
      migrate()
      const current = readFolded()

      if (meta.id && current.ids.has(meta.id)) {
        beforeSave?.()

        const entry = readEntries().find(entry => entry.id === meta.id)

        if (hydraId && entry && Object.keys(entry.after).length) {
          settingsNotice({
            hydraId,
            meta,
            changeId: `shared:${entry.id}`,
            text: `Changed settings: ${Object.keys(entry.after).join(', ')}`,
          })
        }

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

      checkHelperAccount({
        current: current.settings,
        after,
        document: lockedDocument,
      })

      beforeSave?.()

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

      if (hydraId) {
        settingsNotice({
          hydraId,
          meta,
          changeId: `shared:${entry.id}`,
          text: `Changed settings: ${Object.keys(entry.after).join(', ')}`,
        })
      }

      return {
        entry,
        settings: after,
        revision: current.revision + 1,
      }
    },
  })
}

// The Postgres URL set for this home, read without the move from older per-Hydra values, which itself needs Postgres.
export const configuredPostgres = () => readFolded().settings.postgresUrl

// postgresUrl may hold a password, so pages never get it.
export function pageSettings({ settings }: { settings: Settings }): PageSettings {
  const shown: Partial<Settings> = { ...settings }
  delete shown.postgresUrl

  return shown as PageSettings
}

const maskedUrl = ({ url }: { url: string }) => {
  if (!URL.canParse(url)) {
    return url
  }

  const parsed = new URL(url)

  if (!parsed.password) {
    return url
  }

  parsed.password = '***'

  return parsed.toString()
}

// What the CLI prints: everything, with a password in postgresUrl masked.
export const shownSettings = ({ settings }: { settings: Settings }): Settings => ({
  ...settings,
  postgresUrl: maskedUrl({ url: settings.postgresUrl }),
})

// The page reads the shared settings through Zero, so their newest revision is copied into Postgres; the settings log
// stays their record, since it also names the database.
export function mirrorSettings({
  settings,
  revision,
}: {
  settings: Settings
  revision: number
}): void {
  query({
    statements: [
      {
        text: `insert into settings (id, revision, value) values ('shared', $1, $2) on conflict (id)
          do update set revision = excluded.revision, value = excluded.value where settings.revision < excluded.revision`,
        values: [
          revision,
          JSON.stringify(pageSettings({ settings })),
        ],
      },
    ],
  })
}

// A command that also writes a Hydra checks its shared part first and saves it only once that write succeeds.
export function checkSettings({ patch }: { patch: unknown }): void {
  const current = readSettings().settings
  const after = patchSettings({
    current,
    input: patch,
  })

  checkHelperAccount({
    current,
    after,
    document: savedDocument,
  })
}

export function settingsReceipt({ saved }: { saved: SettingsSave }): Output {
  const settings = shownSettings({ settings: saved.settings })

  if ('skipped' in saved) {
    return {
      event: `none: ${saved.skipped}`,
      settings,
      revision: saved.revision,
    }
  }

  const changed = { ...saved.entry.after }

  if (changed.postgresUrl !== undefined) {
    changed.postgresUrl = maskedUrl({ url: changed.postgresUrl })
  }

  return {
    changed,
    settings,
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
