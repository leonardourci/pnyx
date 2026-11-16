import type { HydraSummary } from '#app/server-hydras.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { HydraLabel } from '#web-hydra/hydra-title.tsx'

export function HydraChips({
  hydras,
  current,
  navigate,
  createHydra,
}: {
  hydras: HydraSummary[]
  current: string
  navigate({ url }: { url: string }): Promise<void>
  createHydra(): unknown
}) {
  return (
    <nav className="hydra-chips" aria-label="Hydra navigation">
      {hydras.map(hydra => {
        const waiting = hydra.asks ?? hydra.projects.reduce(
          (
            count,
            project,
          ) => count + project.asks,
          0,
        )

        return (
          <Button
            key={hydra.id}
            className="hydra-chip"
            data-sort-id={hydra.id}
            data-sort-kind="hydra"
            data-sort-scope="hydras"
            aria-current={hydra.id === current ? 'page' : undefined}
            onClick={() => navigate({ url: `/hydra/${encodeURIComponent(hydra.id)}/` })}
          >
            <HydraLabel name={hydra.name} icon={hydra.icon} size={16} />
            {waiting > 0 && <span className="waiting-count">{waiting}</span>}
          </Button>
        )
      })}
      <Button aria-label="New Hydra" onClick={createHydra}><Icon name="plus" /></Button>
    </nav>
  )
}
