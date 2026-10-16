import type { ReactNode } from 'react'
import { Select, type Option } from '../components/ui/controls.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { Popover } from '../components/ui/popover.tsx'

export function AgentPicker({ provider, summary, children }: {
  provider: string
  summary: string
  children({ close }: { close(): void }): ReactNode
}) {
  return (
    <div className="composer-settings">
      <Popover label="Agent settings" className="agent-picker" trigger={<><Icon name={provider} size={14} /><span title={summary}>{summary}</span><span aria-hidden="true">⌄</span></>}>
        {children}
      </Popover>
    </div>
  )
}

export function PickerField({ label, value, options, disabled, reason, onChange }: {
  label: string
  value: string
  options: Option[]
  disabled?: boolean
  reason?: string
  onChange({ value }: { value: string }): void
}) {
  return (
    <div className="picker-field">
      <span>{label}</span>
      <Select
        label={label}
        value={value}
        options={options}
        disabled={disabled || !!reason}
        title={reason}
        onChange={onChange}
      />
      {reason && <small>{reason}</small>}
    </div>
  )
}
