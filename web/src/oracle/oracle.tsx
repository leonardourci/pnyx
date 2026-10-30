import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal, flushSync } from 'react-dom'
import type { CurrentAction } from '#hydra/calls.ts'
import type { HydraState } from '#app/model.ts'
import type { HydraProjectSummary } from '#app/server-hydras.ts'
import type { ViewPreferences } from '#preferences/model.ts'
import type { KeyScope } from '#preferences/keyboard.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import { HYDRA_MARK } from '#hydra/hydra-names.ts'
import type { Command, Receipt } from '#web-app/connection.ts'
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
import { askKey, askStart, askTargets, settledSend, type AskKey, type AskTarget } from './ask.ts'
import { arrowFocus, bufferedScroll, controlKind, enterPreview, INPUT, moveFocus, PASS, recoverFocus } from './focus.ts'
import { useFoundCards } from './card-oracle.ts'
import { addBadge, committedQuery, filterMenu, filterOptions, filterToken, hydraFilter, KIND_FILTERS, queryText, TYPE_LABELS, type Filter } from './filters.ts'
import { movedId, paletteKey, selectedId, type Chosen, type PaletteKey } from './keys.ts'
import { ACTION_ICONS, oracleActions, type OracleAction } from './oracle-catalog.ts'
import { AskPreview, FilterPreview, ResultPreview, type SettingProps } from './oracle-preview.tsx'
import { menuActions, oracleResults, type OracleResult } from './results.ts'

const FOCUSABLE = 'a[href], button, input, textarea, [tabindex]'
const SETTINGS_KIND = KIND_FILTERS.find(filter => filter.values.includes('setting'))!
// The help key opens on the settings and actions that name the keyboard.
const HELP_QUERY = 'keyboard'

const ASK_BADGE = 'ask'

interface Asking {
  // The Hydra named with ask:<name>; without one, Enter shows the picker.
  target?: string
  picking: boolean
  picked?: string
  sending: boolean
  error?: string
}

const MENU_LABEL = 'Filters, actions and settings'

const ARROWS = [
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]

interface Pressed {
  key: string
  mod: boolean
  atEnd: boolean
}

