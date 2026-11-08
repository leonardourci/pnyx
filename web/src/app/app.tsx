import { HYDRA_MARK } from '#hydra/hydra-names.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { taskMention } from '#hydra/mentions.ts'
import { viewFor } from '#preferences/view.ts'
import { pickView } from '#settings/settings.ts'
import { lockedColumn } from '#tasks/column-rules.ts'
import type { Card } from '#tasks/model.ts'
import { UPGRADE_COMMAND } from '#upgrade/model.ts'
import { useStoredComments } from '#web-hydra/comments-store.ts'
import { HydraComposerSources } from '#web-hydra/composer-sources.tsx'
import { HydraChat } from '#web-hydra/hydra-chat.tsx'
import { HydraLabel } from '#web-hydra/hydra-title.tsx'
import { storageKey } from '#web-hydra/outbox.ts'
import { Oracle } from '#web-oracle/oracle.tsx'
import { useHydraKeyboard } from '#web-preferences/keyboard-hydra.tsx'
import { focusElement,KeyboardProvider } from '#web-preferences/keyboard-registry.tsx'
import { useSaveView } from '#web-preferences/save-view.ts'
import { useViewTheme } from '#web-preferences/view-theme.ts'
import { useProjectFilter } from '#web-projects/project-filter.ts'
import { useProjectsResource } from '#web-projects/project-resource.ts'
import { SettingsPage } from '#web-settings/settings-page.tsx'
import { useSharedSettings } from '#web-settings/shared-settings.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { PendingStatus } from '#web-shared/ui/pending-status.tsx'
import { useScrollingClass } from '#web-shared/use-scrolling-class.ts'
import { HydraCard } from '#web-tasks/card.tsx'
import { Column } from '#web-tasks/column.tsx'
import { Detail } from '#web-tasks/detail.tsx'
import { argument } from '#web-tasks/optimistic.ts'
import { TaskCreate,type TaskDraft } from '#web-tasks/task-create.tsx'
import { useTaskNavigation } from '#web-tasks/task-navigation.ts'
import { TaskReferencesProvider } from '#web-tasks/task-reference.tsx'
import { useTaskReferences } from '#web-tasks/task-references.ts'
import { ACCOUNT_SETTINGS } from '#web-workers/account-model-picker.tsx'
import { useInstallationPending } from '#web-workers/dispatch-resource.ts'
import { useCallback,useEffect,useRef,useState,type CSSProperties } from 'react'
import { useHydra } from './connection.ts'
import { useHydraEdits } from './hydra-edits.ts'
import { useHydraFavicon } from './hydra-favicon.ts'
import { Hydras } from './hydras.tsx'
import { Panel } from './panel.tsx'
import { hydraViews,restoreView,usePersistView } from './restore.ts'
import { hydraTitle,pageTitle } from './view.ts'

export function App() {
  const hydra = useHydra()

  return <HydraView key={hydra.viewKey} hydra={hydra} />
}

