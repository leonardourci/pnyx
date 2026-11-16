import { useRef, useState, type ReactNode } from 'react'
import type { ViewPreferences } from '#preferences/model.ts'
import { PROJECT_MIN_WIDTH, DEFAULT_PROJECT_WIDTH } from '#preferences/workspace.ts'
import { useSmoothScroll } from '#web-shared/ui/smooth-scroll.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { Resize } from '#web-shared/ui/resize.tsx'
import { ProjectCounts } from './project-counts.tsx'
import type { ProjectColumnData } from './project-view.ts'

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
  useSmoothScroll({
    root: scroll,
    content: grid,
  })
  const folded = view.workspace.foldedProjects.includes(column.id)
  const saved = view.workspace.projectWidths[column.id] ?? (column.id === 'ideas' ? PROJECT_MIN_WIDTH : DEFAULT_PROJECT_WIDTH)
  const savedWidth = Math.max(
    saved,
    expandedWidth || PROJECT_MIN_WIDTH,
  )
  const width = Math.max(
    preview ?? saved,
    expandedWidth || PROJECT_MIN_WIDTH,
  )
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
      style={{ width: folded ? 48 : width }}
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
          value={savedWidth}
          min={PROJECT_MIN_WIDTH}
          onPreview={({ value }) => setPreview(value)}
          onCommit={({ value }) => save({
            patch: { workspace: { projectWidths: { [column.id]: value } } },
          })}
        />
      )}
    </section>
  )
}
