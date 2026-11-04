import type { ComponentProps } from 'react'

export function MenuOption({
  active = false,
  selected = false,
  disabled = false,
  className = '',
  children,
  onClick,
  ...props
}: ComponentProps<'div'> & {
  active?: boolean
  selected?: boolean
  disabled?: boolean
}) {
  return (
    <div
      {...props}
      className={`menu-option ${className}`}
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
