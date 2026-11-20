import { ICON_SIZE } from '#web-shared/icons.tsx'
import type { ComponentProps, ReactNode } from 'react'
import { motion } from 'motion/react'
import { IconButton } from '#web-shared/ui/icon-button.tsx'

export function CardShell({
  selected = false,
  lifted = false,
  nesting = false,
  tint,
  className = '',
  style,
  ...props
}: ComponentProps<'article'> & {
  selected?: boolean
  lifted?: boolean
  nesting?: boolean
  tint?: string
}) {
  const border = selected || lifted ? 'border-gold-line' : 'border-line select-none hover:border-control has-[.card-open:focus-visible]:border-gold'
  const selection = selected ? 'selected min-h-0' : 'min-h-24'

  return (
    <article
      {...props}
      // eslint-disable-next-line no-restricted-syntax -- Motion forwards its own animation styles through this host component.
      style={style}
      data-nest-armed={nesting}
      data-label-color={tint}
      className={`card group/card relative m-0 flex w-full min-w-0 shrink-0 cursor-pointer touch-pan-y flex-col gap-1.75 overflow-clip rounded-card border bg-card-fill px-2.75 pt-2.25 pb-2.5 transition-colors duration-150 backdrop:bg-shadow has-[.resize:active]:transition-colors data-[nest-armed=true]:border-gold-line data-[nest-armed=true]:ring-2 data-[nest-armed=true]:ring-gold data-[nest-armed=true]:ring-inset motion-reduce:transition-none ${border} ${selection} ${className}`}
    />
  )
}

export function CardContent({
  className = '',
  ...props
}: ComponentProps<'div'>) {
  return <div {...props} className={`card-content flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden [&>*]:shrink-0 [&>.card-open-content]:shrink ${className}`} />
}

export const AnimatedCardShell = motion.create(CardShell)
export const AnimatedCardContent = motion.create(CardContent)

export function CardHeading({
  title,
  hasChildren,
  childrenOpen,
  toggleChildren,
  children,
}: {
  title: string
  hasChildren?: boolean
  childrenOpen?: boolean
  toggleChildren?(): void
  children: ReactNode
}) {
  return (
    <div className="card-title-row flex min-w-0 items-start gap-1.25 [&>.tooltip-anchor]:shrink-0">
      {hasChildren && toggleChildren && (
        <IconButton
          icon={childrenOpen ? 'chevron_up' : 'chevron_down'}
          iconSize={ICON_SIZE.inline}
          size="toggle"
          className="subtask-toggle"
          label={`Sub-tasks of ${title}`}
          aria-expanded={childrenOpen}
          onClick={() => toggleChildren?.()}
        />
      )}
      {children}
    </div>
  )
}

export function CardPanel({
  className = '',
  ...props
}: ComponentProps<'div'>) {
  return <div {...props} role="tabpanel" className={`card-panel flex min-h-0 min-w-0 flex-1 flex-col gap-2.25 overflow-auto [&>.detail]:flex-none [&>.detail]:overflow-visible [&[hidden]]:hidden ${className}`} />
}

export function CardSection({
  heading,
  className = '',
  children,
}: {
  heading: string
  className?: string
  children: ReactNode
}) {
  return <section className={`card-section flex flex-col gap-0.75 [&>.eyebrow]:m-0 [&>.eyebrow]:text-gold! ${className}`} aria-label={heading}><h3 className="eyebrow">{heading}</h3>{children}</section>
}
