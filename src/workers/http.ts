import { HydraError } from '#store/errors.ts'

export const field = ({
  body,
  name,
  optional = false,
}: {
  body: Record<string, unknown>
  name: string
  optional?: boolean
}): string | undefined => {
  const value = body[name]

  if (value === undefined && optional) {
    return undefined
  }

  if (typeof value !== 'string' || !value.trim() || value.length > 32000) {
    throw new HydraError({
      message: `${name} must be a string of 1 to 32000 characters`,
      code: 'VALIDATION_ERROR',
    })
  }

  return value
}
