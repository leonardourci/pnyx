import { Icon } from '../../shared/ui/icon.tsx'

export function ColumnChip({
  icon,
  tone,
  label,
}: {
  icon: string
  tone: string
  label: string
}) {
  return (
    <span className={`chip column-chip ${tone}`} contentEditable={false}>
      <Icon name={icon} size={13} />
      {label}
    </span>
  )
}
