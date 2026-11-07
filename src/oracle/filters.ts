import { HydraError } from '#store/errors.ts'
import type { Query } from './model.ts'

export type SearchFilters = Pick<Query, 'columns' | 'projects' | 'since'>

function parseFilters({ value }: { value: string }): Record<string, unknown> {
  let parsed: unknown

  try {
    parsed = JSON.parse(value)
  } catch {
    throw new HydraError({
      message: 'invalid Oracle filters',
      code: 'VALIDATION_ERROR',
    })
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HydraError({
      message: 'Oracle filters must be an object',
      code: 'VALIDATION_ERROR',
    })
  }

  return parsed as Record<string, unknown>
}

const isNames = ({ value }: { value: unknown }) => Array.isArray(value)
  && value.every(name => typeof name === 'string' && name.length > 0)

const isDate = ({ value }: { value: unknown }) => typeof value === 'string' && Number.isFinite(Date.parse(value))

function validateFilters({ filters }: { filters: Record<string, unknown> }): SearchFilters {
  const found: SearchFilters = {}

  for (const [
    key,
    filter,
  ] of Object.entries(filters)) {
    if (key === 'columns' || key === 'projects') {
      if (!isNames({ value: filter })) {
        throw new HydraError({
          message: `invalid Oracle ${key}`,
          code: 'VALIDATION_ERROR',
        })
      }

      found[key] = filter as string[]
    } else if (key === 'since' && isDate({ value: filter })) {
      found.since = new Date(filter as string).toISOString()
    } else {
      throw new HydraError({
        message: `invalid Oracle filter: ${key}`,
        code: 'VALIDATION_ERROR',
      })
    }
  }

  return found
}

export function readSearchFilters({ value }: { value?: string }): SearchFilters {
  if (value === undefined) {
    return {}
  }

  return validateFilters({ filters: parseFilters({ value }) })
}
