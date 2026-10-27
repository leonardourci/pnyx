import { useEffect, useState, type ComponentProps } from 'react'
import type { ModelOption } from '../../../src/server/provider.ts'
import type { Command } from './connection.ts'
import { Button, Select, type Option } from '../shared/ui/controls.tsx'

type Look = Pick<ComponentProps<typeof Select>, 'defaultValue' | 'onDefault'>

export function PickerField({
  label,
  value,
  options,
  disabled,
  reason,
  onChange,
  ...look
}: {
  label: string
  value: string
  options: Option[]
  disabled?: boolean
  reason?: string
  onChange({ value }: { value: string }): void
} & Look) {
  return (
    <div className="picker-field">
      <span>{label}</span>
      <Select
        label={label}
        value={value}
        options={options}
        disabled={disabled || !!reason}
        onChange={onChange}
        {...look}
        title={reason}
      />
      {reason && <small>{reason}</small>}
    </div>
  )
}

export function useModels({
  harness,
  command,
  connected,
}: {
  harness: 'claude' | 'codex'
  command: Command
  connected: boolean
}) {
  const [
    models,
    setModels,
  ] = useState<ModelOption[]>()
  const [
    error,
    setError,
  ] = useState('')
  const [
    retry,
    setRetry,
  ] = useState(0)

  useEffect(
    () => {
      if (!connected) {
        return
      }

      let active = true
      setError('')
      void command({
        name: 'models',
        args: [harness],
      })
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
    },
    [
      harness,
      command,
      connected,
      retry,
    ],
  )

  return {
    models,
    error,
    retry: () => setRetry(value => value + 1),
  }
}

export function ModelPicker({
  models,
  error,
  retry,
  value,
  options,
  disabled,
  connected,
  onChange,
  ...look
}: {
  models?: ModelOption[]
  error: string
  retry(): void
  value?: string
  options: Option[]
  disabled: boolean
  connected: boolean
  onChange({ value }: { value: string }): void
} & Look) {
  if (error || (models && !value)) {
    return <div className="picker-field"><small role="alert">{error || 'No models available.'}</small><Button disabled={!connected} onClick={retry}>Retry models</Button></div>
  }

  if (!models || !value) {
    return <small role="status">Loading models…</small>
  }

  return (
    <PickerField
      label="Model"
      value={value}
      options={options}
      disabled={disabled}
      onChange={onChange}
      {...look}
    />
  )
}
