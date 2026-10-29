import { useRef, useState, type ReactNode } from 'react'
import type { HydraState } from '#app/model.ts'
import type { ViewPreferences } from '#preferences/model.ts'
import { DEFAULT_COLUMN_WIDTH, DEFAULT_VIEW, VIEW_SIZE_LIMITS } from '#preferences/view.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import type { Command } from '#web-app/connection.ts'
import { About } from '#web-app/about.tsx'
import { KeyboardSettings } from '#web-preferences/keyboard-settings.tsx'
import { Button, NumberField, Switch } from '#web-shared/ui/controls.tsx'
import { InlineConfirm } from '#web-shared/ui/inline-confirm.tsx'
import { SearchBar, type SearchBadge } from '#web-shared/ui/search-bar.tsx'
import { Segmented } from '#web-shared/ui/segmented.tsx'
import { SettingRow } from '#web-shared/ui/setting-row.tsx'
import { useKeyAction } from '#web-preferences/keyboard-registry.tsx'
import { columnsFor } from '#web-tasks/view.ts'
import { BoardPreview, CardTextPreview, CardUpdatesPreview, ChatTextPreview, CodeTextPreview, ConversationPreview, ThemePreview } from './previews.tsx'
import { changedIds, resetPatch } from './changed.ts'
import { SETTINGS_CATALOG, SETTINGS_SECTIONS, searchSettings, type CatalogEntry, type SettingsSection } from './catalog.ts'

export const SETTING_ICONS: Record<string, string> = {
  theme: 'theme',
  fontSize: 'text-size',
  chatFontSize: 'comment',
  codeFontSize: 'tool',
  defaultColumnWidths: 'columns',
  defaultHydraWidth: 'chat-width',
  resetWidths: 'reset',
  lastMessageOnCards: 'cards',
  focusMode: 'focus',
  toolDetails: 'tool',
  thinkingDetails: 'thinking',
  keyboard: 'keyboard',
  version: 'about',
}
const WIDTH_SLIDER_MAX = 900
const WIDTH_MAX = 2400
const SUGGESTIONS = [
  'dark',
  'bigger',
  'width',
  'focus',
]

type Toggle = 'lastMessageOnCards' | 'focusMode' | 'toolDetails' | 'thinkingDetails'

// The setting's live picture, which the Settings page and the Oracle's preview share.
export function SettingPreview({
  entry,
  state,
  view,
  save,
}: Saving & {
  entry: CatalogEntry
  state: HydraState
}): ReactNode {
  switch (entry.id) {
    case 'theme':
      return <ThemePreview view={view} choose={({ theme }) => save({ patch: { theme } })} />
    case 'fontSize':
      return <CardTextPreview view={view} />
    case 'chatFontSize':
      return <ChatTextPreview view={view} />
    case 'codeFontSize':
      return <CodeTextPreview view={view} />
    case 'defaultColumnWidths':
      return <BoardPreview state={state} view={view} mark="columns" />
    case 'defaultHydraWidth':
      return <BoardPreview state={state} view={view} mark="chat" />
    case 'lastMessageOnCards':
      return <CardUpdatesPreview view={view} />
    case 'focusMode':
      return <ConversationPreview view={view} />
    case 'toolDetails':
    case 'thinkingDetails':
      return <ConversationPreview view={view} open />
    default:
      return undefined
  }
}

interface Saving {
  view: ViewPreferences
  save({ patch }: { patch: unknown }): Promise<boolean>
}

function TextSize({
  id,
  label,
  view,
  save,
}: Saving & {
  id: 'fontSize' | 'chatFontSize' | 'codeFontSize'
  label: string
}) {
  return (
    <NumberField
      label={label}
      value={view[id]}
      min={VIEW_SIZE_LIMITS[id].min}
      max={VIEW_SIZE_LIMITS[id].max}
      step={1}
      slider={{
        max: VIEW_SIZE_LIMITS[id].max,
        initial: DEFAULT_VIEW[id],
        unit: 'px',
      }}
      onChange={({ value }) => save({ patch: { [id]: value } })}
    />
  )
}

