import { Tooltip } from './tooltip.tsx'
import type { SavedLabelColor } from '#tasks/model.ts'

export function Label({
  label,
  text = label,
  colors,
  project = false,
  wrap = false,
  compact = false,
}: {
  label: string
  text?: string
  colors?: SavedLabelColor[]
  project?: boolean
  wrap?: boolean
  compact?: boolean
}) {
  const wrapping = wrap ? 'whitespace-normal wrap-anywhere text-clip' : 'whitespace-nowrap text-ellipsis'
  const padding = compact ? 'px-1' : 'px-1.5'

  return <Tooltip content={label}><span className={`task-label block w-fit max-w-full overflow-hidden rounded border border-label-line py-px text-meta leading-normal text-label-ink bg-label-fill ${wrapping} ${padding}${project ? ' project-label' : ''}`} data-label-color={colors?.find(entry => entry.label === label)?.color}>{text}</span></Tooltip>
}
