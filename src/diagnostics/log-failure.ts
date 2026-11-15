import { createHash } from 'node:crypto'

const MAX_CAUSES = 5
const MAX_STACK_LINES = 12
const MAX_STACK_CHARS = 4000
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/
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
  const header = error.message ? `${error.name}: ${error.message}\n` : `${error.name}\n`
  const frames = error.stack?.startsWith(header) ? error.stack.slice(header.length) : undefined
  const stack = frames?.split('\n')
    .filter(line => /^\s+at /.test(line))
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
    name: SAFE_NAME.test(error.name) ? error.name : 'Error',
    code,
    fingerprint: createHash('sha256').update(error.message)
      .digest('hex'),
    stack,
    errors: error instanceof AggregateError ? error.errors.slice(
      0,
      MAX_CAUSES,
    ).map(error => logFailure({
      error,
      depth: depth + 1,
    })) : undefined,
    cause: error.cause === undefined ? undefined : logFailure({
      error: error.cause,
      depth: depth + 1,
    }),
  }
}
