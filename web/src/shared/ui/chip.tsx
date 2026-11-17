import type { ComponentProps } from 'react'
import { Button } from './controls.tsx'

const VARIANTS = {
  settings: 'settings-chip min-h-6 gap-1.25 px-2.5 py-0.5 border-line bg-surface text-ink text-meta [&_svg]:text-muted data-zero:opacity-40 aria-pressed:bg-gold-wash aria-pressed:border-gold-line aria-pressed:text-gold aria-pressed:[&_svg]:text-gold',
  hydra: 'text-[length:inherit] touch-none hydra-chip gap-1.75 border-line px-2.5 py-1 aria-[current=page]:border-gold-line aria-[current=page]:bg-gold-wash max-[760px]:px-2',
  project: 'touch-none border-column-line px-2.25 py-0.75 text-[length:inherit]',
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
  return <Button {...props} className={`flex-none whitespace-nowrap rounded-full ${VARIANTS[variant]} ${vertical ? '[writing-mode:vertical-rl]' : ''} ${className}`} />
}
