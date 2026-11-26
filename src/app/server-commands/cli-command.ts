import { loadTitan } from '#app/store.ts'
import { CLI_COMMANDS } from '#app/server-transport.ts'
import { type createServerWorkers } from '#app/server-workers.ts'
import type { CommandRequest } from './dispatch.ts'

// Any other CLI command the page may run, as the web actor and only on this Titan.
export function cliCommand({
  ws,
  id,
  name,
  args,
  fail,
  send,
  titanId,
  kick,
  startWorker,
}: Omit<CommandRequest, 'args'> & {
  name: unknown
  args: unknown
  titanId: string
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

  if (args.some(a => /^--(?:titan|hydra)(?:=|$)/.test(a))) {
    return fail({
      error: `--titan is not allowed; this server writes Titan ${titanId}`,
      code: 'VALIDATION_ERROR',
    })
  }

  const actor = name === 'history' || name === 'card' || name === 'integrations' || args.some(a => a === '--actor' || a.startsWith('--actor=')) ? [] : [
    '--actor',
    'web',
  ]

  startWorker({
    args: [
      name,
      ...args,
      ...actor,
      '--titan',
      titanId,
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
            stateSeq: loadTitan({ titanId }).state.seq,
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
