export interface ErrorDetails {
  name?: string
  message: string
  code?: string
  stack?: string
  cause?: ErrorDetails
  errors?: ErrorDetails[]
}

// Worker messages cannot carry an Error's non-enumerable fields reliably.
export function errorDetails({
  error,
  seen = new Set<unknown>(),
}: {
  error: unknown
  seen?: Set<unknown>
}): ErrorDetails {
  if (!error || typeof error !== 'object') {
    return { message: String(error) }
  }

  if (seen.has(error)) {
    return { message: '[circular error]' }
  }

  seen.add(error)
  const failure = error as Error & {
    code?: string
    errors?: unknown[]
  }
  const errors = Array.isArray(failure.errors)
    ? failure.errors.map(error => errorDetails({
      error,
      seen,
    }))
    : undefined
  const cause = failure.cause === undefined ? undefined : errorDetails({
    error: failure.cause,
    seen,
  })
  const code = typeof failure.code === 'string' ? failure.code : undefined
  const message = failure.message || code || failure.name || String(error)
  const nested = errors?.map(error => error.message).join('; ') || cause?.message

  return {
    name: failure.name,
    message: nested ? `${message}: ${nested}` : message,
    code,
    stack: failure.stack,
    cause,
    errors,
  }
}
