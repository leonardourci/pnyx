import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal, flushSync } from 'react-dom'
import type { HydraState } from '#app/model.ts'
import type { HydraProjectSummary } from '#app/server-hydras.ts'
import type { ViewPreferences } from '#preferences/model.ts'
import type { KeyScope } from '#preferences/keyboard.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import type { Command } from '#web-app/connection.ts'
import { focusElement, useKeyAction, useKeyboard, type ActionContext } from '#web-preferences/keyboard-registry.tsx'
import { SETTINGS_SECTIONS } from '#web-settings/catalog.ts'
import { SETTING_ICONS } from '#web-settings/settings-page.tsx'
import { useSharedSettings } from '#web-settings/shared-settings.ts'
import { composing } from '#web-shared/ime.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { SearchBar, type SearchBadge } from '#web-shared/ui/search-bar.tsx'
import { Highlight } from '#web-shared/ui/setting-row.tsx'
import { relativeTime } from '#web-tasks/brief.ts'
import { columnsFor } from '#web-tasks/view.ts'
import { useFoundCards } from './card-oracle.ts'
import { addBadge, committedQuery, filterMenu, filterOptions, filterToken, FILTER_TYPES, hydraFilter, KIND_FILTERS, queryText, recentOnly, TYPE_LABELS, type Filter } from './filters.ts'
import { movedId, paletteKey, selectedId, type Chosen, type PaletteKey } from './keys.ts'
import { oracleActions, type OracleAction } from './oracle-catalog.ts'
import { FilterPreview, ResultPreview, type SettingProps } from './oracle-preview.tsx'
import { oracleResults, type OracleResult } from './results.ts'

const FOCUSABLE = 'a[href], button, input, textarea, [tabindex]'
const SETTINGS_KIND = KIND_FILTERS.find(filter => filter.values.includes('setting'))!
// The help key opens on the settings and actions that name the keyboard.
const HELP_QUERY = 'keyboard'

interface Pressed {
  key: string
  mod: boolean
}

const contextOf = ({ target }: { target: HTMLElement }): ActionContext => ({
  target,
  scope: (target.closest<HTMLElement>('[data-key-scope]')?.dataset.keyScope as KeyScope | undefined) ?? 'navigation',
})

const resultIcon = ({ result }: { result: OracleResult }) => {
  switch (result.kind) {
    case 'task':
      return 'task'
    case 'conversation':
      return 'comments'
    case 'project':
      return 'project'
    case 'setting':
      return SETTING_ICONS[result.match.entry.id] ?? 'settings'
    case 'panel':
      return result.panel.panel === 'projects' ? 'project' : 'agent'
    case 'action':
      return result.action.run === 'key' ? 'keyboard' : 'plus'
  }
}

function resultMeta({
  result,
  state,
  keys,
  now,
}: {
  result: OracleResult
  state: HydraState
  keys({ id }: { id: string }): string
  now: number
}): string {
  switch (result.kind) {
    case 'task':
      return `${columnsFor({ state }).find(column => column.id === result.card.column)?.title ?? ''} · ${relativeTime({
        at: result.at,
        now,
      })}`
    case 'conversation':
      return result.at ? relativeTime({
        at: result.at,
        now,
      }) : ''
    case 'project':
      return result.summary.path
    case 'setting':
      return SETTINGS_SECTIONS.find(section => section.id === result.match.entry.section)?.label ?? ''
    case 'panel':
      return ''
    case 'action':
      return result.action.run === 'key' ? keys({ id: result.action.key }) : ''
  }
}

// What to type for a filter: > and the last word of its name.
const menuHint = ({ filter }: { filter: Filter }) => {
  const words = filter.label.toLowerCase().split(' ')

  return `>${words.at(-1)}`
}

// A press outside the palette's box lands on its backdrop, which closes it.
const onBackdrop = ({ event }: { event: MouseEvent<HTMLDialogElement> }) => {
  const box = event.currentTarget.getBoundingClientRect()
  const across = event.clientX >= box.left && event.clientX <= box.right
  const inside = across && event.clientY >= box.top && event.clientY <= box.bottom

  return event.target === event.currentTarget && !inside
}

