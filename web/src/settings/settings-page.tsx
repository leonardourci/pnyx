import { useRef, useState, type ReactNode } from 'react'
import type { HydraState } from '#app/model.ts'
import type { ViewPreferences } from '#preferences/model.ts'
import { DEFAULT_COLUMN_WIDTH, DEFAULT_VIEW, VIEW_SIZE_LIMITS, viewFor } from '#preferences/view.ts'
import type { Settings } from '#settings/model.ts'
import { DEFAULT_SETTINGS } from '#settings/settings.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import type { AgentConfig } from '#workers/model.ts'
import type { Command } from '#web-app/connection.ts'
import { About } from '#web-app/about.tsx'
import { KeyRows } from '#web-preferences/keyboard-settings.tsx'
import { keyActionsMatching } from '#web-preferences/key-search.ts'
import { Button, NumberField, Switch } from '#web-shared/ui/controls.tsx'
import { InlineConfirm } from '#web-shared/ui/inline-confirm.tsx'
import { SearchBar } from '#web-shared/ui/search-bar.tsx'
import { Segmented } from '#web-shared/ui/segmented.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { SettingRow } from '#web-shared/ui/setting-row.tsx'
import { useSharedSettings } from '#web-settings/shared-settings.ts'
import { useKeyAction } from '#web-preferences/keyboard-registry.tsx'
import { columnsFor } from '#web-tasks/view.ts'
import { useHeadsDispatch } from '#web-workers/heads-dispatch.ts'
import { DispatchSettings } from '#web-workers/dispatch-settings.tsx'
import { AgentPreview, BoardPreview, CardTextPreview, CardUpdatesPreview, ChatTextPreview, CodeTextPreview, ConversationPreview, DonePreview, HelperPreview, ResetPreview, ReviewPreview, ThemePreview } from './previews.tsx'
import { DefaultAgent, DispatchStatus, Help, HideDone, ReviewCadence, RoutineHelper } from './hydra-settings.tsx'
import { changedIds, resetPatch } from './changed.ts'
import { SETTINGS_CATALOG, SETTINGS_SECTIONS, searchSettings, type CatalogEntry } from './catalog.ts'

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
  headsDispatch: 'dispatch',
  keyboard: 'keyboard',
  version: 'about',
  doneAfterHours: 'done',
  reviewMinutes: 'reminder',
  helper: 'helper',
  hydraAgent: 'agent',
}
const UNITS: Record<string, string> = {
  fontSize: 'px',
  chatFontSize: 'px',
  codeFontSize: 'px',
  defaultHydraWidth: 'px',
  doneAfterHours: 'h',
  reviewMinutes: 'min',
}
const PREVIEWED = new Set([
  'theme',
  'fontSize',
  'chatFontSize',
  'codeFontSize',
  'defaultColumnWidths',
  'defaultHydraWidth',
  'resetWidths',
  'lastMessageOnCards',
  'focusMode',
  'toolDetails',
  'thinkingDetails',
  'doneAfterHours',
  'reviewMinutes',
  'helper',
  'hydraAgent',
])
const WIDTH_SLIDER_MAX = 900
const WIDTH_MAX = 2400
const SUGGESTIONS = [
  'width',
  'model',
  'dark',
  'quota',
  'shortcut',
]
const THEMES = [
  {
    value: 'system',
    label: 'System',
    icon: 'theme-system',
  },
  {
    value: 'light',
    label: 'Light',
    icon: 'theme-light',
  },
  {
    value: 'dark',
    label: 'Dark',
    icon: 'theme-dark',
  },
]

type Toggle = 'lastMessageOnCards' | 'focusMode' | 'toolDetails' | 'thinkingDetails'

const CAPTIONS: Record<Toggle, string> = {
  lastMessageOnCards: 'Show',
  focusMode: 'On',
  toolDetails: 'Expanded',
  thinkingDetails: 'Expanded',
}

interface Saving {
  view: ViewPreferences
  save({ patch }: { patch: Record<string, unknown> }): Promise<boolean>
}

interface Hydra {
  settings: Settings
  rule?: AgentConfig
  dispatchError?: string
}

// A slider's value while it moves, keyed by the setting it changes; undefined once it is let go.
type Slide = ({
  key,
  value,
}: {
  key: string
  value?: unknown
}) => void

const resetTo = ({ id }: { id: string }) => {
  const initial: unknown = DEFAULT_SETTINGS[id as keyof Settings]

  if (typeof initial === 'number') {
    return UNITS[id] ? `${initial} ${UNITS[id]}` : String(initial)
  }

  return typeof initial === 'string' ? initial : undefined
}

