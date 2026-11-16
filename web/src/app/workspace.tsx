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
import { useProjectsResource } from '#web-projects/project-resource.ts'
import { SettingsPage } from '#web-settings/settings-page.tsx'
import { useSharedSettings } from '#web-settings/shared-settings.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { scrollBehavior } from '#web-shared/ui/smooth-scroll.ts'
import { Icon } from '#web-shared/ui/icon.tsx'
import { PendingStatus } from '#web-shared/ui/pending-status.tsx'
import { useKept,useStableActions } from '#web-shared/stable.ts'
import { useScrollingClass } from '#web-shared/use-scrolling-class.ts'
import { HydraCard } from '#web-tasks/card.tsx'
import { ProjectCounts } from '#web-tasks/project-counts.tsx'
import { ProjectColumn } from '#web-tasks/project-column.tsx'
import { WorkerChat } from '#web-tasks/worker-chat.tsx'
import { TaskFamily, type FamilyCard } from '#web-tasks/task-family.tsx'
import { expandedTaskWidth } from '#web-tasks/project-layout.ts'
import { projectColumns, taskProjectColumn, statusPriority, IDEAS_COLUMN, type ProjectColumnData } from '#web-tasks/project-view.ts'
import { Detail } from '#web-tasks/detail.tsx'
import { argument } from '#web-tasks/optimistic.ts'
import { TaskCreate,type TaskDraft } from '#web-tasks/task-create.tsx'
import { useTaskNavigation } from '#web-tasks/task-navigation.ts'
import { TaskReferencesProvider } from '#web-tasks/task-reference.tsx'
import { useTaskReferences } from '#web-tasks/task-references.ts'
import { ACCOUNT_SETTINGS } from '#web-workers/account-model-picker.tsx'
import { useInstallationPending } from '#web-workers/dispatch-resource.ts'
import { useCallback,useEffect,useMemo,useRef,useState,type CSSProperties } from 'react'
import { useHydra } from './connection.ts'
import { useHydraEdits } from './hydra-edits.ts'
import { movedOrder, type PhysicalMove } from '#web-shared/ui/physical-drag.ts'
import { HydraChips } from './hydra-chips.tsx'
import { Panel } from './panel.tsx'
import { hydraViews,openingView,restoreView,showingPage,usePersistView } from './restore.ts'
import { hydraTitle,pageTitle } from './view.ts'

