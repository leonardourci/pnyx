import { AxiError } from 'axi-sdk-js'
import { HydraError } from '#store/errors.ts'
import { nonblockingLocks } from '#store/storage.ts'
import { integrationsCommand } from '#integrations/cli.ts'
import { followUpSteering } from '#workers/inbox-follow-up.ts'
import { agent, reply } from '#workers/reply.ts'
import { browserCommand } from './server-browser.ts'
import { commands, CLI_COMMANDS } from './server-transport.ts'
import { runForClient } from './request-context.ts'

// What a page command answered: its result, or its error as the page shows it.
export type PageAnswer = {
  failed: boolean
  stdout: string
}

const handlerOf = ({ name }: { name: string }) => {
  if (name === 'inbox-follow') {
    // eslint-disable-next-line pnyx/object-params -- the same shape as the CLI commands beside it.
    return (args: string[]) => followUpSteering({ hydraId: args[0]! }).then(() => ({}))
  }

  if (name === 'agent' || name === 'reply') {
    return name === 'agent' ? agent : reply
  }

  if (!(CLI_COMMANDS as readonly string[]).includes(name)) {
    throw new HydraError({
      code: 'NOT_FOUND',
      message: 'Unknown browser command',
    })
  }

  return name === 'integrations'
    ? integrationsCommand
    : commands[name as Exclude<(typeof CLI_COMMANDS)[number], 'integrations'>]
}

// Runs a command the page asked for in the server, as the page's own actor, without waiting on a held lock.
export async function runPageCommand({ argv }: { argv: string[] }): Promise<PageAnswer> {
  const [
    name = '',
    ...args
  ] = argv

  try {
    const handler = handlerOf({ name })
    const result = await runForClient({
      identity: {},
      cwd: process.cwd(),
      run: () => nonblockingLocks.run(
        true,
        () => browserCommand.run(
          true,
          () => handler(args),
        ),
      ),
    })

    return {
      failed: false,
      stdout: JSON.stringify(result),
    }
  } catch (error) {
    // A reply that failed unexpectedly may or may not have reached its agent; the page says so instead of a reason.
    if (!(error instanceof AxiError) && [
      'agent',
      'reply',
      'inbox-follow',
    ].includes(name)) {
      return {
        failed: true,
        stdout: '',
      }
    }

    let code = 'UNKNOWN'
    let help: string[] | undefined

    if (error instanceof AxiError) {
      code = error.code
      help = error.suggestions
    } else if (error instanceof HydraError) {
      code = error.code
      help = error.help
    }

    return {
      failed: true,
      stdout: JSON.stringify({
        error: {
          message: error instanceof Error ? error.message : String(error),
          code,
          help,
        },
      }),
    }
  }
}
