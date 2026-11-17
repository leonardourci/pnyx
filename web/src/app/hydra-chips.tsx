import type { HydraSummary } from '#app/server-hydras.ts'
import { SortGroup } from '#web-shared/ui/sortable.tsx'
import { SortableButton } from '#web-shared/ui/sortable-button.tsx'
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
            <SortableButton
              item={{
                id: hydra.id,
                kind: 'hydra',
                scope: 'hydras',
                hydra: hydra.id,
              }}
              key={hydra.id}
              className="hydra-chip flex-none touch-none gap-1.75 whitespace-nowrap rounded-full border-line px-2.5 py-1 aria-[current=page]:border-gold-line aria-[current=page]:bg-gold-wash max-[760px]:px-2"
              data-sort-id={hydra.id}
              data-sort-kind="hydra"
              data-sort-scope="hydras"
              aria-current={hydra.id === current ? 'page' : undefined}
              onClick={() => navigate({ url: `/hydra/${encodeURIComponent(hydra.id)}/` })}
            >
              <HydraLabel name={hydra.name} icon={hydra.icon} size={16} />
              {waiting > 0 && <span className="waiting-count inline-grid h-4.75 min-w-4.75 place-items-center rounded-full bg-gold-fill px-1 text-count text-gold-ink">{waiting}</span>}
            </SortableButton>
          )
        })}
      </SortGroup>
      <Button aria-label="New Hydra" onClick={createHydra}><Icon name="plus" /></Button>
    </nav>
  )
}
