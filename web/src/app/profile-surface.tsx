import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from 'react'
import { recordUIRender, type UISurface } from './ui-metrics.ts'

export function ProfileSurface({
  name,
  titanId,
  children,
}: {
  name: UISurface
  titanId?: string
  children: ReactNode
}) {
  if (import.meta.env.VITE_OTHRYS_PROFILE !== '1') {
    return children
  }

  // eslint-disable-next-line othrys/object-params -- React owns the Profiler callback signature.
  const rendered: ProfilerOnRenderCallback = (
    _id,
    _phase,
    actualDuration,
  ) => recordUIRender({
    surface: name,
    titanId,
    ms: actualDuration,
  })

  return <Profiler id={name} onRender={rendered}>{children}</Profiler>
}