function Option({
  id,
  value,
  selected,
  icon,
  label,
  terms,
  meta,
  pick,
}: {
  id: string
  // The result or filter id, which hover reads.
  value: string
  selected: boolean
  icon: string
  label: string
  terms: string[]
  meta: string
  pick(): void
}) {
  return (
    <div
      id={id}
      role="option"
      className="oracle-option"
      data-value={value}
      aria-selected={selected}
      onMouseDown={event => event.preventDefault()}
      onClick={pick}
    >
      <Icon name={icon} size={15} />
      <span className="oracle-option-label"><Highlight text={label} terms={terms} /></span>
      {meta && <span className="oracle-option-meta">{meta}</span>}
    </div>
  )
}

function Group({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div role="group" aria-label={label}>
      <div className="oracle-caption" aria-hidden="true">{label}</div>
      {children}
    </div>
  )
}

export function Oracle({
  state,
  view,
  command,
  connected,
  hydra,
  projects,
  workspace,
  layer,
  save,
  notify,
  upgrade,
  startUpgrade,
  openTask,
  answerTask,
  openHydra,
  selectProject,
  openSettings,
  createTask,
  createColumn,
  action,
}: {
  state: HydraState
  view: ViewPreferences
  command: Command
  connected: boolean
  hydra: {
    id: string
    name: string
    icon: string
  }
  // The current Hydra's attached projects.
  projects: HydraProjectSummary[]
  workspace: string
  // The page element the palette draws in, so it takes the page's text sizes.
  layer: HTMLElement | null
  save({ patch }: { patch: unknown }): Promise<boolean>
  notify({ text }: { text: string }): void
  upgrade?: UpgradeStatus
  startUpgrade(): void
  openTask({ id }: { id: string }): unknown
  // Opens the task and Hydra's composer, ready to reply about it.
  answerTask({ id }: { id: string }): void
  openHydra(): void
  selectProject({ path }: { path: string }): void
  openSettings({ query }: { query: string }): void
  createTask({ column }: { column: string }): void
  createColumn(): void
  action({
    id,
    context,
  }: {
    id: string
    context: ActionContext
  }): boolean
}) {
  const {
    handlers,
    label: keys,
  } = useKeyboard()
  const shared = useSharedSettings()
  const remember = shared?.oracleRememberFilters === true
  const hydraBadge = hydraFilter({ hydra })
  const [
    open,
    setOpen,
  ] = useState(false)
  const [
    query,
    setQuery,
  ] = useState('')
  const [
    badgeIds,
    setBadgeIds,
  ] = useState(() => [hydraBadge.id])
  const [
    chosen,
    setChosen,
  ] = useState<Chosen>()
  const [
    menuChosen,
    setMenuChosen,
  ] = useState<Chosen>()
  const [
    inPreview,
    setInPreview,
  ] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const preview = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const origin = useRef<ActionContext>({
    scope: 'navigation',
    target: document.body,
  })
  // The last Enter or arrow pressed while the query was still being answered, run once it is.
  const waiting = useRef<Pressed | null>(null)
  // Hover selects only when the pointer moves, so a list changing under a still pointer keeps the keyboard's choice.
  const pointer = useRef<{
    x: number
    y: number
  } | null>(null)
  const listId = useId()

  const columns = columnsFor({ state })
  const options = filterOptions({
    hydra: hydraBadge,
    columns,
    projects,
  })
  // Badges keep only ids, so a renamed column or Hydra shows its new name and a deleted one drops out.
  const badges = badgeIds.flatMap(id => options.filter(option => option.id === id))
  const token = filterToken({ query })
  const text = queryText({ query })
  const terms = text.split(/\s+/).filter(Boolean)
  const found = useFoundCards({
    command,
    query: open ? text : '',
    workspace,
    revision: state.seq,
  })
  const menu = token ? filterMenu({
    token,
    badges,
    options,
  }) : []
  const actions: OracleAction[] = open ? oracleActions({
    columns,
    scope: origin.current.scope,
  }) : []
  const now = Date.now()
  const groups = open ? oracleResults({
    state,
    hits: found.hits,
    projects,
    actions,
    hydra,
    text,
    badges,
    now,
  }) : []
  const results = groups.flatMap(group => group.results)
  const resultKey = JSON.stringify([
    text,
    badgeIds,
  ])
  const selected = selectedId({
    ids: results.map(result => result.id),
    chosen,
    key: resultKey,
  })
  const menuKey = token?.text ?? ''
  const menuSelected = selectedId({
    ids: menu.map(filter => filter.id),
    chosen: menuChosen,
    key: menuKey,
  })
  const current = results.find(result => result.id === selected)
  const menuFilter = menu.find(filter => filter.id === menuSelected)
  const optionId = ({ index }: { index: number }) => `${listId}-${index}`
  const activeIndex = token
    ? menu.findIndex(filter => filter.id === menuSelected)
    : results.findIndex(result => result.id === selected)
  const activeDescendant = activeIndex >= 0 ? optionId({ index: activeIndex }) : undefined
  const recent = recentOnly({
    text,
    badges,
  })
  const settings: SettingProps = {
    view,
    save,
    command,
    notify,
    upgrade,
    startUpgrade,
  }

  const returnFocus = () => {
    const { target } = origin.current

    if (target.isConnected && target !== document.body) {
      target.focus({ preventScroll: true })
    } else {
      focusElement({ selector: '[data-card]' })
    }
  }

  const show = ({
    context,
    ids,
    text: opening,
  }: {
    context: ActionContext
    ids?: string[]
    text?: string
  }) => {
    if (dialog.current?.open) {
      input.current?.focus()

      return true
    }

    origin.current = context
    const reset = !remember || ids !== undefined
    // The palette renders before focusing, so keys typed right after the shortcut reach the input.
    flushSync(() => {
      setOpen(true)

      if (reset) {
        setBadgeIds(ids ?? [hydraBadge.id])
      }

      if (opening !== undefined) {
        setQuery(opening)
      }
    })
    dialog.current?.showModal()
    input.current?.focus(); input.current?.select()

    return true
  }

  const close = ({ restore }: { restore: boolean }) => {
    waiting.current = null
    dialog.current?.close()
    setOpen(false); setInPreview(false)

    if (restore) {
      returnFocus()
    }
  }

  useKeyAction({
    id: 'palette',
    handler: ({ context }) => {
      if (!dialog.current?.open) {
        return show({ context })
      }

      close({ restore: true })

      return true
    },
  })
  useKeyAction({
    id: 'find',
    handler: ({ context }) => show({ context }),
  })
  useKeyAction({
    id: 'search',
    handler: ({ context }) => show({ context }),
  })
  useKeyAction({
    id: 'help',
    handler: ({ context }) => show({
      context,
      ids: [
        hydraBadge.id,
        SETTINGS_KIND.id,
      ],
      text: HELP_QUERY,
    }),
  })

  const runAction = ({ entry }: { entry: OracleAction }) => {
    if (entry.run === 'task') {
      createTask({ column: entry.column })
    } else if (entry.run === 'column') {
      createColumn()
    } else {
      const context = origin.current
      const registered = [...(handlers.get(entry.key) ?? [])].reverse()

      if (!registered.some(run => run({ context }))) {
        action({
          id: entry.key,
          context,
        })
      }
    }
  }

  const previewControls = () => [...preview.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []]
    .filter(element => element.tabIndex >= 0 && !element.hasAttribute('disabled'))

  const focusPreview = () => previewControls()[0]?.focus()

  const chooseSetting = ({
    result,
    elsewhere,
  }: {
    result: Extract<OracleResult, { kind: 'setting' }>
    elsewhere: boolean
  }) => {
    const id = result.match.entry.id as keyof ViewPreferences

    if (elsewhere) {
      close({ restore: false })
      openSettings({ query: result.match.entry.label })
    } else if (typeof view[id] === 'boolean') {
      save({ patch: { [id]: !view[id] } })
    } else {
      focusPreview()
    }
  }

  const choose = ({
    result,
    elsewhere,
  }: {
    result: OracleResult
    elsewhere: boolean
  }) => {
    if (result.kind === 'setting') {
      chooseSetting({
        result,
        elsewhere,
      })

      return
    }

    // A panel has nowhere else to open, so both Enters move into its controls.
    if (result.kind === 'panel') {
      focusPreview()

      return
    }

    close({ restore: true }); setQuery('')

    switch (result.kind) {
      case 'task':
        if (elsewhere) {
          answerTask({ id: result.card.id })
        } else {
          openTask({ id: result.card.id })
        }

        break
      case 'conversation':
        openHydra()
        break
      case 'project':
        selectProject({ path: result.summary.path })
        break
      case 'action':
        runAction({ entry: result.action })
    }
  }

  const commit = ({ filter }: { filter?: Filter }) => {
    if (!filter) {
      return
    }

    setBadgeIds(addBadge({
      badges,
      filter,
    }).map(badge => badge.id))
    setQuery(committedQuery({ query }))
    setMenuChosen(undefined)
  }

  // The filter menu and the results each keep their own choice, for the query they were made for.
  const choice = ({ id }: { id: string }) => {
    if (token) {
      setMenuChosen({
        key: menuKey,
        id,
      })
    } else {
      setChosen({
        key: resultKey,
        id,
      })
    }
  }

  const move = ({ step }: { step: number }) => {
    const id = movedId({
      ids: token ? menu.map(filter => filter.id) : results.map(result => result.id),
      current: token ? menuSelected : selected,
      step,
    })

    if (id) {
      choice({ id })
    }
  }

  const act = ({
    key,
    pressed,
  }: {
    key: PaletteKey
    pressed: Pressed
  }) => {
    switch (key) {
      case 'wait':
        waiting.current = pressed
        break
      case 'up':
      case 'down':
        move({ step: key === 'down' ? 1 : -1 })
        break
      case 'open':
      case 'open-elsewhere':
        if (current) {
          choose({
            result: current,
            elsewhere: key === 'open-elsewhere',
          })
        }

        break
      case 'preview':
        focusPreview()
        break
      case 'commit':
        commit({ filter: menuFilter })
        break
      case 'drop-filter':
        setQuery(committedQuery({ query }))
        break
      case 'clear':
        setQuery('')
        break
      case 'close':
        close({ restore: true })
    }
  }

  const route = ({
    pressed,
    isComposing,
  }: {
    pressed: Pressed & { shift: boolean }
    isComposing: boolean
  }) => paletteKey({
    key: pressed.key,
    shift: pressed.shift,
    mod: pressed.mod,
    composing: isComposing,
    pending: found.pending,
    token: token?.text,
    query,
  })

  useEffect(
    () => {
      const pressed = waiting.current

      if (!pressed || found.pending) {
        return
      }

      waiting.current = null
      const key = route({
        pressed: {
          ...pressed,
          shift: false,
        },
        isComposing: false,
      })

      if (key) {
        act({
          key,
          pressed,
        })
      }
    },
    [found.pending],
  )
  useEffect(
    () => {
      list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' })
    },
    [
      selected,
      menuSelected,
    ],
  )

  const inputKey = ({ event }: { event: KeyboardEvent<HTMLInputElement> }) => {
    const pressed = {
      key: event.key,
      mod: event.metaKey || event.ctrlKey,
      shift: event.shiftKey,
    }
    const key = route({
      pressed,
      isComposing: composing({ event: event.nativeEvent }),
    })

    if (!key) {
      return
    }

    event.preventDefault(); event.stopPropagation()
    act({
      key,
      pressed,
    })
  }

  const hover = ({
    x,
    y,
    target,
  }: {
    x: number
    y: number
    target: EventTarget
  }) => {
    const moved = pointer.current?.x !== x || pointer.current?.y !== y
    pointer.current = {
      x,
      y,
    }
    const value = target instanceof Element ? target.closest<HTMLElement>('[role=option]')?.dataset.value : undefined

    if (moved && value && !inPreview) {
      choice({ id: value })
    }
  }

  // Esc and ⇧Tab from the first control go back to the bar, and a typed character carries on the query there.
  const previewKey = ({ event }: { event: KeyboardEvent<HTMLDivElement> }) => {
    if (event.nativeEvent.defaultPrevented || composing({ event: event.nativeEvent })) {
      return
    }

    const { target } = event
    const backTab = event.key === 'Tab' && event.shiftKey && target === previewControls()[0]
    const field = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey
    const typed = event.key.length === 1 && event.key !== ' ' && plain && !field

    if (event.key !== 'Escape' && !backTab && !typed) {
      return
    }

    event.preventDefault(); event.stopPropagation()

    if (typed) {
      setQuery(value => value + event.key)
    }

    input.current?.focus()
  }

  const searchBadges: SearchBadge[] = badges.map(badge => ({
    id: badge.id,
    label: badge.label,
    kind: badge.type,
    icon: badge.icon,
  }))
  const countLabel = found.pending ? 'Searching…' : `${results.length} ${results.length === 1 ? 'result' : 'results'}`
  const count = token ? 'Filters' : countLabel
  const narrowing = badges.some(badge => badge.type !== 'kind' && badge.type !== 'hydra')
  const widen = narrowing ? ' Remove a badge to widen the search.' : ''
  const nothing = recent ? 'No tasks yet.' : `Nothing matches.${widen}`

  const menuList = FILTER_TYPES.map(type => ({
    type,
    filters: menu.filter(filter => filter.type === type),
  })).filter(group => group.filters.length > 0)
    .map(group => (
      <Group key={group.type} label={TYPE_LABELS[group.type]}>
        {group.filters.map(filter => (
          <Option
            key={filter.id}
            id={optionId({ index: menu.indexOf(filter) })}
            value={filter.id}
            selected={filter.id === menuSelected}
            icon={filter.icon}
            label={filter.label}
            terms={[]}
            meta={menuHint({ filter })}
            pick={() => commit({ filter })}
          />
        ))}
      </Group>
    ))
  const resultList = groups.map(group => (
    <Group key={group.label} label={group.label}>
      {group.results.map(result => (
        <Option
          key={result.id}
          id={optionId({ index: results.indexOf(result) })}
          value={result.id}
          selected={result.id === selected}
          icon={resultIcon({ result })}
          label={result.title}
          terms={terms}
          meta={resultMeta({
            result,
            state,
            keys,
            now,
          })}
          pick={() => choose({
            result,
            elsewhere: false,
          })}
        />
      ))}
    </Group>
  ))
  const emptyMenu = <p className="oracle-empty">No filter matches “{token?.text}” here. Esc drops it.</p>
  const emptyResults = <p className="oracle-empty">{nothing}</p>
  const shownList = token ? menuList : resultList
  // The previous results stay, dimmed, until the new query's answer arrives.
  const dimmed = found.pending && !token
  const empty = token ? emptyMenu : emptyResults

  const palette = (
    <dialog
      ref={dialog}
      className="oracle-palette"
      aria-label="Oracle"
      onClose={() => setOpen(false)}
      onCancel={event => {
        event.preventDefault(); close({ restore: true })
      }}
      onKeyDown={event => {
        if (event.key === 'Escape' && !event.nativeEvent.defaultPrevented && !composing({ event: event.nativeEvent })) {
          event.preventDefault(); event.stopPropagation(); close({ restore: true })
        }
      }}
      onMouseDown={event => {
        if (onBackdrop({ event })) {
          close({ restore: true })
        }
      }}
    >
      <SearchBar
        label="Oracle"
        query={query}
        setQuery={({ query }) => setQuery(query)}
        badges={searchBadges}
        removeBadge={({ id }) => setBadgeIds(ids => ids.filter(item => item !== id))}
        count={open ? count : undefined}
        placeholder="Search tasks, conversations, projects and settings; > filters"
        inputRef={input}
        combobox={{
          expanded: open,
          controls: listId,
          activeDescendant,
        }}
        onKeyDown={inputKey}
      />
      {open && (
        <div className="oracle-body">
          <div
            ref={list}
            id={listId}
            className="oracle-list"
            role="listbox"
            aria-label={token ? 'Filters' : 'Oracle results'}
            data-pending={dimmed || undefined}
            onMouseMove={event => hover({
              x: event.clientX,
              y: event.clientY,
              target: event.target,
            })}
          >
            {shownList.length ? shownList : empty}
          </div>
          <div
            ref={preview}
            className="oracle-preview"
            role="region"
            aria-label="Preview"
            onKeyDown={event => previewKey({ event })}
            onFocus={() => setInPreview(true)}
            onBlur={event => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                setInPreview(false)
              }
            }}
          >
            {token && <FilterPreview filter={menuFilter} badges={badges} />}
            {!token && current && (
              <ResultPreview
                result={current}
                state={state}
                terms={terms}
                doneAfterHours={shared?.doneAfterHours}
                connected={connected}
                settings={settings}
                choose={({ elsewhere }) => choose({
                  result: current,
                  elsewhere,
                })}
              />
            )}
          </div>
        </div>
      )}
    </dialog>
  )

  return (
    <>
      <Button
        className="oracle-trigger"
        aria-label="Oracle"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={event => show({ context: contextOf({ target: event.currentTarget }) })}
      >
        <Icon name="oracle" size={15} />
        <span>Oracle…</span>
        <kbd>{keys({ id: 'palette' })}</kbd>
      </Button>
      {layer && createPortal(
        palette,
        layer,
      )}
    </>
  )
}
