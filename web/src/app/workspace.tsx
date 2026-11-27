import { runtimeStyle } from '#web-shared/ui/runtime-style.ts'
import { useSessionView, sessionViewKey } from './session-view.ts'
import { useWorkspaceViewport } from './workspace-viewport.tsx'
import { afterTaskLayout, afterSteadyLayout } from '#web-tasks/scroll-task.ts'
import { WORKSPACE_SIZING, phoneLayout } from '#web-shared/card-sizing.ts'
import { ProjectTasks } from '#web-tasks/project-tasks.tsx'
import { ProfileSurface } from './profile-surface.tsx'
import { timeUIFlow } from './ui-metrics.ts'
import { FoldContent } from '#web-shared/ui/fold-content.tsx'
import { StatusNotice, StatusMessage, ErrorBanner } from '#web-shared/ui/status-message.tsx'
import { projectTitle } from '#web-projects/view.ts'
import { IconButton } from '#web-shared/ui/icon-button.tsx'
import { createPortal } from 'react-dom'
import { TITAN_MARK, pickName } from '#titan/titan-names.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { taskMention } from '#titan/mentions.ts'
import { viewFor } from '#preferences/view.ts'
import { pickView } from '#settings/settings.ts'
import type { Card } from '#tasks/model.ts'
import { UPGRADE_COMMAND } from '#upgrade/model.ts'
import { useChatDrafts } from '#web-titan/chat-drafts.ts'
import { TitanComposerSources } from '#web-titan/composer-sources.tsx'
import { TitanChat } from '#web-titan/titan-chat.tsx'
import { TitanLabel } from '#web-titan/titan-title.tsx'
import { storageKey } from '#web-titan/outbox.ts'
import { Oracle } from '#web-oracle/oracle.tsx'
import { workspaceSearch } from '#web-oracle/workspaces.ts'
import { focusElement } from '#web-shared/ui/focus.ts'
import { useSaveView } from '#web-preferences/save-view.ts'
import { useViewTheme } from '#web-preferences/view-theme.ts'
import { useProjectIntents } from '#web-projects/project-resource.ts'
import { SettingsPage } from '#web-settings/settings-page.tsx'
import { useSharedSettings } from '#web-settings/shared-settings.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { scrollBehavior } from '#web-shared/ui/smooth-scroll.ts'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { PendingStatus } from '#web-shared/ui/pending-status.tsx'
import { useKept,useStableActions } from '#web-shared/stable.ts'
import { useScrollingClass } from '#web-shared/use-scrolling-class.ts'
import { TitanCard } from '#web-tasks/card.tsx'
import { ProjectCounts } from '#web-tasks/project-counts.tsx'
import { ProjectColumn } from '#web-tasks/project-column.tsx'
import { TaskChat } from '#web-tasks/task-chat.tsx'
import { TaskFamily, type FamilyCard } from '#web-tasks/task-family.tsx'
import { SortableChip } from '#web-shared/ui/sortable-chip.tsx'
import { expandedTaskWidth, projectWidth } from '#web-tasks/project-layout.ts'
import { projectColumns, statusPriority, IDEAS_COLUMN, type ProjectColumnData } from '#web-tasks/project-view.ts'
import { taskProjectGroup } from '#tasks/order.ts'
import { Detail } from '#web-tasks/detail.tsx'
import { argument } from '#web-tasks/optimistic.ts'
import { observedStatus } from '#web-tasks/observed-status.ts'
import { TaskCreate,type TaskDraft } from '#web-tasks/task-create.tsx'
import { useTaskNavigation } from '#web-tasks/task-navigation.ts'
import { showTaskModal, useModalTask } from '#web-tasks/presentation.ts'
import { TaskReferencesProvider } from '#web-tasks/task-reference.tsx'
import { useTaskReferences } from '#web-tasks/task-references.ts'
import { ACCOUNT_SETTINGS } from '#web-workers/account-model-picker.tsx'
import { useInstallationPending } from '#web-workers/dispatch-resource.ts'
import { useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState } from 'react'
import { useTitan } from './connection.ts'
import { useTitanEdits } from './titan-edits.ts'
import { SortGroup, movedOrder, type SortMove } from '#web-shared/ui/sortable.tsx'
import { TitanChips, titanWaiting } from './titan-chips.tsx'
import { useNavHidden, NAV_SHORTCUT } from './nav-visibility.ts'
import { Chip } from '#web-shared/ui/chip.tsx'
import { Keycap } from '#web-shared/ui/keycap.tsx'
import { WaitingCount } from '#web-shared/ui/waiting-count.tsx'
import { OPEN_WAITING } from '#web-tasks/waiting-decisions.tsx'
import { Panel } from './panel.tsx'
import { titanViews,openingView,restoreView,usePersistView } from './restore.ts'
import { titanTitle } from './view.ts'

