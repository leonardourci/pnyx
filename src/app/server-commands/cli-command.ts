import { loadHydra } from '#app/store.ts'
import { commandTimeout } from '#app/server-protocol.ts'
import { CLI_COMMANDS } from '#app/server-transport.ts'
import { COMMAND_WORKER, type createServerWorkers } from '#app/server-workers.ts'
import type { CommandRequest } from './dispatch.ts'

// Any other CLI command the page may run, as the web actor and only on this Hydra.
export function cliCommand({
  ws,
  id,
  name,
  args,
  fail,
  send,
  hydraId,
  kick,
  startWorker,
}: Omit<CommandRequest, 'args'> & {
  name: unknown
  args: unknown
  hydraId: string
  kick(): void
  startWorker: ReturnType<typeof createServerWorkers>['startWorker']
}) {
  if (typeof name !== 'string' || !(CLI_COMMANDS as readonly string[]).includes(name)) {
    return fail({
      error: `unknown command: ${String(name)}`,
      code: 'NOT_FOUND',
      help: [`Use one of ${CLI_COMMANDS.join(', ')}`],
    })
  }

  if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) {
    return fail({
      error: 'args must be [string, ...]',
      code: 'VALIDATION_ERROR',
    })
  }

  if (args.some(a => a === '--hydra' || a.startsWith('--hydra='))) {
    return fail({
      error: `--hydra is not allowed; this server writes Hydra ${hydraId}`,
      code: 'VALIDATION_ERROR',
    })
  }

  const actor = name === 'history' || name === 'card' || name === 'integrations' || args.some(a => a === '--actor' || a.startsWith('--actor=')) ? [] : [
    '--actor',
    'web',
  ]

  startWorker({
    file: COMMAND_WORKER,
    timeout: commandTimeout({
      name,
      args,
    }),
    args: [
      name,
      ...args,
      ...actor,
      '--hydra',
      hydraId,
    ],
    done: ({
      error,
      stdout,
    }) => {
      kick()

      try {
        const result = JSON.parse(stdout)

        if (error) {
          if (typeof result.error?.message === 'string' && typeof result.error.code === 'string') {
            fail({
              error: result.error.message,
              code: result.error.code,
              help: result.error.help,
            })

            return
          }

          throw error
        }

        send({
          ws,
          message: {
            ...result,
            through: loadHydra({ hydraId }).state.seq,
            type: 'receipt',
            id,
          },
        })
      } catch {
        fail({
          error: 'Command could not be confirmed; check history before sending again',
          code: 'DELIVERY_UNKNOWN',
        })
      }
    },
  })
}
