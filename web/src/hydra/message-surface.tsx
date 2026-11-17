import type { ComponentProps } from 'react'

export function MessageBubble({
  mine = false,
  kind = '',
  className = '',
  ...props
}: ComponentProps<'article'> & {
  mine?: boolean
  kind?: string
}) {
  const appearance = mine
    ? 'mine self-end max-w-[85%] px-3.5 py-2.5 rounded-message bg-hover font-sans in-[.hydra-chat]:max-w-full'
    : ''

  return <article {...props} className={`message has-[.answer-lead_.show-more[aria-expanded=false]]:cursor-pointer min-w-0 animate-reply-appear motion-reduce:animate-none data-sending:opacity-50 data-unsent:opacity-70 data-pnyx:text-muted data-pnyx:before:content-['Pnyx'] data-pnyx:before:block data-pnyx:before:font-sans data-pnyx:before:text-meta data-pnyx:before:font-semibold data-pnyx:before:tracking-normal [&:is(.tool,.thinking)+.message:is(.tool,.thinking)]:-mt-3.5 in-[.hydra-chat]:[&:is(.tool,.thinking)+.message:is(.tool,.thinking)]:mt-[calc(--spacing(1)-var(--chat-gap))] [&[data-streaming]>.markdown]:after:content-[''] [&[data-streaming]>.markdown]:after:inline-block [&[data-streaming]>.markdown]:after:w-1.25 [&[data-streaming]>.markdown]:after:h-3 [&[data-streaming]>.markdown]:after:ml-0.75 [&[data-streaming]>.markdown]:after:bg-muted [&[data-streaming]>.markdown]:after:rounded-xs ${kind} ${appearance} ${className}`} />
}

export function MessageFooter({
  variant,
  className = '',
  ...props
}: ComponentProps<'div'> & { variant: 'owner' | 'agent' }) {
  const appearance = {
    owner: 'message-meta self-end -mt-3 in-[.hydra-chat]:mt-[calc(--spacing(1.5)-var(--chat-gap))] [&_time]:px-1 [&_time]:py-0 [&_time]:tabular-nums',
    agent: 'turn-foot self-start -mt-2.5 in-[.hydra-chat]:mt-[calc(--spacing(2)-var(--chat-gap))] [&>:is(time,span)]:px-1 [&>:is(time,span)]:py-0 [&>:is(time,span)]:tabular-nums',
  }[variant]

  return <div {...props} className={`flex items-center gap-0.5 text-muted text-meta ${appearance} ${className}`} />
}
