import { Select, type Option } from '../components/ui/controls.tsx'

export function PickerField({ label, value, options, disabled, reason, onOpen, onChange }: {
  label: string
  value: string
  options: Option[]
  disabled?: boolean
  reason?: string
  onOpen?(): void
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
        onOpen={onOpen}
        onChange={onChange}
      />
      {reason && <small>{reason}</small>}
    </div>
  )
}
