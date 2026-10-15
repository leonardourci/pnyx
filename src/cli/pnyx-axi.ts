#!/usr/bin/env node
import { createRequire } from 'node:module'
import { AxiError, runAxiCli } from 'axi-sdk-js'
import { serve, stop } from '../server/server.ts'
import { firstmateCommands, firstmateHelp } from '../integrations/firstmate/cli.ts'
import { SEARCH_HELP, SETTINGS_HELP, searchCommands } from '../search/cli.ts'
import { TOP_LEVEL_HELP, commandHelp, commands, home } from './commands.ts'
import { AGENT_HELP, REPLY_HELP, agent, reply } from './reply.ts'
import { WORKER_HELP, workerCommands } from './workers.ts'
import { INTEGRATIONS_HELP, integrationsCommand } from './integrations.ts'

// Same relative path from src/cli and dist/cli.
const { version } = createRequire(import.meta.url)('../../package.json') as { version: string }
const HELP: Record<string, string> = {
  search: SEARCH_HELP,
  settings: SETTINGS_HELP,
  reply: REPLY_HELP,
  agent: AGENT_HELP,
  ...WORKER_HELP,
  integrations: INTEGRATIONS_HELP,
}

await runAxiCli({
  description: 'Deterministic board of every agent and its work',
  version,
  topLevelHelp: TOP_LEVEL_HELP,
  home,
  getCommandHelp: command => commandHelp({ command })
    ?? firstmateHelp({ command }) ?? HELP[command],
  commands: {
    ...commands,
    ...workerCommands,
    serve,
    stop,
    ...firstmateCommands,
    reply,
    agent,
    integrations: integrationsCommand,
    ...searchCommands,
    // Shadows the SDK's npm self-update: pnyx-axi is not published while pre-v1.
    update: () => {
      throw new AxiError('pnyx-axi is not published yet', 'VALIDATION_ERROR', [
        'Pull the repository and run `pnpm install && pnpm run build`',
      ])
    },
  },
})
