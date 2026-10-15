import { useCallback, useEffect, useState } from 'react'
import type { HydraProject, HydraState } from '../../../src/core/model.ts'
import { Button, Input, Switch, Textarea } from '../components/ui/controls.tsx'
import { ConfirmationDialog } from '../components/ui/confirmation-dialog.tsx'
import type { Command } from './connection.ts'

type ProjectRow = { name: string; path: string; state: string; startCommand?: HydraProject['startCommand'] }
type Confirmation = {
  token: string
  path: string
  hydras: { id: string; name: string; url: string }[]
}

function ProjectCommand({ project, disabled, command, refresh, notify }: {
  project: ProjectRow
  disabled: boolean
  command: Command
  refresh(): Promise<void>
  notify({ text }: { text: string }): void
}) {
  const [name, setName] = useState(project.startCommand?.name ?? '')
  const [shell, setShell] = useState(project.startCommand?.command ?? '')
  const [ownFolder, setOwnFolder] = useState(project.startCommand?.bringsOwnFolder ?? false)
  const [busy, setBusy] = useState(false)

  return (
    <form
      className="project-form"
      aria-label={`Start settings for ${project.name}`}
      onSubmit={e => {
        e.preventDefault(); setBusy(true)
        void command({ name: 'project', args: ['set', project.path, '--command-name', name, '--command', shell, '--brings-own-folder', String(ownFolder), '--event-id', crypto.randomUUID()] })
          .then(async () => {
            await refresh(); notify({ text: shell.trim() ? 'Project start command saved.' : 'Project start command cleared.' })
          })
          .catch((error: Error) => notify({ text: error.message }))
          .finally(() => setBusy(false))
      }}
    >
      <fieldset disabled={disabled || busy}>
        <label>Start command name<Input
          aria-label={`Start command name for ${project.name}`}
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Local worker"
          required={!!shell.trim()}
        />
        </label>
        <label>Command<Textarea
          aria-label={`Start command for ${project.name}`}
          value={shell}
          onChange={e => setShell(e.target.value)}
          rows={2}
          spellCheck={false}
          placeholder="Command to start a worker"
        />
        </label>
        <Switch label="Brings its own folder" checked={ownFolder} onChange={({ value }) => setOwnFolder(value)} />
        <p className="small muted">The command creates the worker’s folder when checked. Hydra can choose this command by name.</p>
        <Button type="submit" variant="surface">{busy ? 'Saving…' : 'Save start command'}</Button>
      </fieldset>
    </form>
  )
}

