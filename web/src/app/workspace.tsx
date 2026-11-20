import { runtimeStyle } from '#web-shared/ui/runtime-style.ts'
import { MOTION_EASING } from '#web-shared/motion.ts'
import { useSessionView, sessionViewKey } from './session-view.ts'
import { useWorkspaceWindow } from './workspace-window.ts'
import { useWorkspaceViewport } from './workspace-viewport.tsx'
import { WindowedStrip } from '#web-shared/ui/windowed-strip.tsx'
import { WORKSPACE_SIZING } from '#web-shared/card-sizing.ts'
import { ProjectTasks } from '#web-tasks/project-tasks.tsx'
import { ProfileSurface } from './profile-surface.tsx'
import { timeUIFlow } from './ui-metrics.ts'
import { FoldContent } from '#web-shared/ui/fold-content.tsx'
import { StatusNotice, StatusMessage, ErrorBanner } from '#web-shared/ui/status-message.tsx'
import { projectTitle } from '#web-projects/view.ts'
import { IconButton } from '#web-shared/ui/icon-button.tsx'
import { createPortal } from 'react-dom'
import { HYDRA_MARK, pickName } from '#hydra/hydra-names.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { taskMention } from '#hydra/mentions.ts'
import { viewFor } from '#preferences/view.ts'
import { pickView } from '#settings/settings.ts'
import type { Card } from '#tasks/model.ts'
import { UPGRADE_COMMAND } from '#upgrade/model.ts'
import { useChatDrafts } from '#web-hydra/chat-drafts.ts'
import { HydraComposerSources } from '#web-hydra/composer-sources.tsx'
import { HydraChat } from '#web-hydra/hydra-chat.tsx'
import { HydraLabel } from '#web-hydra/hydra-title.tsx'
import { storageKey } from '#web-hydra/outbox.ts'
import { Oracle } from '#web-oracle/oracle.tsx'
import { workspaceSearch } from '#web-oracle/workspaces.ts'
import { useHydraKeyboard } from '#web-preferences/keyboard-hydra.tsx'
import { focusElement,KeyboardProvider } from '#web-preferences/keyboard-registry.tsx'
import { useSaveView } from '#web-preferences/save-view.ts'
import { useViewTheme } from '#web-preferences/view-theme.ts'
import { useProjectIntents, useProjectsResource } from '#web-projects/project-resource.ts'
import { SettingsPage } from '#web-settings/settings-page.tsx'
import { useSharedSettings } from '#web-settings/shared-settings.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { scrollBehavior } from '#web-shared/ui/smooth-scroll.ts'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { PendingStatus } from '#web-shared/ui/pending-status.tsx'
import { useKept,useStableActions } from '#web-shared/stable.ts'
import { useScrollingClass } from '#web-shared/use-scrolling-class.ts'
import { HydraCard } from '#web-tasks/card.tsx'
import { ProjectCounts } from '#web-tasks/project-counts.tsx'
import { ProjectColumn } from '#web-tasks/project-column.tsx'
import { TaskChat } from '#web-tasks/task-chat.tsx'
import { TaskFamily, type FamilyCard } from '#web-tasks/task-family.tsx'
import { motion } from 'motion/react'
import { SortableChip } from '#web-shared/ui/sortable-chip.tsx'
import { expandedTaskWidth, projectWidth } from '#web-tasks/project-layout.ts'
import { projectColumns, statusPriority, IDEAS_COLUMN, type ProjectColumnData } from '#web-tasks/project-view.ts'
import { taskProjectGroup } from '#tasks/order.ts'
import { Detail } from '#web-tasks/detail.tsx'
import { argument } from '#web-tasks/optimistic.ts'
import { observedStatus } from '#web-tasks/observed-status.ts'
import { TaskCreate,type TaskDraft } from '#web-tasks/task-create.tsx'
import { useTaskNavigation } from '#web-tasks/task-navigation.ts'
import { useModalTask } from '#web-tasks/presentation.ts'
import { TaskReferencesProvider } from '#web-tasks/task-reference.tsx'
import { useTaskReferences } from '#web-tasks/task-references.ts'
import { ACCOUNT_SETTINGS } from '#web-workers/account-model-picker.tsx'
import { useInstallationPending } from '#web-workers/dispatch-resource.ts'
import { useCallback,useEffect,useMemo,useRef,useState,type ReactNode } from 'react'
import { useHydra } from './connection.ts'
import { useHydraEdits } from './hydra-edits.ts'
import { SortGroup, useSortItem, movedOrder, type SortMove } from '#web-shared/ui/sortable.tsx'
import { HydraChips } from './hydra-chips.tsx'
import { Panel } from './panel.tsx'
import { hydraViews,openingView,restoreView,usePersistView } from './restore.ts'
import { hydraTitle,pageTitle } from './view.ts'

