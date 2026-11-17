import type { ComponentProps } from 'react'
import { Button } from './controls.tsx'
import { Icon } from './icon.tsx'

const SIZES = {
  usage: 'size-6.25 min-h-0 shrink-0 p-1 border-0 rounded-compact bg-transparent text-inherit opacity-76 cursor-pointer enabled:hover:opacity-100 enabled:hover:bg-usage-hover focus-visible:outline-1 focus-visible:outline-current focus-visible:outline-offset-2 aria-disabled:cursor-wait aria-disabled:opacity-45',
  menu: 'size-7 min-h-7 p-1',
  key: 'min-h-0 flex-none px-0.5 py-0 border-0 rounded-none bg-transparent text-muted enabled:hover:text-red enabled:hover:bg-transparent disabled:opacity-30 disabled:cursor-default',
  small: 'size-6 min-h-6 p-0 flex-none text-muted',
  copy: 'size-6.5 min-h-6.5 p-0 flex-none text-muted',
  normal: 'size-[var(--control-h)] flex-none p-1.5',
  compact: 'size-6.5 min-h-0 flex-none rounded-full p-1 text-meta',
  toggle: 'min-w-3.5 flex-none px-0 py-0.5',
}

export function IconButton({
  icon,
  label,
  size = 'normal',
  iconSize = 16,
  className = '',
  ...props
}: Omit<ComponentProps<typeof Button>, 'children'> & {
  icon: string
  label: string
  size?: keyof typeof SIZES
  iconSize?: number
}) {
  return <Button {...props} aria-label={label} className={`${SIZES[size]} ${className}`}><Icon name={icon} size={iconSize} /></Button>
}
