import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

const Context = createContext<{
  width: number
} | null>(null)

export function WorkspaceViewport({
  children,
}: {
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
      width,
    }),
    [width],
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
