import { ICON_SIZE } from '#web-shared/icons.tsx'
import { useState } from 'react'
import type { TitanSummary } from '#app/server-titans.ts'
import type { Command } from '#web-app/connection.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { TitanLabel } from '#web-titan/titan-title.tsx'

export function RepositoryOwnership({
  titans,
  commandFor,
  connected,
}: {
  titans: TitanSummary[]
  commandFor({ id }: { id: string }): Command
  connected: boolean
}) {
  const [
    error,
    setError,
  ] = useState('')
  const repositories = new Map<string, {
    name: string
    titans: TitanSummary[]
  }>()

  for (const titan of titans) {
    for (const project of titan.projects) {
      const repository = repositories.get(project.path) ?? {
        name: project.name,
        titans: [],
      }
      repository.titans.push(titan)
      repositories.set(
        project.path,
        repository,
      )
    }
  }

  const duplicates = [...repositories].filter(([
    , repository,
  ]) => repository.titans.length > 1)

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
            {repository.titans.map(titan => (
              <div key={titan.id} className="flex items-center gap-2">
                <TitanLabel name={titan.name} icon={titan.icon} size={ICON_SIZE.control} />
                <Button
                  aria-label={`Keep ${repository.name} in ${titan.name || titan.id}`}
                  disabled={!connected}
                  onClick={async () => {
                    try {
                      await commandFor({ id: titan.id })({
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
