import { Icon } from '../components/ui/icon.tsx'
import { useEffect, useRef, useState } from 'react'
import type { FolderListing } from '../../../src/projects/folders.ts'
import { Button, Input } from '../components/ui/controls.tsx'
import { FolderSearch } from '../components/ui/folder-search.tsx'
import type { Command } from './connection.ts'

type Confirmation = {
  token: string
  path: string
  name: string
  hydras: { id: string; name: string; url: string }[]
}

function useFolders({ path, repository, connected }: {
  path: string
  repository: string
  connected: boolean
}) {
  const [result, setResult] = useState<{ query: string; listing?: FolderListing; error?: string }>()
  const query = new URLSearchParams({ path, repository }).toString()
  useEffect(() => {
    if (!connected) {
      return
    }

    const abort = new AbortController()
    const timer = setTimeout(() => {
      void fetch(new URL(`folders?${query}`, document.baseURI), { signal: abort.signal }).then(async response => {
        const body = await response.json()

        if (!response.ok) {
          throw new Error(body.error ?? 'Folders could not be listed.')
        }

        if (!abort.signal.aborted) {
          setResult({ query, listing: body as FolderListing })
        }
      })
        .catch((error: Error) => {
          if (!abort.signal.aborted) {
            setResult({ query, error: error.message })
          }
        })
    }, 150)

    return () => {
      clearTimeout(timer); abort.abort()
    }
  }, [query, connected])

  return result?.query === query ? result : undefined
}

export function AddProject({ command, connected, notify, attached, cancel }: {
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
  attached?(): void
  cancel?(): void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.scrollIntoView({ block: 'start' })
    heading.current?.focus({ preventScroll: true })
  }, [])
  const [mode, setMode] = useState<'folder' | 'clone' | null>(null)
  const [path, setPath] = useState(''), [repository, setRepository] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const result = useFolders({ path, repository: mode === 'clone' ? repository : '', connected })
  const listing = result?.listing
  const disabled = !connected || busy

  const run = async ({ args }: { args: string[] }) => {
    setBusy(true)

    try {
      const receipt = await command({ name: 'project', args })

      if (receipt.confirmation === 'needed') {
        const preview = receipt.preview as {
          project: { path: string; name: string }
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
        >⎘ Clone a repo
        </Button>
        {cancel && <Button disabled={busy} onClick={cancel} aria-label="Close add project"><Icon name="close" /></Button>}
      </div>
      {mode && !confirmation && (
        <form
          className="project-form"
          onSubmit={e => {
            e.preventDefault()

            if (mode === 'clone' && listing?.cloneInto) {
              void run({ args: ['add', '--clone', repository.trim(), '--into', listing.cloneInto] })
            } else if (mode === 'folder' && listing?.selected && path.trim()) {
              void run({ args: ['add', listing.selected.path] })
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
          {listing?.selected && path.trim() && <div className="picked-folder"><strong>{listing.selected.name}</strong><small>{listing.selected.path}</small></div>}
          {result?.error && <p className="small" role="status">{result.error}</p>}
          {mode === 'clone' && listing?.cloneInto && <p className="clone-preview">Code will land in <strong>{listing.cloneInto}</strong></p>}
          <Button type="submit" variant="surface" disabled={disabled || !path.trim() || (mode === 'clone' ? !listing?.cloneInto : !listing?.selected)}>{busy ? mode === 'clone' ? 'Cloning…' : 'Attaching…' : mode === 'clone' ? 'Clone and attach' : 'Add project'}</Button>
          {mode === 'folder' && !!listing?.recent.length && (
            <div className="recent-folders"><span className="small muted">Folders your agents worked in</span>{listing.recent.map(folder => (
              <Button
                key={folder.path}
                disabled={disabled}
                title={folder.path}
                onClick={() => void run({ args: ['add', folder.path] })}
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
          confirm={() => void run({ args: ['add', confirmation.path, '--confirm', confirmation.token] })}
        />
      )}
      {!confirmation && <p className="small muted project-sharing-note">Each worker normally gets its own copy. Only one Hydra at a time may have a worker editing the folder itself.</p>}
    </section>
  )
}

export function ProjectSharing({ confirmation, disabled, cancel, confirm }: {
  confirmation: Confirmation
  disabled: boolean
  cancel(): void
  confirm(): void
}) {
  return (
    <div className="project-sharing" role="status">
      <span><strong>{confirmation.name}</strong> · also in {confirmation.hydras.map((hydra, n) => <span key={hydra.id}>{n > 0 ? ', ' : ''}<a href={hydra.url} target="_blank" rel="noreferrer">{hydra.name} <Icon name="external" size={12} /></a></span>)}</span>
      <p className="small muted">Each worker normally gets its own copy. Only one Hydra at a time may have a worker editing the folder itself.</p>
      <div className="project-actions"><Button disabled={disabled} variant="surface" onClick={confirm}>Add anyway</Button><Button disabled={disabled} onClick={cancel}>Cancel</Button></div>
    </div>
  )
}
