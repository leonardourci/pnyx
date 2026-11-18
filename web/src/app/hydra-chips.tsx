import { ICON_SIZE } from '#web-shared/icons.tsx'
import { IconButton } from '#web-shared/ui/icon-button.tsx'
import type { HydraSummary } from '#app/server-hydras.ts'
import { SortGroup } from '#web-shared/ui/sortable.tsx'
import { SortableChip } from '#web-shared/ui/sortable-chip.tsx'
import { WaitingCount } from '#web-shared/ui/waiting-count.tsx'
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
    <nav data-sort-surface={`hydra-chips:${current}`} className="hydra-chips flex min-w-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden" aria-label="Hydra navigation">
      <SortGroup id={`hydra-chips:${current}`} items={hydras.map(hydra => hydra.id)}>
        {hydras.map(hydra => {
          const waiting = hydra.asks ?? hydra.projects.reduce(
            (
              count,
              project,
            ) => count + project.asks,
            0,
          )

          return (
            <SortableChip
              item={{
                id: hydra.id,
                kind: 'hydra',
                scope: 'hydras',
                hydra: hydra.id,
              }}
              key={hydra.id}
              variant="hydra"
              data-sort-id={hydra.id}
              data-sort-kind="hydra"
              data-sort-scope="hydras"
              aria-current={hydra.id === current ? 'page' : undefined}
              onClick={() => navigate({ url: `/hydra/${encodeURIComponent(hydra.id)}/` })}
            >
              <HydraLabel name={hydra.name} icon={hydra.icon} size={ICON_SIZE.control} />
              <WaitingCount count={waiting} />
            </SortableChip>
          )
        })}
      </SortGroup>
      <IconButton
        label="New Hydra"
        onClick={createHydra}
        icon="plus"
      />
    </nav>
  )
}
