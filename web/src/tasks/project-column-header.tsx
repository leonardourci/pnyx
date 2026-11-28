import { motion } from 'motion/react'
import type { KeyboardEventHandler } from 'react'
import type { useSortItem } from '#web-shared/ui/sortable.tsx'
import { Button } from '#web-shared/ui/controls.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { IconButton } from '#web-shared/ui/icon-button.tsx'
import { ProjectCounts } from './project-counts.tsx'
import type { ProjectColumnData } from './project-view.ts'

type ColumnDrag = Pick<ReturnType<typeof useSortItem>, 'attributes' | 'listeners' | 'setActivatorNodeRef' | 'pointerDown'>

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
  fold?(): unknown
  create(): void
}) {
  const keyDown = drag.listeners?.onKeyDown as KeyboardEventHandler<HTMLButtonElement> | undefined
  const foldLabel = `${folded ? 'Unfold' : 'Fold'} ${column.title}`

  return (
    <header onPointerDown={drag.pointerDown} className="project-column-heading relative flex min-h-10.75 items-center justify-between gap-2 border-b border-column-line px-2 py-1.25 group-[.folded]/project:h-full group-[.folded]/project:border-0 group-[.folded]/project:p-2">
      <div className={`contents ${hint ? 'invisible' : ''}`} aria-hidden={hint}>
        <Button
          className="min-w-0 touch-none justify-start gap-2 group-[.folded]/project:self-start group-[.folded]/project:writing-vertical max-phone:touch-auto [&>strong]:truncate"
          {...drag.attributes}
          onKeyDown={keyDown}
          aria-disabled={undefined}
          ref={drag.setActivatorNodeRef}
          data-column-heading={column.id}
          aria-label={fold ? foldLabel : column.title}
          onClick={fold}
        >{fold && <Icon name={folded ? 'chevron_right' : 'chevron_left'} size={ICON_SIZE.control} />}<strong>{column.title}</strong><ProjectCounts asks={column.asks} running={column.running} />
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