export function Projects({ state, connected, command, notify }: {
  state: HydraState
  connected: boolean
  command: Command
  notify({ text }: { text: string }): void
}) {
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [readonly, setReadonly] = useState(false)
  const [path, setPath] = useState(''), [url, setUrl] = useState(''), [into, setInto] = useState('')
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const refresh = useCallback(() => command({ name: 'project', args: ['list'] }).then(r => {
    setProjects(Array.isArray(r.projects) ? r.projects as ProjectRow[] : [])
    setReadonly(r.readonly === true); setLoading(false)
  }), [command])
  useEffect(() => {
    if (!connected) {
      setLoading(true)

      return
    }

    void refresh().catch((e: Error) => {
      setLoading(false); notify({ text: e.message })
    })
  }, [
    connected,
    state.projectsRevision,
    state.config?.hydra.home,
    state.config?.hydra.kind,
    refresh,
    notify,
  ])

  const run = ({ args }: { args: string[] }) => {
    setBusy(true)
    void command({ name: 'project', args }).then(async r => {
      if (r.confirmation === 'needed') {
        const preview = r.preview as { project: { path: string }; hydras: Confirmation['hydras'] }
        setConfirmation({
          token: r.token as string,
          path: preview.project.path,
          hydras: preview.hydras,
        })
      } else {
        setConfirmation(null); setPath(''); setUrl(''); setInto(''); await refresh()
        const text = args[0] === 'remove'
          ? 'Project detached. Tasks and history stay.' : 'Project attached.'
        notify({ text })
      }
    })
      .catch((e: Error) => notify({ text: e.message }))
      .finally(() => setBusy(false))
  }

  const row = ({ project: p }: { project: ProjectRow }) => (
    <li key={p.path} className={`project-row ${p.state === 'detached' ? 'detached' : ''}`}>
      <div className="project-details">
        <strong>{p.name}</strong><span className="project-path">{p.path}</span>
        {!readonly && p.state === 'attached' && (
          <ProjectCommand
            key={JSON.stringify(p.startCommand)}
            project={p}
            disabled={!connected || busy}
            command={command}
            refresh={refresh}
            notify={notify}
          />
        )}
      </div>
      {!readonly && <Button disabled={busy || !connected} aria-label={`${p.state === 'detached' ? 'Re-attach' : 'Detach'} ${p.name}`} onClick={() => run({ args: [p.state === 'detached' ? 'add' : 'remove', p.path] })}>{p.state === 'detached' ? 'Re-attach' : 'Detach'}</Button>}
    </li>
  )

  return (
    <section className="settings-box" aria-label="Projects">
      <h2>Projects</h2>
      {loading ? <p className="muted">Loading projects…</p> : (
        <>
          {readonly && (
            <>
              <p className="muted">Managed by Firstmate. Projects are read-only here.</p>
              <Button
                disabled={busy || !connected}
                onClick={() => {
                  void refresh().catch((e: Error) => notify({ text: e.message }))
                }}
              >Refresh projects
              </Button>
            </>
          )}
          {!projects.some(p => p.state === 'attached') && <p className="muted">No projects attached.</p>}
          <ul className="project-list">{projects.filter(p => p.state === 'attached').map(p => row({ project: p }))}</ul>
          {projects.some(p => p.state === 'detached') && <><h3>Detached</h3><ul className="project-list">{projects.filter(p => p.state === 'detached').map(p => row({ project: p }))}</ul></>}
          {!readonly && (
            <>
              <form
                className="project-form"
                onSubmit={e => {
                  e.preventDefault(); run({ args: ['add', path.trim()] })
                }}
              >
                <label className="setting-label" htmlFor="project-path">Folder path</label>
                <Input
                  id="project-path"
                  aria-label="Project folder path"
                  value={path}
                  onChange={e => setPath(e.target.value)}
                  placeholder="/path/to/project"
                  disabled={busy || !connected}
                  required
                />
                <Button type="submit" variant="surface" disabled={busy || !connected || !path.trim()}>Add project</Button>
              </form>
              <form
                className="project-form"
                onSubmit={e => {
                  e.preventDefault(); run({ args: ['add', '--clone', url.trim(), '--into', into.trim()] })
                }}
              >
                <label className="setting-label" htmlFor="project-url">Clone URL</label>
                <Input
                  id="project-url"
                  aria-label="Project clone URL"
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  disabled={busy || !connected}
                  required
                />
                <label className="setting-label" htmlFor="project-into">Destination folder</label>
                <Input
                  id="project-into"
                  aria-label="Project clone destination"
                  value={into}
                  onChange={e => setInto(e.target.value)}
                  disabled={busy || !connected}
                  required
                />
                <Button type="submit" variant="surface" disabled={busy || !connected || !url.trim() || !into.trim()}>Clone and attach</Button>
              </form>
            </>
          )}
        </>
      )}
      {confirmation && (
        <ConfirmationDialog
          title="Share project with another Hydra?"
          busy={busy || !connected}
          cancel={() => setConfirmation(null)}
          confirm={() => run({ args: ['add', confirmation.path, '--confirm', confirmation.token] })}
        >
          <p>This folder is already attached to:</p>
          <ul>{confirmation.hydras.map(h => <li key={h.id}><a href={h.url} target="_blank" rel="noreferrer">{h.name}</a></li>)}</ul>
          <p>Attach it to this Hydra too?</p>
        </ConfirmationDialog>
      )}
    </section>
  )
}
