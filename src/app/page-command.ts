import { canonicalCommandName } from './command-aliases.ts'
import { TitanError } from '#store/errors.ts'
import { integrationsCommand } from '#integrations/cli.ts'
import { followUpSteering } from '#workers/inbox-follow-up.ts'
import { agent } from '#workers/agent-cli.ts'
import { reply } from '#workers/reply-cli.ts'
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
    // eslint-disable-next-line othrys/object-params -- the same shape as the CLI commands beside it.
    return async (args: string[]) => {
      await followUpSteering({ hydraId: args[0]! })

      return {}
    }
  }

  if (name === 'agent' || name === 'reply') {
    return name === 'agent' ? agent : reply
  }

  if (!(CLI_COMMANDS as readonly string[]).includes(name)) {
    throw new TitanError({
      code: 'NOT_FOUND',
      message: 'Unknown browser command',
    })
  }

  return name === 'integrations'
    ? integrationsCommand
    : commands[canonicalCommandName({ name }) as Exclude<(typeof CLI_COMMANDS)[number], 'integrations'>]
}

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
      run: () => browserCommand.run(
        true,
        () => handler(args),
      ),
    })

    return {
      failed: false,
      stdout: JSON.stringify(result),
    }
  } catch (error) {
    // A reply that failed unexpectedly may or may not have reached its agent; the page says so instead of a reason.
    if (!(error instanceof TitanError) && [
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

    if (error instanceof TitanError) {
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
