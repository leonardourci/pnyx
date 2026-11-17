import type { ComponentProps, ReactNode } from 'react'
import { Button } from './controls.tsx'
import { Icon } from './icon.tsx'

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
    <div className="setting-row group/setting grid grid-cols-[var(--spacing-setting-icon)_minmax(0,1fr)] gap-(--settings-column-gap) items-start px-5 py-4 border-t border-subtle data-preview:grid-cols-[var(--spacing-setting-icon)_minmax(0,1fr)_var(--spacing-setting-preview)] max-[760px]:data-preview:grid-cols-[var(--spacing-setting-icon)_minmax(0,1fr)]" data-changed={changed || undefined} data-preview={preview ? '' : undefined}>
      <span className="setting-icon grid place-items-center size-setting-icon border border-subtle rounded-control bg-raised text-muted group-data-changed/setting:border-gold-line group-data-changed/setting:bg-gold-wash group-data-changed/setting:text-gold"><Icon name={icon} size={16} /></span>
      <div className="setting-body min-w-0 [&_mark]:bg-gold/28 [&_mark]:text-inherit [&_mark]:rounded-xs [&_mark]:px-px [&_mark]:py-0">
        <div className="setting-head flex items-center flex-wrap gap-2 has-[.setting-action]:flex-nowrap [&:has(.setting-action)>.setting-name]:flex-1 [&:has(.setting-action)>.setting-name]:min-w-0 [&:has(.setting-action)>.setting-name]:wrap-anywhere">
          <span className="setting-name text-ui font-semibold"><Highlight text={label} terms={terms} /></span>
          {changed && <span className="setting-changed px-1.5 py-0 border border-gold-line rounded-full text-gold text-meta font-medium">changed</span>}
          {action && <span className="setting-action inline-flex items-center ml-auto">{action}</span>}
        </div>
        <p className="setting-description mt-0.75 mb-2.5 mx-0 text-muted text-ui"><Highlight text={description} terms={terms} /></p>
        {children && <div className="setting-control min-w-0">{children}</div>}
        {changed && reset && (
          <Button className="setting-reset min-h-0 mt-1.5 p-0 gap-1 bg-transparent text-gold text-meta enabled:hover:bg-transparent enabled:hover:underline" onClick={reset}>
            <Icon name="reset" size={12} />Reset to default{resetTo ? ` (${resetTo})` : ''}
          </Button>
        )}
      </div>
      {preview && <div className="setting-preview flex flex-col min-w-0 max-[760px]:col-span-full">{preview}</div>}
    </div>
  )
}

export function SettingsRows({
  className = '',
  ...props
}: ComponentProps<'div'>) {
  return <div {...props} className={`settings-rows border border-line rounded-card bg-surface [&>:first-child]:border-t-0 ${className}`} />
}

export const SETTING_STACK = 'setting-stack flex flex-col items-start [:where(&)]:gap-2 [&>.slider-field]:self-stretch [&>.hydra-agent-pickers]:self-stretch'

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
  return <div {...props} className={`setting-field flex flex-col gap-2 w-full [&_.setting-description]:m-0 ${className}`} />
}
