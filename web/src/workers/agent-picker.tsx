import { useEffect, useState, type ComponentProps } from 'react'
import type { ModelOption } from '#workers/provider.ts'
import type { Command } from '#web-app/connection.ts'
import { Select, type Option } from '#web-shared/ui/controls.tsx'

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
  account,
  folder,
  command,
  connected,
}: {
  harness: 'claude' | 'codex'
  account?: string
  folder?: string
  command: Command
  connected: boolean
}) {
  const key = JSON.stringify([
    harness,
    account,
    folder,
  ])
  const [
    models,
    setModels,
  ] = useState<{
    key: string
    models: ModelOption[]
  }>()
  const [
    error,
    setError,
  ] = useState<{
    key: string
    text: string
  }>()
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
      setModels(undefined)
      setError(undefined)
      void command({
        name: 'models',
        args: account ? [
          harness,
          account,
        ] : [harness],
      })
        .then(receipt => {
          if (active) {
            setModels({
              key,
              models: receipt.models as ModelOption[],
            })
          }
        })
        .catch((error: Error) => {
          if (active) {
            setError({
              key,
              text: error.message,
            })
          }
        })

      return () => {
        active = false
      }
    },
    [
      harness,
      account,
      folder,
      key,
      command,
      connected,
      retry,
    ],
  )

  return {
    models: models?.key === key ? models.models : undefined,
    error: error?.key === key ? error.text : '',
    retry: () => setRetry(value => value + 1),
  }
}
