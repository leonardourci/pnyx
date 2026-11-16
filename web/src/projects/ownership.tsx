import { useState } from 'react'
import type { HydraSummary } from '#app/server-hydras.ts'
import type { Command } from '#web-app/connection.ts'
import { InlineConfirm } from '#web-shared/ui/inline-confirm.tsx'
import { HydraLabel } from '#web-hydra/hydra-title.tsx'

export function RepositoryOwnership({
  hydras,
  commandFor,
  connected,
}: {
  hydras: HydraSummary[]
  commandFor({ id }: { id: string }): Command
  connected: boolean
}) {
  const [
    error,
    setError,
  ] = useState('')
  const repositories = new Map<string, {
    name: string
    hydras: HydraSummary[]
  }>()

  for (const hydra of hydras) {
    for (const project of hydra.projects) {
      const repository = repositories.get(project.path) ?? {
        name: project.name,
        hydras: [],
      }
      repository.hydras.push(hydra)
      repositories.set(
        project.path,
        repository,
      )
    }
  }

  const duplicates = [...repositories].filter(([
    , repository,
  ]) => repository.hydras.length > 1)

  if (!duplicates.length) {
    return null
  }

  return (
    <section className="ownership-settings" aria-label="Repository ownership">
      <h2>Repository ownership</h2>
      {error && <p role="alert">{error}</p>}
      {duplicates.map(([
        path,
        repository,
      ]) => (
        <div key={path} className="ownership-repository">
          <strong>{repository.name}</strong><code>{path}</code>
          <div className="row">
            {repository.hydras.map(hydra => (
              <div key={hydra.id}>
                <HydraLabel name={hydra.name} icon={hydra.icon} size={15} />
                <InlineConfirm
                  label={`Keep ${repository.name} in ${hydra.name || hydra.id}`}
                  trigger="Keep here"
                  action="Move tasks"
                  message={`Move this repository's tasks to ${hydra.name || hydra.id}?`}
                  disabled={!connected}
                  confirm={async () => {
                    try {
                      await commandFor({ id: hydra.id })({
                        name: 'project',
                        args: [
                          'keep',
                          path,
                          '--event-id',
                          crypto.randomUUID(),
                        ],
                      })
                      setError('')

                      return true
                    } catch (error) {
                      setError(error instanceof Error ? error.message : String(error))

                      return false
                    }
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}
