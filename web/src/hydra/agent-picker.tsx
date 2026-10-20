import { useEffect, useRef, useState } from 'react'
import type { ModelOption } from '../../../src/server/provider.ts'
import type { Command } from './connection.ts'
import { modelOptions } from './model-options.ts'
import { Button, Select, type Option } from '../components/ui/controls.tsx'

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

export function ModelPicker({
  harness, selected, command, disabled, connected, resolveDefault, onChange,
}: {
  harness: 'claude' | 'codex'
  selected?: string
  command: Command
  disabled: boolean
  connected: boolean
  resolveDefault: boolean
  onChange({ value }: { value: string }): void
}) {
  const [models, setModels] = useState<ModelOption[]>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const resolved = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!connected) {
      return
    }

    let active = true
    setError('')
    void command({ name: 'models', args: [harness] })
      .then(receipt => {
        if (active) {
          setModels(receipt.models as ModelOption[])
        }
      })
      .catch((error: Error) => {
        if (active) {
          setError(error.message)
        }
      })

    return () => {
      active = false
    }
  }, [harness, command, connected, retry])

  const picker = modelOptions({ models: models ?? [], selected })

  useEffect(() => {
    if (models && resolveDefault && picker.value && resolved.current !== picker.value) {
      resolved.current = picker.value
      onChange({ value: picker.value })
    }
  }, [models, resolveDefault, picker.value, onChange])

  if (error || (models && !picker.value)) {
    return <div className="picker-field"><small role="alert">{error || 'No models available.'}</small><Button disabled={!connected} onClick={() => setRetry(value => value + 1)}>Retry models</Button></div>
  }

  if (!models || !picker.value) {
    return <small role="status">Loading models…</small>
  }

  return (
    <PickerField
      label="Model"
      value={picker.value}
      options={picker.options}
      disabled={disabled}
      onChange={onChange}
    />
  )
}
