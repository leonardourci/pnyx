import { Fragment } from 'react'
import { ICON_SIZE } from '#web-shared/icons.tsx'
import { IconButton } from '#web-shared/ui/icon-button.tsx'
import type { TitanSummary } from '#app/server-titans.ts'
import { SortGroup } from '#web-shared/ui/sortable.tsx'
import { SortableChip } from '#web-shared/ui/sortable-chip.tsx'
import { WaitingCount } from '#web-shared/ui/waiting-count.tsx'
import { TitanLabel } from '#web-titan/titan-title.tsx'

export function TitanChips({
  titans,
  current,
  navigate,
  createTitan,
}: {
  titans: TitanSummary[]
  current: string
  navigate({ url }: { url: string }): Promise<void>
  createTitan(): unknown
}) {
  return (
    <nav data-sort-surface={`titan-chips:${current}`} className="titan-chips flex min-w-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden" aria-label="Titan navigation">
      <SortGroup id={`titan-chips:${current}`} items={titans.map(titan => titan.id)}>
        {titans.map((
          titan,
          index,
        ) => {
          const polis = titan.polis ?? 'shared'
          const previousPolis = titans[index - 1]?.polis ?? 'shared'
          // Titans keep their polis order; a wider gap marks where the next polis starts.
          const startsPolis = index > 0 && previousPolis !== polis
          const waiting = titan.asks ?? titan.projects.reduce(
            (
              count,
              project,
            ) => count + project.asks,
            0,
          )

          return (
            <Fragment key={titan.id}>
              {startsPolis && <span aria-hidden className="polis-gap w-2.5 flex-none" />}
              <SortableChip
                item={{
                  id: titan.id,
                  kind: 'titan',
                  scope: 'titans',
                  titan: titan.id,
                }}
                variant="titan"
                data-sort-id={titan.id}
                data-sort-kind="titan"
                data-sort-scope="titans"
                aria-current={titan.id === current ? 'page' : undefined}
                onClick={() => navigate({ url: `/titan/${encodeURIComponent(titan.id)}/` })}
              >
                <TitanLabel name={titan.name} icon={titan.icon} size={ICON_SIZE.control} />
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
