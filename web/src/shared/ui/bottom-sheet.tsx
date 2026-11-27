import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { OverlaySurface } from './overlay-surface.tsx'

export function BottomSheet({
  label,
  close,
  children,
}: {
  label: string
  close(): void
  children: ReactNode
}) {
  const sheet = useRef<HTMLDialogElement>(null)
  useLayoutEffect(
    () => {
      const element = sheet.current
      element?.showModal()

      return () => element?.close()
    },
    [],
  )

  return (
    <OverlaySurface
      ref={sheet}
      variant="sheet"
      aria-label={label}
      className="animate-sheet-rise"
      // eslint-disable-next-line othrys/object-params -- React owns the dialog event signature.
      onCancel={event => {
        event.preventDefault(); close()
      }}
      // eslint-disable-next-line othrys/object-params -- React owns the dialog event signature.
      onClick={event => {
        if (event.target === event.currentTarget) {
          close()
        }
      }}
    >{children}
    </OverlaySurface>
  )
}
