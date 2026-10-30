import { AxiError } from 'axi-sdk-js'
import { HydraError } from '#store/errors.ts'
import { nonblockingLocks } from '#store/storage.ts'
import { integrationsCommand } from '#integrations/cli.ts'
import { browserCommand } from './server-browser.ts'
import { commands, CLI_COMMANDS } from './server-transport.ts'

// A failed cleanup must leave a dead process lease, so another attempt can reclaim it.
try {
  const [
    name,
    ...args
  ] = process.argv.slice(2)

  if (!name || !(CLI_COMMANDS as readonly string[]).includes(name)) {
    throw new HydraError({
      code: 'NOT_FOUND',
      message: 'Unknown browser command',
    })
  }

  const handler = name === 'integrations'
    ? integrationsCommand
    : commands[name as Exclude<(typeof CLI_COMMANDS)[number], 'integrations'>]
  const result = await nonblockingLocks.run(
    true,
    () => browserCommand.run(
      true,
      () => handler(args),
    ),
  )
  process.stdout.write(JSON.stringify(result))
} catch (error) {
  let code = 'UNKNOWN'
  let help: string[] | undefined

  if (error instanceof AxiError) {
    code = error.code
    help = error.suggestions
  } else if (error instanceof HydraError) {
    code = error.code
    help = error.help
  }

  process.stdout.write(JSON.stringify({
    error: {
      message: error instanceof Error ? error.message : String(error),
      code,
      help,
    },
  }))
  process.exitCode = 1
}
