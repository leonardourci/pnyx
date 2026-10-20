import { Select, type Option } from '../components/ui/controls.tsx'

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
