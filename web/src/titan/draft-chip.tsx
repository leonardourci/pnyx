import type { ComponentProps } from 'react'

export const COLUMN_CHIP_TONE = 'text-chip-column bg-chip-column-fill shadow-chip-column'

export function DraftChip({
  className = '',
  ...props
}: ComponentProps<'span'>) {
  const tone = 'cursor-pointer -mx-(--spacing-chip-inline) px-(--spacing-chip-inline) py-(--chip-pad) bg-gold-wash text-gold shadow-chip-reference data-[kind=file]:cursor-default data-[kind=column]:cursor-default data-[kind=slot]:text-muted data-[kind=slot]:italic data-[kind=slot]:bg-transparent [&:is([data-kind=column],[data-kind=task])]:text-chip-column [&:is([data-kind=column],[data-kind=task])]:bg-chip-column-fill [&:is([data-kind=column],[data-kind=task])]:shadow-chip-column'

  return <span {...props} className={`draft-chip reference rounded-compact box-decoration-clone [:where(.markdown,.message_.message-lead)_&:not(.composer-field_*)]:inline-block [:where(.markdown,.message_.message-lead)_&:not(.composer-field_*)]:max-w-full [:where(.markdown,.message_.message-lead)_&:not(.composer-field_*)]:leading-(--chip-text) ${tone} ${className}`} />
}

export function ChipIcon({
  className = '',
  ...props
}: ComponentProps<'span'>) {
  return <span {...props} className={`chip-icon relative inline [&>svg]:absolute [&>svg]:left-1/2 [&>svg]:top-1/2 [&>svg]:-translate-x-1/2 [&>svg]:-translate-y-1/2 ${className}`} />
}
