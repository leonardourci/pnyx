import { useEffect, useState, type ComponentProps } from 'react'
import type { ModelOption } from '#workers/provider.ts'
import type { Command } from '#web-app/connection.ts'
import { Button, Select, type Option } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'

// A picker that is a table cell: changed from what is saved, or holding a problem.
export interface CellMark {
  changed?: boolean
  invalid?: boolean
}

type Look = Pick<ComponentProps<typeof Select>, 'defaultValue' | 'onDefault' | 'iconSize'> & { mark?: CellMark }

export function PickerField({
  label,
  value,
  options,
  disabled,
  reason,
  onChange,
  mark,
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
    <div className="picker-field" data-changed={mark?.changed || undefined} data-invalid={mark?.invalid || undefined}>
      <span>{label}</span>
      <Select
        label={label}
        value={value}
        options={options}
        disabled={disabled || !!reason}
        onChange={onChange}
        {...look}
        title={reason ?? label}
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
  if (!value && (error || models)) {
    return <div className="picker-field"><small role="alert">{error || 'No models available.'}</small><Button disabled={!connected} onClick={retry}>Retry models</Button></div>
  }

  if (!value || (!error && !models)) {
    return <small role="status">Loading models…</small>
  }

  // A saved model stays visible and changeable when its harness's catalog cannot load.
  return (
    <span className="model-picker">
      <PickerField
        label="Model"
        value={value}
        options={options}
        disabled={disabled}
        onChange={onChange}
        {...look}
      />
      {error && (
        <Button
          className="picker-retry"
          aria-label="Retry models"
          title={error}
          disabled={!connected}
          onClick={retry}
        >
          <Icon name="reset" size={14} />
        </Button>
      )}
    </span>
  )
}
