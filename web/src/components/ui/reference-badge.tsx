import { Fragment, type ComponentProps, type ReactNode } from 'react'
import { CHIP_JOIN, ICON_SPACE, WORD_JOINER } from '../../hydra/draft.ts'
import { Icon } from '../../shared/ui/icon.tsx'

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
    <span className={`draft-chip reference ${className}`} onMouseDown={event => event.preventDefault()} {...props}>
      {icons.map((
        icon,
        index,
      ) => (
        <Fragment key={icon}>
          {index > 0 && WORD_JOINER}
          <span className="chip-icon">{ICON_SPACE}<Icon name={icon} size={14} /></span>
        </Fragment>
      ))}
      {icons.length > 0 && CHIP_JOIN}{children}
    </span>
  )
}
