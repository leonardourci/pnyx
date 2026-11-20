import { createContext, useContext, useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react'

const Context = createContext<{
  axis: RefObject<HTMLDivElement | null>
  width: number
} | null>(null)

export function WorkspaceViewport({
  axis,
  children,
}: {
  axis: RefObject<HTMLDivElement | null>
  children: ReactNode
}) {
  const [
    width,
    setWidth,
  ] = useState(innerWidth)
  useEffect(
    () => {
      const resize = () => setWidth(innerWidth)
      addEventListener(
        'resize',
        resize,
      )

      return () => removeEventListener(
        'resize',
        resize,
      )
    },
    [],
  )
  const value = useMemo(
    () => ({
      axis,
      width,
    }),
    [
      axis,
      width,
    ],
  )

  return <Context value={value}>{children}</Context>
}

export function useWorkspaceViewport() {
  const value = useContext(Context)

  if (!value) {
    throw new Error('WorkspaceViewport is required')
  }

  return value
}
