import { ICON_SIZE } from '#web-shared/icons.tsx'
import { useState } from 'react'
import type { HydraSummary } from '#app/server-hydras.ts'
import type { Command } from '#web-app/connection.ts'
import { Button } from '#web-shared/ui/controls.tsx'
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
    <section className="ownership-settings my-3 rounded-xl border border-gold-line p-4" aria-label="Repository ownership">
      <h2>Repository ownership</h2>
      {error && <p role="alert">{error}</p>}
      {duplicates.map(([
        path,
        repository,
      ]) => (
        <div key={path} className="ownership-repository mt-3 flex flex-col gap-2">
          <strong>{repository.name}</strong><code className="text-meta! text-muted">{path}</code>
          <div className="row">
            {repository.hydras.map(hydra => (
              <div key={hydra.id} className="flex items-center gap-2">
                <HydraLabel name={hydra.name} icon={hydra.icon} size={ICON_SIZE.control} />
                <Button
                  aria-label={`Keep ${repository.name} in ${hydra.name || hydra.id}`}
                  disabled={!connected}
                  onClick={async () => {
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
                >Keep here
                </Button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}
