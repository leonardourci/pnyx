import { Icon } from '#web-shared/ui/icon.tsx'

export function ProjectCounts({
  asks = 0,
  running = 0,
}: {
  asks?: number
  running?: number
}) {
  return (
    <span className="project-counts">
      {asks > 0 && <span className="waiting-count" aria-label={`${asks} waiting for you`}>{asks}</span>}
      {running > 0 && <span className="running-count" aria-label={`${running} running`}><Icon name="play" size={12} />{running}</span>}
    </span>
  )
}
