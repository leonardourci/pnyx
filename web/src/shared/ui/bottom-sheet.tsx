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
      onCancel={({ nativeEvent }) => {
        nativeEvent.preventDefault()
        close()
      }}
      onClick={({
        target,
        currentTarget,
      }) => {
        if (target === currentTarget) {
          close()
        }
      }}
    >{children}
    </OverlaySurface>
  )
}
