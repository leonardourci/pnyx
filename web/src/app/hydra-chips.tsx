import { Fragment } from 'react'
import { Chip } from '#web-shared/ui/chip.tsx'
import { ICON_SIZE } from '#web-shared/icons.tsx'
import { IconButton } from '#web-shared/ui/icon-button.tsx'
import type { TitanSummary } from '#app/server-hydras.ts'
import { SortGroup } from '#web-shared/ui/sortable.tsx'
import { SortableChip } from '#web-shared/ui/sortable-chip.tsx'
import { WaitingCount } from '#web-shared/ui/waiting-count.tsx'
import { TitanLabel } from '#web-titan/hydra-title.tsx'

export function TitanChips({
  hydras,
  current,
  navigate,
  createTitan,
  polisFilter,
  filterPolis,
}: {
  hydras: TitanSummary[]
  current: string
  navigate({ url }: { url: string }): Promise<void>
  polisFilter?: string
  filterPolis({ polis }: { polis?: string }): void
  createTitan(): unknown
}) {
  return (
    <nav data-sort-surface={`hydra-chips:${current}`} className="hydra-chips flex min-w-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden" aria-label="Titan navigation">
      <SortGroup id={`hydra-chips:${current}`} items={hydras.map(hydra => hydra.id)}>
        {hydras.map((
          hydra,
          index,
        ) => {
          const polis = hydra.polis ?? 'shared'
          const previousPolis = hydras[index - 1]?.polis ?? 'shared'
          const startsPolis = index === 0 || previousPolis !== polis
          const selected = polisFilter === polis
          const nextFilter = selected ? undefined : polis
          const waiting = hydra.asks ?? hydra.projects.reduce(
            (
              count,
              project,
            ) => count + project.asks,
            0,
          )

          return (
            <Fragment key={hydra.id}>
              {startsPolis && (
                <Chip
                  variant="settings"
                  aria-label={`Filter polis ${polis}`}
                  aria-pressed={selected}
                  onClick={() => filterPolis({ polis: nextFilter })}
                >{polis}
                </Chip>
              )}
              <SortableChip
                item={{
                  id: hydra.id,
                  kind: 'hydra',
                  scope: 'titans',
                  hydra: hydra.id,
                }}
                variant="hydra"
                data-sort-id={hydra.id}
                data-sort-kind="hydra"
                data-sort-scope="hydras"
                aria-current={hydra.id === current ? 'page' : undefined}
                onClick={() => {
                  if (polisFilter !== polis) {
                    filterPolis({})
                  }

                  return navigate({ url: `/hydra/${encodeURIComponent(hydra.id)}/` })
                }}
              >
                <TitanLabel name={hydra.name} icon={hydra.icon} size={ICON_SIZE.control} />
                <WaitingCount count={waiting} />
              </SortableChip>
            </Fragment>
          )
        })}
      </SortGroup>
      <IconButton
        label="New Titan"
        onClick={createTitan}
        icon="plus"
      />
    </nav>
  )
}
