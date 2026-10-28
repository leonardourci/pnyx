import { supervisedCommands } from '../helper/commands.ts'
import { approval } from '../app/confirmations.ts'
import { dispatchCommands, DISPATCH_HELP } from '../dispatch/cli.ts'
import { project, PROJECT_HELP } from '../projects/cli.ts'
import { AxiError, runAxiCli, type AxiCliCommand } from 'axi-sdk-js'
import { serve, stop } from '../app/server-cli.ts'
import { firstmateCommands, firstmateHelp } from '../integrations/firstmate/cli.ts'
import { ORACLE_HELP, oracleCommands } from '../oracle/cli.ts'
import { TOP_LEVEL_HELP, commandHelp } from '../app/help.ts'
import { helpHint, invocation } from '../app/cli-support.ts'
import { commands } from '../app/cli.ts'
import { home } from './commands.ts'
import { focusedHelp } from './help.ts'
import { version } from './version.ts'
import { AGENT_HELP, REPLY_HELP, agent, reply } from './reply.ts'
import { workerCommands } from './workers.ts'
import { INTEGRATIONS_HELP, integrationsCommand } from '../integrations/cli.ts'
import { ownerOnly } from './hydra-session.ts'
import { UPGRADE_HELP, upgrade } from '../upgrade/cli.ts'

const HELP: Record<string, string> = {
  approval: 'usage: pnyx-axi approval confirm|dismiss <token> [--confirm <token>]\nOwner-only questions appear in Hydra’s chat.',
  oracle: ORACLE_HELP,
  project: PROJECT_HELP,
  reply: REPLY_HELP,
  agent: AGENT_HELP,
  ...DISPATCH_HELP,
  integrations: INTEGRATIONS_HELP,
  upgrade: UPGRADE_HELP,
}

const help = ({ command }: { command: string }) => commandHelp({ command })
  ?? firstmateHelp({ command }) ?? HELP[command]
const [
  command,
  sub,
] = process.argv.slice(2)
const full = command ? help({ command }) : undefined
const focused = full && sub ? focusedHelp({
  help: full,
  command,
  sub,
}) : full

// Named after the subcommand only when its help has a section for it (`card <id>` stays `card`).
// The server runs other commands in its own process for the web, so serve sets nothing.
if (command !== 'serve') {
  invocation.name = focused !== full ? `${command} ${sub}` : command
  invocation.help = focused
}

// A usage error with no next step points at the subcommand's own help.
const hinted = ({ run }: { run: AxiCliCommand<undefined> }): AxiCliCommand<undefined> =>
  // eslint-disable-next-line pnyx/object-params -- runAxiCli owns the command signature.
  async (
    args,
    context,
  ) => {
    try {
      return await run(
        args,
        context,
      )
    } catch (error) {
      if (error instanceof AxiError && error.code === 'VALIDATION_ERROR' && !error.suggestions.length) {
        throw new AxiError(
          error.message,
          error.code,
          [helpHint()],
        )
      }

      throw error
    }
  }

const all = ownerOnly({
  commands: {
    ...commands,
    ...supervisedCommands({
      commands: {
        approval,
        project,
        ...workerCommands,
        ...dispatchCommands,
        serve,
        stop,
        upgrade,
        ...firstmateCommands,
        reply,
        agent,
        integrations: integrationsCommand,
        ...oracleCommands,
        // Shadows the SDK's npm self-update: pnyx-axi is not published while pre-v1.
        update: () => {
          throw new AxiError(
            'pnyx-axi is not published yet',
            'VALIDATION_ERROR',
            ['Run `pnyx-axi upgrade` to pull, install and build the latest main'],
          )
        },
      },
    }),
  },
})

await runAxiCli({
  description: 'Every agent and its work in Pnyx',
  version,
  topLevelHelp: TOP_LEVEL_HELP,
  home,
  getCommandHelp: () => focused,
  commands: Object.fromEntries(Object.entries(all).map(([
    name,
    run,
  ]) => [
    name,
    hinted({ run }),
  ])),
})