export function HydraView({
  hydra,
  active,
  edits,
  preview,
}: {
  hydra: ReturnType<typeof useHydra>
  active: boolean
  edits: ReturnType<typeof useHydraEdits>
  preview: PhysicalMove | null
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
  const { intents: projectPending } = useProjectsResource({
    command,
    connected,
    revision: state.projectsRevision,
  })
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
  ] = useState(() => openingView({ restored }))
  const {
    page,
    panel,
    selected: selectedRef,
    expanded,
    revealed,
  } = pageView
  const setPage = ({ page }: { page: string }) => setPageView(view => showingPage({
    view,
    page,
  }))
  const [
    notice,
    setNotice,
  ] = useState<{ text: string } | null>(null)
  const [
    settingsVisited,
    setSettingsVisited,
  ] = useState(page === 'settings')
  useEffect(
    () => {
      if (page === 'settings') {
        setSettingsVisited(true)
      }
    },
    [page],
  )
  // The view persistence reads the same record the chat's saves write into.
  const drafts = useRef<Record<string, string>>(restored.drafts ?? {})
  const chatDrafts = useChatDrafts({
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
  ] = useState<{
    column: string
    project?: string
    group?: string
    parent?: string
    draft?: TaskDraft
    version: number
  } | null>(null)
  const taskFormVersion = useRef(0)
  // Another Hydra's Add project request waits in the URL until that Hydra opens.
  const [
    projectRequest,
    setProjectRequest,
  ] = useState(new URLSearchParams(location.search).has('add-project'))
  // The search Settings opens with when the Oracle sends a setting there; it also remounts the page for it.
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
    [],
  )
  useEffect(
    () => {
      if (page !== 'settings') {
        setAccountSetup(undefined)
      }
    },
    [page],
  )
  // The Oracle's palette draws inside the page, so it takes the page's text sizes.
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
  useEffect(
    () => {
      if (projectRequest && state.config?.hydra.kind === 'firstmate') {
        notify({ text: 'Firstmate manages this Hydra’s projects.' }); setProjectRequest(false)
      }
    },
    [
      projectRequest,
      state.config?.hydra.kind,
      notify,
    ],
  )
  useScrollingClass()
  const {
    selected,
    expandedIds,
    cards,
    columns: statusColumns,
    cancelOpen,
    clearSelection,
    expand,
    open,
    revealTask,
    close,
    openHydra,
  } = useTaskNavigation({
    state,
    hydraId: navigation.hydraId,
    command,
    connected,
    notify,
    view: pageView,
    setView: setPageView,
    project: '',
    projectReferences: [],
  })
  usePersistView({
    workspace: navigation.hydraId,
    viewKey: hydra.viewKey,
    key: restoreKey,
    selected,
    expanded,
    revealed,
    page,
    panel,
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
    cards: state.cards,
    selected,
    needsYou: statusColumns.find(c => c.role === 'needs_you')?.id,
    hydra: shownHydra && hydraTitle(shownHydra),
  })
  useEffect(
    () => {
      if (active) {
        document.title = title
      }
    },
    [title],
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

      return intent.stage === 'refused' && name === 'task' && args[0] === 'create'
        && matchesForm && !state.keys[`task:${attempt}`]
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
      column,
      project,
      group,
      version: taskFormVersion.current,
      draft,
      ...(parent ? { parent } : {}),
    })
    requestAnimationFrame(() => requestAnimationFrame(() => focusElement({ selector: '.task-create [aria-label="Task title"]' })))
  }

  const baseColumns = projectColumns({
    state,
    cards,
    actions,
    order: view.workspace.projectOrder,
  })
  const columns = preview?.kind === 'project' && preview.hydra === navigation.hydraId
    ? movedOrder({
      items: baseColumns,
      ...preview,
      key: ({ item }) => item.id,
    }) : baseColumns

  if (preview?.kind === 'task' && preview.hydra === navigation.hydraId && !preview.nest && preview.scope === preview.targetScope) {
    for (const column of columns) {
      column.cards = movedOrder({
        items: column.cards,
        ...preview,
        key: ({ item }) => item.id,
      })
    }
  }

  const queuedColumn = statusColumns.find(column => column.role === 'queued')?.id ?? statusColumns[0]!.id

  const createColumn = () => {
    setPage({ page: 'hydra' }); setProjectRequest(true)
  }

  const keyboard = useHydraKeyboard({
    state,
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
    togglePanel: () => setPageView(view => ({
      ...view,
      panel: !view.panel,
    })),
    openSettings: () => {
      if (page === 'settings') {
        setPage({ page: 'hydra' })

        return
      }

      openSettings({ query: settingsQuery })
    },
  })

  const answerTask = ({ card }: { card: Card }) => {
    setPageView(view => ({
      ...view,
      panel: true,
    }))
    chatDrafts.setDraft({
      text: `${chatDrafts.read().text}\nFor ${taskMention({
        id: card.id,
        title: card.title,
      })}: `.trimStart(),
    })
    requestAnimationFrame(() => layer?.querySelector<HTMLTextAreaElement>('.hydra-chat textarea')?.focus())
  }

  // Board cards redraw only for their own changes, so what they call keeps its identity.
  const cardActions = useStableActions({
    actions: {
      notify,
      answer: answerTask,
      onEdit: cancelOpen,
      save,
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
      }: {
        id: string
        pointer?: boolean
        focusPanel?: boolean
      }) => {
        if (expandedIds.includes(id)) {
          close({ id })

          return Promise.resolve(false)
        }

        return open({
          id,
          pointer,
          focusPanel,
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
    requestAnimationFrame(() => focusElement({ selector: '.settings-page .search-bar-input' }))
  }

  const selectProject = ({ path }: { path: string }) => {
    setPage({ page: 'hydra' })
    const project = state.projects?.find(project => project.path === path || project.name === path)
    const id = project?.group?.id ?? project?.path ?? path
    save({
      patch: {
        workspace: {
          collapsed: false,
          foldedProjects: view.workspace.foldedProjects.filter(item => item !== id),
        },
      },
    })
    requestAnimationFrame(() => layer?.querySelector<HTMLElement>(`[data-column="${CSS.escape(id)}"]`)
      ?.scrollIntoView({
        behavior: scrollBehavior(),
        inline: 'start',
        block: 'nearest',
      }))
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
    if (id === navigation.hydraId) {
      openHydra()

      return
    }

    try {
      await navigate({
        url: new URL(
          `/hydra/${encodeURIComponent(id)}/`,
          location.href,
        ).href,
      })
      requestAnimationFrame(() => focusElement({ selector: '.hydra-chat textarea' }))
    } catch (error) {
      notify({ text: error instanceof Error ? error.message : String(error) })
    }
  }

  // The Oracle names the Hydra as its list does, never by its id.
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

  const addProject = async ({ id }: { id: string }) => {
    if (id === navigation.hydraId) {
      setPage({ page: 'hydra' }); setProjectRequest(true)

      return
    }

    const url = new URL(
      `/hydra/${encodeURIComponent(id)}/`,
      location.href,
    )
    url.searchParams.set(
      'add-project',
      '1',
    )

    try {
      await navigate({ url: url.href })
    } catch (error) {
      notify({ text: (error as Error).message })
    }
  }

  const revealProject = ({ id }: { id: string }) => {
    save({
      patch: {
        workspace: {
          collapsed: false,
          foldedProjects: view.workspace.foldedProjects.filter(item => item !== id),
        },
      },
    })
    requestAnimationFrame(() => {
      const selector = `[data-column="${CSS.escape(id)}"]`
      layer?.querySelector<HTMLElement>(selector)?.scrollIntoView({
        behavior: scrollBehavior(),
        inline: 'start',
        block: 'nearest',
      })
    })
  }

  const toggleAllProjects = () => {
    const allProjectIds = columns.map(column => column.id)
    const foldedProjects = view.workspace.foldedProjects.length ? [] : allProjectIds
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
    const opened = expandedIds.includes(item.id)
    const parent = item.parentId ? state.cards[item.parentId] : undefined
    const crossProject = !!parent && parent.project !== item.project
    const legacyProject = !!item.project && !state.projects?.some(project =>
      project.path === item.project || project.name === item.project)
    const showProject = column.repositories.length > 1 || crossProject || legacyProject

    return (
      <HydraCard
        key={item.key}
        card={item}
        sortScope={`${navigation.hydraId}:${column.id}:${statusPriority({ status: family.status })}:${item.parentId ?? 'root'}`}
        statusOverride={family.status}
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
        onEdit={cardActions.onEdit}
        recoverSelection={cardActions.recoverSelection}
        view={cardView}
        save={cardActions.save}
        open={cardActions.open}
        command={command}
        connected={connected}
        tabIndex={0}
        chat={opened && (
          <WorkerChat
            hydraId={navigation.hydraId}
            card={item}
            state={state}
            live={hydra.taskThreads[item.id]}
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
        connected={connected}
        references={references}
        openTask={revealTask}
        notify={notify}
        otherProjects={otherProjects}
      >
        <div
          ref={setLayer}
          className="app hydra-workspace"
          data-hydra-workspace={navigation.hydraId}
          data-active={active}
          data-collapsed={view.workspace.collapsed}
          data-seq={state.seq}
          data-connected={connected}
          style={{
            '--text-ui': `${view.fontSize}px`,
            '--text-chat': `${view.chatFontSize}px`,
            '--text-code': `${view.codeFontSize}px`,
          } as CSSProperties}
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
                openHydra={openHydra}
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
            )}
          >
            <HydraChips
              hydras={edits.hydras}
              current={navigation.hydraId}
              navigate={navigate}
              createHydra={() => hydra.createHydra(pickName({
                taken: edits.hydras.map(item => item.name),
              }))}
            />
          </Panel>
          <header className="hydra-workspace-bar">
            <div
              data-sort-id={navigation.hydraId}
              data-sort-kind="hydra"
              data-sort-scope="hydras"
              className="hydra-drag-name"
            >
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
              <HydraLabel name={shownHydra?.name ?? ''} icon={shownHydra?.icon} size={20} />
            </div>
            <nav className="project-chips" aria-label="Projects">
              {columns.map(column => (
                <Button
                  key={column.id}
                  data-sort-id={column.id}
                  data-sort-kind="project"
                  data-sort-scope="projects"
                  data-sort-disabled={column.id === IDEAS_COLUMN}
                  onClick={() => revealProject({ id: column.id })}
                >{column.title}<ProjectCounts asks={column.asks} running={column.running} />
                </Button>
              ))}
            </nav>
            <Button aria-label="Fold all projects" onClick={toggleAllProjects}>
              <Icon name="fold_columns" />
            </Button>
            <Button
              aria-label={view.workspace.collapsed ? 'Unfold Hydra' : 'Fold Hydra'}
              onClick={toggleHydra}
            ><Icon name="chevron_right" />
            </Button>
          </header>
          <main
            hidden={view.workspace.collapsed}
            className="shell"
            aria-busy={!!loading || !loaded}
            data-hydra={navigation.hydraId}
            data-provisional={hydra.creating || undefined}
          >
            {(loading || !loaded || hydra.offline) && (
              <p className="loading-status" role="status">
                {hydra.offline && 'Connection lost. Reconnecting automatically.'}
                {!hydra.offline && <>{hydra.creating ? 'Creating Hydra' : <>Loading {opening ? <HydraLabel name={opening.name} icon={opening.icon} size={14} /> : 'Hydra'}</>}…</>}
              </p>
            )}
            {error && <p className="error-banner" role="alert">{error} <Button onClick={hydra.dismissError}>Dismiss</Button></p>}
            {hydra.recovery && (
              <p className="error-banner" role="alert">
                {hydra.recovery.message}
                {hydra.recovery.action === 'retry' && <Button onClick={hydra.retryHydra}>{retryLabel}</Button>}
                {hydra.recovery.action === 'reload' && <Button onClick={() => location.reload()}>Reload page</Button>}
              </p>
            )}
            {checking && <p className="save-checking loading-status" role="status">Checking whether your changes were saved. Retrying automatically.</p>}
            <PendingStatus
              intents={[
                ...hydra.intents,
                ...installationPending,
                ...projectPending,
              ]}
            />
            {page === 'hydra' && (
              <>
                <div className="hydra-page">
                  <div className={`workspace-chat ${view.workspace.chatCollapsed ? 'collapsed' : ''}`}>
                    <Button
                      className="chat-fold"
                      aria-label={view.workspace.chatCollapsed ? 'Unfold chat' : 'Fold chat'}
                      onClick={toggleChat}
                    ><Icon name="chevron_right" />
                    </Button>
                    <div className="chat-content" hidden={view.workspace.chatCollapsed}>
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
                        addProject={() => addProject({ id: navigation.hydraId })}
                        projectRequest={projectRequest}
                        projectRequested={() => setProjectRequest(false)}
                        state={state}
                        liveThread={hydraThread}
                        action={actions[HYDRA_CARD]}
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
                    </div>
                  </div>

                  <TaskReferencesProvider references={references} openTask={revealTask}>
                    <div className="hydra-main">
                      <div className="work-area inline">
                        <div className="hydra-space">
                          <div className="kanban" aria-label="Work columns">
                            {columns.map(c => {
                              const items = c.cards
                              const openIds = expandedIds.filter(id => {
                                const card = state.cards[id]

                                return card && taskProjectColumn({
                                  state,
                                  card,
                                }) === c.id
                              })

                              const openedWidths = openIds.map(id => expandedTaskWidth({
                                card: state.cards[id]!,
                                widths: view.workspace.cardWidths,
                              }))
                              const expandedWidth = Math.max(
                                0,
                                ...openedWidths,
                              )

                              return (
                                <ProjectColumn
                                  key={c.id}
                                  column={c}
                                  view={view}
                                  save={save}
                                  expandedWidth={expandedWidth}
                                  create={() => createTask({
                                    column: queuedColumn,
                                    project: c.repositories.length === 1
                                      ? c.repositories[0] : undefined,
                                    group: c.id,
                                  })}
                                >
                                  {creatingTask?.group === c.id && (
                                    <TaskCreate
                                      key={`${c.id}:${creatingTask.parent ?? ''}`}
                                      {...creatingTask}
                                      repositories={c.repositories.map(path => ({
                                        value: path,
                                        label: path.split('/').at(-1) ?? path,
                                      }))}
                                      before={items.find(item => item.column === queuedColumn)?.id}
                                      command={command}
                                      connected={connected}
                                      notify={notify}
                                      cancel={() => setCreatingTask(null)}
                                      recover={({ draft }) => {
                                        if (taskFormVersion.current === creatingTask.version) {
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
                                      submitted={({ id }) => {
                                        setCreatingTask(null); expand({
                                          id,
                                          column: c.id,
                                        })
                                      }}
                                    />
                                  )}
                                  {items.map(item => (
                                    <TaskFamily
                                      key={item.key}
                                      card={item}
                                      state={state}
                                      actions={actions}
                                      selected={expandedIds}
                                      cardWidths={view.workspace.cardWidths}
                                      preview={preview}
                                      renderCard={({
                                        card,
                                        ...family
                                      }) => renderCard({
                                        card,
                                        ...family,
                                        column: c,
                                      })}
                                    />
                                  ))}
                                </ProjectColumn>
                              )
                            })}
                            <div className="add-column">
                              <Button disabled={!connected} onClick={createColumn}><Icon name="plus" />Project</Button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </TaskReferencesProvider>
                </div>
              </>
            )}
            {(settingsVisited || page === 'settings') && (
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
              />
            )}
          </main>
          {notice && (
            <div className="notice" role="status">
              <span>{notice.text}</span>
              <Button aria-label="Dismiss notification" onClick={() => setNotice(null)}>
                <Icon name="close" />
              </Button>
            </div>
          )}
        </div>
      </HydraComposerSources>
    </KeyboardProvider>
  )
}
