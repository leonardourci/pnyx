import type { ComponentProps } from 'react'
import { Button } from './controls.tsx'

const VARIANTS = {
  hydra: 'text-[length:inherit] hydra-chip gap-1.75 border-line px-2.5 py-1 aria-[current=page]:border-gold-line aria-[current=page]:bg-gold-wash max-[760px]:px-2',
  project: 'border-column-line px-2.25 py-0.75 text-[length:inherit]',
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
  return <Button {...props} className={`flex-none touch-none whitespace-nowrap rounded-full ${VARIANTS[variant]} ${vertical ? '[writing-mode:vertical-rl]' : ''} ${className}`} />
}
