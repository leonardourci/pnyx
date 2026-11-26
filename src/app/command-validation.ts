import { TitanError } from '#store/errors.ts'

export function notUndoable({ message }: { message: string }): TitanError {
  return new TitanError({
    message,
    code: 'NOT_UNDOABLE',
    help: ['Read titan.log and task.log to find an undoable edit'],
  })
}

export function invalid({
  message,
  field,
}: {
  message: string
  field?: string
}): TitanError {
  return new TitanError({
    message,
    code: 'VALIDATION_ERROR',
    field,
  })
}

export function asRecord({ value }: { value: unknown }): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function onlyKeys({
  value,
  allowed,
  what,
}: {
  value: Record<string, unknown>
  allowed: string[]
  what: string
}): void {
  const extra = Object.keys(value).filter(k => !allowed.includes(k))

  if (extra.length > 0) {
    throw invalid({ message: `${what}: unknown field ${extra.join(', ')}; allowed: ${allowed.join(', ')}` })
  }
}

export function text({
  value,
  what,
}: {
  value: unknown
  what: string
}): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid({ message: `${what} must be a non-empty string` })
  }

  return value
}

export function optionalText({
  value,
  what,
}: {
  value: unknown
  what: string
}): string | undefined {
  return value === undefined ? undefined : text({
    value,
    what,
  })
}