const keepInView = ({
  container,
  items,
  focus,
}: {
  container: HTMLElement
  items: HTMLElement[]
  focus: HTMLElement
}) => {
  const box = container.getBoundingClientRect()

  container.scrollTop = bufferedScroll({
    scrollTop: container.scrollTop,
    viewport: container.clientHeight,
    rows: items.map(item => {
      const rect = item.getBoundingClientRect()

      return {
        top: rect.top - box.top + container.scrollTop,
        height: rect.height,
      }
    }),
    index: items.indexOf(focus),
  })
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
      return ACTION_ICONS[result.action.run]
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
      return conversationMeta({
        result,
        now,
      })
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

const conversationMeta = ({
  result,
  now,
}: {
  result: Extract<OracleResult, { kind: 'conversation' }>
  now: number
}) => {
  const when = result.at ? relativeTime({
    at: result.at,
    now,
  }) : ''

  return result.card ? `Task · ${when}` : when
}

const menuHint = ({ filter }: { filter: Filter }) => {
  const words = filter.label.toLowerCase().split(' ')

  return `${TYPE_LABELS[filter.type]} · >${words.at(-1)}`
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
  cardActions,
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
  // Every Hydra a request can go to, by display name.
  hydras: AskTarget[]
  send({
    id,
    text,
  }: {
    id: string
    text: string
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
  const attempt = useRef<{
    text: string
    to: string
  } | null>(null)
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

  const leaveAsk = () => {
    attempt.current = null
    setAsk(null)
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

  // A roving item (tabindex -1) is reached through the one that stands for its group.
  const previewControls = () => [...preview.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []]
    .filter(element => element.tabIndex >= 0 && !element.hasAttribute('disabled') && element.checkVisibility())

  const focusStop = ({ to }: { to: HTMLElement | typeof INPUT }) => {
    if (to === INPUT) {
      focused.current = null
      setInPreview(false)
      input.current?.focus()
    } else {
      to.focus()
    }
  }

  const focusPreview = () => {
    const controls = previewControls()

    enterPreview({
      controls,
      own: controls.filter(control => control.closest('.setting-control')),
    })?.focus()
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
  // A focused control that unmounts or is disabled would leave focus nowhere the keyboard can leave, so it moves on.
  useEffect(
    () => {
      const node = preview.current

      if (!open || !node) {
        return
      }

      const observer = new MutationObserver(() => {
        const last = focused.current

        if (!last) {
          return
        }

        const controls = previewControls()
        const active = document.activeElement

        if (controls.includes(last.control)) {
          last.before = controls

          return
        }

        if (active instanceof HTMLElement && active !== last.control && controls.includes(active)) {
          focused.current = {
            control: active,
            before: controls,
          }

          return
        }

        focusStop({
          to: recoverFocus({
            before: last.before,
            controls,
            lost: last.control,
          }),
        })
      })
      observer.observe(
        node,
        {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: [
            'disabled',
            'tabindex',
            'hidden',
            'class',
            'style',
          ],
        },
      )

      return () => observer.disconnect()
    },
    [open],
  )
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

  const sendAsk = async ({
    to,
    opening,
  }: {
    to?: AskTarget
    opening: boolean
  }) => {
    const text = query.trim()

    if (!ask || !to || ask.sending || !text) {
      return
    }

    const sending = {
      text,
      to: to.id,
    }
    attempt.current = sending
    setAsk({
      ...ask,
      sending: true,
      error: undefined,
    })

    let problem: string | undefined

    try {
      const receipt = await send({
        id: to.id,
        text,
      })

      if (receipt.state !== 'queued') {
        problem = typeof receipt.detail === 'string' ? receipt.detail : `${to.name} did not take the request.`
      }
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error)
    }

    const sent = problem === undefined
    const outcome = settledSend({
      current: attempt.current === sending,
      sent,
      opening,
    })

    switch (outcome) {
      case 'notify':
        notify({ text: sent ? `Sent to ${to.name}` : `Ask ${to.name}: ${problem}` })
        break
      case 'show-error':
        setAsk(value => value && {
          ...value,
          sending: false,
          error: problem,
        })
        break
      case 'close':
      case 'open-chat':
        setAsk(null); setQuery('')
        close({ restore: outcome === 'close' })
        notify({ text: `Sent to ${to.name}` })

        if (outcome === 'open-chat') {
          openChat({ id: to.id })
        }
    }
  }

  const askAct = ({ key }: { key: AskKey }) => {
    if (!ask) {
      return
    }

    switch (key) {
      case 'leave':
        leaveAsk()
        break
      case 'back':
        setAsk({
          ...ask,
          picking: false,
        })
        break
      case 'pick':
        setAsk({
          ...ask,
          picking: true,
          picked: undefined,
        })
        break
      case 'up':
      case 'down':
        stepped.current = true
        setAsk({
          ...ask,
          picked: movedId({
            ids: targetIds,
            current: pickedId,
            step: key === 'down' ? 1 : -1,
          }),
        })
        break
      case 'send':
      case 'send-open':
        sendAsk({
          to: ask.picking ? pickedTarget : askTarget,
          opening: key === 'send-open',
        })
    }
  }

  const askInput = ({ event }: { event: KeyboardEvent<HTMLInputElement> }) => {
    const key = askKey({
      key: event.key,
      mod: event.metaKey || event.ctrlKey,
      composing: composing({ event: event.nativeEvent }),
      picking: ask?.picking === true,
      targeted: !!askTarget,
      request: query,
    })

    if (!key) {
      return
    }

    event.preventDefault(); event.stopPropagation()
    askAct({ key })
  }

  const type = ({ typed }: { typed: string }) => {
    // The request is on its way, so its text stays as sent.
    if (ask?.sending) {
      return
    }

    const start = ask ? null : askStart({
      query: typed,
      hydras: targets,
    })

    if (start) {
      setAsk({
        target: start.target?.id,
        picking: false,
        sending: false,
      })
      setQuery(start.request)

      return
    }

    if (ask?.error) {
      setAsk({
        ...ask,
        error: undefined,
      })
    }

    setQuery(typed)
  }

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
  const cycleFocus = ({ event }: { event: KeyboardEvent<HTMLDialogElement> }) => {
    const controls = previewControls()
    const control = controls.find(item => item === event.target)

    event.preventDefault(); event.stopPropagation()
    focusStop({
      to: moveFocus({
        controls,
        from: control ?? INPUT,
        move: event.shiftKey ? 'previous' : 'next',
      }),
    })
  }

  // Runs before the control's own keys, so a closed Select or a radio group doesn't take ↑ ↓ for itself.
  const previewArrow = ({ event }: { event: KeyboardEvent<HTMLDivElement> }) => {
    const { target } = event
    const modified = event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
    const typing = composing({ event: event.nativeEvent })
    const plainArrow = ARROWS.includes(event.key) && !modified && !typing

    if (!plainArrow || !(target instanceof HTMLElement)) {
      return
    }

    const to = arrowFocus({
      controls: previewControls(),
      from: target,
      key: event.key,
      kind: controlKind({
        tag: target.tagName,
        type: target instanceof HTMLInputElement ? target.type : undefined,
        role: target.getAttribute('role'),
        expanded: target.getAttribute('aria-expanded') === 'true',
        popup: ![
          null,
          'false',
        ].includes(target.getAttribute('aria-haspopup')),
      }),
    })

    if (to === PASS) {
      return
    }

    event.preventDefault(); event.stopPropagation()

    if (to !== target) {
      focusStop({ to })
    }
  }

  // A control that closed its own popup on this Esc already kept the key, so only the next Esc returns.
  const previewKey = ({ event }: { event: KeyboardEvent<HTMLDivElement> }) => {
    if (composing({ event: event.nativeEvent })) {
      return
    }

    const { target } = event
    const field = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey
    const typed = event.key.length === 1 && event.key !== ' ' && plain && !field && !event.nativeEvent.defaultPrevented

    if (event.key !== 'Escape' && !typed) {
      return
    }

    event.preventDefault(); event.stopPropagation()

    if (typed) {
      setQuery(value => value + event.key)
    }

    focusStop({
      to: moveFocus({
        controls: previewControls(),
        from: INPUT,
        move: 'escape',
      }),
    })
  }

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
  const countLabel = found.pending ? 'Searching…' : `${results.length} ${results.length === 1 ? 'result' : 'results'}`
  const searchCount = token ? MENU_LABEL : countLabel
  const count = ask ? 'Ask' : searchCount
  const narrowing = badges.some(badge => badge.type !== 'kind' && badge.type !== 'hydra')
  const widen = narrowing ? ' Remove a badge to widen the search.' : ''
  const nothing = `Nothing matches.${widen}`

  const resultOption = ({
    result,
    index,
    picked,
  }: {
    result: OracleResult
    index: number
    picked: boolean
  }) => (
    <Option
      key={result.id}
      id={optionId({ index })}
      value={result.id}
      selected={picked}
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
  )
  const filterGroup = menu.length > 0 && (
    <Group key="filters" label="Filters">
      {menu.map((
        filter,
        index,
      ) => (
        <Option
          key={filter.id}
          id={optionId({ index })}
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
  )
  const actionGroup = typedActions.length > 0 && (
    <Group key="actions" label="Actions and settings">
      {typedActions.map((
        result,
        index,
      ) => resultOption({
        result,
        index: menu.length + index,
        picked: result.id === menuSelected,
      }))}
    </Group>
  )
  const menuList = [
    filterGroup,
    actionGroup,
  ].filter(group => group !== false)
  const resultList = groups.map(group => (
    <Group key={group.label} label={group.label}>
      {group.results.map(result => resultOption({
        result,
        index: results.indexOf(result),
        picked: result.id === selected,
      }))}
    </Group>
  ))
  const emptyMenu = <p className="oracle-empty">Nothing matches “{token?.text}” here. Esc drops it.</p>
  const emptyResults = <p className="oracle-empty">{nothing}</p>
  const askRow = (
    <Group label="Request">
      <Option
        id={optionId({ index: 0 })}
        value={ASK_BADGE}
        selected
        icon={askTarget?.icon ?? HYDRA_MARK}
        label={askTarget ? `Send to ${askTarget.name}` : 'Send to which Hydra?'}
        terms={[]}
        meta={askTarget ? `↵ sends · ${mod}↵ and opens its chat` : '↵ picks the Hydra'}
        pick={() => askAct({ key: askTarget ? 'send' : 'pick' })}
      />
    </Group>
  )
  const pickList = (
    <Group label="Send to which Hydra?">
      {targets.map((
        target,
        index,
      ) => (
        <Option
          key={target.id}
          id={optionId({ index })}
          value={target.id}
          selected={target.id === pickedId}
          icon={target.icon}
          label={target.name}
          terms={[]}
          meta={target.id === hydra.id ? 'this Hydra' : ''}
          pick={() => sendAsk({
            to: target,
            opening: false,
          })}
        />
      ))}
    </Group>
  )
  const askList = ask?.picking ? pickList : askRow
  const searchList = token ? menuList : resultList
  const shownList = ask ? [askList] : searchList
  // The previous results stay, dimmed, until the new query's answer arrives.
  const dimmed = found.pending && !token && !ask
  const empty = token ? emptyMenu : emptyResults
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
