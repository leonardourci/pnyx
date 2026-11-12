// A worker entry that fails knowingly prints { error: { message, code, help } }.
export function workerError({ stdout }: { stdout: string }): {
  message: string
  code: string
  help?: string[]
} | undefined {
  try {
    const known = JSON.parse(stdout).error

    if (typeof known?.message === 'string' && typeof known.code === 'string') {
      return known
    }
  } catch {
    // Not JSON: the worker failed before it could say why.
  }

  return undefined
}
