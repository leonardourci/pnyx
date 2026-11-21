#!/usr/bin/env node
import { cliArguments } from './arguments.ts'
import { installedVersion } from './version.ts'

let argumentsToRun: ReturnType<typeof cliArguments> | undefined

try {
  argumentsToRun = cliArguments({ argv: process.argv.slice(2) })
} catch {
  // The command runner prints argument errors with its other validation errors.
}

if (argumentsToRun?.version) {
  const version = installedVersion()
  process.stdout.write(argumentsToRun.json ? `${JSON.stringify({ version })}\n` : `${version}\n`)
} else if (!argumentsToRun || !argumentsToRun.argv.length || argumentsToRun.help
  || [
    'serve',
    'setup',
  ].includes(argumentsToRun.argv[0]!)) {
  await import('./main.ts')
} else {
  const { forward } = await import('./client.ts')
  await forward({ argv: process.argv.slice(2) })
}
