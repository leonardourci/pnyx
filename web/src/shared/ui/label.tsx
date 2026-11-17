import { Tooltip } from './tooltip.tsx'
import type { SavedLabelColor } from '#tasks/model.ts'

export function Label({
  label,
  text = label,
  colors,
  project = false,
}: {
  label: string
  text?: string
  colors?: SavedLabelColor[]
  project?: boolean
}) {
  return <Tooltip content={label}><span className={`task-label block w-fit max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded border border-label-line px-1.5 py-px text-meta leading-normal text-label-ink bg-label-fill${project ? ' project-label' : ''}`} data-label-color={colors?.find(entry => entry.label === label)?.color}>{text}</span></Tooltip>
}
