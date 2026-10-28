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
  return <Tooltip content={label}><span className={`task-label${project ? ' project-label' : ''}`} data-label-color={colors?.find(entry => entry.label === label)?.color}>{text}</span></Tooltip>
}
