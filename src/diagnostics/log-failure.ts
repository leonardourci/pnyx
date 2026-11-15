import { createHash } from 'node:crypto'

const MAX_CAUSES = 5
const MAX_STACK_LINES = 12
const MAX_STACK_CHARS = 4000
const ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'AggregateError',
  'URIError',
  'EvalError',
])
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/

// Error messages and child-process failures can contain entire prompts and credentials.
// Keep a fingerprint and call sites so repeated failures remain identifiable without their input.
export function logFailure({
  error,
  depth = 0,
}: {
  error: unknown
  depth?: number
}): Record<string, unknown> {
  if (depth >= MAX_CAUSES) {
    return { name: 'CauseLimit' }
  }

  if (!(error instanceof Error)) {
    return {
      name: 'ThrownValue',
      type: typeof error,
    }
  }

  const code = 'code' in error && typeof error.code === 'string' && SAFE_CODE.test(error.code) ? error.code : undefined
  const stack = error.stack?.split('\n').filter(line => /^\s+at /.test(line))
    .slice(
      0,
      MAX_STACK_LINES,
    )
    .join('\n')
    .slice(
      0,
      MAX_STACK_CHARS,
    )

  return {
    name: ERROR_NAMES.has(error.name) ? error.name : 'Error',
    code,
    fingerprint: createHash('sha256').update(error.message)
      .digest('hex'),
    stack,
    cause: error.cause === undefined ? undefined : logFailure({
      error: error.cause,
      depth: depth + 1,
    }),
  }
}
