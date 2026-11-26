import type { ComponentProps, ReactNode } from 'react'
import { Button } from './controls.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'

export function Highlight({
  text,
  terms,
}: {
  text: string
  terms: string[]
}) {
  if (!terms.length) {
    return text
  }

  const pattern = new RegExp(
    `(${terms.map(term => term.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    )).join('|')})`,
    'gi',
  )

  return text.split(pattern).map((
    part,
    index,
  ) => index % 2 ? <mark key={index}>{part}</mark> : part)
}

export function SettingRow({
  icon,
  label,
  description,
  terms = [],
  changed = false,
  reset,
  resetTo,
  preview,
  action,
  children,
}: {
  icon: string
  label: string
  description: string
  // Search words to highlight in the name and description.
  terms?: string[]
  changed?: boolean
  reset?(): void
  // The default named on the reset link, such as 14 px.
  resetTo?: string
  // A live picture of what the setting changes.
  preview?: ReactNode
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="setting-row group/setting grid grid-cols-setting items-start gap-(--settings-column-gap) border-t border-subtle px-5 py-4 data-preview:grid-cols-setting-preview max-phone:data-preview:grid-cols-setting" data-changed={changed || undefined} data-preview={preview ? '' : undefined}>
      <span className="setting-icon grid size-setting-icon place-items-center rounded-control border border-subtle bg-raised text-muted group-data-changed/setting:border-gold-line group-data-changed/setting:bg-gold-wash group-data-changed/setting:text-gold"><Icon name={icon} size={ICON_SIZE.control} /></span>
      <div className="setting-body min-w-0 [&_mark]:rounded-xs [&_mark]:bg-gold/28 [&_mark]:px-px [&_mark]:py-0 [&_mark]:text-inherit">
        <div className="setting-head flex flex-wrap items-center gap-2 has-[.setting-action]:flex-nowrap [&:has(.setting-action)>.setting-name]:min-w-0 [&:has(.setting-action)>.setting-name]:flex-1 [&:has(.setting-action)>.setting-name]:wrap-anywhere">
          <span className="setting-name text-ui font-semibold"><Highlight text={label} terms={terms} /></span>
          {changed && <span className="setting-changed rounded-full border border-gold-line px-1.5 py-0 text-meta font-medium text-gold">changed</span>}
          {action && <span className="setting-action ml-auto inline-flex items-center">{action}</span>}
        </div>
        <p className="setting-description mx-0 mt-0.75 mb-2.5 text-ui text-muted"><Highlight text={description} terms={terms} /></p>
        {children && <div className="setting-control min-w-0">{children}</div>}
        {changed && reset && (
          <Button className="setting-reset mt-1.5 min-h-0 gap-1 bg-transparent p-0 text-meta text-gold enabled:hover:bg-transparent enabled:hover:underline" onClick={reset}>
            <Icon name="reset" size={ICON_SIZE.badge} />Reset to default{resetTo ? ` (${resetTo})` : ''}
          </Button>
        )}
      </div>
      {preview && <div className="setting-preview flex min-w-0 flex-col max-phone:col-span-full">{preview}</div>}
    </div>
  )
}

export function SettingsRows({
  className = '',
  ...props
}: ComponentProps<'div'>) {
  return <div {...props} className={`settings-rows rounded-card border border-line bg-surface [&>:first-child]:border-t-0 ${className}`} />
}

export const SETTING_STACK = 'setting-stack flex flex-col items-start [&>.slider-field]:self-stretch [&>.titan-agent-pickers]:self-stretch [:where(&)]:gap-2'

export function SettingStack({
  className = '',
  ...props
}: ComponentProps<'div'>) {
  return <div {...props} className={`${SETTING_STACK} ${className}`} />
}

export function SettingField({
  className = '',
  ...props
}: ComponentProps<'div'>) {
  return <div {...props} className={`setting-field flex w-full flex-col gap-2 [&_.setting-description]:m-0 ${className}`} />
}
