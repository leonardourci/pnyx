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
    <span className="project-counts inline-flex shrink-0 items-center gap-1 text-meta whitespace-nowrap writing-horizontal">
      <WaitingCount count={asks} />
      {running > 0 && <span className="running-count inline-flex shrink-0 items-center gap-1 text-meta whitespace-nowrap text-gold" aria-label={`${running} running`}><Icon name="play" size={ICON_SIZE.badge} />{running}</span>}
    </span>
  )
}
