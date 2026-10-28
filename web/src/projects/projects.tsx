import { useEffect, useState } from 'react'
import type { HydraState } from '../../../src/app/model.ts'
import { AddProject, ProjectSharing } from './add-project.tsx'
import { Button, Input, Switch, Textarea } from '../shared/ui/controls.tsx'
import type { Command } from '../app/connection.ts'
import { useProjectsResource, type ProjectRow } from './project-resource.ts'
import { PendingStatus } from '../shared/ui/pending-status.tsx'
import { LandingFields, landingArgs, type LandingChoice } from '../hydra/landing-fields.tsx'

type Confirmation = {
  token: string
  path: string
  name: string
  hydras: {
    id: string
    name: string
    url: string
  }[]
}

function ProjectCommand({
  project,
  disabled,
  mutate,
  notify,
}: {
  project: ProjectRow
  disabled: boolean
  mutate({ args }: { args: string[] }): Promise<unknown>
  notify({ text }: { text: string }): void
}) {
  const [
    draft,
    setDraft,
  ] = useState<Partial<NonNullable<ProjectRow['startCommand']>>>({})
  const name = draft.name ?? project.startCommand?.name ?? ''
  const shell = draft.command ?? project.startCommand?.command ?? ''
  const ownFolder = draft.bringsOwnFolder ?? project.startCommand?.bringsOwnFolder ?? false
  const edit = ({ patch }: { patch: typeof draft }) => setDraft(current => ({
    ...current,
    ...patch,
  }))
  const [
    busy,
    setBusy,
  ] = useState(false)

  return (
    <form
      className="project-form"
      aria-label={`Start settings for ${project.name}`}
      onSubmit={async e => {
        e.preventDefault(); setBusy(true)
        const submitted = draft

        try {
          await mutate({
            args: [
              'set',
              project.path,
              '--command-name',
              name,
              '--command',
              shell,
              '--brings-own-folder',
              String(ownFolder),
              '--event-id',
              crypto.randomUUID(),
            ],
          })
          setDraft(current => current === submitted ? {} : current)
          notify({ text: shell.trim() ? 'Project start command saved.' : 'Project start command cleared.' })
        } catch (error) {
          notify({ text: (error as Error).message })
        } finally {
          setBusy(false)
        }
      }}
    >
      <fieldset disabled={disabled}>
        <label>Start command name<Input
          aria-label={`Start command name for ${project.name}`}
          value={name}
          onChange={e => edit({ patch: { name: e.target.value } })}
          placeholder="Local worker"
          required={!!shell.trim()}
        />
        </label>
        <label>Command<Textarea
          aria-label={`Start command for ${project.name}`}
          value={shell}
          onChange={e => edit({ patch: { command: e.target.value } })}
          rows={2}
          spellCheck={false}
          placeholder="Command to start a worker"
        />
        </label>
        <Switch label="Brings its own folder" checked={ownFolder} onChange={({ value }) => edit({ patch: { bringsOwnFolder: value } })} />
        <p className="small muted">The command creates the worker’s folder when checked. Hydra can choose this command by name.</p>
        <Button type="submit" variant="surface">{busy ? 'Saving…' : 'Save start command'}</Button>
      </fieldset>
    </form>
  )
}

function ProjectLanding({
  project,
  disabled,
  mutate,
  notify,
}: {
  project: ProjectRow
  disabled: boolean
  mutate({ args }: { args: string[] }): Promise<unknown>
  notify({ text }: { text: string }): void
}) {
  const save = async ({ choice }: { choice: LandingChoice }) => {
    try {
      await mutate({
        args: [
          'set',
          project.path,
          ...landingArgs({ choice }),
          '--event-id',
          crypto.randomUUID(),
        ],
      })
      notify({ text: 'Landing rule saved.' })
    } catch (error) {
      notify({ text: (error as Error).message })
    }
  }

  return (
    <LandingFields
      name={project.name}
      choice={{
        landing: project.landing,
        merge: project.merge,
      }}
      disabled={disabled}
      onChange={save}
    />
  )
}

