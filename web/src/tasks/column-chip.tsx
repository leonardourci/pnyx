import { COLUMN_CHIP_TONE } from '#web-hydra/draft-chip.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'

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
    <span className={`chip column-chip inline-flex items-center gap-1 px-1.5 py-0 rounded-md text-column-chip align-baseline ${COLUMN_CHIP_TONE} ${tone}`} contentEditable={false}>
      <Icon name={icon} size={13} />
      {label}
    </span>
  )
}
