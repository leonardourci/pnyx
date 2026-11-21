import type { ComponentProps } from 'react'
import { Button } from '#web-shared/ui/controls.tsx'

export function ComposerFrame({
  className = '',
  ...props
}: ComponentProps<'form'>) {
  return <form {...props} className={`composer [.thread>&]:m-0 [.thread>&]:px-2.5 [.thread>&]:py-1 [.thread>&]:border-0 [.thread>&]:rounded-none group/composer relative flex shrink-0 data-[limit-height=true]:max-h-[min(50%,var(--spacing-composer-max))] flex-col gap-1 rounded-2xl border border-line bg-composer pt-2.5 pr-2.5 pb-1.5 pl-3 transition-[border-color,box-shadow] duration-(--transition-duration-composer) focus-within:border-gold-line focus-within:ring-3 focus-within:ring-gold-wash [&_.select-menu]:max-h-none! [&_.select-menu]:overflow-visible! [&_.select-menu]:[scrollbar-width:none] [&_.select-menu::-webkit-scrollbar]:hidden ${className}`} />
}

export function ComposerBar({
  className = '',
  ...props
}: ComponentProps<'div'>) {
  return <div {...props} className={`composer-bar [--composer-control-h:var(--spacing-composer-control)] flex min-h-(--spacing-composer-control) shrink-0 items-center gap-(--composer-control-gap) [&_.hydra-agent-pickers]:gap-(--composer-control-gap) [&_:is(.hydra-agent-pickers_.select>.button,.fast-toggle)]:min-h-(--spacing-composer-control) [&_:is(.hydra-agent-pickers_.select>.button,.fast-toggle)]:h-(--spacing-composer-control) [&_:is(.hydra-agent-pickers_.select>.button,.account-model-picker>.button)]:px-1.25 [&_:is(.hydra-agent-pickers_.select>.button,.account-model-picker>.button)]:py-0 [&_:is(.hydra-agent-pickers_.select>.button,.account-model-picker>.button)]:gap-(--composer-control-gap) [&_.fast-toggle]:w-(--spacing-composer-control) [&_.fast-toggle]:p-0 [&_.account-model-picker>.button>svg:first-child]:text-muted [&_.account-model-label]:leading-[1.1] [&_.account-model-label>span]:text-meta [&_.account-model-label>small]:text-composer-account [&_.agent-settings-menu>.button]:max-w-full [&_.agent-settings-menu>.button]:text-ink [&_.agent-settings-menu>.button]:text-meta [&_.agent-settings-menu>.button]:whitespace-nowrap ${className}`} />
}

export function ComposerAction({
  kind,
  className = '',
  ...props
}: ComponentProps<typeof Button> & { kind: 'send' | 'stop' }) {
  const action = kind === 'send' ? 'composer-send ml-auto' : 'composer-stop border border-line text-ink [&+.composer-send]:ml-0'

  return <Button {...props} className={`size-(--spacing-composer-control) min-h-(--spacing-composer-control) justify-center rounded-full p-0 ${action} ${className}`} />
}

export function ComposerSettings({
  className = '',
  ...props
}: ComponentProps<'div'>) {
  return <div {...props} className={`composer-settings block min-w-0 flex-1 ${className}`} />
}