function HydraView({ hydra }: { hydra: ReturnType<typeof useHydra> }) {
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
        setPage('hydra')
        const frame = requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.hydra-chat textarea')?.focus())

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
  const restoreKey = storageKey({ key: 'restore' })
  const commentsKey = storageKey({
    key: 'comments',
    hydraId: navigation.hydraId,
  })
  const [restored] = useState(() => hydraViews.get(hydra.viewKey)
    ?? restoreView({ key: restoreKey }))
  const [
    page,
    setPage,
  ] = useState(() => new URLSearchParams(location.search).has('settings') || restored.page === 'settings' ? 'settings' : 'hydra')
  const [
      selectedRef,
      setActive,
    ] = useState<string | null>(new URLSearchParams(location.search).has('open-project') ? null : restored.selected ?? restored.expanded?.at(-1) ?? null), [
      drafts,
      setDrafts,
    ] = useState<Record<string,string>>(restored.drafts ?? {}), [
      notice,
      setNotice,
    ] = useState<{ text: string } | null>(null), [
      newColumn,
      setNewColumn,
    ] = useState<string | null>(null)
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
  const [
    expanded,
    setExpanded,
  ] = useState<string[]>(new URLSearchParams(location.search).has('open-project')
    ? [] : restored.expanded ?? (restored.selected ? [restored.selected] : []))
  const [
    revealed,
    setRevealed,
  ] = useState<{
    scope: string
    ids: string[]
  }>(restored.revealed ?? {
    scope: '',
    ids: [],
  })
  const {
    comments,
    setComments,
  } = useStoredComments({ commentsKey })
  const [
    creatingTask,
    setCreatingTask,
  ] = useState<{
    column: string
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
  const [
    panel,
    setPanel,
  ] = useState(restored.panel ?? true)
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
        const requested = (event as CustomEvent<{ harness?: 'claude' | 'codex' }>).detail.harness
        setAccountSetup(requested ?? 'claude')
        setSettingsQuery('Accounts')
        setPage('settings')
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
  const {
    project,
    projectReferences,
    resolveProject,
    filterProject,
  } = useProjectFilter()
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
  const edits = useHydraEdits({
    hydras: navigation.hydras,
    command,
    notify,
  })
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
    columns,
    cancelOpen,
    clearSelection,
    expand,
    open,
    revealTask,
    close,
    openHydra,
  } = useTaskNavigation({
    state,
    selectedRef,
    setActive,
    expanded,
    setExpanded,
    revealed,
    setRevealed,
    page,
    setPage,
    project,
    projectReferences,
  })
  usePersistView({
    viewKey: hydra.viewKey,
    key: restoreKey,
    selected,
    expanded,
    revealed,
    page,
    panel,
    drafts,
    scroll: restored.scroll,
    seq: state.seq,
  })
  const shared = useSharedSettings()
  const view = viewFor({
    state,
    settings: shared && pickView({ view: shared }),
  })
  const references = useTaskReferences({
    state,
    actions,
    connected,
  })
  useViewTheme({ view })

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
    needsYou: columns.find(c => c.role === 'needs_you')?.id,
    hydra: shownHydra && hydraTitle(shownHydra),
  })
  useHydraFavicon({ icon: shownHydra?.icon })
  useEffect(
    () => {
      document.title = title
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
    parent,
  }: {
    column: string
    parent?: string
  }) => {
    setPage('hydra'); filterProject({ path: '' }); clearSelection()
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
      attempt: argument({
        args: refused.patch.args,
        flag: '--event-id',
      }) ?? refused.id,
    }
    setCreatingTask({
      column,
      version: taskFormVersion.current,
      draft,
      ...(parent ? { parent } : {}),
    })
    requestAnimationFrame(() => requestAnimationFrame(() => focusElement({ selector: '.task-create [aria-label="Task title"]' })))
  }

  const createColumn = () => {
    const id = `custom:${crypto.randomUUID()}`
    setPage('hydra'); setNewColumn(id)
    void command({
      name: 'column',
      args: [
        'create',
        '--id',
        id,
        '--title',
        'New column',
        '--if-revision',
        String(state.configRevision ?? 0),
        '--event-id',
        crypto.randomUUID(),
      ],
    }).catch((error: Error) => {
      setNewColumn(current => current === id ? null : current)
      notify({ text: error.message })
    })
  }

  const keyboard = useHydraKeyboard({
    state,
    groups: columns.map(c => ({
      id: c.id,
      cards: cards.filter(card => card.column === c.id).map(card => card.id),
    })),
    page,
    setPage: ({ page }) => setPage(page),
    selected,
    open,
    close,
    command,
    connected,
    notify,
    newColumn: newColumn !== null,
    cancelColumn: () => setNewColumn(null),
    togglePanel: () => setPanel(shown => !shown),
    openSettings: () => {
      if (page === 'settings') {
        setPage('hydra')

        return
      }

      openSettings({ query: settingsQuery })
    },
  })

  const answerTask = ({ card }: { card: Card }) => {
    setPanel(true)
    setDrafts(drafts => ({
      ...drafts,
      [HYDRA_CARD]: `${drafts[HYDRA_CARD] || ''}\nFor ${taskMention({
        id: card.id,
        title: card.title,
      })}: `.trimStart(),
    }))
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.hydra-chat textarea')?.focus())
  }

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
    setAccountSetup(undefined); setSettingsQuery(query); setPage('settings')
    requestAnimationFrame(() => focusElement({ selector: '.settings-page .search-bar-input' }))
  }

  const selectProject = ({ path }: { path: string }) => {
    filterProject({ path }); clearSelection(); setPage('hydra')
  }

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
  const others = edits.hydras.filter(h => h.id !== navigation.hydraId)
  const otherProjects = others.flatMap(h => h.projects.map(p => ({
    name: p.name,
    path: p.path,
    hydra: hydraTitle(h),
  })))

  const addProject = async ({ id }: { id: string }) => {
    if (id === navigation.hydraId) {
      setPage('hydra'); setProjectRequest(true)

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

  return (
    <KeyboardProvider
      prefs={view.keyboard}
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
          className="app"
          data-seq={state.seq}
          data-connected={connected}
          style={{
            '--text-ui': `${view.fontSize}px`,
            '--text-chat': `${view.chatFontSize}px`,
            '--text-code': `${view.codeFontSize}px`,
          } as CSSProperties}
        >
          <Panel
            shown={panel}
            connected={connected}
            offline={offline}
            upgrade={upgrade}
            startUpgrade={startUpgrade}
            page={page}
            navigate={({ page }) => {
              setSettingsQuery(''); setPage(page)
            }}
            oracle={(
              <Oracle
                state={state}
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
                openTask={open}
                answerTask={answerTaskById}
                openHydra={openHydra}
                selectProject={selectProject}
                openSettings={openSettings}
                createTask={createTask}
                createColumn={createColumn}
                action={keyboard.onAction}
                hydras={askTargets}
                send={askHydra}
                openChat={openChat}
              />
            )}
          >
            <Hydras
              createHydra={hydra.createHydra}
              editHydra={edits.edit}
              moveHydra={edits.move}
              command={command}
              connected={connected}
              notify={notify}
              hydras={edits.hydras}
              current={navigation.hydraId}
              navigate={navigate}
              loading={!!loading}
              project={project}
              resolveProject={resolveProject}
              selectProject={({ path }) => {
                filterProject({ path: project === path ? '' : path }); clearSelection(); setPage('hydra')
              }}
              showHydra={() => {
                setPage('hydra'); filterProject({ path: '' })
              }}
              addProject={addProject}
            />
          </Panel>
          <main
            className="shell"
            aria-busy={!!loading || !loaded}
            data-hydra={navigation.hydraId}
            data-provisional={hydra.creating || undefined}
          >
            {(loading || !loaded) && (
              <p className="loading-status" role="status">
                {hydra.creating ? 'Creating Hydra' : <>Loading {opening ? <HydraLabel name={opening.name} icon={opening.icon} size={14} /> : 'Hydra'}</>}…
              </p>
            )}
            {error && <p className="error-banner" role="alert">{error} <Button onClick={hydra.retryHydra}>Retry connection</Button></p>}
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
                    queue={hydraQueue}
                    command={command}
                    connected={connected}
                    openTask={revealTask}
                    notify={notify}
                    view={view}
                    save={save}
                    draft={drafts[HYDRA_CARD] ?? ''}
                    setDraft={({ text }) => setDrafts(d => ({
                      ...d,
                      [HYDRA_CARD]: text,
                    }))}
                    comments={comments[HYDRA_CARD] ?? []}
                    // eslint-disable-next-line pnyx/object-params -- React state setter callback contract.
                    setComments={({ items }) => setComments(c => ({
                      ...c,
                      [HYDRA_CARD]: items,
                    }))}
                  />
                  <TaskReferencesProvider references={references} openTask={revealTask}>
                    <div className="hydra-main">
                      <div className="work-area inline">
                        <div className="hydra-space">
                          <div className="kanban" aria-label="Work columns">
                            {columns.map(c => {
                              const items = cards.filter(card => card.column === c.id)

                              return (
                                <Column
                                  key={c.id}
                                  {...c}
                                  cards={items}
                                  view={view}
                                  save={save}
                                  command={command}
                                  notify={notify}
                                  revision={state.configRevision ?? 0}
                                  connected={connected}
                                  columnIds={columns.map(c => c.id)}
                                  locked={lockedColumn({
                                    state,
                                    id: c.id,
                                  })}
                                  editingTitle={newColumn === c.id}
                                  titleFinished={() => setNewColumn(null)}
                                  createTask={createTask}
                                >
                                  {creatingTask?.column === c.id && (
                                    <TaskCreate
                                      key={`${c.id}:${creatingTask.parent ?? ''}`}
                                      {...creatingTask}
                                      before={items[0]?.id}
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
                                        setActive(current => current === key ? null : current)
                                        setExpanded(ids => ids.filter(id => id !== key))
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
                                    <HydraCard
                                      key={item.key}
                                      card={item}
                                      state={state}
                                      labelColors={state.labelColors}
                                      doneAfterHours={shared?.doneAfterHours}
                                      notify={notify}
                                      latest={latest[item.id]}
                                      action={actions[item.id]}
                                      answer={answerTask}
                                      selected={expandedIds.includes(item.id)}
                                      onEdit={cancelOpen}
                                      recoverSelection={({ id }) => {
                                        setActive(current => current ?? id)
                                        setExpanded(ids => ids.length ? ids : [id])
                                      }}
                                      view={view}
                                      save={save}
                                      open={({
                                        id,
                                        pointer,
                                        focusPanel,
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
                                      }}
                                      command={command}
                                      connected={connected}
                                      tabIndex={
                                        (items.some(i => i.id === keyboard.remembered[c.id])
                                          ? keyboard.remembered[c.id]
                                          : items[0]?.id) === item.id ? 0 : -1
                                      }
                                    >
                                      {expandedIds.includes(item.id) && (
                                        <Detail
                                          card={item}
                                          state={state}
                                          command={command}
                                          connected={connected}
                                        />
                                      )}
                                    </HydraCard>
                                  ))}
                                </Column>
                              )
                            })}
                            <div className="add-column">
                              <Button
                                disabled={!connected}
                                onClick={createColumn}
                              ><Icon name="plus" />Add column
                              </Button>
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
