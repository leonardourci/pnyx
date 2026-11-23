import { COLUMN_CHIP_TONE } from '#web-titan/draft-chip.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'

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
    <span className={`chip column-chip inline-flex items-center gap-1 rounded-md px-1.5 py-0 align-baseline text-column-chip ${COLUMN_CHIP_TONE} ${tone}`}>
      <Icon name={icon} size={ICON_SIZE.inline} />
      {label}
    </span>
  )
}