export function TitanView({
  titan,
  active,
  edits,
  preview,
  navigatePage,
}: {
  titan: ReturnType<typeof useTitan>
  navigatePage: ReturnType<typeof useTitan>['navigate']
  active: boolean
  edits: ReturnType<typeof useTitanEdits>
  preview: SortMove | null
}) {
  const {
    state,
    command,
    connected,
    offline,
    titanThread,
    titanQueue,
    upgrade,
    actions,
    navigation,
    navigate,
    loading,
    loaded,
    error,
    checking,
  } = titan
  useEffect(
    () => {
      if (titan.creating) {
        setPage({ page: 'titan' })
        const frame = requestAnimationFrame(() => layer?.querySelector<HTMLTextAreaElement>('.titan-chat textarea')?.focus())

        return () => cancelAnimationFrame(frame)
      }
    },
    [titan.viewKey],
  )
  const installationPending = useInstallationPending()
  const projectPending = useProjectIntents({ command })
  const restoreKey = storageKey({
    key: 'restore',
    titanId: titan.storageTitan,
  })
  const commentsKey = storageKey({
    key: 'comments',
    titanId: navigation.titanId,
  })
  const [restored] = useState(() => titanViews.get(titan.viewKey)
    ?? restoreView({ key: restoreKey }))
  const [
    pageView,
    setPageView,
  ] = useState(() => openingView({
    restored,
    titanId: navigation.titanId,
  }))
  const {
    selected: selectedRef,
    expanded,
    revealed,
  } = pageView
  const page = navigation.page

  const setPage = ({ page }: { page: string }) => {
    if (page === navigation.page) {
      return
    }

    const finish = timeUIFlow({
      surface: 'workspace',
      titanId: navigation.titanId,
      action: page === 'settings' ? 'settings.open' : 'settings.close',
    })
    const suffix = page === 'settings' ? 'settings/' : ''
    navigatePage({ url: `/titan/${encodeURIComponent(navigation.titanId)}/${suffix}` })
      .catch((error: Error) => notify({ text: error.message }))
      .finally(finish)
  }

  const [
    notice,
    setNotice,
  ] = useState<{ text: string } | null>(null)
  // The view persistence reads the same record the chat's saves write into.
  const drafts = useRef<Record<string, string>>(restored.drafts ?? {})
  const chatDrafts = useChatDrafts({
    identity: restoreKey,
    text: drafts.current[TITAN_CARD] ?? '',
    commentsKey,
    saveText: ({ text }) => {
      drafts.current[TITAN_CARD] = text

      try {
        const saved = restoreView({ key: restoreKey })
        sessionStorage.setItem(
          restoreKey,
          JSON.stringify({
            ...saved,
            drafts: drafts.current,
          }),
        )
      } catch { /* The mounted chat retains the draft when storage is blocked. */ }
    },
  })
  const [
    creatingTask,
    setCreatingTask,
  ] = useSessionView<{
    identity: string
    project?: string
    group?: string
    parent?: string
    draft?: TaskDraft
    version: number
  } | null>({
    key: sessionViewKey({
      scope: 'titan',
      id: titan.storageTitan,
      field: 'creatingTask',
    }),
    initial: null,
  })
  const taskFormVersion = useRef(creatingTask?.version ?? 0)
  // Another Titan's Add project request waits in the URL until that Titan opens.
  const [
    projectRequest,
    setProjectRequest,
  ] = useState(active && new URLSearchParams(location.search).has('add-project'))
  const [
    settingsQuery,
    setSettingsQuery,
  ] = useState('')
  const [
    accountSetup,
    setAccountSetup,
  ] = useState<'claude' | 'codex'>()
  useEffect(
    () => {
      const open = (event: Event) => {
        if (!active) {
          return
        }

        const requested = (event as CustomEvent<{ harness?: 'claude' | 'codex' }>).detail.harness
        setAccountSetup(requested ?? 'claude')
        setSettingsQuery('Accounts')
        setPage({ page: 'settings' })
      }

      window.addEventListener(
        ACCOUNT_SETTINGS,
        open,
      )

      return () => window.removeEventListener(
        ACCOUNT_SETTINGS,
        open,
      )
    },
    [
      active,
      navigation.titanId,
      navigation.page,
      navigatePage,
    ],
  )
  useEffect(
    () => {
      if (page !== 'settings') {
        setAccountSetup(undefined)
      }
    },
    [page],
  )
  const [
    layer,
    setLayer,
  ] = useState<HTMLDivElement | null>(null)

  useEffect(
    () => {
      if (!notice) {
        return
      }

      const timer = setTimeout(
        () => setNotice(null),
        5000,
      )

      return () => clearTimeout(timer)
    },
    [notice],
  )

  const notify = useCallback(
    ({ text }: { text: string }) => {
      setNotice({ text })
    },
    [],
  )
  useScrollingClass()
  const modalTask = useModalTask({ titanId: navigation.titanId })
  const [
    columnRequest,
    setColumnRequest,
  ] = useState<{
    id: string
    key: string
  } | null>(creatingTask?.group
    ? {
      id: creatingTask.group,
      key: creatingTask.identity,
    } : null)
  const projectReveal = useRef<AbortController | null>(null)

  const cancelProjectReveal = () => {
    projectReveal.current?.abort()
    setColumnRequest(null)
  }

  const {
    selected,
    expandedIds,
    cards,
    cancelOpen,
    clearSelection,
    open,
    revealTask,
    close,
  } = useTaskNavigation({
    state,
    titanId: navigation.titanId,
    command,
    connected,
    notify,
    opening: cancelProjectReveal,
    view: {
      ...pageView,
      page: 'titan',
    },
    setView: setPageView,
  })
  usePersistView({
    workspace: navigation.titanId,
    viewKey: titan.viewKey,
    key: restoreKey,
    selected,
    expanded,
    revealed,
    page,
    drafts: drafts.current,
    scroll: restored.scroll,
    seq: state.seq,
  })
  const shared = useSharedSettings()
  const configuredView = viewFor({
    state,
    settings: shared && pickView({ view: shared }),
  })
  const view = {
    ...configuredView,
    workspace: {
      ...configuredView.workspace,
      collapsed: state.view?.workspace?.collapsed
        ?? shared?.hiddenTitans.includes(navigation.titanId) ?? false,
    },
  }
  const references = useTaskReferences({
    state,
    actions,
    connected,
  })
  useViewTheme({
    view,
    active,
  })

  const startUpgrade = async () => {
    try {
      await command({
        name: 'titan',
        args: [
          'send',
          `--text=${UPGRADE_COMMAND}`,
          '--event-id',
          crypto.randomUUID(),
        ],
      })
    } catch (error) {
      notify({ text: (error as Error).message })
    }
  }

  const shownTitan = edits.titans.find(h => h.id === navigation.titanId)
  const save = useSaveView({
    state,
    command,
    notify,
  })

  const createTask = ({
    project,
    group = IDEAS_COLUMN,
    parent,
  }: {
    project?: string
    group?: string
    parent?: string
  }) => {
    setPage({ page: 'titan' }); clearSelection()
    taskFormVersion.current++
    const refused = titan.edits.findLast(intent => {
      const {
        name,
        args,
      } = intent.patch
      const attempt = argument({
        args,
        flag: '--event-id',
      }) ?? intent.id
      const matchesForm = argument({
        args,
        flag: '--parent',
      }) === parent
      const refusedProject = argument({
        args,
        flag: '--project',
      })
      const destination = columns.find(column => column.id === group)
      let matchesProject = !refusedProject

      if (project !== undefined) {
        matchesProject = refusedProject === project
      } else if (destination && destination.repositories.length > 0) {
        matchesProject = refusedProject !== undefined
          && destination.repositories.includes(refusedProject)
      }

      return intent.stage === 'refused' && name === 'task' && args[0] === 'create'
        && matchesForm && matchesProject && !state.keys[`task:${attempt}`]
    })
    const draft = refused && {
      title: argument({
        args: refused.patch.args,
        flag: '--title',
      }) ?? '',
      prompt: argument({
        args: refused.patch.args,
        flag: '--ask',
      }) ?? '',
      project: argument({
        args: refused.patch.args,
        flag: '--project',
      }),
      attempt: argument({
        args: refused.patch.args,
        flag: '--event-id',
      }) ?? refused.id,
    }
    setCreatingTask({
      identity: crypto.randomUUID(),
      project,
      group,
      version: taskFormVersion.current,
      draft,
      parent,
    })
    requestAnimationFrame(() => requestAnimationFrame(() => focusElement({ selector: `[data-titan-workspace="${CSS.escape(navigation.titanId)}"] .task-create [aria-label="Task title"]` })))
  }

  const baseColumns = useMemo(
    () => projectColumns({
      state,
      cards,
      actions,
      order: view.workspace.projectOrder,
    }),
    [
      state,
      cards,
      actions,
      JSON.stringify(view.workspace.projectOrder),
    ],
  )
  const orderedColumns = preview?.kind === 'project' && preview.titan === navigation.titanId
    ? movedOrder({
      items: baseColumns,
      ...preview,
      key: ({ item }) => item.id,
    }) : baseColumns
  const columns = preview?.kind === 'task' && preview.titan === navigation.titanId
    && !preview.nest && preview.scope === preview.targetScope
    ? orderedColumns.map(column => ({
      ...column,
      cards: movedOrder({
        items: column.cards,
        ...preview,
        key: ({ item }) => item.id,
      }),
    })) : orderedColumns
  const viewport = useWorkspaceViewport()
  const expandedProjectWidths = new Map<string, number>()

  for (const id of expandedIds) {
    const card = state.cards[id]

    if (!card) {
      continue
    }

    const project = taskProjectGroup({
      state,
      card,
    })
    const width = expandedTaskWidth({ card })
    const previous = expandedProjectWidths.get(project) ?? 0
    expandedProjectWidths.set(
      project,
      Math.max(
        previous,
        width,
      ),
    )
  }

  const columnWidth = ({ item }: { item: ProjectColumnData }) => {
    if (view.workspace.foldedProjects.includes(item.id)) {
      return WORKSPACE_SIZING.foldedColumn
    }

    return projectWidth({
      id: item.id,
      widths: view.workspace.projectWidths,
      expandedWidth: expandedProjectWidths.get(item.id) ?? 0,
      viewport: viewport.width,
    }).width
  }

  const phone = phoneLayout({ width: viewport.width })
  const chatWidth = view.workspace.chatCollapsed ? WORKSPACE_SIZING.foldedChat
    : phone ? viewport.width - WORKSPACE_SIZING.phoneChatInset : view.titanWidth
  let projectLeft = (phone ? WORKSPACE_SIZING.phoneInset : WORKSPACE_SIZING.inset) / 2
    + chatWidth + WORKSPACE_SIZING.columnGap
  const projectSnaps = columns.map(column => {
    const left = projectLeft
    projectLeft += columnWidth({ item: column }) + WORKSPACE_SIZING.columnGap

    return left
  })
  const [
    kanban,
    setKanban,
  ] = useState<HTMLDivElement | null>(null)
  const revealPadding = (phone ? WORKSPACE_SIZING.phoneFrameMargin
    : WORKSPACE_SIZING.frameMargin) / 2
  const requestedColumnId = columns.find(column => column.id === columnRequest?.id)?.id
  useLayoutEffect(
    () => {
      if (!active) {
        cancelProjectReveal()

        return
      }

      const scroller = viewport.axis.current

      if (!columnRequest || !requestedColumnId || !kanban || !scroller) {
        return
      }

      const target = kanban.querySelector<HTMLElement>(`[data-column="${CSS.escape(requestedColumnId)}"]`)

      if (!target) {
        return
      }

      const controller = new AbortController()
      const { signal } = controller
      projectReveal.current = controller

      const reveal = async () => {
        if (!await afterTaskLayout({ signal }) || !await afterSteadyLayout({
          element: target,
          signal,
        })) {
          return
        }

        const viewport = scroller.getBoundingClientRect()
        const bounds = target.getBoundingClientRect()
        const availablePadding = Math.max(
          0,
          scroller.clientWidth - bounds.width,
        )
        const padding = Math.min(
          revealPadding,
          availablePadding,
        )
        const viewportLeft = viewport.left + scroller.clientLeft
        const left = scroller.scrollLeft + bounds.left - viewportLeft - padding
        scroller.scrollTo({
          left,
          behavior: 'instant',
        })

        setColumnRequest(current => current?.key === columnRequest.key ? null : current)
      }

      reveal()

      return () => controller.abort()
    },
    [
      active,
      kanban,
      columnRequest,
      requestedColumnId,
      revealPadding,
    ],
  )

  const requestProject = () => {
    if (view.workspace.collapsed || view.workspace.chatCollapsed) {
      save({
        patch: {
          workspace: {
            collapsed: false,
            chatCollapsed: false,
          },
        },
      })
    }

    setPage({ page: 'titan' })
    setProjectRequest(true)
  }

  const answerTask = ({ card }: { card: Card }) => {
    void save({ patch: { workspace: { chatCollapsed: false } } })
    chatDrafts.setDraft({
      text: `${chatDrafts.read().text}\nFor ${taskMention({
        id: card.id,
        title: card.title,
      })}: `.trimStart(),
    })
    requestAnimationFrame(() => layer?.querySelector<HTMLTextAreaElement>('.titan-chat textarea')?.focus())
  }

  // Stable callbacks let unchanged cards retain their memoized render.
  const cardActions = useStableActions({
    actions: {
      notify,
      answer: answerTask,
      onEdit: cancelOpen,
      recoverSelection: ({ id }: { id: string }) => setPageView(view => {
        const recovered = view.selected && view.expanded.length

        return recovered ? view : {
          ...view,
          selected: view.selected ?? id,
          expanded: view.expanded.length ? view.expanded : [id],
        }
      }),
      open: ({
        id,
        pointer,
        focusPanel,
        modal,
      }: {
        id: string
        pointer?: boolean
        focusPanel?: boolean
        modal?: boolean
      }) => {
        if (!modal && expandedIds.includes(id)) {
          close({ id })

          return Promise.resolve(false)
        }

        if (phone && !modal) {
          return open({
            id,
            pointer,
            focusPanel,
            modal: true,
          }).then(opened => {
            if (opened && modalTask !== id) {
              showTaskModal({ id })
            }

            return opened
          })
        }

        return open({
          id,
          pointer,
          focusPanel,
          modal,
        })
      },
    },
  })
  const cardView = useKept({ value: view })

  const answerTaskById = ({ id }: { id: string }) => {
    const card = state.cards[id]

    if (!card) {
      return
    }

    open({
      id,
      focusPanel: false,
    })
    answerTask({ card })
  }

  const openSettings = ({ query }: { query: string }) => {
    setAccountSetup(undefined); setSettingsQuery(query); setPage({ page: 'settings' })
    requestAnimationFrame(() => focusElement({ selector: `[data-settings-titan="${CSS.escape(navigation.titanId)}"] .search-bar-input` }))
  }

  const revealProject = ({ id }: { id: string }) => {
    cancelOpen()
    projectReveal.current?.abort()
    setColumnRequest({
      id,
      key: crypto.randomUUID(),
    })
    save({
      patch: {
        workspace: {
          collapsed: false,
          foldedProjects: { [id]: false },
        },
      },
    })
  }

  const selectProject = ({ path }: { path: string }) => {
    setPage({ page: 'titan' })
    const project = state.projects?.find(project => project.path === path || project.name === path)
    const id = project?.group?.id ?? project?.path ?? path
    revealProject({ id })
  }

  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{
        titan: string
        id?: string
        path?: string
        answer?: boolean
        addProject?: boolean
      }>).detail

      if (detail.titan !== navigation.titanId) {
        return
      }

      if (detail.addProject) {
        requestProject()
      }

      if (detail.path) {
        selectProject({ path: detail.path })
      }

      if (detail.id) {
        if (detail.answer) {
          answerTaskById({ id: detail.id })
        } else {
          revealTask({ id: detail.id })
        }
      }
    }

    window.addEventListener(
      'othrys:workspace-target',
      receive,
    )

    return () => window.removeEventListener(
      'othrys:workspace-target',
      receive,
    )
  })

  const oracleTarget = async ({
    id,
    path,
    titan: destination = navigation.titanId,
    answer,
    addProject,
  }: {
    id?: string
    path?: string
    titan?: string
    answer?: boolean
    addProject?: boolean
  }) => {
    await navigate({ url: `/titan/${encodeURIComponent(destination)}/` })

    window.dispatchEvent(new CustomEvent(
      'othrys:workspace-target',
      {
        detail: {
          titan: destination,
          id,
          path,
          answer,
          addProject,
        },
      },
    ))
  }

  const oracleIds = titan.workspaces.filter(workspace => workspace.connected)
    .map(workspace => workspace.navigation.titanId)
    .join(':')
  const searchCommand = useMemo(
    () => workspaceSearch({
      ids: oracleIds.split(':').filter(Boolean),
      commandFor: titan.commandFor,
    }),
    [
      oracleIds,
      titan.commandFor,
    ],
  )
  const oracleWorkspaces = titan.workspaces.map(workspace => {
    const summary = navigation.titans.find(item => item.id === workspace.navigation.titanId)

    return {
      state: workspace.state,
      actions: workspace.actions,
      projects: summary?.projects ?? [],
      titan: {
        id: workspace.navigation.titanId,
        name: summary?.name ?? '',
        icon: summary?.icon ?? TITAN_MARK,
      },
    }
  })

  // The same command Titan's composer sends the owner's message with, scoped to the chosen Titan.
  const askTitan = ({
    id,
    text,
    event,
    onChecking,
  }: {
    id: string
    text: string
    event: string
    onChecking(): void
  }) => titan.commandFor({ id })({
    name: 'titan',
    args: [
      'send',
      `--text=${text}`,
      '--event-id',
      event,
    ],
    onChecking,
  })

  const openChat = async ({ id }: { id: string }) => {
    try {
      await navigate({
        url: new URL(
          `/titan/${encodeURIComponent(id)}/`,
          location.href,
        ).href,
      })
    } catch (error) {
      notify({ text: error instanceof Error ? error.message : String(error) })
    }
  }

  const oracleTitan = {
    id: navigation.titanId,
    name: shownTitan ? titanTitle(shownTitan) : 'Titan',
    icon: shownTitan?.icon ?? TITAN_MARK,
  }
  const askTargets = edits.titans.map(h => ({
    id: h.id,
    name: titanTitle(h),
    icon: h.icon ?? TITAN_MARK,
  }))
  const opening = navigation.titans.find(h => h.id === loading)
  const retryLabel = titan.creating ? 'Retry creating Titan' : 'Retry loading Titan'
  const others = edits.titans.filter(h => h.id !== navigation.titanId)
  const otherTitans = askTargets.filter(target => target.id !== navigation.titanId)
  const otherProjects = others.flatMap(h => h.projects.map(p => ({
    name: p.name,
    path: p.path,
    titan: titanTitle(h),
  })))

  const repositoryOptions = (state.projects ?? [])
    .filter(project => !project.detached)
    .map(project => ({
      value: project.path,
      label: projectTitle({ project: project.path }),
    }))

  const allProjectsFolded = columns.every(column =>
    view.workspace.foldedProjects.includes(column.id))

  const toggleAllProjects = () => {
    const allProjectIds = columns.map(column => column.id)
    const foldedProjects = Object.fromEntries(allProjectIds.map(id => [
      id,
      !allProjectsFolded,
    ]))
    save({ patch: { workspace: { foldedProjects } } })
  }

  const toggleTitan = () => {
    save({ patch: { workspace: { collapsed: !view.workspace.collapsed } } })
    requestAnimationFrame(() => layer?.scrollIntoView({
      inline: 'start',
      block: 'nearest',
      behavior: scrollBehavior(),
    }))
  }

  const nav = useNavHidden({
    phone,
    shortcut: active,
  })
  const titanAsks = columns.reduce(
    (
      total,
      column,
    ) => total + (column.asks ?? 0),
    0,
  )
  const titanRunning = columns.reduce(
    (
      total,
      column,
    ) => total + (column.running ?? 0),
    0,
  )

  const showChat = () => {
    setPage({ page: 'titan' })
    save({
      patch: {
        workspace: {
          collapsed: false,
          chatCollapsed: false,
        },
      },
    })
    requestAnimationFrame(() => layer?.querySelector('.workspace-chat')?.scrollIntoView({
      inline: 'start',
      block: 'nearest',
      behavior: scrollBehavior(),
    }))
  }

  const openWaiting = () => {
    showChat()
    requestAnimationFrame(() => dispatchEvent(new CustomEvent(
      OPEN_WAITING,
      { detail: { titan: navigation.titanId } },
    )))
  }

  const titanMenu = (
    <>
      <Button role="menuitem" onClick={toggleTitan}>{view.workspace.collapsed ? 'Unfold Titan' : 'Fold Titan'}</Button>
      <Button role="menuitem" onClick={toggleAllProjects}>{allProjectsFolded ? 'Unfold all projects' : 'Fold all projects'}</Button>
      <Button role="menuitem" disabled={!connected} onClick={requestProject}>Add project</Button>
      <Button role="menuitem" className="justify-between!" onClick={nav.toggle}>Hide the nav <Keycap>{NAV_SHORTCUT}</Keycap></Button>
    </>
  )

  const projectChips = (
    <div
      data-sort-surface={`project-chips:${navigation.titanId}`}
      className="project-chips flex flex-none items-center gap-1.25"
      role="group"
      aria-label="Projects"
    >
      <SortGroup id={`project-chips:${navigation.titanId}`} items={columns.map(column => column.id)}>
        {columns.map(column => (
          <SortableChip
            item={{
              id: column.id,
              kind: 'project',
              scope: 'projects',
              titan: navigation.titanId,
            }}
            disabledSort={column.id === IDEAS_COLUMN || !connected}
            key={column.id}
            data-sort-disabled={column.id === IDEAS_COLUMN}
            onClick={() => revealProject({ id: column.id })}
          >{column.title}<ProjectCounts asks={column.asks} running={column.running} />
          </SortableChip>
        ))}
      </SortGroup>
      <IconButton
        label="Add project"
        icon="plus"
        disabled={!connected}
        onClick={requestProject}
      />
    </div>
  )

  const navSheet = ({ close }: { close(): void }) => {
    const choose = ({ action }: { action(): void }) => {
      close()
      action()
    }

    return (
      <div className="nav-sheet flex min-h-0 flex-col gap-2 overflow-auto p-3 [&_h3]:px-1.75 [&_h3]:pt-2 [&_h3]:text-meta [&_h3]:tracking-eyebrow [&_h3]:text-muted [&_h3]:uppercase">
        <div className="flex flex-none gap-1.5 overflow-x-auto pb-1">
          {edits.titans.map(item => (
            <Chip
              key={item.id}
              variant="titan"
              aria-current={item.id === navigation.titanId ? 'page' : undefined}
              onClick={() => choose({ action: () => void navigate({ url: `/titan/${encodeURIComponent(item.id)}/` }) })}
            >
              <TitanLabel name={item.name} icon={item.icon} size={ICON_SIZE.control} />
              <WaitingCount count={titanWaiting({ titan: item })} />
            </Chip>
          ))}
        </div>
        <section className="flex flex-col" aria-label={shownTitan ? titanTitle(shownTitan) : 'Titan'}>
          <h3>{shownTitan ? titanTitle(shownTitan) : 'Titan'}</h3>
          <Button variant="menu-choice" onClick={() => choose({ action: showChat })}><span>Chat</span></Button>
          <Button variant="menu-choice" disabled={!titanAsks} onClick={() => choose({ action: openWaiting })}><span>Needs you</span><div><WaitingCount count={titanAsks} /></div></Button>
        </section>
        <section className="flex flex-col" aria-label="Projects">
          <h3>Projects</h3>
          {columns.map(column => (
            <Button key={column.id} variant="menu-choice" onClick={() => choose({ action: () => revealProject({ id: column.id }) })}>
              <span>{column.title}</span>
              <div className="flex items-center gap-2">
                <ProjectCounts asks={column.asks} running={column.running} />
                <span className="text-meta text-muted">{column.cards.length}</span>
              </div>
            </Button>
          ))}
          <Button
            variant="menu-choice"
            className="text-gold"
            disabled={!connected}
            onClick={() => choose({ action: requestProject })}
          >
            <Icon name="plus" size={ICON_SIZE.inline} />
            <span>Add project</span>
          </Button>
        </section>
        <div className="flex flex-none gap-2 border-t border-line pt-2">
          <Button variant="surface" onClick={() => choose({ action: () => setPage({ page: 'settings' }) })}>
            <Icon name="settings" size={ICON_SIZE.inline} />
            Settings
          </Button>
        </div>
      </div>
    )
  }

  const toggleChat = () => save({
    patch: { workspace: { chatCollapsed: !view.workspace.chatCollapsed } },
  })

  const renderCard = ({
    column,
    card: item,
    ...family
  }: FamilyCard & { column: ProjectColumnData }) => {
    const openInline = expandedIds.includes(item.id)
    const opened = openInline || modalTask === item.id
    const parent = item.parentId ? state.cards[item.parentId] : undefined
    const crossProject = !!parent && parent.project !== item.project
    const legacyProject = !!item.project && !state.projects?.some(project =>
      project.path === item.project || project.name === item.project)
    const showProject = column.repositories.length > 1 || crossProject || legacyProject
    const priority = statusPriority({ status: family.status })
    const rootColumn = item.parentId ? taskProjectGroup({
      state,
      card: {
        ...item,
        parentId: undefined,
      },
    }) : undefined
    const pendingTurn = titan.pendingTurns[item.id]
    const statusOverride = pendingTurn ? observedStatus({
      card: item,
      state,
      action: actions[item.id],
      pending: pendingTurn,
    }) : family.status

    return (
      <TitanCard
        key={item.key}
        card={item}
        titanId={navigation.titanId}
        sortScope={`${navigation.titanId}:${column.id}:${priority}:${item.parentId ?? 'root'}`}
        rootColumn={rootColumn}
        rootScope={rootColumn && `${navigation.titanId}:${rootColumn}:${priority}:root`}
        statusOverride={statusOverride}
        progress={family.progress}
        hasChildren={family.hasChildren}
        childrenOpen={family.childrenOpen}
        toggleChildren={family.toggleChildren}
        showProject={showProject}
        legacyProject={legacyProject}
        labelColors={state.labelColors}
        doneAfterHours={shared?.doneAfterHours}
        notify={cardActions.notify}
        action={actions[item.id]}
        answer={cardActions.answer}
        selected={opened}
        openInline={openInline}
        onEdit={cardActions.onEdit}
        recoverSelection={cardActions.recoverSelection}
        open={cardActions.open}
        command={command}
        connected={connected}
        tabIndex={0}
        chat={opened && (
          <TaskChat
            storageIdentity={titan.storageTitan}
            titanId={navigation.titanId}
            card={item}
            state={state}
            live={titan.taskThreads[item.id]}
            action={actions[item.id]}
            pendingTurn={pendingTurn}
            view={cardView}
            command={command}
            connected={connected}
            notify={notify}
          />
        )}
      >
        {opened && (
          <Detail
            card={item}
            state={state}
            command={command}
            connected={connected}
          />
        )}
      </TitanCard>
    )
  }

  const showWorkspace = (loaded || titan.creating) && page === 'titan'
  const fontSizes = {
    uiFont: `${view.fontSize}px`,
    chatFont: `${view.chatFontSize}px`,
    codeFont: `${view.codeFontSize}px`,
  }

  return (

    <TitanComposerSources
      state={state}
      command={command}
      connected={connected}
      references={references}
      openTask={revealTask}
      notify={notify}
      otherProjects={otherProjects}
      otherTitans={otherTitans}
    >
      <div
        ref={setLayer}
        className="app titan-workspace group/workspace flex h-full w-max min-w-workspace-frame flex-none snap-start flex-col overflow-clip rounded-workspace border border-line p-2 text-ui leading-normal data-[collapsed=true]:w-14.5 data-[collapsed=true]:min-w-0 max-phone:min-w-phone-workspace-frame max-phone:p-1.5"
        data-ui-surface="workspace"
        data-titan-workspace={navigation.titanId}
        data-active={active}
        data-page={page}
        data-project-snaps={phone ? JSON.stringify(projectSnaps) : undefined}
        data-collapsed={view.workspace.collapsed}
        data-seq={state.seq}
        data-connected={connected}
        style={runtimeStyle(fontSizes)}
      >
        <Panel
          shown={active}
          phone={phone}
          hidden={nav.hidden}
          reveal={nav.toggle}
          titan={shownTitan}
          waiting={titanAsks}
          openWaiting={openWaiting}
          sheet={navSheet}
          connected={connected}
          offline={offline}
          upgrade={upgrade}
          startUpgrade={startUpgrade}
          page={page}
          navigate={({ page }) => {
            setSettingsQuery(''); setPage({ page })
          }}
          oracle={(
            <ProfileSurface name="oracle" titanId={navigation.titanId}>
              <Oracle
                state={state}
                workspaces={oracleWorkspaces}
                searchCommand={searchCommand}
                cardActions={actions}
                view={view}
                command={command}
                connected={connected}
                titan={oracleTitan}
                projects={shownTitan?.projects ?? []}
                layer={layer}
                save={save}
                notify={notify}
                upgrade={upgrade}
                startUpgrade={startUpgrade}
                openTask={oracleTarget}
                answerTask={({
                  id,
                  titan,
                }) => oracleTarget({
                  id,
                  titan,
                  answer: true,
                })}
                selectProject={oracleTarget}
                openSettings={openSettings}
                createTask={({ column: group }) => {
                  const projectColumn = columns.find(column => column.id === group)
                  const singleRepository = projectColumn?.repositories.length === 1
                  createTask({
                    group,
                    project: singleRepository ? projectColumn.repositories[0] : undefined,
                  })
                }}
                createColumn={requestProject}
                titans={askTargets}
                send={askTitan}
                openChat={openChat}
              />
            </ProfileSurface>
          )}
        >
          <TitanChips
            titans={edits.titans}
            current={navigation.titanId}
            navigate={navigate}
            menu={titanMenu}
            projects={projectChips}
            openProject={({
              titan,
              path,
            }) => oracleTarget({
              titan,
              path,
            })}
            addProject={({ titan }) => oracleTarget({
              titan,
              addProject: true,
            })}
            createTitan={async () => {
              try {
                await titan.createTitan(pickName({
                  taken: edits.titans.map(item => item.name),
                }))
              } catch (error) {
                notify({ text: error instanceof Error ? error.message : String(error) })
              }
            }}
          />
        </Panel>
        {view.workspace.collapsed && (
          <Button
            className="titan-fold-strip flex h-full w-full items-center justify-start gap-1.5 px-0 py-2 font-brand text-workspace font-bold writing-vertical [&_.titan-label]:max-w-workspace-label"
            aria-label="Unfold Titan"
            onClick={toggleTitan}
          >
            <ProjectCounts asks={titanAsks} running={titanRunning} />
            <TitanLabel name={shownTitan?.name ?? ''} icon={shownTitan?.icon} size={ICON_SIZE.heading} />
          </Button>
        )}
        <FoldContent
          as="main"
          open={!view.workspace.collapsed}
          className="shell flex min-h-0 w-max flex-1 flex-col gap-2 overflow-visible p-0"
          aria-busy={!!loading || !loaded}
          data-titan={navigation.titanId}
          data-provisional={titan.creating || undefined}
        >
          {(loading || !loaded || titan.offline) && (
            <StatusMessage role="status">
              {titan.offline && 'Connection lost. Reconnecting automatically.'}
              {!titan.offline && <>{titan.creating ? 'Creating Titan' : <>Loading {opening ? <TitanLabel name={opening.name} icon={opening.icon} size={ICON_SIZE.inline} /> : 'Titan'}</>}…</>}
            </StatusMessage>
          )}
          {error && <ErrorBanner role="alert">{error} <Button onClick={titan.dismissError}>Dismiss</Button></ErrorBanner>}
          {titan.recovery && (
            <ErrorBanner role="alert">
              {titan.recovery.message}
              {titan.recovery.action === 'retry' && <Button onClick={titan.retryTitan}>{retryLabel}</Button>}
              {titan.recovery.action === 'reload' && <Button onClick={() => location.reload()}>Reload page</Button>}
            </ErrorBanner>
          )}
          {checking && <StatusMessage className="save-checking" role="status">Checking whether your changes were saved. Retrying automatically.</StatusMessage>}
          <PendingStatus
            intents={[
              ...titan.intents,
              ...installationPending,
              ...projectPending,
            ]}
          />
          {showWorkspace && (
            <div className="titan-page flex h-full min-h-0 w-max flex-row gap-2.5 overflow-visible">
              <div data-ui-surface="chat" className={`workspace-chat relative z-1 h-full flex-none ${view.workspace.chatCollapsed ? 'collapsed w-10 rounded-card border border-line [&>.chat-fold]:inset-x-1.25' : ''}`}>
                <IconButton
                  className="chat-fold absolute top-3 right-1.75 z-4 p-1"
                  label={view.workspace.chatCollapsed ? 'Unfold chat' : 'Fold chat'}
                  onClick={toggleChat}
                  icon={view.workspace.chatCollapsed ? 'chevron_right' : 'chevron_left'}
                />
                <FoldContent open={!view.workspace.chatCollapsed} className="chat-content h-full [&_.titan-head]:pr-12 [&_.titan-title_.titan-label]:truncate [&>.titan-chat]:h-full [&>.titan-chat]:max-h-none [&>.titan-chat]:min-w-75 [&>.titan-chat]:shrink-0 [&>.titan-chat]:rounded-xl [&>.titan-chat]:border [&>.titan-chat]:border-line max-phone:[&>.titan-chat]:w-phone-chat! max-phone:[&>.titan-chat]:basis-phone-chat!">
                  <ProfileSurface name="chat" titanId={navigation.titanId}>
                    <TitanChat
                      titanId={navigation.titanId}
                      identity={shownTitan && {
                        name: shownTitan.name,
                        icon: shownTitan.icon,
                        taken: edits.titans.filter(h => h.id !== shownTitan.id).map(h => h.name),
                      }}
                      editTitan={({
                        name,
                        icon,
                      }) => edits.edit({
                        id: navigation.titanId,
                        name,
                        icon,
                      })}
                      storageIdentity={titan.storageTitan}
                      projectRequest={projectRequest}
                      projectRequested={() => setProjectRequest(false)}
                      state={state}
                      liveThread={titanThread}
                      action={actions[TITAN_CARD]}
                      pendingTurn={titan.pendingTurns[TITAN_CARD]}
                      taskActions={actions}
                      selectedTask={selectedRef}
                      queue={titanQueue}
                      command={command}
                      connected={connected}
                      openTask={revealTask}
                      notify={notify}
                      view={view}
                      save={save}
                      drafts={chatDrafts}
                    />
                  </ProfileSurface>
                </FoldContent>
              </div>

              <TaskReferencesProvider references={references} openTask={revealTask}>
                <div className="titan-main flex min-h-0 w-max flex-none flex-col">
                  <div className="work-area relative inline h-full min-h-0 min-w-0 flex-1 overflow-visible">
                    <div className="titan-space flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-visible">
                      <div
                        ref={setKanban}
                        data-sort-surface={`project-columns:${navigation.titanId}`}
                        className="kanban flex h-full min-h-0 flex-1 gap-2.5 overflow-visible p-0"
                        aria-label="Work columns"
                      >
                        <SortGroup id={`project-columns:${navigation.titanId}`} items={columns.map(column => column.id)}>
                          {columns.map(c => {
                            const items = c.cards
                            const expandedWidth = expandedProjectWidths.get(c.id) ?? 0

                            return (
                              <ProjectColumn
                                key={c.id}
                                column={c}
                                titanId={navigation.titanId}
                                view={view}
                                save={save}
                                expandedWidth={expandedWidth}
                                create={() => createTask({
                                  project: c.repositories.length === 1
                                    ? c.repositories[0] : undefined,
                                  group: c.id,
                                })}
                              >{() => (
                                  <>
                                    {creatingTask?.group === c.id && (
                                      <TaskCreate
                                        titanId={navigation.titanId}
                                        storageIdentity={titan.storageTitan}
                                        key={`${c.id}:${creatingTask.parent ?? ''}`}
                                        {...creatingTask}
                                        repositories={c.repositories.length
                                          ? repositoryOptions.filter(option =>
                                            c.repositories.includes(option.value))
                                          : repositoryOptions}
                                        before={items[0] && {
                                          task: items[0].id,
                                          repositories: c.repositories,
                                        }}
                                        command={command}
                                        connected={connected}
                                        notify={notify}
                                        cancel={() => setCreatingTask(null)}
                                        recover={({ draft }) => {
                                          const current = taskFormVersion.current
                                                === creatingTask.version

                                          if (current) {
                                            setCreatingTask({
                                              ...creatingTask,
                                              draft,
                                            })
                                          }

                                          const key = `task:${draft.attempt}`
                                          setPageView(view => ({
                                            ...view,
                                            selected: view.selected === key ? null : view.selected,
                                            expanded: view.expanded.filter(id => id !== key),
                                          }))
                                        }}
                                        submitted={() => {
                                          focusElement({ selector: `[data-titan-workspace="${CSS.escape(navigation.titanId)}"] [data-column-heading="${CSS.escape(c.id)}"]` })
                                          setCreatingTask(null)
                                        }}
                                      />
                                    )}
                                    <SortGroup namespace={`tasks:${navigation.titanId}`} id={`tasks:${navigation.titanId}:${c.id}`} items={items.map(item => item.id)}>
                                      <ProjectTasks
                                        items={items}
                                        render={({ card: item }) => (
                                          <TaskFamily
                                            card={item}
                                            titanId={navigation.titanId}
                                            state={state}
                                            actions={actions}
                                            selected={expandedIds}
                                            preview={preview}
                                            renderCard={({ ...family }) => renderCard({
                                              ...family,
                                              column: c,
                                            })}
                                          />
                                        )}
                                      />
                                    </SortGroup>
                                  </>
                                )}
                              </ProjectColumn>
                            )
                          })}
                        </SortGroup>
                      </div>
                    </div>
                  </div>
                </div>
              </TaskReferencesProvider>
            </div>
          )}
          {active && page === 'settings' && createPortal(
            <div
              className="settings-route fixed inset-x-0 top-topbar-height bottom-0 z-65 flex bg-background [&>.settings-page]:w-full [&>.settings-page]:min-w-0 [&[hidden]]:hidden"
              data-ui-surface="settings"
              data-settings-titan={navigation.titanId}
              hidden={!active || page !== 'settings'}
              style={runtimeStyle(fontSizes)}
            >
              <ProfileSurface name="settings" titanId={navigation.titanId}>
                <SettingsPage
                  titans={navigation.titans}
                  commandFor={titan.commandFor}
                  key={settingsQuery}
                  initialQuery={settingsQuery}
                  accountSetup={accountSetup}
                  hidden={page !== 'settings'}
                  state={state}
                  connected={connected}
                  view={view}
                  save={save}
                  command={command}
                  notify={notify}
                  upgrade={upgrade}
                  startUpgrade={startUpgrade}
                />
              </ProfileSurface>
            </div>,
            document.body,
          )}
        </FoldContent>
        {notice && createPortal(
          <StatusNotice role="status">
            <span>{notice.text}</span>
            <IconButton
              label="Dismiss notification"
              onClick={() => setNotice(null)}
              icon="close"
            />
          </StatusNotice>,
          document.body,
        )}
      </div>
    </TitanComposerSources>

  )
}
