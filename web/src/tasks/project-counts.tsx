import { WaitingCount } from '#web-shared/ui/waiting-count.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'

export function ProjectCounts({
  asks = 0,
  running = 0,
}: {
  asks?: number
  running?: number
}) {
  return (
    <span className="project-counts inline-flex items-center gap-1 text-meta">
      <WaitingCount count={asks} />
      {running > 0 && <span className="running-count inline-flex items-center gap-1 text-meta text-gold" aria-label={`${running} running`}><Icon name="play" size={ICON_SIZE.badge} />{running}</span>}
    </span>
  )
}
