import type { ComponentProps } from 'react'

export function QuestionPanel({
  as: Element = 'article',
  answered = false,
  className = '',
  ...props
}: ComponentProps<'article'> & {
  as?: 'article' | 'section'
  answered?: boolean
}) {
  const appearance = answered ? 'answered border-line bg-transparent' : 'border-line border-l-gold bg-surface'

  return <Element {...props} className={`ask flex flex-col gap-1.5 my-2 mx-0 p-2 text-ui border border-l-3 rounded-xl [&>p]:whitespace-pre-wrap [&>p]:text-ui [&_form]:flex [&_form]:flex-col [&_form]:gap-1.5 ${appearance} ${className}`} />
}

export function QuestionHeading({ ...props }: ComponentProps<'strong'>) {
  return <strong {...props} className="ask-title flex items-center gap-1.5 text-meta font-semibold text-gold" />
}

export function QuestionFields({ ...props }: ComponentProps<'div'>) {
  return <div {...props} className="ask-choices flex flex-col gap-1.5 [&[hidden]]:hidden" />
}

export function QuestionOptions({ ...props }: ComponentProps<'div'>) {
  return <div {...props} className="ask-options flex flex-col gap-0.75" />
}

export function QuestionActions({ ...props }: ComponentProps<'div'>) {
  return <div {...props} className="pending-decision-actions flex items-center justify-between gap-3 w-full [&>.button]:py-1.25 [&>.button]:px-2.25 [&>.button]:text-meta" />
}

export const QUESTION_HEADLINE = 'm-0 text-ink font-semibold wrap-anywhere'
export const QUESTION_SOURCE = 'm-0 text-muted text-meta'

export function RecommendedBadge({ compact = false }: { compact?: boolean }) {
  const size = compact ? 'shrink-0 m-0 px-1 text-recommended' : 'ml-1.5 px-1.5 text-meta'

  return <span className={`decision-recommended py-0 rounded-sm bg-gold-wash text-gold font-semibold ${size}`}>Recommended</span>
}
