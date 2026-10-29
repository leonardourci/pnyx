import { useProjectsResource } from './project-resource.ts'
import { PendingStatus } from '#web-shared/ui/pending-status.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { useEffect, useRef, useState } from 'react'
import type { FolderListing } from '#projects/folders.ts'
import { Button, Input } from '#web-shared/ui/controls.tsx'
import { FolderSearch } from './folder-search.tsx'
import { CommandFailure } from '#web-shared/pending-intents.ts'
import { argument } from '#web-tasks/optimistic.ts'
import type { Command } from '#web-app/connection.ts'
import { hydraTitle } from '#web-app/view.ts'
import { DEFAULT_LANDING, LandingFields, landingArgs, type LandingChoice } from '#web-tasks/delivery/delivery-fields.tsx'

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

function useFolders({
  path,
  repository,
  connected,
}: {
  path: string
  repository: string
  connected: boolean
}) {
  const [
    result,
    setResult,
  ] = useState<{
    query: string
    listing?: FolderListing
    error?: string
  }>()
  const query = new URLSearchParams({
    path,
    repository,
  }).toString()
  useEffect(
    () => {
      if (!connected) {
        return
      }

      const abort = new AbortController()
      const timer = setTimeout(
        () => {
          void fetch(
            new URL(
              `folders?${query}`,
              document.baseURI,
            ),
            { signal: abort.signal },
          ).then(async response => {
            const body = await response.json()

            if (!response.ok) {
              throw new Error(body.error ?? 'Folders could not be listed.')
            }

            if (!abort.signal.aborted) {
              setResult({
                query,
                listing: body as FolderListing,
              })
            }
          })
            .catch((error: Error) => {
              if (!abort.signal.aborted) {
                setResult({
                  query,
                  error: error.message,
                })
              }
            })
        },
        150,
      )

      return () => {
        clearTimeout(timer); abort.abort()
      }
    },
    [
      query,
      connected,
    ],
  )

  return result?.query === query ? result : undefined
}

