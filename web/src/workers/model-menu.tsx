import type { ComponentProps, KeyboardEvent } from 'react'
import { Popover } from '#web-shared/ui/popover.tsx'

export function ModelPicker({
  className = '',
  ...props
}: ComponentProps<typeof Popover>) {
  return <Popover {...props} className={`account-model-picker [&>.button]:min-h-9 [&>.button]:py-0.5 [&>.button]:px-1.25 [&>.button]:gap-1.75 [&>.button]:text-left [&_.popover-panel]:w-model-menu [&_.popover-panel]:h-model-menu-height [&_.popover-panel]:p-0 [&_.popover-panel]:overflow-hidden in-[.settings-page]:[&>.button]:max-w-full ${className}`} />
}

export function ModelMenu({
  keyboard,
  ...props
}: Omit<ComponentProps<'div'>, 'onKeyDown'> & { keyboard({ event }: { event: KeyboardEvent<HTMLDivElement> }): void }) {
  return <div {...props} onKeyDown={event => keyboard({ event })} className="account-model-menu h-full flex flex-col min-h-0 p-2 gap-2 [&_.search-bar]:flex-none" />
}

export function ModelResults({ ...props }: ComponentProps<'div'>) {
  return <div {...props} className="account-model-results flex-1 min-h-0 overflow-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>:is(p,[role=alert])]:p-2 [&>:is(p,[role=alert])]:text-meta [&>:is(p,[role=alert])]:text-muted" />
}