export function SettingPreview({
  entry,
  state,
  view,
  save,
  settings,
  rule,
}: Saving & Hydra & {
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
    case 'resetWidths':
      return <ResetPreview state={state} view={view} />
    case 'lastMessageOnCards':
      return <CardUpdatesPreview view={view} />
    case 'focusMode':
      return <ConversationPreview view={view} />
    case 'toolDetails':
    case 'thinkingDetails':
      return <ConversationPreview view={view} open />
    case 'doneAfterHours':
      return <DonePreview hours={settings.doneAfterHours} />
    case 'reviewMinutes':
      return <ReviewPreview minutes={settings.reviewMinutes} />
    case 'helper':
      return rule && <HelperPreview helper={settings.helper} hydra={rule} />
    case 'hydraAgent':
      return rule && <AgentPreview agent={rule} />
    default:
      return undefined
  }
}

function TextSize({
  id,
  label,
  view,
  save,
  slide,
}: Saving & {
  id: 'fontSize' | 'chatFontSize' | 'codeFontSize'
  label: string
  slide: Slide
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
      onSlide={({ value }) => slide({
        key: id,
        value,
      })}
    />
  )
}

function ColumnWidths({
  state,
  view,
  save,
  slide,
}: Saving & {
  state: HydraState
  slide: Slide
}) {
  const columns = columnsFor({ state })
  const widthOf = ({ id }: { id: string }) =>
    view.defaultColumnWidths[id] ?? view.defaultColumnWidth
  const slider = {
    max: WIDTH_SLIDER_MAX,
    initial: DEFAULT_COLUMN_WIDTH,
    unit: 'px',
  }

  return (
    <div className="setting-stack">
      <NumberField
        label="Default column width"
        value={view.defaultColumnWidth}
        min={VIEW_SIZE_LIMITS.columnWidth.min}
        max={WIDTH_MAX}
        slider={slider}
        onChange={({ value }) => save({ patch: { defaultColumnWidth: value } })}
        onSlide={({ value }) => slide({
          key: 'defaultColumnWidth',
          value,
        })}
      />
      <details className="setting-more">
        <summary>Per column</summary>
        <div className="setting-per-column">
          {columns.map(column => (
            <div className="setting-labeled" key={column.id}>
              <span>{column.title}</span>
              <NumberField
                label={`${column.title} width`}
                value={widthOf({ id: column.id })}
                min={VIEW_SIZE_LIMITS.columnWidth.min}
                max={WIDTH_MAX}
                slider={slider}
                onChange={({ value }) => save({
                  patch: { defaultColumnWidths: { [column.id]: value } },
                })}
                onSlide={({ value }) => slide({
                  key: 'defaultColumnWidths',
                  value: value === undefined ? undefined : {
                    ...view.defaultColumnWidths,
                    [column.id]: value,
                  },
                })}
              />
            </div>
          ))}
        </div>
      </details>
    </div>
  )
}

