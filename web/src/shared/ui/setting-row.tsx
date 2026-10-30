import type { ReactNode } from 'react'
import { Button } from './controls.tsx'
import { Icon } from './icon.tsx'

function Highlight({
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
  children: ReactNode
}) {
  return (
    <div className="setting-row" data-changed={changed || undefined} data-preview={preview ? '' : undefined}>
      <span className="setting-icon"><Icon name={icon} size={16} /></span>
      <div className="setting-body">
        <div className="setting-head">
          <span className="setting-name"><Highlight text={label} terms={terms} /></span>
          {changed && <span className="setting-changed">changed</span>}
        </div>
        <p className="setting-description"><Highlight text={description} terms={terms} /></p>
        <div className="setting-control">{children}</div>
        {changed && reset && (
          <Button className="setting-reset" onClick={reset}>
            <Icon name="reset" size={12} />Reset to default{resetTo ? ` (${resetTo})` : ''}
          </Button>
        )}
      </div>
      {preview && <div className="setting-preview">{preview}</div>}
    </div>
  )
}
