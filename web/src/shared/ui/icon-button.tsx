import type { ComponentProps } from 'react'
import { Button } from './controls.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'

const SIZES = {
  usage: 'size-6.25 min-h-0 shrink-0 cursor-pointer rounded-compact border-0 bg-transparent p-1 text-inherit opacity-76 focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-current enabled:hover:bg-usage-hover aria-disabled:cursor-wait aria-disabled:opacity-45 [&:not([aria-disabled=true]):hover]:opacity-100',
  menu: 'size-7 min-h-7 p-1',
  key: 'min-h-0 flex-none rounded-none border-0 bg-transparent px-0.5 py-0 text-muted enabled:hover:bg-transparent enabled:hover:text-red disabled:cursor-default disabled:opacity-30',
  small: 'size-6 min-h-6 flex-none p-0 text-muted',
  copy: 'size-6.5 min-h-6.5 flex-none p-0 text-muted',
  normal: 'size-(--control-h) flex-none p-1.5',
  compact: 'size-6.5 min-h-0 flex-none rounded-full p-1 text-meta',
  toggle: 'min-w-3.5 flex-none px-0 py-0.5',
}

export function IconButton({
  icon,
  label,
  size = 'normal',
  iconSize = ICON_SIZE.control,
  className = '',
  ...props
}: Omit<ComponentProps<typeof Button>, 'children'> & {
  icon: string
  label: string
  size?: keyof typeof SIZES
  iconSize?: number
}) {
  return (
    <Button
      data-ui-action={icon}
      {...props}
      aria-label={label}
      className={`${SIZES[size]} ${className}`}
    ><Icon name={icon} size={iconSize} />
    </Button>
  )
}
