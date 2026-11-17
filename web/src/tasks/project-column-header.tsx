import { motion } from 'motion/react'
import type { useSortItem } from '#web-shared/ui/sortable.tsx'
import { Button } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { IconButton } from '#web-shared/ui/icon-button.tsx'
import { ProjectCounts } from './project-counts.tsx'
import type { ProjectColumnData } from './project-view.ts'

type ColumnDrag = Pick<ReturnType<typeof useSortItem>, 'attributes' | 'listeners' | 'setActivatorNodeRef'>

export function ProjectColumnHeader({
  column,
  folded,
  hint,
  drag,
  fold,
  create,
}: {
  column: ProjectColumnData
  folded: boolean
  hint: boolean
  drag: ColumnDrag
  fold(): unknown
  create(): void
}) {
  return (
    <header className="project-column-heading relative flex min-h-10.75 items-center justify-between gap-2 border-b border-column-line px-2 py-1.25 group-[.folded]/project:h-full group-[.folded]/project:border-0 group-[.folded]/project:p-2">
      <div className={`contents ${hint ? 'invisible' : ''}`} aria-hidden={hint}>
        <Button
          className="min-w-0 touch-none justify-start gap-2 [&>strong]:truncate group-[.folded]/project:self-start group-[.folded]/project:[writing-mode:vertical-rl]"
          {...drag.attributes}
          {...drag.listeners}
          ref={drag.setActivatorNodeRef}
          data-column-heading={column.id}
          data-key-scope="hydra"
          aria-label={`${folded ? 'Unfold' : 'Fold'} ${column.title}`}
          onClick={fold}
        ><Icon name={folded ? 'chevron_right' : 'chevron_left'} size={15} /><strong>{column.title}</strong><ProjectCounts asks={column.asks} running={column.running} />
        </Button>
        {!folded && <IconButton icon="plus" label={`New task in ${column.title}`} onClick={create} />}
      </div>
      {hint && (
        <motion.p
          data-drag-column-hint
          role="status"
          className="absolute inset-x-2 inset-y-1 m-0 flex flex-wrap content-center items-center justify-center gap-x-1 text-center text-meta leading-tight text-gold"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >Hold <kbd className="inline-flex items-center gap-0.5 rounded border border-gold-line px-1 py-px font-sans font-medium">⇧ shift</kbd> and drop on a task to make it a sub-task
        </motion.p>
      )}
    </header>
  )
}
