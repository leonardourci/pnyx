import type { ComponentProps, KeyboardEvent } from 'react'
import { Popover } from '#web-shared/ui/popover.tsx'

export function ModelPicker({
  className = '',
  ...props
}: ComponentProps<typeof Popover>) {
  return <Popover {...props} className={`account-model-picker [&_.popover-panel]:h-model-menu-height [&_.popover-panel]:w-model-menu [&_.popover-panel]:p-0 [&>.button]:min-h-9 [&>.button]:gap-1.75 [&>.button]:px-1.25 [&>.button]:py-0.5 [&>.button]:text-left in-[.settings-page]:[&>.button]:max-w-full ${className}`} />
}

export function ModelMenu({
  keyboard,
  ...props
}: Omit<ComponentProps<'div'>, 'onKeyDown'> & { keyboard({ event }: { event: KeyboardEvent<HTMLDivElement> }): void }) {
  return <div {...props} onKeyDown={event => keyboard({ event })} className="account-model-menu flex h-full min-h-0 flex-col gap-2 p-2 [&_.search-bar]:flex-none" />
}

export function ModelResults({ ...props }: ComponentProps<'div'>) {
  return <div {...props} className="account-model-results min-h-8 flex-1 scrollbar-none overflow-auto overscroll-contain [&::-webkit-scrollbar]:hidden [&>:is(p,[role=alert])]:p-2 [&>:is(p,[role=alert])]:text-meta [&>:is(p,[role=alert])]:text-muted" />
}
