import type { ModelOption } from '../../../src/server/provider.ts'

export function modelOptions({ models, selected }: { models: ModelOption[]; selected?: string }) {
  const options = models.filter(model => model.value !== 'default')
  const find = ({ value }: { value?: string }) => options.find(model => model.value === value)
    ?? options.find(model => model.resolvedModel === value && value !== undefined)
  const configured = selected && selected !== 'default' ? find({ value: selected }) : undefined
  const fallback = find({ value: models.find(model => model.value === 'default')?.resolvedModel })
    ?? options.find(model => model.isDefault) ?? options[0]

  if (selected && selected !== 'default' && !configured) {
    options.push({ value: selected, label: selected })
  }

  return {
    options,
    value: configured?.value
      ?? (selected && selected !== 'default' ? selected : fallback?.value),
  }
}
