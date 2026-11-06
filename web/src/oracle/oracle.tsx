import type { HydraState } from '#app/model.ts'
import type { HydraProjectSummary } from '#app/server-hydras.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import { HYDRA_MARK } from '#hydra/hydra-names.ts'
import type { ViewPreferences } from '#preferences/model.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import type { Command,Receipt } from '#web-app/connection.ts'
import { focusElement,keyScopeOf,useKeyAction,useKeyboard,type ActionContext } from '#web-preferences/keyboard-registry.tsx'
import { useSharedSettings } from '#web-settings/shared-settings.ts'
import { composing } from '#web-shared/ime.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { SearchBar,type SearchBadge } from '#web-shared/ui/search-bar.tsx'
import { columnsFor } from '#web-tasks/view.ts'
import { useEffect,useId,useRef,useState,type KeyboardEvent,type MouseEvent } from 'react'
import { createPortal,flushSync } from 'react-dom'
import { ASK_BADGE,useAskMode,type Asking } from './ask-mode.ts'
import { askTargets,type AskAttempt,type AskTarget } from './ask.ts'
import { useFoundCards } from './card-oracle.ts'
import { addBadge,committedQuery,filterMenu,filterOptions,filterToken,hydraFilter,queryText,SETTINGS_FILTER,type Filter } from './filters.ts'
import { keepInView,usePreviewFocus } from './focus.ts'
import { movedId,paletteKey,selectedId,type Chosen,type PaletteKey } from './keys.ts'
import { oracleActions,type OracleAction } from './oracle-catalog.ts'
import { AskPreview,FilterPreview,ResultPreview,type SettingProps } from './oracle-preview.tsx'
import { oracleResultList } from './result-list.tsx'
import { countLabel,menuActions,oracleResults,type OracleResult } from './results.ts'

// The help key opens on the settings and actions that name the keyboard.
const HELP_QUERY = 'keyboard'

const MENU_LABEL = 'Filters, actions and settings'

interface Pressed {
  key: string
  mod: boolean
  atEnd: boolean
}

const contextOf = ({ target }: { target: HTMLElement }): ActionContext => ({
  target,
  scope: keyScopeOf({ target }),
})

const onBackdrop = ({ event }: { event: MouseEvent<HTMLDialogElement> }) => {
  const box = event.currentTarget.getBoundingClientRect()
  const across = event.clientX >= box.left && event.clientX <= box.right
  const inside = across && event.clientY >= box.top && event.clientY <= box.bottom

  return event.target === event.currentTarget && !inside
}