function ColumnWidths({
  state,
  view,
  save,
}: Saving & { state: HydraState }) {
  const columns = columnsFor({ state })

  return (
    <div className="setting-stack">
      {columns.map(column => (
        <div className="setting-labeled" key={column.id}>
          <span>{column.title}</span>
          <NumberField
            label={`${column.title} width`}
            value={view.defaultColumnWidths[column.id] ?? DEFAULT_COLUMN_WIDTH}
            min={VIEW_SIZE_LIMITS.columnWidth.min}
            max={WIDTH_MAX}
            slider={{
              max: WIDTH_SLIDER_MAX,
              initial: DEFAULT_COLUMN_WIDTH,
              unit: 'px',
            }}
            onChange={({ value }) => save({
              patch: { defaultColumnWidths: { [column.id]: value } },
            })}
          />
        </div>
      ))}
    </div>
  )
}

function ResetWidths({
  command,
  notify,
}: {
  command: Command
  notify({ text }: { text: string }): void
}) {
  const reset = async () => {
    try {
      await command({
        name: 'layout',
        args: [
          'reset',
          '--all',
          '--event-id',
          crypto.randomUUID(),
        ],
      })

      return true
    } catch (error) {
      notify({ text: error instanceof Error ? error.message : String(error) })

      return false
    }
  }

  return (
    <InlineConfirm
      label="Reset dragged widths in every Hydra"
      trigger="Reset every Hydra"
      action="Reset widths"
      message="Every Hydra’s columns and chat go back to the widths above."
      disabled={false}
      confirm={reset}
    />
  )
}

export function SettingControl({
  entry,
  state,
  view,
  save,
  command,
  notify,
  upgrade,
  startUpgrade,
}: Saving & {
  entry: CatalogEntry
  state: HydraState
  command: Command
  notify({ text }: { text: string }): void
  upgrade?: UpgradeStatus
  startUpgrade(): void
}): ReactNode {
  const toggle = ({ key }: { key: Toggle }) => (
    <Switch
      quiet
      label={entry.label}
      checked={view[key]}
      onChange={({ value }) => save({ patch: { [key]: value } })}
    />
  )

  switch (entry.id) {
    case 'theme':
      return (
        <Segmented
          label="Theme"
          value={view.theme}
          options={[
            {
              value: 'system',
              label: 'System',
            },
            {
              value: 'light',
              label: 'Light',
            },
            {
              value: 'dark',
              label: 'Dark',
            },
          ]}
          onChange={({ value }) => save({ patch: { theme: value } })}
        />
      )
    case 'fontSize':
    case 'chatFontSize':
    case 'codeFontSize':
      return (
        <TextSize
          id={entry.id}
          label={entry.label}
          view={view}
          save={save}
        />
      )
    case 'defaultColumnWidths':
      return <ColumnWidths state={state} view={view} save={save} />
    case 'defaultHydraWidth':
      return (
        <NumberField
          label={entry.label}
          value={view.defaultHydraWidth}
          min={VIEW_SIZE_LIMITS.hydraWidth.min}
          max={WIDTH_MAX}
          slider={{
            max: WIDTH_SLIDER_MAX,
            initial: DEFAULT_VIEW.defaultHydraWidth,
            unit: 'px',
          }}
          onChange={({ value }) => save({ patch: { defaultHydraWidth: value } })}
        />
      )
    case 'resetWidths':
      return <ResetWidths command={command} notify={notify} />
    case 'lastMessageOnCards':
    case 'focusMode':
    case 'toolDetails':
    case 'thinkingDetails':
      return toggle({ key: entry.id })
    case 'keyboard':
      return <KeyboardSettings embedded prefs={view.keyboard} save={save} />
    case 'version':
      return <About upgrade={upgrade} startUpgrade={startUpgrade} />
    default:
      return null
  }
}

function Empty({ search }: { search({ query }: { query: string }): void }) {
  return (
    <div className="settings-empty" role="status">
      <p>No setting matches.</p>
      <p className="muted">Try {SUGGESTIONS.map((
        word,
        index,
      ) => (
        <span key={word}>
          {index ? ', ' : ''}<Button className="settings-suggestion" onClick={() => search({ query: word })}>{word}</Button>
        </span>
      ))}.
      </p>
    </div>
  )
}

