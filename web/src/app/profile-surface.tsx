import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from 'react'
import { recordUIRender, type UISurface } from './ui-metrics.ts'

export function ProfileSurface({
  name,
  hydraId,
  children,
}: {
  name: UISurface
  hydraId?: string
  children: ReactNode
}) {
  if (import.meta.env.VITE_PNYX_PROFILE !== '1') {
    return children
  }

  // eslint-disable-next-line pnyx/object-params -- React owns the Profiler callback signature.
  const rendered: ProfilerOnRenderCallback = (
    _id,
    _phase,
    actualDuration,
  ) => recordUIRender({
    surface: name,
    hydraId,
    ms: actualDuration,
  })

  return <Profiler id={name} onRender={rendered}>{children}</Profiler>
}