const draggedText = ({ state }: { state: HydraState }) => {
  const dragged: string[] = []

  if (state.view?.hydraWidth) {
    dragged.push(`the chat to ${state.view.hydraWidth} px`)
  }

  for (const column of columnsFor({ state })) {
    const width = state.view?.columnWidths?.[column.id]

    if (width !== undefined) {
      dragged.push(`${column.title} to ${width} px`)
    }
  }

  return dragged.length
    ? `In this Hydra you dragged ${dragged.join(' and ')}. Reset returns every pane in every Hydra to the defaults above.`
    : 'Nothing is dragged in this Hydra; every pane sits at its default.'
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
      trigger="Reset widths in every Hydra"
      action="Reset widths"
      message="Every Hydra’s columns and chat go back to the defaults above."
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
  slide,
  command,
  notify,
  upgrade,
  startUpgrade,
  settings,
  rule,
  connected,
  saveHydra,
  dispatchError,
}: Saving & Hydra & {
  entry: CatalogEntry
  state: HydraState
  slide: Slide
  command: Command
  notify({ text }: { text: string }): void
  upgrade?: UpgradeStatus
  startUpgrade(): void
  connected: boolean
  saveHydra({ patch }: { patch: Partial<AgentConfig> }): Promise<unknown>
}): ReactNode {
  if ((entry.id === 'helper' || entry.id === 'hydraAgent') && !rule) {
    return <DispatchStatus error={dispatchError} />
  }

  // Focus mode hides tool calls and thinking, so their own switches wait for it to turn off.
  const hidden = view.focusMode && (entry.id === 'toolDetails' || entry.id === 'thinkingDetails')
  const toggle = ({ key }: { key: Toggle }) => (
    <div className="setting-stack">
      <Switch
        label={entry.label}
        caption={CAPTIONS[key]}
        checked={view[key]}
        disabled={hidden}
        onChange={({ value }) => save({ patch: { [key]: value } })}
      />
      {hidden && <Help text="Focus mode is on, so these stay hidden; turn it off to use this." />}
    </div>
  )
  const slideTo = ({ key }: { key: string }) => ({ value }: { value?: number }) => slide({
    key,
    value,
  })

  switch (entry.id) {
    case 'theme':
      return (
        <Segmented
          label="Theme"
          value={view.theme}
          options={THEMES}
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
          slide={slide}
        />
      )
    case 'defaultColumnWidths':
      return (
        <ColumnWidths
          state={state}
          view={view}
          save={save}
          slide={slide}
        />
      )
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
          onSlide={slideTo({ key: 'defaultHydraWidth' })}
        />
      )
    case 'resetWidths':
      return <ResetWidths command={command} notify={notify} />
    case 'lastMessageOnCards':
    case 'focusMode':
    case 'toolDetails':
    case 'thinkingDetails':
      return toggle({ key: entry.id })
    case 'doneAfterHours':
      return <HideDone hours={settings.doneAfterHours} save={save} slide={slideTo({ key: 'doneAfterHours' })} />
    case 'reviewMinutes':
      return <ReviewCadence minutes={settings.reviewMinutes} save={save} slide={slideTo({ key: 'reviewMinutes' })} />
    case 'helper':
      return (
        rule && (
          <RoutineHelper
            helper={settings.helper}
            hydra={rule}
            command={command}
            connected={connected}
            save={save}
          />
        )
      )
    case 'hydraAgent':
      return (
        rule && (
          <DefaultAgent
            rule={rule}
            command={command}
            connected={connected}
            saveHydra={({ patch }) => saveHydra({ patch })
              .catch((error: Error) => notify({ text: error.message }))}
          />
        )
      )
    case 'headsDispatch':
      return <DispatchSettings state={state} command={command} notify={notify} />
    case 'keyboard':
      return (
        <Switch
          label="Character shortcuts"
          caption="On"
          checked={view.keyboard.characterShortcuts}
          onChange={({ value: characterShortcuts }) => save({
            patch: { keyboard: { characterShortcuts } },
          })}
        />
      )
    case 'version':
      return <About upgrade={upgrade} startUpgrade={startUpgrade} />
    default:
      return null
  }
}