export function AddProject({
  command,
  connected,
  notify,
  attached,
  cancel,
  autoFocus = false,
}: {
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
  attached?(): void
  cancel?(): void
  autoFocus?: boolean
}) {
  const {
    mutate,
    projects,
    intents,
  } = useProjectsResource({
    command,
    connected,
  })
  const recovered = intents.findLast(intent => intent.stage === 'refused' && intent.patch.args[0] === 'add'
    && !projects.some(project => project.path === intent.patch.path && project.state === 'attached'))
  const recoveredRepository = recovered && argument({
    args: recovered.patch.args,
    flag: '--clone',
  })
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(
    () => {
      if (!autoFocus) {
        return
      }

      heading.current?.scrollIntoView({ block: 'start' })
      heading.current?.focus({ preventScroll: true })
    },
    [autoFocus],
  )
  const [
    mode,
    setMode,
  ] = useState<'folder' | 'clone' | null>(recovered ? recoveredRepository ? 'clone' : 'folder' : null)
  const [
      path,
      setPath,
    ] = useState(recovered?.patch.path ?? ''), [
      repository,
      setRepository,
    ] = useState(recoveredRepository ?? '')
  const [
    busy,
    setBusy,
  ] = useState(false)
  const [
    confirmation,
    setConfirmation,
  ] = useState<Confirmation | null>(null)
  const [
    landing,
    setLanding,
  ] = useState<LandingChoice>(recovered ? {
    landing: (argument({
      args: recovered.patch.args,
      flag: '--landing',
    }) as LandingChoice['landing']) ?? DEFAULT_LANDING.landing,
    merge: (argument({
      args: recovered.patch.args,
      flag: '--merge',
    }) as LandingChoice['merge']) ?? DEFAULT_LANDING.merge,
  } : DEFAULT_LANDING)
  const result = useFolders({
    path,
    repository: mode === 'clone' ? repository : '',
    connected,
  })
  const listing = result?.listing
  const disabled = !connected || busy
  const canSubmit = !!path.trim() && !!(mode === 'clone' ? listing?.cloneInto : listing?.selected)

  const run = async ({ args }: { args: string[] }) => {
    const previousMode = mode
    setBusy(true); setMode(null)

    try {
      const receipt = await mutate({
        args: [
          ...args,
          ...landingArgs({ choice: landing }),
        ],
      })

      if (receipt.confirmation === 'needed') {
        const preview = receipt.preview as {
          project: {
            path: string
            name: string
          }
          hydras: Confirmation['hydras']
        }
        setConfirmation({
          token: receipt.token as string,
          ...preview.project,
          hydras: preview.hydras,
        })
      } else {
        setConfirmation(null); setMode(null); setPath(''); setRepository('')
        notify({ text: 'Project attached.' }); attached?.()
      }
    } catch (error) {
      if (!(error instanceof CommandFailure) || error.outcome === 'refused') {
        setMode(previousMode ?? (args.includes('--clone') ? 'clone' : 'folder'))
      }

      notify({ text: (error as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="add-project-box" aria-label="Add a project">
      <h2 ref={heading} tabIndex={-1}>Give Hydra a project</h2>
      <p className="small muted">Attach a folder on this laptop, or clone a repository here.</p>
      <div className="project-actions">
        <Button
          variant={mode === 'folder' ? 'surface' : 'quiet'}
          disabled={disabled}
          aria-pressed={mode === 'folder'}
          onClick={() => {
            setMode('folder'); setConfirmation(null)
          }}
        ><Icon name="plus" />Add a folder
        </Button>
        <Button
          variant={mode === 'clone' ? 'surface' : 'quiet'}
          disabled={disabled}
          aria-pressed={mode === 'clone'}
          onClick={() => {
            setMode('clone'); setConfirmation(null)
          }}
        ><Icon name="clone" />Clone a repo
        </Button>
        {cancel && <Button disabled={busy} onClick={cancel} aria-label="Close add project"><Icon name="close" /></Button>}
      </div>
      {projects.some(project => project.pending) && (
        <ul className="project-list">{projects.filter(project => project.pending).map(project => (
          <li key={project.path}><strong>{project.name}</strong> <span>{project.path}</span> <span role="status">{project.pending}</span></li>
        ))}
        </ul>
      )}
      <PendingStatus intents={intents} />
      {mode && !confirmation && (
        <form
          className="project-form"
          onSubmit={e => {
            e.preventDefault()

            if (mode === 'clone' && listing?.cloneInto) {
              void run({
                args: [
                  'add',
                  '--clone',
                  repository.trim(),
                  '--into',
                  listing.cloneInto,
                ],
              })
            } else if (mode === 'folder' && listing?.selected && path.trim()) {
              void run({
                args: [
                  'add',
                  listing.selected.path,
                ],
              })
            }
          }}
        >
          {mode === 'clone' && (
            <label>Repository to clone<Input
              aria-label="Repository to clone"
              value={repository}
              disabled={disabled}
              required
              onChange={e => setRepository(e.target.value)}
              placeholder="https://example.com/team/project.git"
            />
            </label>
          )}
          <FolderSearch
            label={mode === 'clone' ? 'Destination' : 'Folder path'}
            value={path}
            folders={listing?.folders ?? []}
            disabled={disabled}
            onChange={({ path }) => setPath(path)}
          />
          {listing?.selected && path.trim() && (
            <div className="picked-folder">
              <strong>{listing.selected.name}</strong><small>{listing.selected.path}</small>
            </div>
          )}
          {result?.error && <p className="small" role="status">{result.error}</p>}
          {mode === 'clone' && listing?.cloneInto && <p className="clone-preview">Code will land in <strong>{listing.cloneInto}</strong></p>}
          <LandingFields
            name="this project"
            choice={landing}
            disabled={disabled}
            onChange={({ choice }) => setLanding(choice)}
          />
          <Button type="submit" variant="surface" disabled={disabled || !canSubmit}>
            {mode === 'clone' ? 'Clone and attach' : 'Add project'}
          </Button>
          {mode === 'folder' && !!listing?.recent.length && (
            <div className="recent-folders"><span className="small muted">Folders your agents worked in</span>{listing.recent.map(folder => (
              <Button
                key={folder.path}
                disabled={disabled}
                title={folder.path}
                onClick={() => void run({
                  args: [
                    'add',
                    folder.path,
                  ],
                })}
              ><strong>{folder.name}</strong><small>{folder.path}</small>
              </Button>
            ))}
            </div>
          )}
        </form>
      )}
      {confirmation && (
        <ProjectSharing
          confirmation={confirmation}
          disabled={disabled}
          cancel={() => setConfirmation(null)}
          confirm={() => void run({
            args: [
              'add',
              confirmation.path,
              '--confirm',
              confirmation.token,
            ],
          })}
        />
      )}
      {!confirmation && (
        <p className="small muted project-sharing-note">
          Each worker normally gets its own copy. Only one Hydra at a time may have a worker
          editing the folder itself.
        </p>
      )}
    </section>
  )
}

export function ProjectSharing({
  confirmation,
  disabled,
  cancel,
  confirm,
}: {
  confirmation: Confirmation
  disabled: boolean
  cancel(): void
  confirm(): void
}) {
  return (
    <div className="project-sharing" role="status">
      <span><strong>{confirmation.name}</strong> · also in {confirmation.hydras.map((
        hydra,
        n,
      ) => <span key={hydra.id}>{n > 0 ? ', ' : ''}<a href={hydra.url} target="_blank" rel="noreferrer">{hydraTitle(hydra)} <Icon name="external" size={12} /></a></span>)}
      </span>
      <p className="small muted">Each worker normally gets its own copy. Only one Hydra at a time may have a worker editing the folder itself.</p>
      <div className="project-actions">
        <Button disabled={disabled} variant="surface" onClick={confirm}>Add anyway</Button>
        <Button disabled={disabled} onClick={cancel}>Cancel</Button>
      </div>
    </div>
  )
}
