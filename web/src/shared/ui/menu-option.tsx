import type { ComponentProps } from 'react'

export function MenuOption({
  compact = false,
  active = false,
  selected = false,
  disabled = false,
  className = '',
  children,
  onClick,
  ...props
}: ComponentProps<'div'> & {
  compact?: boolean
  active?: boolean
  selected?: boolean
  disabled?: boolean
}) {
  return (
    <div
      {...props}
      className={`menu-option flex items-center justify-between ${compact ? 'gap-0' : 'gap-5'} min-w-0 rounded-sm cursor-pointer text-ui [&:not([aria-disabled=true]):is([data-active],:focus-within)]:bg-hover aria-disabled:opacity-45 aria-disabled:cursor-default [&[aria-disabled=true]_.button:disabled]:opacity-100 [&>.button:enabled:hover]:bg-transparent [&>.tooltip-anchor>.button:enabled:hover]:bg-transparent ${className}`}
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      data-active={active || undefined}
      onClick={event => {
        if (!disabled) {
          onClick?.(event)
        }
      }}
    >{children}
    </div>
  )
}
