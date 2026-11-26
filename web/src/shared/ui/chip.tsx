import type { ComponentProps } from 'react'
import { Button } from './controls.tsx'

const VARIANTS = {
  settings: 'settings-chip min-h-6 gap-1.25 border-line bg-surface px-2.5 py-0.5 text-meta text-ink aria-pressed:border-gold-line aria-pressed:bg-gold-wash aria-pressed:text-gold data-zero:opacity-40 [&_svg]:text-muted aria-pressed:[&_svg]:text-gold',
  titan: 'titan-chip touch-none gap-1.75 border-line px-2.5 py-1 text-inherit-size aria-[current=page]:border-gold-line aria-[current=page]:bg-gold-wash max-phone:px-2',
  project: 'touch-none border-column-line px-2.25 py-0.75 text-inherit-size',
}

export function Chip({
  variant = 'project',
  vertical = false,
  className = '',
  ...props
}: Omit<ComponentProps<typeof Button>, 'variant'> & {
  variant?: keyof typeof VARIANTS
  vertical?: boolean
}) {
  return <Button {...props} className={`flex-none rounded-full whitespace-nowrap ${VARIANTS[variant]} ${vertical ? 'w-full writing-vertical focus-visible:-outline-offset-2' : 'w-max'} ${className}`} />
}
