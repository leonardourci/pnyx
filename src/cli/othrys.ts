#!/usr/bin/env node
import { compatibleEnvironment } from '#store/legacy-env.ts'
import { cliArguments } from './arguments.ts'
import { installedVersion } from './version.ts'

Object.assign(
  process.env,
  compatibleEnvironment({ env: process.env }),
)

const argv = process.argv.slice(2)
let argumentsToRun: ReturnType<typeof cliArguments>

try {
  argumentsToRun = cliArguments({ argv })
} catch (error) {
  if (!(error instanceof TypeError) || !('code' in error) || !String(error.code).startsWith('ERR_PARSE_ARGS')) {
    throw error
  }

  argumentsToRun = cliArguments({ argv: [] })
}

const command = argumentsToRun.argv[0]

if (argumentsToRun.version) {
  const version = installedVersion()
  process.stdout.write(argumentsToRun.json ? `${JSON.stringify({ version })}\n` : `${version}\n`)
} else if (!command || argumentsToRun.help || command === 'serve' || command === 'setup') {
  await import('./main.ts')
} else {
  const { forward } = await import('./client.ts')
  await forward({ argv })
}
