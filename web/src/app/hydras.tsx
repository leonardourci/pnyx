import { Icon } from '#web-shared/ui/icon.tsx'
import { useCallback, useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { HydraProjectSummary, HydraSummary } from '#app/server-hydras.ts'
import { HYDRA_MARK, pickName } from '#hydra/hydra-names.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { ContextMenu, DeleteItem, menuPoint, opensMenu } from '#web-shared/ui/menu.tsx'
import { HydraLabel, HydraNameEditor, type HydraIdentity } from '#web-hydra/hydra-title.tsx'
import type { Command } from './connection.ts'
import { hydraTitle } from './view.ts'

type MenuItem = {
  kind: 'hydra'
  hydra: HydraSummary
} | {
  kind: 'project'
  hydra: HydraSummary
  project: HydraProjectSummary
}
type MenuTarget = MenuItem & {
  at: {
    x: number
    y: number
  }
}

const identityOf = ({ hydra }: { hydra: HydraSummary }): HydraIdentity => ({
  name: hydra.name,
  icon: hydra.icon ?? HYDRA_MARK,
})

const otherNames = ({
  hydras,
  id,
}: {
  hydras: HydraSummary[]
  id?: string
}) => hydras.filter(h => h.id !== id).map(h => h.name)

export function Hydras({
  command,
  createHydra,
  editHydra,
  connected,
  notify,
  hydras,
  current,
  project,
  resolveProject,
  selectProject,
  showHydra,
  addProject,
  navigate,
  loading,
}: {
  loading: boolean
  createHydra({
    name,
    icon,
  }: HydraIdentity): Promise<void>
  editHydra({
    id,
    name,
    icon,
  }: HydraIdentity & { id: string }): void
  navigate({ url }: { url: string }): Promise<void>
  command: Command
  connected: boolean
  hydras: HydraSummary[]
  current: string
  project: string
  resolveProject({ references }: { references: string[] }): void
  selectProject({ path }: { path: string }): void
  showHydra(): void
  addProject({ id }: { id: string }): void
  notify({ text }: { text: string }): void
}) {
  const [
    expanded,
    setExpanded,
  ] = useState<Record<string, boolean>>({})
  const [
    editing,
    setEditing,
  ] = useState<string | null>(null)
  // A new Hydra's name is edited before it is created, so Enter, a click away and Esc all create it.
  const [
    drafting,
    setDrafting,
  ] = useState<HydraIdentity | null>(null)
  const [
    menu,
    setMenu,
  ] = useState<MenuTarget | null>(null)
  const closeMenu = useCallback(
    () => setMenu(null),
    [],
  )
  useEffect(
    () => {
      const chosen = hydras.find(h => h.id === current)?.projects.find(p => p.path === project)
      resolveProject({ references: chosen?.references ?? [project] })
    },
    [
      hydras,
      current,
      project,
      resolveProject,
    ],
  )

  useEffect(
    () => {
      const target = new URLSearchParams(location.search).get('open-hydra')

      if (!connected || !target) {
        return
      }

      const clean = new URL(location.href)
      clean.searchParams.delete('open-hydra'); history.replaceState(
        null,
        '',
        clean,
      )
      void navigate({ url: `/hydra/${encodeURIComponent(target)}/` }).catch((e: Error) => notify({ text: e.message }))
    },
    [
      connected,
      navigate,
      notify,
    ],
  )

  const openHydra = async ({
    id,
    path,
  }: {
    id: string
    path?: string
  }) => {
    const url = new URL(
      `/hydra/${encodeURIComponent(id)}/`,
      location.href,
    )

    if (path) {
      url.searchParams.set(
        'open-project',
        path,
      )
    }

    try {
      await navigate({ url: url.href })
    } catch (error) {
      notify({ text: (error as Error).message })
    }
  }

  const create = async ({
    name,
    icon,
  }: HydraIdentity) => {
    setDrafting(null)

    try {
      await createHydra({
        name,
        icon,
      })
    } catch (error) {
      notify({ text: (error as Error).message })
    }
  }

  const openMenu = ({
    event,
    target,
  }: {
    event: MouseEvent<Element> | KeyboardEvent<Element>
    target: MenuItem
  }) => {
    event.preventDefault()
    setMenu({
      ...target,
      at: menuPoint({ event: 'clientX' in event ? event : { currentTarget: event.currentTarget } }),
    })
  }

  const copyPath = async ({ path }: { path: string }) => {
    try {
      await navigator.clipboard.writeText(path)
      notify({ text: 'Path copied' })
    } catch {
      notify({ text: 'Could not copy the path' })
    }
  }

  const detach = async ({ path }: { path: string }) => {
    try {
      await command({
        name: 'project',
        args: [
          'remove',
          path,
        ],
      })
      notify({ text: 'Project detached. Tasks and history stay.' })
    } catch (error) {
      notify({ text: (error as Error).message })
    }
  }

  return (
    <section className="hydras-panel" aria-label="Hydras">
      <div className="hydras-heading"><h2>Hydras</h2>
        <Button
          aria-label="Create Hydra"
          disabled={!connected || !!drafting}
          onClick={() => setDrafting(pickName({ taken: otherNames({ hydras }) }))}
        ><Icon name="plus" />
        </Button>
      </div>
      <div className="hydras-tree">
        {hydras.map(h => {
          const active = h.id === current, isOpen = expanded[h.id] ?? active

          return (
            <div key={h.id} className="hydra-branch">
              <div className="hydra-row">
                <Button
                  aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${hydraTitle(h)}`}
                  aria-expanded={isOpen}
                  aria-controls={`projects-${h.id}`}
                  onClick={() => setExpanded(e => ({
                    ...e,
                    [h.id]: !isOpen,
                  }))}
                ><Icon name={isOpen ? 'chevron_down' : 'chevron_right'} />
                </Button>
                {editing === h.id ? (
                  <HydraNameEditor
                    saved={identityOf({ hydra: h })}
                    taken={otherNames({
                      hydras,
                      id: h.id,
                    })}
                    save={({
                      name,
                      icon,
                    }) => {
                      setEditing(null); editHydra({
                        id: h.id,
                        name,
                        icon,
                      })
                    }}
                    cancel={() => setEditing(null)}
                  />
                ) : (
                  <Button
                    className="hydra-name"
                    data-hydra-current={active ? '' : undefined}
                    aria-current={active ? 'page' : undefined}
                    title="Double-click or right-click to edit"
                    onDoubleClick={() => setEditing(h.id)}
                    onContextMenu={event => openMenu({
                      event,
                      target: {
                        kind: 'hydra',
                        hydra: h,
                      },
                    })}
                    onKeyDown={event => opensMenu({ event }) && openMenu({
                      event,
                      target: {
                        kind: 'hydra',
                        hydra: h,
                      },
                    })}
                    onClick={() => active && !loading ? showHydra() : openHydra({ id: h.id })}
                  ><HydraLabel name={h.name} icon={h.icon} />
                  </Button>
                )}
              </div>
              {isOpen && (
                <div className="hydra-projects" id={`projects-${h.id}`}>
                  {h.projects.map(p => (
                    <Button
                      key={p.path}
                      className="panel-project"
                      title={p.path}
                      aria-pressed={active && project === p.path}
                      disabled={!connected}
                      onContextMenu={event => openMenu({
                        event,
                        target: {
                          kind: 'project',
                          hydra: h,
                          project: p,
                        },
                      })}
                      onKeyDown={event => opensMenu({ event }) && openMenu({
                        event,
                        target: {
                          kind: 'project',
                          hydra: h,
                          project: p,
                        },
                      })}
                      onClick={() => active ? selectProject({ path: p.path }) : openHydra({
                        id: h.id,
                        path: p.path,
                      })}
                    >
                      <span>{p.name}</span>
                      <small aria-label={`${p.live} live, ${p.asks} asks`}><span>{p.live} live</span><span className={p.asks ? 'project-asks' : ''}>{p.asks} asks</span></small>
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {drafting && (
          <div className="hydra-branch">
            <div className="hydra-row">
              <span className="hydra-row-spacer" />
              <HydraNameEditor
                saved={drafting}
                taken={otherNames({ hydras })}
                save={create}
                cancel={() => create(drafting)}
              />
            </div>
          </div>
        )}
      </div>
      {menu?.kind === 'hydra' && (
        <ContextMenu label={`${hydraTitle(menu.hydra)} menu`} at={menu.at} close={closeMenu}>
          <Button disabled={!connected} onClick={() => setEditing(menu.hydra.id)}>Edit</Button>
          <Button
            disabled={!connected}
            onClick={() => addProject({ id: menu.hydra.id })}
          >Add project
          </Button>
        </ContextMenu>
      )}
      {menu?.kind === 'project' && (
        <ContextMenu label={`${menu.project.name} menu`} at={menu.at} close={closeMenu}>
          <Button onClick={() => copyPath({ path: menu.project.path })}>Copy path</Button>
          {menu.hydra.id === current && (
            <DeleteItem
              label="Detach…"
              disabled={!connected}
              confirm={() => detach({ path: menu.project.path }).finally(closeMenu)}
            />
          )}
        </ContextMenu>
      )}
    </section>
  )
}
