import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { ViewPreferences } from '#preferences/model.ts'
import { PROJECT_MIN_WIDTH, DEFAULT_PROJECT_WIDTH } from '#preferences/workspace.ts'
import { useSmoothScroll } from '#web-shared/ui/smooth-scroll.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { Resize } from '#web-shared/ui/resize.tsx'
import { ProjectCounts } from './project-counts.tsx'
import type { ProjectColumnData } from './project-view.ts'
import { CARD_GAP, CLOSED_CARD_MIN_WIDTH, PROJECT_CONTENT_INSET } from './project-layout.ts'
import { useFlowMotion } from '#web-shared/ui/flow-motion.ts'

export function ProjectColumn({
  column,
  view,
  save,
  expandedWidth,
  children,
  create,
}: {
  column: ProjectColumnData
  view: ViewPreferences
  save({ patch }: { patch: Record<string, unknown> }): Promise<boolean>
  expandedWidth: number
  children: ReactNode
  create(): void
}) {
  const [
    preview,
    setPreview,
  ] = useState<number | null>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  useFlowMotion({ root: grid })
  useSmoothScroll({
    root: scroll,
    content: grid,
  })
  const folded = view.workspace.foldedProjects.includes(column.id)
  const saved = view.workspace.projectWidths[column.id] ?? (column.id === 'ideas' ? PROJECT_MIN_WIDTH : DEFAULT_PROJECT_WIDTH)
  const openedMinimum = expandedWidth ? expandedWidth + PROJECT_CONTENT_INSET : PROJECT_MIN_WIDTH
  const requested = preview ?? saved
  const alongside = expandedWidth > 0 && requested > openedMinimum
  const minimum = alongside ? openedMinimum + CLOSED_CARD_MIN_WIDTH + CARD_GAP : openedMinimum
  const width = Math.max(
    requested,
    minimum,
  )
  const available = width - PROJECT_CONTENT_INSET - (expandedWidth ? expandedWidth + CARD_GAP : 0)
  const beside = available >= CLOSED_CARD_MIN_WIDTH
  const space = beside ? available : width - PROJECT_CONTENT_INSET
  const count = Math.max(
    1,
    Math.floor((space + CARD_GAP) / (CLOSED_CARD_MIN_WIDTH + CARD_GAP)),
  )
  const reserved = beside ? expandedWidth + CARD_GAP : 0
  const style = {
    width: folded ? 48 : width,
    '--closed-card-width': `max(min(${CLOSED_CARD_MIN_WIDTH}px, calc(100% - ${CARD_GAP}px)), calc((100% - ${reserved}px) / ${count} - ${CARD_GAP}px))`,
    '--card-gap': `${CARD_GAP}px`,
  } as CSSProperties
  const toggle = () => save({
    patch: {
      workspace: {
        foldedProjects: folded
          ? view.workspace.foldedProjects.filter(id => id !== column.id)
          : [
            ...view.workspace.foldedProjects,
            column.id,
          ],
      },
    },
  })

  return (
    <section
      className={`project-column column ${folded ? 'folded' : ''}`}
      data-column={column.id}
      data-resizing={preview !== null}
      data-sort-id={column.id}
      data-sort-kind="project"
      data-sort-scope="projects"
      data-sort-disabled={column.id === 'ideas'}
      aria-label={column.title}
      style={style}
    >
      <header className="project-column-heading">
        <Button
          data-column-heading={column.id}
          aria-label={`${folded ? 'Unfold' : 'Fold'} ${column.title}`}
          onClick={toggle}
        >
          <Icon name="chevron_right" size={15} />
          <strong>{column.title}</strong>
          <ProjectCounts asks={column.asks} running={column.running} />
        </Button>
        {!folded && <Button aria-label={`New task in ${column.title}`} onClick={create}><Icon name="plus" /></Button>}
      </header>
      {!folded && <div ref={scroll} className="column-cards project-cards"><div ref={grid} className="project-card-grid">{children}</div></div>}
      {!folded && (
        <Resize
          label={`Resize ${column.title}`}
          value={width}
          min={minimum}
          onPreview={({ value }) => setPreview(value)}
          onCommit={async ({ value }) => {
            try {
              return await save({
                patch: { workspace: { projectWidths: { [column.id]: value } } },
              })
            } finally {
              setPreview(null)
            }
          }}
        />
      )}
    </section>
  )
}
