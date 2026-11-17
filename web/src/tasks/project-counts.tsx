import { Icon } from '#web-shared/ui/icon.tsx'

export function ProjectCounts({
  asks = 0,
  running = 0,
}: {
  asks?: number
  running?: number
}) {
  return (
    <span className="project-counts inline-flex items-center gap-1 text-meta">
      {asks > 0 && <span className="waiting-count inline-grid h-4.75 min-w-4.75 place-items-center rounded-full bg-gold-fill px-1 text-[11px] text-gold-ink" aria-label={`${asks} waiting for you`}>{asks}</span>}
      {running > 0 && <span className="running-count inline-flex items-center gap-1 text-meta text-gold" aria-label={`${running} running`}><Icon name="play" size={12} />{running}</span>}
    </span>
  )
}