export function Projects({
  state,
  connected,
  command,
  notify,
}: {
  state: HydraState
  connected: boolean
  command: Command
  notify({ text }: { text: string }): void
}) {
  const {
    projects,
    readonly,
    loaded,
    error,
    mutate,
    intents,
    refresh,
  } = useProjectsResource({
    command,
    connected,
    revision: `${state.projectsRevision ?? 0}:${state.config?.hydra.kind}:${state.config?.hydra.home ?? ''}`,
  })
  const [
    confirmation,
    setConfirmation,
  ] = useState<Confirmation | null>(null)
  useEffect(
    () => {
      if (error) {
        notify({ text: error })
      }
    },
    [
      error,
      notify,
    ],
  )

  const run = async ({ args }: { args: string[] }) => {
    try {
      const r = await mutate({ args })

      if (r.confirmation === 'needed') {
        const preview = r.preview as {
          project: {
            path: string
            name: string
          }
          hydras: Confirmation['hydras']
        }
        setConfirmation({
          token: r.token as string,
          path: preview.project.path,
          name: preview.project.name,
          hydras: preview.hydras,
        })
      } else {
        setConfirmation(null)
        const text = args[0] === 'remove'
          ? 'Project detached. Tasks and history stay.' : 'Project attached.'
        notify({ text })
      }
    } catch (error) {
      notify({ text: (error as Error).message })
    }
  }

  const row = ({ project: p }: { project: ProjectRow }) => (
    <li key={p.path} className={`project-row ${p.state === 'detached' ? 'detached' : ''}`}>
      <div className="project-details">
        <strong>{p.name}</strong><span className="project-path">{p.path}</span>
        {p.pending && <span role="status">{p.pending}</span>}
        {!readonly && p.state === 'attached' && (
          <ProjectLanding
            project={p}
            disabled={!connected || !!p.pending}
            mutate={mutate}
            notify={notify}
          />
        )}
        {!readonly && p.state === 'attached' && (
          <ProjectCommand
            key={p.path}
            project={p}
            disabled={!connected || !!p.pending}
            mutate={mutate}
            notify={notify}
          />
        )}
      </div>
      {!readonly && (
        <Button
          disabled={!connected || !!p.pending}
          aria-label={`${p.state === 'detached' ? 'Re-attach' : 'Detach'} ${p.name}`}
          onClick={() => run({
            args: [
              p.state === 'detached' ? 'add' : 'remove',
              p.path,
            ],
          })}
        >{p.state === 'detached' ? 'Re-attach' : 'Detach'}
        </Button>
      )}
    </li>
  )

  return (
    <section className="settings-box" aria-label="Projects">
      <h2>Projects</h2>
      {!loaded && !projects.length ? <p className="muted">Loading projects…</p> : (
        <>
          {readonly && (
            <>
              <p className="muted">Managed by Firstmate. Projects are read-only here.</p>
              <Button
                disabled={!connected}
                onClick={() => {
                  void refresh()
                }}
              >Refresh projects
              </Button>
            </>
          )}
          {!projects.some(p => p.state === 'attached') && <p className="muted">No projects attached.</p>}
          <ul className="project-list">{projects.filter(p => p.state === 'attached').map(p => row({ project: p }))}</ul>
          {projects.some(p => p.state === 'detached') && (
            <>
              <h3>Detached</h3>
              <ul className="project-list">
                {projects.filter(p => p.state === 'detached').map(p => row({ project: p }))}
              </ul>
            </>
          )}
          {!readonly && (
            <AddProject
              command={command}
              connected={connected}
              notify={notify}
            />
          )}
        </>
      )}
      <PendingStatus intents={intents} />
      {confirmation && (
        <ProjectSharing
          confirmation={confirmation}
          disabled={!connected}
          cancel={() => setConfirmation(null)}
          confirm={() => run({
            args: [
              'add',
              confirmation.path,
              '--confirm',
              confirmation.token,
            ],
          })}
        />
      )}
    </section>
  )
}
