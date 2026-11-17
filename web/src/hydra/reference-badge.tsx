import { DraftChip, ChipIcon } from './draft-chip.tsx'
import { Fragment, type ComponentProps, type ReactNode } from 'react'
import { CHIP_JOIN, ICON_SPACE, WORD_JOINER } from './draft.ts'
import { Icon } from '#web-shared/ui/icon.tsx'

export function ReferenceBadge({
  icons,
  children,
  className = '',
  ...props
}: ComponentProps<'span'> & {
  icons: string[]
  children: ReactNode
}) {
  return (
    <DraftChip
      className={className}
      // eslint-disable-next-line pnyx/object-params -- React owns the pointer event signature.
      onMouseDown={event => event.preventDefault()}
      {...props}
    >
      {icons.map((
        icon,
        index,
      ) => (
        <Fragment key={icon}>
          {index > 0 && WORD_JOINER}
          <ChipIcon>{ICON_SPACE}<Icon name={icon} size={14} /></ChipIcon>
        </Fragment>
      ))}
      {icons.length > 0 && CHIP_JOIN}{children}
    </DraftChip>
  )
}
