import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Dialog } from '#web-shared/ui/dialog.tsx'
import { Resize } from '#web-shared/ui/resize.tsx'
import { useTaskModalSize } from './presentation.ts'

export function TaskCardModal({
  title,
  layoutId,
  close,
  children,
}: {
  title: string
  layoutId: string
  close(): void
  children: ReactNode
}) {
  const modal = useTaskModalSize()

  // Moving a dialog’s DOM ancestor removes it from the browser’s modal top layer.
  return createPortal(
    <Dialog
      title={title}
      layoutId={layoutId}
      className="task-modal max-w-none! max-h-none! overflow-visible!"
      style={modal.size}
      close={close}
    >
      {children}
      <Resize
        label="Resize task modal width"
        value={modal.size.width}
        min={modal.minimum.width}
        max={modal.maximum.width}
        onPreview={({ value }) => modal.preview({
          axis: 'width',
          value,
        })}
        onCommit={({ value }) => modal.commit({
          axis: 'width',
          value,
        })}
      />
      <Resize
        label="Resize task modal height"
        axis="y"
        value={modal.size.height}
        min={modal.minimum.height}
        max={modal.maximum.height}
        onPreview={({ value }) => modal.preview({
          axis: 'height',
          value,
        })}
        onCommit={({ value }) => modal.commit({
          axis: 'height',
          value,
        })}
      />
    </Dialog>,
    document.body,
  )
}
