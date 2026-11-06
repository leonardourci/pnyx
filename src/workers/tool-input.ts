export const SHELL_WRAPPER = /(^|\/)(ba|z)?sh$/

// Claude's Bash input is {command}; Codex's shell calls carry {cmd} or an argv list.
export function commandOf({ input }: { input: Record<string, unknown> }): string | undefined {
  const value = input.command ?? input.cmd

  if (typeof value === 'string') {
    return value
  }

  if (!Array.isArray(value) || !value.every(part => typeof part === 'string')) {
    return undefined
  }

  const [
    program,
    flag,
    script,
  ] = value
  const wrapsScript = value.length === 3 && SHELL_WRAPPER.test(program ?? '') && !!flag?.startsWith('-')

  return wrapsScript ? script : value.join(' ')
}
