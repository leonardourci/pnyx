import { useRef, useState, type ReactNode, type CSSProperties } from 'react'
import type { ViewPreferences } from '#preferences/model.ts'
import { PROJECT_MIN_WIDTH, DEFAULT_PROJECT_WIDTH } from '#preferences/workspace.ts'
import { useSmoothScroll } from '#web-shared/ui/smooth-scroll.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { Resize } from '#web-shared/ui/resize.tsx'
import { motion, useReducedMotion } from 'motion/react'
import { useSortItem, useSortState } from '#web-shared/ui/sortable.tsx'
import { ProjectCounts } from './project-counts.tsx'
import type { ProjectColumnData } from './project-view.ts'
import { PROJECT_CONTENT_INSET } from './project-layout.ts'

export function ProjectColumn({
  column,
  hydraId,
  view,
  save,
  expandedWidth,
  children,
  create,
}: {
  column: ProjectColumnData
  hydraId: string
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
  const minimum = expandedWidth ? expandedWidth + PROJECT_CONTENT_INSET : PROJECT_MIN_WIDTH
  const width = Math.max(
    preview ?? saved,
    minimum,
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

  const sort = useSortItem({
    item: {
      id: column.id,
      kind: 'project',
      scope: 'projects',
      hydra: hydraId,
    },
    disabled: column.id === 'ideas',
  })
  const reduced = useReducedMotion()
  const dragging = useSortState()
  const lifted = dragging.active?.kind === 'project' && dragging.active.id === column.id
    && dragging.active.hydra === hydraId

  return (
    <motion.section
      layout="position"
      initial={false}
      ref={sort.setNodeRef}
      data-sort-key={sort.key}
      data-drag-slot={lifted}
      onPointerDown={sort.pointerDown}
      className={`project-column column group/project [&[data-drag-slot=true]>*]:invisible data-[drag-slot=true]:outline data-[drag-slot=true]:outline-dashed data-[drag-slot=true]:outline-gold-line relative flex h-full min-h-0 flex-none flex-col overflow-visible rounded-xl border border-column-line bg-column-background wrap-anywhere  ${folded ? 'folded min-w-12' : ''}`}
      data-column={column.id}
      data-resizing={preview !== null}
      data-sort-id={column.id}
      data-sort-kind="project"
      data-sort-scope="projects"
      data-sort-disabled={column.id === 'ideas'}
      aria-label={column.title}
      style={{ '--project-card-width': `${width - PROJECT_CONTENT_INSET}px` } as CSSProperties}
      animate={{ width: folded ? 48 : width }}
      transition={preview !== null || reduced ? { duration: 0 } : undefined}
    >
      <header className="project-column-heading flex min-h-10.75 items-center justify-between gap-2 border-b border-column-line px-2 py-1.25 group-[.folded]/project:h-full group-[.folded]/project:border-0 group-[.folded]/project:p-2">
        <Button
          className="min-w-0 touch-none justify-start gap-2 [&>strong]:truncate [&>svg]:rotate-90 group-[.folded]/project:self-start group-[.folded]/project:[writing-mode:vertical-rl] group-[.folded]/project:[&>svg]:rotate-0"
          {...sort.attributes}
          {...sort.listeners}
          ref={sort.setActivatorNodeRef}
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
      <div
        ref={scroll}
        data-sort-surface={`tasks:${hydraId}:${column.id}`}
        hidden={folded}
        className="column-cards project-cards block min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-2 [&[hidden]]:hidden"
      ><div ref={grid} className="project-card-grid relative flex flex-wrap items-start gap-2 [&>:not(.task-family)]:w-full">{children}</div>
      </div>
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
    </motion.section>
  )
}
