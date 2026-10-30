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

// One setting: its icon, name, description, control and live preview, with a reset while it differs from its default.
export function SettingRow({
  icon,
  label,
  description,
  terms = [],
  changed = false,
  reset,
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
  // A live picture of what the setting changes, drawn under the control.
  preview?: ReactNode
  children: ReactNode
}) {
  const resettable = changed && reset

  return (
    <div className="setting-row">
      <span className="setting-icon"><Icon name={icon} size={18} /></span>
      <div className="setting-text">
        <span className="setting-name">
          <Highlight text={label} terms={terms} />
          {changed && <span className="setting-changed">Changed</span>}
        </span>
        <span className="setting-description"><Highlight text={description} terms={terms} /></span>
        {resettable && <Button className="setting-reset" onClick={reset}>Reset to default</Button>}
      </div>
      <div className="setting-control">{children}</div>
      {preview && <div className="setting-preview">{preview}</div>}
    </div>
  )
}
