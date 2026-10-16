import { Icon } from '../components/ui/icon.tsx'
import { useEffect, useState } from 'react'
import type { HydraSummary } from '../../../src/server/hydras.ts'
import { Button } from '../components/ui/controls.tsx'
import { InlineTitle } from '../components/ui/inline-title.tsx'
import type { Command } from './connection.ts'

export function Hydras({
  command, connected, notify, hydras, current, project, resolveProject, selectProject,
  showHydra, addProject,
}: {
  command: Command
  connected: boolean
  hydras: HydraSummary[]
  current: string
  project: string
  resolveProject({ references }: { references: string[] }): void
  selectProject({ path }: { path: string }): void
  showHydra(): void
  addProject(): void
  notify({ text }: { text: string }): void
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState(false)
  useEffect(() => {
    const chosen = hydras.find(h => h.id === current)?.projects.find(p => p.path === project)
    resolveProject({ references: chosen?.references ?? [project] })
  }, [hydras, current, project, resolveProject])

  useEffect(() => {
    const target = new URLSearchParams(location.search).get('open-hydra')

    if (!connected || !target) {
      return
    }

    const clean = new URL(location.href)
    clean.searchParams.delete('open-hydra'); history.replaceState(null, '', clean)
    void command({ name: 'hydras', args: ['open', target] }).then(r => location.assign(r.url as string), (e: Error) => notify({ text: e.message }))
  }, [connected, command, notify])

  const go = ({ args, path, projects = false }: {
    args: string[]
    path?: string
    projects?: boolean
  }) => {
    setBusy(true)
    void command({ name: 'hydras', args }).then(r => {
      const url = new URL(r.url as string)

      if (path) {
        url.searchParams.set('open-project', path)
      }

      if (projects) {
        url.searchParams.set('projects', '1')
      }

      if (args[0] === 'create') {
        url.searchParams.set('new-chat', '1')
      }

      location.assign(url)
    }, (e: Error) => {
      setBusy(false); notify({ text: e.message })
    })
  }

  return (
    <section className="hydras-panel" aria-label="Hydras">
      <div className="hydras-heading"><h2>Hydras</h2>
        <Button aria-label="Create Hydra" disabled={!connected || busy} onClick={() => go({ args: ['create'] })}><Icon name="plus" /></Button>
      </div>
      <div className="hydras-tree">
        {hydras.map(h => {
          const active = h.id === current, open = expanded[h.id] ?? active

          return (
            <div key={h.id} className="hydra-branch">
              <div className="hydra-row">
                <Button
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${h.name}`}
                  aria-expanded={open}
                  aria-controls={`projects-${h.id}`}
                  onClick={() => setExpanded(e => ({ ...e, [h.id]: !open }))}
                ><Icon name={open ? 'chevron_down' : 'chevron_right'} />
                </Button>
                {active && renaming ? (
                  <InlineTitle
                    value={h.name}
                    label={`Rename Hydra ${h.name}`}
                    startEditing
                    finished={() => setRenaming(false)}
                    save={({ title }) => command({ name: 'hydras', args: ['rename', h.id, title] })}
                  />
                ) : (
                  <Button
                    className="hydra-name"
                    data-hydra-current={active ? '' : undefined}
                    aria-current={active ? 'page' : undefined}
                    disabled={!connected || busy}
                    onDoubleClick={() => active && setRenaming(true)}
                    onClick={() => active ? showHydra() : go({ args: ['open', h.id] })}
                  ><Icon name="hydra" size={20} />{h.name}
                  </Button>
                )}
              </div>
              {open && (
                <div className="hydra-projects" id={`projects-${h.id}`}>
                  {h.projects.map(p => (
                    <Button
                      key={p.path}
                      className="panel-project"
                      title={p.path}
                      aria-pressed={active && project === p.path}
                      disabled={!connected || busy}
                      onClick={() => active ? selectProject({ path: p.path }) : go({ args: ['open', h.id], path: p.path })}
                    >
                      <span>{p.name}</span>
                      <small aria-label={`${p.live} live, ${p.asks} asks`}><span>{p.live} live</span><span className={p.asks ? 'project-asks' : ''}>{p.asks} asks</span></small>
                    </Button>
                  ))}
                  <Button className="add-project" disabled={!connected || busy} onClick={() => active ? addProject() : go({ args: ['open', h.id], projects: true })}><Icon name="plus" />Add project</Button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