function Empty({
  query,
  search,
  clear,
}: {
  query: string
  search({ query }: { query: string }): void
  clear(): void
}) {
  return (
    <div className="settings-empty" role="status">
      <h3>No setting matches “{query || 'Changed'}”</h3>
      <p>Search looks at names, descriptions, values and related words.</p>
      <div className="settings-chips">
        {SUGGESTIONS.map(word => (
          <Button key={word} className="settings-chip" onClick={() => search({ query: word })}>{word}</Button>
        ))}
      </div>
      <Button variant="surface" onClick={clear}>Clear search</Button>
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
    onlyChanged,
    setOnlyChanged,
  ] = useState(false)
  const [
    live,
    setLive,
  ] = useState<Record<string, unknown>>({})
  const settings = useSharedSettings() ?? DEFAULT_SETTINGS
  const {
    effective,
    saveHydra,
    error: dispatchError,
  } = useHeadsDispatch({ command })
  const rule = effective?.dispatch.rules.hydra?.candidates[0] ?? effective?.dispatch.default[0]
  // Previews draw what a slider shows while it moves, before the value saves.
  const shownView = viewFor({
    state,
    settings: {
      ...view,
      ...settings,
      ...live,
    },
  })
  const shownSettings = {
    ...settings,
    ...live,
  } as Settings
  const changed = changedIds({
    view,
    settings,
  })
  const searching = query.trim() !== ''
  const found = searchSettings({ query })
  const keyboardFound = found.some(match => match.entry.id === 'keyboard')
  const keys = searching && !keyboardFound ? keyActionsMatching({ query }) : []
  const keyboardEntry = SETTINGS_CATALOG.find(entry => entry.id === 'keyboard')!
  const matches = keys.length ? [
    ...found,
    {
      entry: keyboardEntry,
      terms: [],
    },
  ] : found
  const shown = matches.filter(match => !onlyChanged || changed.has(match.entry.id))
  const counts = Object.fromEntries(SETTINGS_SECTIONS.map(item => [
    item.id,
    shown.filter(match => match.entry.section === item.id).length + (item.id === 'keyboard' ? keys.length : 0),
  ]))
  const filtering = searching || onlyChanged
  const total = shown.length + keys.length
  const count = filtering ? `${total} match${total === 1 ? '' : 'es'}` : undefined
  const sections = SETTINGS_SECTIONS
    .filter(item => shown.some(match => match.entry.section === item.id))

  const slide: Slide = ({
    key,
    value,
  }) => setLive(current => {
    const rest = Object.fromEntries(Object.entries(current).filter(([name]) => name !== key))

    return value === undefined ? rest : {
      ...rest,
      [key]: value,
    }
  })

  const clearFilters = () => {
    setQuery('')
    setOnlyChanged(false)
  }

  const goTo = ({ id }: { id: string }) => document.getElementById(`settings-${id}`)?.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
  })

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
        <header className="settings-head"><h1>Settings</h1></header>
        <p role="status" className="muted">Waiting for connection…</p>
      </section>
    )
  }

  return (
    <section className="settings-page" aria-label="Settings">
      <header className="settings-head">
        <h1 data-settings-heading tabIndex={-1}>Settings</h1>
        <p>Apply to every Hydra · changes save as you make them</p>
      </header>
      <div className="settings-search">
        <SearchBar
          label="Search settings"
          query={query}
          setQuery={({ query }) => setQuery(query)}
          count={count}
          hint={query ? undefined : '/'}
          placeholder="Search settings"
          inputRef={search}
          onKeyDown={({ event }) => {
            if (event.key === 'Escape' && filtering) {
              event.preventDefault()
              clearFilters()
            }
          }}
        />
        <nav className="settings-chips" aria-label="Settings sections">
          <Button
            className="settings-chip"
            data-filter
            aria-pressed={onlyChanged}
            onClick={() => setOnlyChanged(current => !current)}
          >
            <Icon name="edit" size={14} />Changed{changed.size > 0 && <span className="settings-chip-count">{changed.size}</span>}
          </Button>
          {SETTINGS_SECTIONS.map(item => (
            <Button
              key={item.id}
              className="settings-chip"
              data-zero={(filtering && !counts[item.id]) || undefined}
              onClick={() => goTo({ id: item.id })}
            >
              <Icon name={item.icon} size={14} />{item.label}
              {filtering && counts[item.id] ? <span className="settings-chip-count">{counts[item.id]}</span> : null}
            </Button>
          ))}
        </nav>
      </div>
      {sections.map(item => (
        <section
          key={item.id}
          id={`settings-${item.id}`}
          className="settings-section"
          aria-labelledby={`settings-${item.id}-title`}
        >
          <h2 id={`settings-${item.id}-title`}>
            <span className="settings-section-icon"><Icon name={item.icon} size={16} /></span>{item.label}
          </h2>
          {'note' in item && <p className="settings-section-note">{item.note}</p>}
          <div className="settings-rows">
            {shown.filter(match => match.entry.section === item.id).map(match => {
              const control = (
                <SettingControl
                  entry={match.entry}
                  state={state}
                  view={view}
                  save={save}
                  slide={slide}
                  command={command}
                  notify={notify}
                  upgrade={upgrade}
                  startUpgrade={startUpgrade}
                  settings={settings}
                  rule={rule}
                  connected={connected}
                  saveHydra={saveHydra}
                  dispatchError={dispatchError}
                />
              )

              // Heads dispatch is a whole editor, so it fills the box instead of sitting in a row.
              if (match.entry.id === 'headsDispatch') {
                return <div key={match.entry.id} className="settings-wide">{control}</div>
              }

              return (
                <SettingRow
                  key={match.entry.id}
                  icon={SETTING_ICONS[match.entry.id] ?? 'settings'}
                  label={match.entry.label}
                  description={match.entry.id === 'resetWidths' ? draggedText({ state }) : match.entry.description}
                  terms={match.terms}
                  changed={changed.has(match.entry.id)}
                  reset={() => save({
                    patch: resetPatch({
                      id: match.entry.id,
                      view,
                      settings,
                    }),
                  })}
                  resetTo={resetTo({ id: match.entry.id })}
                  preview={PREVIEWED.has(match.entry.id) && (
                    <SettingPreview
                      entry={match.entry}
                      state={state}
                      view={shownView}
                      save={save}
                      settings={shownSettings}
                      rule={rule}
                    />
                  )}
                >
                  {control}
                </SettingRow>
              )
            })}
            {item.id === 'keyboard' && (
              <KeyRows prefs={view.keyboard} save={save} query={keyboardFound ? '' : query} />
            )}
          </div>
        </section>
      ))}
      {!sections.length && (
        <Empty
          query={query}
          search={({ query }) => {
            clearFilters()
            setQuery(query)
          }}
          clear={() => {
            clearFilters()
            search.current?.focus()
          }}
        />
      )}
    </section>
  )
}
