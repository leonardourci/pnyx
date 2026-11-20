import type { ComponentProps } from 'react'
import { TooltipSection } from '#web-shared/ui/tooltip.tsx'

const ROWS = {
  header: 'justify-between gap-1.5 text-usage-heading',
  icon: 'gap-1.75 [&>b]:ml-auto',
  source: 'gap-1.75 text-usage-detail opacity-76',
  amounts: 'justify-between gap-1.5 text-usage-detail',
  account: 'my-0.75 gap-1.75 text-usage-heading',
  reset: 'flex-wrap gap-0.75 text-usage-reset opacity-90 [&>span]:whitespace-nowrap [&>time]:whitespace-nowrap [&>time]:opacity-80',
}

export function UsageRow({
  variant = 'icon',
  className = '',
  ...props
}: ComponentProps<'span'> & { variant?: keyof typeof ROWS }) {
  return <span {...props} className={`flex items-center ${ROWS[variant]} ${className}`} />
}

export function UsageStack({
  compact = false,
  className = '',
  ...props
}: ComponentProps<'span'> & { compact?: boolean }) {
  return <span {...props} className={`flex flex-col ${compact ? 'gap-1.25' : 'gap-1.75'} ${className}`} />
}

export function UsageText({
  className = '',
  ...props
}: ComponentProps<'span'>) {
  return <span {...props} className={`text-usage-detail opacity-76 ${className}`} />
}

export function UsageSection({
  divided = false,
  className = '',
  ...props
}: ComponentProps<typeof TooltipSection> & { divided?: boolean }) {
  const variant = divided ? 'border-t border-usage-line pt-2.5 gap-1.25 text-usage-heading' : 'gap-1.75'

  return <TooltipSection {...props} className={`${variant} ${className}`} />
}

export const USAGE_TONE = 'data-[tone=critical]:usage-critical data-[tone=normal]:usage-normal data-[tone=warning]:usage-warning'
