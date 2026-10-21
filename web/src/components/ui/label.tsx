import type { SavedLabelColor } from '../../../../src/core/model.ts'

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
  return <span className={`task-label${project ? ' project-label' : ''}`} data-label-color={colors?.find(entry => entry.label === label)?.color} title={label}>{text}</span>
}
