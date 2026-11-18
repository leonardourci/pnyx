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
    ? 'bg-surface border-l-3 border-l-gold [&>strong]:text-gold [&_p]:m-0'
    : 'bg-raised'

  return <Element {...props} className={`shrink-0 flex flex-col items-start gap-1.25 py-2 px-2.5 border border-line rounded-question-summary text-meta in-[.card]:gap-0.75 in-[.card]:py-1.5 in-[.card]:px-2 ${appearance} ${className}`} />
}
