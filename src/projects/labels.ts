import { text, invalid } from '../app/command-validation.ts'

export function projectLabel({ value }: { value: unknown }): string | null {
  if (value === null || value === '') {
    return null
  }

  const label = text({
    value,
    what: 'project',
  }).trim()

  if (label.length > 100 || /[\r\n]/.test(label)) {
    throw invalid({ message: 'project must be a single line of up to 100 characters' })
  }

  return label
}