export function Oracle({
  state,
  cardActions,
  view,
  command,
  connected,
  hydra,
  projects,
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
  hydras,
  send,
  openChat,
}: {
  state: HydraState
  cardActions: Record<string, CurrentAction>
  view: ViewPreferences
  command: Command
  connected: boolean
  hydra: {
    id: string
    name: string
    icon: string
  }
  projects: HydraProjectSummary[]
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
  // Every Hydra a request can go to, by display name.
  hydras: AskTarget[]
  send({
    id,
    text,
    event,
    onChecking,
  }: {
    id: string
    text: string
    event: string
    onChecking(): void
  }): Promise<Receipt>
  openChat({ id }: { id: string }): void
}) {
  const {
    handlers,
    label: keys,
    platform,
  } = useKeyboard()
  const mod = platform === 'mac' ? '⌘' : 'Ctrl+'
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
  const [
    ask,
    setAsk,
  ] = useState<Asking | null>(null)
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
  // The request being sent or last refused; opening, closing or leaving Ask mode drops it.
  const attempt = useRef<AskAttempt | null>(null)
  // Hover selects only when the pointer moves, so a list changing under a still pointer keeps the keyboard's choice.
  const pointer = useRef<{
    x: number
    y: number
  } | null>(null)
  // The preview control with focus and the controls around it then, so focus can move on if that control goes away.
  const focused = useRef<{
    control: HTMLElement
    before: HTMLElement[]
  } | null>(null)
  // The selection last moved by a key, so the list keeps its scroll buffer then and not on hover.
  const stepped = useRef(false)
  const listId = useId()

  const columns = columnsFor({ state })
  const options = filterOptions({
    hydra: hydraBadge,
    columns,
    projects,
  })
  // Badges keep only ids, so a renamed column or Hydra shows its new name and a deleted one drops out.
  const badges = badgeIds.flatMap(id => options.filter(option => option.id === id))
  // A request is not a search, so Ask mode reads no filters and sends no query.
  const token = ask ? null : filterToken({ query })
  const text = ask ? '' : queryText({ query })
  const terms = text.split(/\s+/).filter(Boolean)
  const found = useFoundCards({
    command,
    query: open ? text : '',
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
  const typedActions = open ? menuActions({
    token,
    text,
    actions,
    state,
    hydra,
  }) : []
  const groups = open && !ask ? oracleResults({
    state,
    hits: found.hits,
    projects,
    actions,
    cardActions,
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
  const menuIds = [
    ...menu.map(filter => filter.id),
    ...typedActions.map(result => result.id),
  ]
  const menuSelected = selectedId({
    ids: menuIds,
    chosen: menuChosen,
    key: menuKey,
  })
  const current = results.find(result => result.id === selected)
  const menuFilter = menu.find(filter => filter.id === menuSelected)
  const menuAction = typedActions.find(result => result.id === menuSelected)
  const optionId = ({ index }: { index: number }) => `${listId}-${index}`
  const targets = askTargets({
    hydras,
    current: hydra,
  })
  const targetIds = targets.map(target => target.id)
  const askTarget = targets.find(target => target.id === ask?.target)
  const pickedId = targetIds.find(id => id === ask?.picked) ?? targetIds[0]
  const pickedTarget = targets.find(target => target.id === pickedId)
  const resultIndex = token
    ? menuIds.findIndex(id => id === menuSelected)
    : results.findIndex(result => result.id === selected)
  const askIndex = ask?.picking ? targetIds.findIndex(id => id === pickedId) : 0
  const activeIndex = ask ? askIndex : resultIndex
  const activeDescendant = activeIndex >= 0 ? optionId({ index: activeIndex }) : undefined
  // While a filter is half-typed, the menu's selection stands in for the results list's.
  const shownResult = token ? menuAction : current
  const settings: SettingProps = {
    view,
    connected,
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
    attempt.current = null
    const reset = !remember || ids !== undefined
    // The palette renders before focusing, so keys typed right after the shortcut reach the input.
    flushSync(() => {
      setOpen(true)
      setAsk(null)

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
    const shown = dialog.current?.open === true
    waiting.current = null
    attempt.current = null
    dialog.current?.close()
    setOpen(false); setInPreview(false)

    if (restore && shown) {
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
    id: 'search',
    handler: ({ context }) => show({ context }),
  })
  useKeyAction({
    id: 'help',
    handler: ({ context }) => show({
      context,
      ids: [
        hydraBadge.id,
        SETTINGS_FILTER.id,
      ],
      text: HELP_QUERY,
    }),
  })

  const runAction = ({ entry }: { entry: OracleAction }) => {
    if (entry.run === 'task') {
      createTask({ column: entry.column })
    } else if (entry.run === 'column') {
      createColumn()
    } else if (entry.run === 'key') {
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

    // Ask is a mode of the bar, so the palette stays open for the request.
    if (result.kind === 'action' && result.action.run === 'ask') {
      setAsk({
        picking: false,
        sending: false,
      })
      setQuery('')
      input.current?.focus()

      return
    }

    close({ restore: true }); setQuery('')

    const openCard = ({ id }: { id: string }) => {
      if (elsewhere) {
        answerTask({ id })
      } else {
        openTask({ id })
      }
    }

    switch (result.kind) {
      case 'task':
        openCard({ id: result.card.id })
        break
      case 'conversation':
        if (result.card) {
          openCard({ id: result.card.id })
        } else {
          openHydra()
        }

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
    if (ask?.picking) {
      setAsk({
        ...ask,
        picked: id,
      })
    } else if (ask) {
      return
    } else if (token) {
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
    const current = token ? menuSelected : selected
    const id = movedId({
      ids: token ? menuIds : results.map(result => result.id),
      current,
      step,
    })

    if (id && id !== current) {
      stepped.current = true
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
        if (shownResult) {
          choose({
            result: shownResult,
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
    atEnd: pressed.atEnd,
    onAction: !!menuAction,
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
  const {
    previewControls,
    focusPreview,
    cycleFocus,
    previewArrow,
    previewKey,
  } = usePreviewFocus({
    preview,
    input,
    focused,
    setInPreview,
    setQuery,
    open,
  })
  useEffect(
    () => {
      const node = list.current
      const row = node?.querySelector<HTMLElement>('[aria-selected=true]')

      if (!node || !row) {
        return
      }

      if (stepped.current) {
        stepped.current = false
        keepInView({
          container: node,
          items: [...node.querySelectorAll<HTMLElement>('[role=option]')],
          focus: row,
        })
      } else {
        row.scrollIntoView({ block: 'nearest' })
      }
    },
    [
      selected,
      menuSelected,
      pickedId,
    ],
  )

  const {
    leaveAsk,
    sendAsk,
    askAct,
    askInput,
    type,
  } = useAskMode({
    ask,
    setAsk,
    attempt,
    query,
    setQuery,
    targets,
    stepped,
    send,
    notify,
    close,
    openChat,
  })

  const removeBadge = ({ id }: { id: string }) => {
    if (id === ASK_BADGE) {
      leaveAsk()
    } else {
      setBadgeIds(ids => ids.filter(item => item !== id))
    }

    input.current?.focus()
  }

  const inputKey = ({ event }: { event: KeyboardEvent<HTMLInputElement> }) => {
    if (ask) {
      askInput({ event })

      return
    }

    const field = event.currentTarget
    const end = field.value.length
    const pressed = {
      key: event.key,
      mod: event.metaKey || event.ctrlKey,
      shift: event.shiftKey,
      atEnd: field.selectionStart === end && field.selectionEnd === end,
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

  // Tab and ⇧Tab always follow the palette's own order, so the browser never picks a stop outside it.
  const searchBadges: SearchBadge[] = badges.map(badge => ({
    id: badge.id,
    label: badge.label,
    kind: badge.type,
    icon: badge.icon,
  }))
  const askBadges: SearchBadge[] = [
    {
      id: ASK_BADGE,
      label: askTarget ? `Ask ${askTarget.name}` : 'Ask',
      kind: 'ask',
      icon: askTarget?.icon ?? HYDRA_MARK,
    },
  ]
  const shownBadges = ask ? askBadges : searchBadges
  const resultCount = countLabel({
    pending: found.pending,
    failed: found.failed,
    count: results.length,
  })
  const searchCount = token ? MENU_LABEL : resultCount
  const count = ask ? 'Ask' : searchCount
  const narrowing = badges.some(badge => badge.type !== 'kind' && badge.type !== 'hydra')
  const widen = narrowing ? ' Remove a badge to widen the search.' : ''
  const nothing = `Nothing matches.${widen}`

  const shownList = oracleResultList({
    terms,
    state,
    keys,
    now,
    choose,
    commit,
    optionId,
    menu,
    menuSelected,
    typedActions,
    groups,
    results,
    selected,
    token,
    ask,
    askTarget,
    mod,
    askAct,
    targets,
    pickedId,
    hydra,
    sendAsk,
  })
  // The previous results stay, dimmed, until the new query's answer arrives.
  const dimmed = found.pending && !token && !ask
  const empty = token ? <p className="oracle-empty">Nothing matches “{token.text}” here. Esc drops it.</p> : <p className="oracle-empty">{nothing}</p>
  const listLabel = token ? MENU_LABEL : 'Oracle results'
  const searchPlaceholder = 'Search tasks, conversations, projects and settings; > filters; ask to ask a Hydra'

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
        if (event.key === 'Tab' && !composing({ event: event.nativeEvent })) {
          cycleFocus({ event })
        } else if (event.key === 'Escape' && !event.nativeEvent.defaultPrevented && !composing({ event: event.nativeEvent })) {
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
        setQuery={({ query }) => type({ typed: query })}
        badges={shownBadges}
        removeBadge={removeBadge}
        count={open ? count : undefined}
        placeholder={ask ? 'Type what you want to ask' : searchPlaceholder}
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
            aria-label={ask ? 'Ask' : listLabel}
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
            onKeyDownCapture={event => previewArrow({ event })}
            onKeyDown={event => previewKey({ event })}
            onFocus={event => {
              const controls = previewControls()
              setInPreview(true)
              focused.current = {
                control: event.target,
                before: controls,
              }

              if (event.target.matches(':focus-visible')) {
                keepInView({
                  container: event.currentTarget,
                  items: controls,
                  focus: event.target,
                })
              }
            }}
            onBlur={event => {
              // Removing the focused control blurs with no new target; the observer moves focus on then.
              if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
                focused.current = null
                setInPreview(false)
              }
            }}
          >
            {ask && (
              <AskPreview
                to={ask.picking ? pickedTarget : askTarget}
                request={query}
                picking={ask.picking}
                sending={ask.sending}
                checking={ask.checking === true}
                error={ask.error}
              />
            )}
            {token && !menuAction && <FilterPreview filter={menuFilter} badges={badges} />}
            {!ask && shownResult && (
              <ResultPreview
                result={shownResult}
                state={state}
                cardActions={cardActions}
                terms={terms}
                doneAfterHours={shared?.doneAfterHours}
                connected={connected}
                settings={settings}
                choose={({ elsewhere }) => choose({
                  result: shownResult,
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
