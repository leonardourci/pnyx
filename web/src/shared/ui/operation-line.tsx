import type { ComponentProps } from 'react'

export function OperationLine({
  as: Tag = 'div',
  upgrade = false,
  className = '',
  ...props
}: ComponentProps<'div'> & {
  as?: 'div' | 'span'
  upgrade?: boolean
}) {
  const appearance = upgrade ? 'upgrade-row items-start [&>svg]:mt-0.75 [&>svg]:shrink-0' : 'items-center'

  return (
    <Tag
      {...props}
      className={`compaction-row flex gap-2 text-ui text-muted tabular-nums data-[state=failed]:text-red ${appearance} ${className}`}
    />
  )
}