export function SettingsPage({
  state,
  connected,
  view,
  save,
  command,
  notify,
  upgrade,
  startUpgrade,
  initialQuery = '',
}: Saving & {
  state: HydraState
  connected: boolean
  command: Command
  notify({ text }: { text: string }): void
  upgrade?: UpgradeStatus
  startUpgrade(): void
  // The search the page opens with, such as a setting the Oracle sent here.
  initialQuery?: string
}) {
  const search = useRef<HTMLInputElement>(null)
  const [
    query,
    setQuery,
  ] = useState(initialQuery)
  const [
    section,
    setSection,
  ] = useState<SettingsSection>()
  const [
    onlyChanged,
    setOnlyChanged,
  ] = useState(false)
  const changed = changedIds({ view })
  const found = searchSettings({ query })
    .filter(match => !onlyChanged || changed.has(match.entry.id))
  const shown = found.filter(match => !section || match.entry.section === section)
  const counts = Object.fromEntries(SETTINGS_SECTIONS.map(item => [
    item.id,
    found.filter(match => match.entry.section === item.id).length,
  ]))
  const badges: SearchBadge[] = []

  if (section) {
    badges.push({
      id: 'section',
      label: SETTINGS_SECTIONS.find(item => item.id === section)!.label,
      kind: 'section',
    })
  }

  if (onlyChanged) {
    badges.push({
      id: 'changed',
      label: 'Changed',
      kind: 'changed',
    })
  }

  const filtering = query !== '' || badges.length > 0
  const count = filtering ? `${shown.length} of ${SETTINGS_CATALOG.length}` : undefined
  const sections = SETTINGS_SECTIONS
    .filter(item => shown.some(match => match.entry.section === item.id))

  const clearFilters = () => {
    setQuery('')
    setSection(undefined)
    setOnlyChanged(false)
  }

  // While Settings is open, the search action focuses its own search instead of the Oracle's.
  useKeyAction({
    id: 'search',
    handler: () => {
      search.current?.focus()

      return true
    },
  })

  if (!connected) {
    return (
      <section className="settings-page" aria-label="Settings">
        <h1>Settings</h1>
        <p role="status" className="muted">Waiting for connection…</p>
      </section>
    )
  }

  return (
    <section className="settings-page" aria-label="Settings">
      <header className="settings-head">
        <h1 data-settings-heading tabIndex={-1}>Settings</h1>
        <SearchBar
          label="Search settings"
          query={query}
          setQuery={({ query }) => setQuery(query)}
          badges={badges}
          removeBadge={({ id }) => id === 'section' ? setSection(undefined) : setOnlyChanged(false)}
          count={count}
          placeholder="Search settings, values or what they do"
          inputRef={search}
          onKeyDown={({ event }) => {
            if (event.key === 'Escape' && filtering) {
              event.preventDefault()
              clearFilters()
            }
          }}
        />
        <nav className="settings-chips" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map(item => (
            <Button
              key={item.id}
              aria-pressed={section === item.id}
              disabled={!counts[item.id]}
              onClick={() => setSection(current => current === item.id ? undefined : item.id)}
            >
              {item.label}<span className="settings-chip-count">{counts[item.id]}</span>
            </Button>
          ))}
          <Button aria-pressed={onlyChanged} onClick={() => setOnlyChanged(current => !current)}>
            Changed<span className="settings-chip-count">{changed.size}</span>
          </Button>
        </nav>
      </header>
      {sections.map(item => (
        <section key={item.id} className="settings-section" aria-labelledby={`settings-${item.id}`}>
          <div className="settings-section-head">
            <h2 id={`settings-${item.id}`}>{item.label}</h2>
          </div>
          {shown.filter(match => match.entry.section === item.id).map(match => (
            <SettingRow
              key={match.entry.id}
              icon={SETTING_ICONS[match.entry.id] ?? 'settings'}
              label={match.entry.label}
              description={match.entry.description}
              terms={match.terms}
              changed={changed.has(match.entry.id)}
              reset={() => save({
                patch: resetPatch({
                  id: match.entry.id,
                  view,
                }),
              })}
              preview={(
                <SettingPreview
                  entry={match.entry}
                  state={state}
                  view={view}
                  save={save}
                />
              )}
            >
              <SettingControl
                entry={match.entry}
                state={state}
                view={view}
                save={save}
                command={command}
                notify={notify}
                upgrade={upgrade}
                startUpgrade={startUpgrade}
              />
            </SettingRow>
          ))}
        </section>
      ))}
      {!shown.length && (
        <Empty
          search={({ query }) => {
            clearFilters()
            setQuery(query)
          }}
        />
      )}
    </section>
  )
}
