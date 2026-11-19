import { useSharedSettings } from '#web-settings/shared-settings.ts'
import { ProjectForm, ProjectList } from './folder-ui.tsx'
import { SettingsBox } from '#web-shared/ui/settings-box.tsx'
import { useEffect, useState } from 'react'
import type { HydraState } from '#app/model.ts'
import { AddProject } from './add-project.tsx'
import { Button, Input, Select, Switch, Textarea } from '#web-shared/ui/controls.tsx'
import type { Command } from '#web-app/connection.ts'
import { useProjectsResource, type ProjectRow } from './project-resource.ts'
import { PendingStatus } from '#web-shared/ui/pending-status.tsx'
import { LandingFields, landingArgs, type LandingChoice } from '#web-tasks/delivery/delivery-fields.tsx'

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
    <ProjectForm
      aria-label={`Start settings for ${project.name}`}
      submit={async ({ event: e }) => {
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
    </ProjectForm>
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
  const settings = useSharedSettings()
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
    revision: `${JSON.stringify(settings?.poleis)}:${JSON.stringify(state.config?.readPoleis)}:${JSON.stringify(settings?.projectPoleis)}:${state.projectsRevision ?? 0}:${state.config?.hydra.kind}:${state.config?.hydra.home ?? ''}`,
  })
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
      await mutate({ args })
      const text = args[0] === 'remove'
        ? 'Project detached. Tasks and history stay.' : 'Project attached.'
      notify({ text })
    } catch (error) {
      notify({ text: (error as Error).message })
    }
  }

  const row = ({ project: p }: { project: ProjectRow }) => (
    <li key={p.path} className={`project-row flex items-center justify-between gap-3 py-2 px-0 [&>div]:min-w-0 [&.detached_strong]:text-muted ${p.state === 'detached' ? 'detached' : ''}`}>
      <div className="project-details flex-1">
        <strong>{p.name}</strong><span className="project-path block text-muted text-ui wrap-anywhere">{p.path}</span>
        {p.state === 'attached' && (
          <label>Polis<Select
            label={`Polis for ${p.name}`}
            value={p.polis ?? 'shared'}
            options={(p.readPoleis ?? []).map(polis => ({
              value: polis,
              label: polis,
            }))}
            disabled={!connected}
            onChange={async ({ value }) => {
              try {
                await mutate({
                  args: [
                    'move',
                    p.path,
                    '--polis',
                    value,
                    '--event-id',
                    crypto.randomUUID(),
                  ],
                })
              } catch (error) {
                notify({ text: (error as Error).message })
              }
            }}
          />
          </label>
        )}
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
    <SettingsBox aria-label="Projects">
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
          <ProjectList>{projects.filter(p => p.state === 'attached').map(p => row({ project: p }))}</ProjectList>
          {projects.some(p => p.state === 'detached') && (
            <>
              <h3>Detached</h3>
              <ProjectList>
                {projects.filter(p => p.state === 'detached').map(p => row({ project: p }))}
              </ProjectList>
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
    </SettingsBox>
  )
}
