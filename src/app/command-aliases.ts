import { parseArgs, type ParseArgsConfig } from 'node:util'

export const canonicalCommandName = ({ name }: { name: string }): string => name === 'titan' ? 'hydra' : name

// Parse option tokens before translating so user-written flag-like values stay verbatim.
export const parseCommandArgs = (({
  args = process.argv.slice(2),
  options,
  ...config
}: ParseArgsConfig) => {
  const inspected = parseArgs({
    ...config,
    args,
    options: {
      ...options,
      titan: { type: 'string' },
    },
    strict: false,
    tokens: true,
  })
  const aliases = new Set(inspected.tokens.filter(token => token.kind === 'option' && token.name === 'titan').map(token => token.index))
  const canonical = args.map((
    arg,
    index,
  ) => aliases.has(index) ? arg.replace(
    /^--titan/,
    '--hydra',
  ) : arg)

  return parseArgs({
    ...config,
    options,
    args: canonical,
  })
}) as typeof parseArgs