function HydraDragName({
  id,
  name,
  disabled,
  children,
}: {
  id: string
  name: string
  disabled: boolean
  children: ReactNode
}) {
  const sort = useSortItem({
    item: {
      id,
      kind: 'hydra',
      scope: 'hydras',
      hydra: id,
    },
    disabled,
  })

  return (
    <div
      ref={sort.setNodeRef}
      {...sort.attributes}
      {...sort.listeners}
      data-sort-key={sort.key}
      aria-label={`Move ${name}`}
      data-sort-id={id}
      data-sort-kind="hydra"
      data-sort-scope="hydras"
      className={`hydra-drag-name ${sort.isDragging ? 'opacity-0' : ''} flex max-w-workspace-title min-w-0 flex-none cursor-grab touch-none items-center gap-1.5 font-brand text-workspace font-bold group-data-[collapsed=true]/workspace:writing-vertical [&_.hydra-label]:max-w-workspace-label [&_.hydra-label]:truncate`}
    >{children}
    </div>
  )
}

export function HydraView({
  hydra,
  active,
  edits,
  preview,
  navigatePage,
  hydraLayout,
  polisFilter,
  filterPolis,
}: {
  hydra: ReturnType<typeof useHydra>
  navigatePage: ReturnType<typeof useHydra>['navigate']
  active: boolean
  edits: ReturnType<typeof useHydraEdits>
  preview: SortMove | null
  hydraLayout: string
  polisFilter?: string
  filterPolis({ polis }: { polis?: string }): void
}) {
  const {
    state,
    command,
    connected,
    offline,
    hydraThread,
    hydraQueue,
    upgrade,
    latest,
    actions,
    navigation,
    navigate,
    loading,
    loaded,
    error,
    checking,
  } = hydra
  useEffect(
    () => {
      if (hydra.creating) {
        setPage({ page: 'hydra' })
        const frame = requestAnimationFrame(() => layer?.querySelector<HTMLTextAreaElement>('.hydra-chat textarea')?.focus())

        return () => cancelAnimationFrame(frame)
      }
    },
    [hydra.viewKey],
  )
  const installationPending = useInstallationPending()
  const projectPending = useProjectIntents({ command })
  const restoreKey = storageKey({
    key: 'restore',
    hydraId: hydra.storageHydra,
  })
  const commentsKey = storageKey({
    key: 'comments',
    hydraId: navigation.hydraId,
  })
  const [restored] = useState(() => hydraViews.get(hydra.viewKey)
    ?? restoreView({ key: restoreKey }))
  const [
    pageView,
    setPageView,
  ] = useState(() => openingView({
    restored,
    hydraId: navigation.hydraId,
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
      hydraId: navigation.hydraId,
      action: page === 'settings' ? 'settings.open' : 'settings.close',
    })
    const suffix = page === 'settings' ? 'settings/' : ''
    navigatePage({ url: `/hydra/${encodeURIComponent(navigation.hydraId)}/${suffix}` })
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
    text: drafts.current[HYDRA_CARD] ?? '',
    commentsKey,
    saveText: ({ text }) => {
      drafts.current[HYDRA_CARD] = text

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
    column: string
    project?: string
    group?: string
    parent?: string
    draft?: TaskDraft
    version: number
  } | null>({
    key: sessionViewKey({
      scope: 'hydra',
      id: hydra.storageHydra,
      field: 'creatingTask',
    }),
    initial: null,
  })
  const taskFormVersion = useRef(creatingTask?.version ?? 0)
  // Another Hydra's Add project request waits in the URL until that Hydra opens.
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
      navigation.hydraId,
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
  const modalTask = useModalTask({ hydraId: navigation.hydraId })
  const {
    selected,
    revealing,
    expandedIds,
    cards,
    columns: statusColumns,
    cancelOpen,
    clearSelection,
    expand,
    open,
    revealTask,
    close,
  } = useTaskNavigation({
    state,
    hydraId: navigation.hydraId,
    command,
    connected,
    notify,
    view: {
      ...pageView,
      page: 'hydra',
    },
    setView: setPageView,
  })
  usePersistView({
    workspace: navigation.hydraId,
    viewKey: hydra.viewKey,
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
        ?? shared?.hiddenHydras.includes(navigation.hydraId) ?? false,
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
        name: 'hydra',
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

  const shownHydra = edits.hydras.find(h => h.id === navigation.hydraId)
  const title = pageTitle({
    page,
    taskTitle: selected ? state.cards[selected]?.title : undefined,
    hydra: shownHydra && hydraTitle(shownHydra),
  })
  useEffect(
    () => {
      if (active) {
        document.title = title
      }
    },
    [
      title,
      active,
    ],
  )
  const save = useSaveView({
    state,
    command,
    notify,
  })

  const createTask = ({
    column,
    project,
    group = IDEAS_COLUMN,
    parent,
  }: {
    column: string
    project?: string
    group?: string
    parent?: string
  }) => {
    setPage({ page: 'hydra' }); clearSelection()
    taskFormVersion.current++
    const refused = hydra.edits.findLast(intent => {
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
        flag: '--column',
      }) === column
        && argument({
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
      column,
      project,
      group,
      version: taskFormVersion.current,
      draft,
      parent,
    })
    requestAnimationFrame(() => requestAnimationFrame(() => focusElement({ selector: `[data-hydra-workspace="${CSS.escape(navigation.hydraId)}"] .task-create [aria-label="Task title"]` })))
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
  const orderedColumns = preview?.kind === 'project' && preview.hydra === navigation.hydraId
    ? movedOrder({
      items: baseColumns,
      ...preview,
      key: ({ item }) => item.id,
    }) : baseColumns
  const columns = preview?.kind === 'task' && preview.hydra === navigation.hydraId
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

  const columnWidth = ({ item }: { item: ProjectColumnData }) => {
    if (item.id === 'create-project') {
      return WORKSPACE_SIZING.createColumn
    }

    if (view.workspace.foldedProjects.includes(item.id)) {
      return WORKSPACE_SIZING.foldedColumn
    }

    const opened = expandedIds.map(id => state.cards[id]).filter((card): card is Card =>
      !!card && taskProjectGroup({
        state,
        card,
      }) === item.id)

    return projectWidth({
      id: item.id,
      widths: view.workspace.projectWidths,
      expandedWidth: Math.max(
        0,
        ...opened.map(card => expandedTaskWidth({ card })),
      ),
      viewport: viewport.width,
    }).width
  }

  const phone = viewport.width <= WORKSPACE_SIZING.phone
  const chatWidth = view.workspace.chatCollapsed ? WORKSPACE_SIZING.foldedChat
    : phone ? viewport.width - WORKSPACE_SIZING.phoneChatInset : view.hydraWidth
  const modelWidth = Math.max(
    viewport.width - (phone ? WORKSPACE_SIZING.phoneFrameMargin : WORKSPACE_SIZING.frameMargin),
    (phone ? WORKSPACE_SIZING.phoneInset : WORKSPACE_SIZING.inset)
      + chatWidth + WORKSPACE_SIZING.columnGap
      + columns.reduce(
        (
          total,
          column,
        ) => total + columnWidth({ item: column })
        + WORKSPACE_SIZING.columnGap,
        WORKSPACE_SIZING.createColumn,
      ),
  )
  let projectLeft = (phone ? WORKSPACE_SIZING.phoneInset : WORKSPACE_SIZING.inset) / 2
    + chatWidth + WORKSPACE_SIZING.columnGap
  const projectSnaps = columns.map(column => {
    const left = projectLeft
    projectLeft += columnWidth({ item: column }) + WORKSPACE_SIZING.columnGap

    return left
  })
  const workspaceWindow = useWorkspaceWindow({
    element: layer,
    hydra: navigation.hydraId,
    width: modelWidth,
    collapsed: view.workspace.collapsed,
    loaded,
  })
  const projectSettings = useSharedSettings()
  const { projects: polisProjects } = useProjectsResource({
    command,
    connected: connected && workspaceWindow.mounted,
    revision: `${state.projectsRevision}:${JSON.stringify(projectSettings?.projectPoleis)}:${JSON.stringify(projectSettings?.poleis)}:${JSON.stringify(state.config?.readPoleis)}`,
  })
  const projectPolisByPath = new Map(polisProjects.map(project => [
    project.path,
    project.polis,
  ]))
  const protectedColumns = new Set(columns.filter(column =>
    viewport.protectsColumn({
      hydra: navigation.hydraId,
      id: column.id,
    })
    || [...(viewport.tasks.get(navigation.hydraId) ?? [])].some(id => {
      const card = state.cards[id]

      return card && taskProjectGroup({
        state,
        card,
      }) === column.id
    })).map(column => column.id))
  const revealingColumn = revealing && state.cards[revealing]
    ? taskProjectGroup({
      state,
      card: state.cards[revealing]!,
    }) : columnRequest?.id

  const queuedColumn = statusColumns.find(column => column.role === 'queued')?.id ?? statusColumns[0]!.id

  const createColumn = () => {
    setPage({ page: 'hydra' }); setProjectRequest(true)
  }

  const keyboard = useHydraKeyboard({
    state,
    actions,
    hydraId: navigation.hydraId,
    groups: columns.map(c => ({
      id: c.id,
      cards: c.cards.map(card => card.id),
    })),
    page,
    setPage,
    selected,
    open,
    close,
    command,
    connected,
    notify,
    newColumn: false,
    cancelColumn: () => {},
    togglePanel: () => {
      void save({ patch: { workspace: { chatCollapsed: !view.workspace.chatCollapsed } } })
    },
    openSettings: () => {
      if (page === 'settings') {
        setPage({ page: 'hydra' })

        return
      }

      openSettings({ query: settingsQuery })
    },
  })

  const answerTask = ({ card }: { card: Card }) => {
    void save({ patch: { workspace: { chatCollapsed: false } } })
    chatDrafts.setDraft({
      text: `${chatDrafts.read().text}\nFor ${taskMention({
        id: card.id,
        title: card.title,
      })}: `.trimStart(),
    })
    requestAnimationFrame(() => layer?.querySelector<HTMLTextAreaElement>('.hydra-chat textarea')?.focus())
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
    requestAnimationFrame(() => focusElement({ selector: `[data-settings-hydra="${CSS.escape(navigation.hydraId)}"] .search-bar-input` }))
  }

  const selectProject = ({ path }: { path: string }) => {
    setPage({ page: 'hydra' })
    const project = state.projects?.find(project => project.path === path || project.name === path)
    const id = project?.group?.id ?? project?.path ?? path
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

  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{
        hydra: string
        id?: string
        path?: string
        answer?: boolean
      }>).detail

      if (detail.hydra !== navigation.hydraId) {
        return
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
      'pnyx:workspace-target',
      receive,
    )

    return () => window.removeEventListener(
      'pnyx:workspace-target',
      receive,
    )
  })

  const oracleTarget = async ({
    id,
    path,
    hydra: destination = navigation.hydraId,
    answer,
  }: {
    id?: string
    path?: string
    hydra?: string
    answer?: boolean
  }) => {
    await navigate({ url: `/hydra/${encodeURIComponent(destination)}/` })

    window.dispatchEvent(new CustomEvent(
      'pnyx:workspace-target',
      {
        detail: {
          hydra: destination,
          id,
          path,
          answer,
        },
      },
    ))
  }

  const oracleIds = hydra.workspaces.filter(workspace => workspace.connected)
    .map(workspace => workspace.navigation.hydraId)
    .join(':')
  const searchCommand = useMemo(
    () => workspaceSearch({
      ids: oracleIds.split(':').filter(Boolean),
      commandFor: hydra.commandFor,
    }),
    [
      oracleIds,
      hydra.commandFor,
    ],
  )
  const oracleWorkspaces = hydra.workspaces.map(workspace => {
    const summary = navigation.hydras.find(item => item.id === workspace.navigation.hydraId)

    return {
      state: workspace.state,
      actions: workspace.actions,
      projects: summary?.projects ?? [],
      hydra: {
        id: workspace.navigation.hydraId,
        name: summary?.name ?? '',
        icon: summary?.icon ?? HYDRA_MARK,
      },
    }
  })

  // The same command Hydra's composer sends the owner's message with, scoped to the chosen Hydra.
  const askHydra = ({
    id,
    text,
    event,
    onChecking,
  }: {
    id: string
    text: string
    event: string
    onChecking(): void
  }) => hydra.commandFor({ id })({
    name: 'hydra',
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
          `/hydra/${encodeURIComponent(id)}/`,
          location.href,
        ).href,
      })
    } catch (error) {
      notify({ text: error instanceof Error ? error.message : String(error) })
    }
  }

  const oracleHydra = {
    id: navigation.hydraId,
    name: shownHydra ? hydraTitle(shownHydra) : 'Hydra',
    icon: shownHydra?.icon ?? HYDRA_MARK,
  }
  const askTargets = edits.hydras.map(h => ({
    id: h.id,
    name: hydraTitle(h),
    icon: h.icon ?? HYDRA_MARK,
  }))
  const opening = navigation.hydras.find(h => h.id === loading)
  const retryLabel = hydra.creating ? 'Retry creating Hydra' : 'Retry loading Hydra'
  const others = edits.hydras.filter(h => h.id !== navigation.hydraId)
  const otherProjects = others.flatMap(h => h.projects.map(p => ({
    name: p.name,
    path: p.path,
    hydra: hydraTitle(h),
  })))

  const revealProject = ({ id }: { id: string }) => {
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

  const toggleHydra = () => {
    save({ patch: { workspace: { collapsed: !view.workspace.collapsed } } })
    requestAnimationFrame(() => layer?.scrollIntoView({
      inline: 'start',
      block: 'nearest',
      behavior: scrollBehavior(),
    }))
  }

  const toggleChat = () => save({
    patch: { workspace: { chatCollapsed: !view.workspace.chatCollapsed } },
  })

  const renderCard = ({
    card: item,
    column,
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
    const pendingTurn = hydra.pendingTurns[item.id]
    const statusOverride = pendingTurn ? observedStatus({
      card: item,
      state,
      action: actions[item.id],
      pending: pendingTurn,
    }) : family.status

    return (
      <HydraCard
        key={item.key}
        card={item}
        hydraId={navigation.hydraId}
        sortScope={`${navigation.hydraId}:${column.id}:${priority}:${item.parentId ?? 'root'}`}
        rootColumn={rootColumn}
        rootScope={rootColumn && `${navigation.hydraId}:${rootColumn}:${priority}:root`}
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
        latest={latest[item.id]}
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
            storageIdentity={hydra.storageHydra}
            hydraId={navigation.hydraId}
            card={item}
            state={state}
            live={hydra.taskThreads[item.id]}
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
      </HydraCard>
    )
  }

  const showWorkspace = workspaceWindow.mounted && (loaded || hydra.creating) && page === 'hydra'
  const fontSizes = {
    uiFont: `${view.fontSize}px`,
    chatFont: `${view.chatFontSize}px`,
    codeFont: `${view.codeFontSize}px`,
  }

  return (
    <KeyboardProvider
      workspace={navigation.hydraId}
      prefs={cardView.keyboard}
      onAction={keyboard.onAction}
      leaveField={keyboard.leaveField}
      hints={keyboard.hints.length > 0}
      hintKey={keyboard.hintKey}
    >
      <HydraComposerSources
        state={state}
        command={command}
        connected={connected && workspaceWindow.mounted}
        references={references}
        openTask={revealTask}
        notify={notify}
        otherProjects={otherProjects}
      >
        <motion.div
          layout="position"
          initial={{minWidth: workspaceWindow.minimum}}
          transition={{
            layout: {
              duration: hydraLayout ? workspaceWindow.duration / 1000 : 0,
              ease: MOTION_EASING,
            },
          }}
          ref={setLayer}
          className="app hydra-workspace group/workspace flex h-full w-max flex-none snap-start flex-col overflow-clip rounded-workspace border border-line p-2 text-ui leading-normal max-phone:p-1.5"
          data-ui-surface="workspace"
          data-hydra-workspace={navigation.hydraId}
          data-active={active}
          data-page={page}
          data-project-snaps={phone ? JSON.stringify(projectSnaps) : undefined}
          data-collapsed={view.workspace.collapsed}
          data-seq={state.seq}
          data-connected={connected}
          style={runtimeStyle({
            width: workspaceWindow.width,
            ...fontSizes,
          })}
        >
          <Panel
            shown={active}
            connected={connected}
            offline={offline}
            upgrade={upgrade}
            startUpgrade={startUpgrade}
            page={page}
            navigate={({ page }) => {
              setSettingsQuery(''); setPage({ page })
            }}
            oracle={(
              <ProfileSurface name="oracle" hydraId={navigation.hydraId}>
                <Oracle
                  state={state}
                  workspaces={oracleWorkspaces}
                  searchCommand={searchCommand}
                  cardActions={actions}
                  view={view}
                  command={command}
                  connected={connected}
                  hydra={oracleHydra}
                  projects={shownHydra?.projects ?? []}
                  layer={layer}
                  save={save}
                  notify={notify}
                  upgrade={upgrade}
                  startUpgrade={startUpgrade}
                  openTask={oracleTarget}
                  answerTask={({
                    id,
                    hydra,
                  }) => oracleTarget({
                    id,
                    hydra,
                    answer: true,
                  })}
                  selectProject={oracleTarget}
                  openSettings={openSettings}
                  createTask={({ column: group }) => {
                    const projectColumn = columns.find(column => column.id === group)
                    const singleRepository = projectColumn?.repositories.length === 1
                    createTask({
                      column: queuedColumn,
                      group,
                      project: singleRepository ? projectColumn.repositories[0] : undefined,
                    })
                  }}
                  createColumn={createColumn}
                  action={keyboard.onAction}
                  hydras={askTargets}
                  send={askHydra}
                  openChat={openChat}
                />
              </ProfileSurface>
            )}
          >
            <HydraChips
              polisFilter={polisFilter}
              filterPolis={filterPolis}
              hydras={edits.hydras}
              current={navigation.hydraId}
              navigate={navigate}
              createHydra={async () => {
                try {
                  await hydra.createHydra(pickName({
                    taken: edits.hydras.map(item => item.name),
                  }))
                } catch (error) {
                  notify({ text: error instanceof Error ? error.message : String(error) })
                }
              }}
            />
          </Panel>
          <motion.header layoutRoot className="hydra-workspace-bar sticky left-4 z-5 flex min-h-9.5 w-max max-w-workspace-bar flex-none items-center gap-2.5 bg-background px-0.5 pb-2 group-data-[collapsed=true]/workspace:relative group-data-[collapsed=true]/workspace:left-auto group-data-[collapsed=true]/workspace:h-full group-data-[collapsed=true]/workspace:w-full group-data-[collapsed=true]/workspace:max-w-none group-data-[collapsed=true]/workspace:flex-col [&>.button]:flex-none">
            <HydraDragName id={navigation.hydraId} name={shownHydra?.name ?? 'Hydra'} disabled={!connected}>
              {view.workspace.collapsed && (
                <ProjectCounts
                  asks={columns.reduce(
                    (
                      total,
                      column,
                    ) => total + (column.asks ?? 0),
                    0,
                  )}
                  running={columns.reduce(
                    (
                      total,
                      column,
                    ) => total + (column.running ?? 0),
                    0,
                  )}
                />
              )}
              <HydraLabel name={shownHydra?.name ?? ''} icon={shownHydra?.icon} size={ICON_SIZE.heading} />
            </HydraDragName>
            <nav data-sort-surface={`project-chips:${navigation.hydraId}`} className="project-chips flex min-w-0 gap-1.25 overflow-x-auto overflow-y-hidden group-data-[collapsed=true]/workspace:min-h-0 group-data-[collapsed=true]/workspace:flex-col group-data-[collapsed=true]/workspace:overflow-y-auto" aria-label="Projects">
              <SortGroup id={`project-chips:${navigation.hydraId}`} items={columns.map(column => column.id)}>
                {columns.map(column => (
                  <SortableChip
                    item={{
                      id: column.id,
                      kind: 'project',
                      scope: 'projects',
                      hydra: navigation.hydraId,
                    }}
                    disabledSort={column.id === IDEAS_COLUMN || !connected}
                    vertical={view.workspace.collapsed}
                    key={column.id}
                    data-sort-id={column.id}
                    data-sort-kind="project"
                    data-sort-scope="projects"
                    data-sort-disabled={column.id === IDEAS_COLUMN}
                    onClick={() => revealProject({ id: column.id })}
                  >{column.title}<ProjectCounts asks={column.asks} running={column.running} />
                  </SortableChip>
                ))}
              </SortGroup>
            </nav>
            <IconButton
              label={allProjectsFolded ? 'Unfold all projects' : 'Fold all projects'}
              onClick={toggleAllProjects}
              icon={allProjectsFolded ? 'unfold_columns' : 'fold_columns'}
            />
            <IconButton
              label={view.workspace.collapsed ? 'Unfold Hydra' : 'Fold Hydra'}
              onClick={toggleHydra}
              icon={view.workspace.collapsed ? 'chevron_right' : 'chevron_left'}
            />
          </motion.header>
          <FoldContent
            as="main"
            axis="none"
            open={!view.workspace.collapsed}
            className="shell flex min-h-0 w-max flex-1 flex-col gap-2 overflow-visible p-0 [&[hidden]]:hidden"
            aria-busy={!!loading || !loaded}
            data-hydra={navigation.hydraId}
            data-provisional={hydra.creating || undefined}
          >
            {(loading || !loaded || hydra.offline) && (
              <StatusMessage role="status">
                {hydra.offline && 'Connection lost. Reconnecting automatically.'}
                {!hydra.offline && <>{hydra.creating ? 'Creating Hydra' : <>Loading {opening ? <HydraLabel name={opening.name} icon={opening.icon} size={ICON_SIZE.inline} /> : 'Hydra'}</>}…</>}
              </StatusMessage>
            )}
            {error && <ErrorBanner role="alert">{error} <Button onClick={hydra.dismissError}>Dismiss</Button></ErrorBanner>}
            {hydra.recovery && (
              <ErrorBanner role="alert">
                {hydra.recovery.message}
                {hydra.recovery.action === 'retry' && <Button onClick={hydra.retryHydra}>{retryLabel}</Button>}
                {hydra.recovery.action === 'reload' && <Button onClick={() => location.reload()}>Reload page</Button>}
              </ErrorBanner>
            )}
            {checking && <StatusMessage className="save-checking" role="status">Checking whether your changes were saved. Retrying automatically.</StatusMessage>}
            <PendingStatus
              intents={[
                ...hydra.intents,
                ...installationPending,
                ...projectPending,
              ]}
            />
            {showWorkspace && (
              <div className="hydra-page flex h-full min-h-0 w-max flex-row gap-2.5 overflow-visible">
                <motion.div layout data-ui-surface="chat" className={`workspace-chat relative z-1 h-full flex-none ${view.workspace.chatCollapsed ? 'collapsed w-10 rounded-card border border-line [&>.chat-fold]:inset-x-1.25' : ''}`}>
                  <IconButton
                    className="chat-fold absolute top-3 right-1.75 z-4 p-1"
                    label={view.workspace.chatCollapsed ? 'Unfold chat' : 'Fold chat'}
                    onClick={toggleChat}
                    icon={view.workspace.chatCollapsed ? 'chevron_right' : 'chevron_left'}
                  />
                  <FoldContent open={!view.workspace.chatCollapsed} axis="none" className="chat-content h-full [&_.hydra-head]:pr-12 [&_.hydra-title_.hydra-label]:truncate [&>.hydra-chat]:h-full [&>.hydra-chat]:max-h-none [&>.hydra-chat]:min-w-75 [&>.hydra-chat]:shrink-0 [&>.hydra-chat]:rounded-xl [&>.hydra-chat]:border [&>.hydra-chat]:border-line max-phone:[&>.hydra-chat]:w-phone-chat! max-phone:[&>.hydra-chat]:basis-phone-chat! [&[hidden]]:hidden">
                    <ProfileSurface name="chat" hydraId={navigation.hydraId}>
                      <HydraChat
                        hydraId={navigation.hydraId}
                        identity={shownHydra && {
                          name: shownHydra.name,
                          icon: shownHydra.icon,
                          taken: edits.hydras.filter(h => h.id !== shownHydra.id).map(h => h.name),
                        }}
                        editHydra={({
                          name,
                          icon,
                        }) => edits.edit({
                          id: navigation.hydraId,
                          name,
                          icon,
                        })}
                        storageIdentity={hydra.storageHydra}
                        addProject={createColumn}
                        projectRequest={projectRequest}
                        projectRequested={() => setProjectRequest(false)}
                        state={state}
                        liveThread={hydraThread}
                        action={actions[HYDRA_CARD]}
                        pendingTurn={hydra.pendingTurns[HYDRA_CARD]}
                        taskActions={actions}
                        selectedTask={selectedRef}
                        queue={hydraQueue}
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
                </motion.div>

                <TaskReferencesProvider references={references} openTask={revealTask}>
                  <div className="hydra-main flex min-h-0 w-max flex-none flex-col">
                    <div className="work-area relative inline h-full min-h-0 min-w-0 flex-1 overflow-visible">
                      <div className="hydra-space flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-visible">
                        <div data-sort-surface={`project-columns:${navigation.hydraId}`} className="kanban flex h-full min-h-0 flex-1 gap-2.5 overflow-visible p-0" aria-label="Work columns">
                          <SortGroup id={`project-columns:${navigation.hydraId}`} items={columns.map(column => column.id)}>
                            <WindowedStrip
                              items={[
                                ...columns,
                                {
                                  id: 'create-project',
                                  title: '',
                                  cards: [],
                                  repositories: [],
                                },
                              ]}
                              itemKey={({ item }) => item.id}
                              scroll={viewport.axis.current}
                              gap={WORKSPACE_SIZING.columnGap}
                              protectedItems={protectedColumns}
                              reveal={revealingColumn}
                              revealKey={columnRequest?.key}
                              padding={(phone ? WORKSPACE_SIZING.phoneFrameMargin
                                : WORKSPACE_SIZING.frameMargin) / 2}
                              size={columnWidth}
                              render={({ item: c }) => {
                                if (c.id === 'create-project') {
                                  return <div className="add-column w-57.5 flex-none p-2"><Button disabled={!connected} onClick={createColumn}><Icon name="plus" />Project</Button></div>
                                }

                                const items = c.cards
                                const openIds = expandedIds.filter(id => {
                                  const card = state.cards[id]

                                  return card && taskProjectGroup({
                                    state,
                                    card,
                                  }) === c.id
                                })

                                const openedWidths = openIds.map(id => expandedTaskWidth({
                                  card: state.cards[id]!,
                                }))
                                const expandedWidth = Math.max(
                                  0,
                                  ...openedWidths,
                                )

                                return (
                                  <ProjectColumn
                                    key={c.id}
                                    column={c}
                                    poleis={[
                                      ...new Set(c.repositories.flatMap(path => {
                                        const polis = projectPolisByPath.get(path)

                                        return polis ? [polis] : []
                                      })),
                                    ]}
                                    hydraId={navigation.hydraId}
                                    view={view}
                                    save={save}
                                    expandedWidth={expandedWidth}
                                    create={() => createTask({
                                      column: queuedColumn,
                                      project: c.repositories.length === 1
                                        ? c.repositories[0] : undefined,
                                      group: c.id,
                                    })}
                                  >{() => (
                                      <>
                                        {creatingTask?.group === c.id && (
                                          <TaskCreate
                                            hydraId={navigation.hydraId}
                                            storageIdentity={hydra.storageHydra}
                                            key={`${c.id}:${creatingTask.parent ?? ''}`}
                                            {...creatingTask}
                                            repositories={c.repositories.length
                                              ? repositoryOptions.filter(option =>
                                                c.repositories.includes(option.value))
                                              : repositoryOptions}
                                            before={items.find(item =>
                                              item.column === queuedColumn)?.id}
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
                                                selected: view.selected === key
                                                  ? null : view.selected,
                                                expanded: view.expanded.filter(id => id !== key),
                                              }))
                                            }}
                                            submitted={({ id }) => {
                                              setCreatingTask(null); expand({
                                                id,
                                                column: c.id,
                                              })
                                            }}
                                          />
                                        )}
                                        <SortGroup namespace={`tasks:${navigation.hydraId}`} id={`tasks:${navigation.hydraId}:${c.id}`} items={items.map(item => item.id)}>
                                          <ProjectTasks
                                            items={items}
                                            render={({ card: item }) => (
                                              <TaskFamily
                                                card={item}
                                                hydraId={navigation.hydraId}
                                                state={state}
                                                actions={actions}
                                                selected={expandedIds}
                                                preview={preview}
                                                // eslint-disable-next-line pnyx/object-params -- The library owns this callback signature.
                                                renderCard={family => renderCard({
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
                              }}
                            />
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
                data-settings-hydra={navigation.hydraId}
                hidden={!active || page !== 'settings'}
                style={runtimeStyle(fontSizes)}
              >
                <ProfileSurface name="settings" hydraId={navigation.hydraId}>
                  <SettingsPage
                    hydras={navigation.hydras}
                    commandFor={hydra.commandFor}
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
                    showConfirmation={() => {
                      if (location.pathname !== `/hydra/${encodeURIComponent(navigation.hydraId)}/settings/`) {
                        return
                      }

                      save({ patch: { workspace: { chatCollapsed: false } } })
                        .catch(error => notify({ text: String(error) }))
                      openChat({ id: navigation.hydraId })
                        .catch((error: Error) => notify({ text: error.message }))
                    }}
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
        </motion.div>
      </HydraComposerSources>
    </KeyboardProvider>
  )
}
