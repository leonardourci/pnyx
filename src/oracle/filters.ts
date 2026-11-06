import { HydraError } from '#store/errors.ts'
import type { Query } from './model.ts'

export type SearchFilters = Pick<Query, 'columns' | 'projects' | 'since'>

export function readSearchFilters({ value }: { value?: string }): SearchFilters {
  if (value === undefined) {
    return {}
  }

  let filters: unknown

  try {
    filters = JSON.parse(value)
  } catch {
    throw new HydraError({
      message: 'invalid Oracle filters',
      code: 'VALIDATION_ERROR',
    })
  }

  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new HydraError({
      message: 'Oracle filters must be an object',
      code: 'VALIDATION_ERROR',
    })
  }

  const found: SearchFilters = {}

  for (const [
    key,
    value,
  ] of Object.entries(filters)) {
    if (key === 'columns' || key === 'projects') {
      if (!Array.isArray(value) || !value.every(value => typeof value === 'string' && value.length > 0)) {
        throw new HydraError({
          message: `invalid Oracle ${key}`,
          code: 'VALIDATION_ERROR',
        })
      }

      found[key] = value
    } else if (key === 'since' && typeof value === 'string' && Number.isFinite(Date.parse(value))) {
      found.since = new Date(value).toISOString()
    } else {
      throw new HydraError({
        message: `invalid Oracle filter: ${key}`,
        code: 'VALIDATION_ERROR',
      })
    }
  }

  return found
}
