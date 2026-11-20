import type { ComponentProps } from 'react'

export function SummaryPanel({
  as: Element = 'section',
  tone = 'raised',
  className = '',
  ...props
}: Omit<ComponentProps<'section'>, 'ref'> & {
  as?: 'section' | 'div'
  tone?: 'raised' | 'accent'
}) {
  const appearance = tone === 'accent'
    ? 'border-l-3 border-l-gold bg-surface [&_p]:m-0 [&>strong]:text-gold'
    : 'bg-raised'

  return <Element {...props} className={`flex shrink-0 flex-col items-start gap-1.25 rounded-question-summary border border-line px-2.5 py-2 text-meta in-[.card]:gap-0.75 in-[.card]:px-2 in-[.card]:py-1.5 ${appearance} ${className}`} />
}
