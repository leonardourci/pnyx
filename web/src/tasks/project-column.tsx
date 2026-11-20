import { runtimeStyle } from '#web-shared/ui/runtime-style.ts'
import { useRememberedScroll } from '#web-app/remembered-scroll.ts'
import { sessionViewKey } from '#web-app/session-view.ts'
import { FoldContent } from '#web-shared/ui/fold-content.tsx'
import { motionDuration } from '#web-shared/motion.ts'
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ViewPreferences } from '#preferences/model.ts'
import { useWorkspaceViewport } from '#web-app/workspace-viewport.tsx'
import { useSmoothScroll } from '#web-shared/ui/smooth-scroll.ts'
import { Resize } from '#web-shared/ui/resize.tsx'
import { useReducedMotion } from 'motion/react'
import { useDropZone, useSortItem, useSortState, nestingRefusal } from '#web-shared/ui/sortable.tsx'
import { ProjectColumnHeader } from './project-column-header.tsx'
import { SortablePanel } from '#web-shared/ui/sortable-panel.tsx'
import type { ProjectColumnData } from './project-view.ts'
import { PROJECT_CONTENT_INSET, projectWidth } from './project-layout.ts'

export function ProjectColumn({
  column,
  poleis,
  hydraId,
  view,
  save,
  expandedWidth,
  children,
  create,
}: {
  poleis?: string[]
  column: ProjectColumnData
  hydraId: string
  view: ViewPreferences
  save({ patch }: { patch: Record<string, unknown> }): Promise<boolean>
  expandedWidth: number
  children({
    scroll,
    width,
  }: {
    scroll: HTMLElement | null
    width: number
  }): ReactNode
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
  const remembered = useRememberedScroll({
    key: sessionViewKey({
      scope: 'column',
      id: `${hydraId}:${column.id}`,
      field: 'scroll',
    }),
    active: !folded,
  })
  const [
    scrollElement,
    setScrollElement,
  ] = useState<HTMLDivElement | null>(null)
  const outdentZone = useDropZone({
    item: {
      id: column.id,
      kind: 'task',
      scope: column.id,
      hydra: hydraId,
      zone: 'outdent',
    },
  })
  const outdentNode = outdentZone.setNodeRef
  const scrollRef = useCallback(
    // eslint-disable-next-line pnyx/object-params -- The library owns this callback signature.
    (node: HTMLDivElement | null) => {
      scroll.current = node
      setScrollElement(node)
      remembered.ref(node)
      outdentNode(node)
    },
    [
      remembered.ref,
      outdentNode,
    ],
  )
  const viewport = useWorkspaceViewport()
  const {
    width,
    minimum,
    phone,
  } = projectWidth({
    id: column.id,
    widths: view.workspace.projectWidths,
    expandedWidth,
    viewport: viewport.width,
    preview,
  })
  const toggle = () => save({
    patch: {
      workspace: {
        foldedProjects: { [column.id]: !folded },
      },
    },
  })

  const contentWidth = width - PROJECT_CONTENT_INSET
  const content = useMemo(
    () => children({
      scroll: scrollElement,
      width: contentWidth,
    }),
    [
      children,
      scrollElement,
      contentWidth,
    ],
  )

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

  const outdentSource = dragging.shift && dragging.active?.parent ? dragging.active : null
  const outdentOver = dragging.over?.zone === 'outdent' && dragging.over.id === column.id
    && dragging.over.hydra === hydraId ? dragging.over : null
  const outdentArmed = !!outdentSource && !!outdentOver && !nestingRefusal({
    source: outdentSource,
    target: outdentOver,
  })
  const showHint = dragging.active?.kind === 'task'
    && dragging.active.hydra === hydraId && dragging.active.column === column.id
    && !dragging.active.hasChildren

  return (
    <SortablePanel
      as="section"
      surface="column"
      layout="position"
      initial={false}
      ref={sort.setNodeRef}
      data-sort-key={sort.key}
      lifted={lifted}
      className={`project-column column group/project relative flex h-full min-h-0 flex-none flex-col overflow-visible rounded-xl border border-column-line bg-column-background wrap-anywhere data-[outdent-armed=true]:border-gold-line data-[outdent-armed=true]:ring-2 data-[outdent-armed=true]:ring-gold data-[outdent-armed=true]:ring-inset max-phone:snap-start ${folded ? 'folded min-w-12' : ''}`}
      data-column={column.id}
      data-resizing={preview !== null}
      data-outdent-armed={outdentArmed}
      data-sort-id={column.id}
      data-sort-kind="project"
      data-sort-scope="projects"
      data-sort-disabled={column.id === 'ideas'}
      aria-label={column.title}
      style={runtimeStyle({ projectCardWidth: `${contentWidth}px` })}
      animate={{ width: folded ? 48 : width }}
      transition={preview !== null || reduced ? { duration: motionDuration({ speed: 'instant' }) / 1000 } : undefined}
    >
      <ProjectColumnHeader
        column={column}
        poleis={poleis}
        folded={folded}
        hint={showHint}
        drag={sort}
        fold={toggle}
        create={create}
      />
      <FoldContent
        open={!folded}
        axis="none"
        ref={scrollRef}
        layoutScroll
        data-sort-surface={`tasks:${hydraId}:${column.id}`}
        className="column-cards project-cards block min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-2 [&[hidden]]:hidden"
      >
        <div ref={grid} className="project-card-grid relative w-(--project-card-width)">
          {content}
        </div>
      </FoldContent>
      {!folded && !phone && (
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
    </SortablePanel>
  )
}
