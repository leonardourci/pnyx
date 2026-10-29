import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { HydraState } from '#app/model.ts'
import type { ViewPreferences } from '#preferences/model.ts'
import { DEFAULT_COLUMN_WIDTH, DEFAULT_VIEW, VIEW_SIZE_LIMITS } from '#preferences/view.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import { DEFAULT_SETTINGS } from '#settings/settings.ts'
import type { Command } from '#web-app/connection.ts'
import { About } from '#web-app/about.tsx'
import { KeyboardSettings } from '#web-preferences/keyboard-settings.tsx'
import { Button, Switch } from '#web-shared/ui/controls.tsx'
import { InlineConfirm } from '#web-shared/ui/inline-confirm.tsx'
import { SearchBar, type SearchBadge } from '#web-shared/ui/search-bar.tsx'
import { Segmented } from '#web-shared/ui/segmented.tsx'
import { SettingRow } from '#web-shared/ui/setting-row.tsx'
import { SliderField } from '#web-shared/ui/slider-field.tsx'
import { columnsFor } from '#web-tasks/view.ts'
import { AskHydra } from './ask-hydra.tsx'
import { SETTINGS_CATALOG, SETTINGS_SECTIONS, searchSettings, type CatalogEntry, type SettingsSection } from './catalog.ts'

const ICONS: Record<string, string> = {
  theme: 'image',
  fontSize: 'file',
  chatFontSize: 'comment',
  codeFontSize: 'terminal',
  defaultColumnWidths: 'task-card',
  defaultHydraWidth: 'comments',
  resetWidths: 'clone',
  lastMessageOnCards: 'summary',
  focusMode: 'review',
  toolDetails: 'tool',
  thinkingDetails: 'thinking',
  keyboard: 'terminal',
  version: 'version',
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

interface Saving {
  view: ViewPreferences
  save({ patch }: { patch: unknown }): Promise<boolean>
}

const differs = ({
  value,
  initial,
}: {
  value: unknown
  initial: unknown
}) => JSON.stringify(value) !== JSON.stringify(initial)

const initialOf = ({ id }: { id: string }) => DEFAULT_SETTINGS[id as keyof typeof DEFAULT_SETTINGS]

// A catalog entry that names a shared setting differs from its default; actions never do. Column widths
// count as changed once any column differs, since the map also holds columns the default does not name.
function changedIds({ view }: { view: ViewPreferences }): Set<string> {
  const ids = new Set(Object.keys(DEFAULT_SETTINGS).filter(key => key !== 'defaultColumnWidths' && key in view && differs({
    value: view[key as keyof ViewPreferences],
    initial: initialOf({ id: key }),
  })))

  if (Object.values(view.defaultColumnWidths).some(width => width !== DEFAULT_COLUMN_WIDTH)) {
    ids.add('defaultColumnWidths')
  }

  return ids
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
    <SliderField
      label={label}
      value={view[id]}
      min={VIEW_SIZE_LIMITS[id].min}
      max={VIEW_SIZE_LIMITS[id].max}
      unit="px"
      initial={DEFAULT_VIEW[id]}
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
          <SliderField
            label={`${column.title} width`}
            value={view.defaultColumnWidths[column.id] ?? DEFAULT_COLUMN_WIDTH}
            min={VIEW_SIZE_LIMITS.hydraWidth.min}
            max={WIDTH_MAX}
            sliderMax={WIDTH_SLIDER_MAX}
            step={8}
            unit="px"
            initial={DEFAULT_COLUMN_WIDTH}
            onChange={({ value }) => save({
              patch: { defaultColumnWidths: { [column.id]: value } },
            })}
          />
        </div>
      ))}
    </div>
  )
}

function ResetWidths({ command }: { command: Command }) {
  return (
    <InlineConfirm
      label="Reset every Hydra"
      action="Reset widths"
      message="Every Hydra’s columns and chat go back to the widths above."
      disabled={false}
      confirm={async () => {
        await command({
          name: 'layout',
          args: [
            'reset',
            '--all',
          ],
        })

        return true
      }}
    />
  )
}

function Control({
  entry,
  state,
  view,
  save,
  command,
  upgrade,
  startUpgrade,
}: Saving & {
  entry: CatalogEntry
  state: HydraState
  command: Command
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
        <SliderField
          label={entry.label}
          value={view.defaultHydraWidth}
          min={VIEW_SIZE_LIMITS.hydraWidth.min}
          max={WIDTH_MAX}
          sliderMax={WIDTH_SLIDER_MAX}
          step={8}
          unit="px"
          initial={DEFAULT_VIEW.defaultHydraWidth}
          onChange={({ value }) => save({ patch: { defaultHydraWidth: value } })}
        />
      )
    case 'resetWidths':
      return <ResetWidths command={command} />
    case 'lastMessageOnCards':
    case 'focusMode':
    case 'toolDetails':
    case 'thinkingDetails':
      return toggle({ key: entry.id })
    case 'keyboard':
      return <KeyboardSettings prefs={view.keyboard} save={save} />
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
  view,
  save,
  command,
  notify,
  upgrade,
  startUpgrade,
}: Saving & {
  state: HydraState
  command: Command
  notify({ text }: { text: string }): void
  upgrade?: UpgradeStatus
  startUpgrade(): void
}) {
  const search = useRef<HTMLInputElement>(null)
  const ask = useRef<HTMLTextAreaElement>(null)
  const [
    query,
    setQuery,
  ] = useState('')
  const [
    section,
    setSection,
  ] = useState<SettingsSection>()
  const [
    onlyChanged,
    setOnlyChanged,
  ] = useState(false)
  const [
    context,
    setContext,
  ] = useState('Settings')
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

  const askAbout = ({ label }: { label: string }) => {
    setContext(`Settings › ${label}`)
    ask.current?.focus()
  }

  useEffect(
    () => {
      const slash = (event: KeyboardEvent) => {
        const typing = event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable=true]')

        if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) {
          event.preventDefault()
          search.current?.focus()
        }
      }

      window.addEventListener(
        'keydown',
        slash,
      )

      return () => window.removeEventListener(
        'keydown',
        slash,
      )
    },
    [],
  )

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
              setQuery('')
              setSection(undefined)
              setOnlyChanged(false)
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
            <Button onClick={() => askAbout({ label: item.label })}>Ask Hydra</Button>
          </div>
          {shown.filter(match => match.entry.section === item.id).map(match => (
            <SettingRow
              key={match.entry.id}
              id={match.entry.id}
              icon={ICONS[match.entry.id] ?? 'settings'}
              label={match.entry.label}
              description={match.entry.description}
              terms={match.terms}
              changed={changed.has(match.entry.id)}
              reset={() => save({ patch: { [match.entry.id]: initialOf({ id: match.entry.id }) } })}
            >
              <Control
                entry={match.entry}
                state={state}
                view={view}
                save={save}
                command={command}
                upgrade={upgrade}
                startUpgrade={startUpgrade}
              />
            </SettingRow>
          ))}
        </section>
      ))}
      {!shown.length && <Empty search={({ query }) => setQuery(query)} />}
      <AskHydra
        command={command}
        notify={notify}
        context={context}
        clearContext={() => setContext('Settings')}
        inputRef={ask}
      />
    </section>
  )
}
