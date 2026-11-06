import { AxiError } from 'axi-sdk-js'
import { type createIndexSync } from '#oracle/index-sync.ts'
import { HydraError } from '#store/errors.ts'
import { nonblockingLocks } from '#store/storage.ts'
import { knownHarness } from '#workers/providers.ts'
import type { createHost } from '#app/host.ts'
import type { HydraState } from '#app/model.ts'
import { saveEventId, savedReceipt, type SaveCommand } from '#app/save-receipts.ts'
import type { createServerClients } from '#app/server-clients.ts'
import { commandTimeout } from '#app/server-protocol.ts'
import { CLI_COMMANDS, type HydraClient } from '#app/server-transport.ts'
import { COMMAND_WORKER, type createServerWorkers } from '#app/server-workers.ts'
import { loadHydra } from '#app/store.ts'
import type { createThreadSubscriptions } from '#app/thread-subscriptions.ts'
import { hydraAgentChangeCommand, hydraAgentCommand } from './hydra-agent.ts'
import { hydrasCommand } from './hydras.ts'
import { oracleCommand } from './oracle.ts'
import { replyCommand } from './reply.ts'
import { threadCommand } from './thread.ts'

type ThreadSubscriptions = ReturnType<typeof createThreadSubscriptions>

// A command the server answers itself: the tab that sent it, its id and arguments, and how to answer.
export type CommandRequest = {
  ws: HydraClient
  id: string
  args: string[]
  send: ReturnType<typeof createServerClients>['send']
  fail({
    error,
    code,
    help,
  }: {
    error: string
    code: string
    help?: string[]
  }): void
}

// The page's WebSocket commands: the ones the server answers itself, then any CLI command the page may run.
export function createServerCommands({
  hydraId,
  url,
  open,
  state,
  homes,
  closed,
  send,
  kick,
  agents,
  catalogCommand,
  historyIndex,
  hydraSubscribers,
  subscriptionMap,
  bindThread,
  threadPage,
  startWorker,
}: {
  hydraId: string
  url: string
  open({ id }: { id: string }): Promise<string>
  state(): HydraState
  homes(): string[]
  closed(): boolean
  send: ReturnType<typeof createServerClients>['send']
  kick(): void
  agents: ReturnType<typeof createHost>
  catalogCommand({
    ws,
    id,
    args,
    fail,
    send,
  }: CommandRequest): void
  historyIndex: ReturnType<typeof createIndexSync>
  hydraSubscribers: WeakSet<HydraClient>
  subscriptionMap: ThreadSubscriptions['subscriptionMap']
  bindThread: ThreadSubscriptions['bindThread']
  threadPage: ThreadSubscriptions['threadPage']
  startWorker: ReturnType<typeof createServerWorkers>['startWorker']
}) {
  const runCommand = ({
    ws,
    message,
  }: Parameters<typeof attemptCommand>[0]) => nonblockingLocks.run(
    true,
    () => attemptCommand({
      ws,
      message,
    }),
  )

  const attemptCommand = ({
    ws,
    message,
  }: {
    ws: HydraClient
    message: {
      id?: unknown
      name?: unknown
      args?: unknown
    }
  }) => {
    const id = typeof message.id === 'string' ? message.id : null

    const fail = ({
      error,
      code,
      help,
    }: {
      error: string
      code: string
      help?: string[]
    }) => {
      let saved: boolean | undefined

      if (id && typeof message.name === 'string' && Array.isArray(message.args) && message.args.every(arg => typeof arg === 'string')) {
        const command: SaveCommand = {
          type: 'command',
          id,
          name: message.name,
          args: message.args,
        }

        if (saveEventId({ command })) {
          try {
            const receipt = savedReceipt({
              command,
              state: loadHydra({ hydraId }).state,
            })

            if (receipt) {
              send({
                ws,
                message: {
                  ...receipt,
                  type: 'receipt',
                  id,
                },
              })

              return
            }

            // A concurrent request may still commit after a lock or I/O failure.
            saved = code === 'VALIDATION_ERROR' || code === 'NO_ROUTE' ? false : undefined
          } catch { /* An unreadable log cannot establish whether the save committed. */ }
        }
      }

      send({
        ws,
        message: {
          type: 'error',
          id,
          error,
          code,
          help,
          saved,
        },
      })
    }

    const {
      name,
      args,
    } = message

    if (id === null) {
      return fail({
        error: 'command needs a string id',
        code: 'VALIDATION_ERROR',
      })
    }

    if ([
      'thread',
      'oracle',
      'reply',
      'task-message',
      'answer',
      'agent',
      'catalog',
      'hydras',
      'hydra-agent',
      'hydra-agent-change',
      'models',
      'compact',
    ].includes(String(name))) {
      if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) {
        return fail({
          error: 'args must be strings',
          code: 'VALIDATION_ERROR',
        })
      }

      try {
        if (name === 'compact') {
          if (args.length < 1 || args.length > 2) {
            throw new HydraError({
              message: 'compact expects a card and an optional queued message ID',
              code: 'VALIDATION_ERROR',
            })
          }

          void agents.compact({
            card: args[0]!,
            sendNow: args[1],
          }).then(
            result => send({
              ws,
              message: {
                type: 'receipt',
                id,
                ...result,
              },
            }),
            (error: Error) => fail({
              error: error.message,
              code: error instanceof HydraError ? error.code : 'UNKNOWN',
            }),
          )
        } else if (name === 'models') {
          const harness = knownHarness({ name: args[0] })

          if (args.length < 1 || args.length > 2 || !harness) {
            throw new HydraError({
              message: 'models expects claude or codex and an optional account name',
              code: 'VALIDATION_ERROR',
            })
          }

          void agents.models({
            harness,
            account: args[1],
          })
            .then(models => send({
              ws,
              message: {
                type: 'receipt',
                id,
                models,
              },
            }))
            .catch((error: Error) => fail({
              error: error instanceof HydraError ? error.message : 'Harness model catalog unavailable. Reopen the picker to retry.',
              code: error instanceof HydraError ? error.code : 'CATALOG_UNAVAILABLE',
            }))
        } else if (name === 'catalog') {
          catalogCommand({
            ws,
            id,
            args,
            fail,
            send,
          })
        } else if (name === 'oracle') {
          oracleCommand({
            ws,
            id,
            args,
            fail,
            send,
            hydraId,
            state,
            historyIndex,
          })
        } else if (name === 'hydra-agent-change') {
          hydraAgentChangeCommand({
            ws,
            id,
            args,
            send,
            agents,
            kick,
          })
        } else if (name === 'hydra-agent') {
          hydraAgentCommand({
            ws,
            id,
            args,
            send,
            hydraId,
            agents,
            kick,
          })
        } else if (name === 'hydras') {
          hydrasCommand({
            ws,
            id,
            args,
            fail,
            send,
            hydraId,
            url,
            open,
            hydraSubscribers,
          })
        } else if (name === 'thread') {
          threadCommand({
            ws,
            id,
            args,
            fail,
            send,
            state,
            subscriptionMap,
            bindThread,
            threadPage,
          })
        } else {
          replyCommand({
            ws,
            id,
            name,
            args,
            fail,
            send,
            hydraId,
            state,
            homes,
            closed,
            kick,
            startWorker,
          })
        }
      } catch (error) {
        fail({
          error: (error as Error).message,
          code: error instanceof HydraError || error instanceof AxiError ? error.code : 'UNKNOWN',
        })
      }

      return
    }

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

  return { runCommand }
}
