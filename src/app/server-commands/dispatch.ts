import { pageInterest, parsePage } from '#app/page-cli.ts'
import { invocationOf } from '#cli/run.ts'
import { log } from '#app/diagnostics.ts'
import { TitanError } from '#store/errors.ts'
import type { createHost } from '#app/host.ts'
import type { TitanState } from '#app/model.ts'
import { saveEventId, savedEvent, type SaveCommand } from '#app/save-receipts.ts'
import type { createServerClients } from '#app/server-clients.ts'
import type { TitanClient } from '#app/server-transport.ts'
import type { createServerWorkers } from '#app/server-workers.ts'
import { loadTitan } from '#app/store.ts'
import type { createThreadSubscriptions } from '#app/thread-subscriptions.ts'
import type { createFileIndex } from '#projects/file-index.ts'
import { cliCommand } from './cli-command.ts'
import { compactCommand } from './compact.ts'
import { filesCommand } from './files.ts'
import { titanAgentCommand } from './titan-agent.ts'
import { titansCommand } from './titans.ts'
import { modelsCommand } from './models.ts'
import { oracleCommand } from './oracle.ts'
import { replyCommand } from './reply.ts'
import { threadCommand } from './thread.ts'

type ThreadSubscriptions = ReturnType<typeof createThreadSubscriptions>

// A command the server answers itself: the tab that sent it, its id and arguments, and how to answer.
export type CommandRequest = {
  ws: TitanClient
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
  titanId,
  url,
  open,
  state,
  closed,
  send: sendToTab,
  kick,
  agents,
  catalogCommand,
  fileIndex,
  showPage,
  subscriptionMap,
  retainThreads,
  bindThread,
  threadPage,
  startWorker,
}: {
  titanId: string
  url: string
  open({ id }: { id: string }): Promise<string>
  state(): TitanState
  closed(): boolean
  send: ReturnType<typeof createServerClients>['send']
  kick(): void
  agents: ReturnType<typeof createHost>
  fileIndex: ReturnType<typeof createFileIndex>
  catalogCommand({
    ws,
    id,
    args,
    fail,
    send,
  }: CommandRequest): void
  showPage: ReturnType<typeof createServerClients>['show']
  subscriptionMap: ThreadSubscriptions['subscriptionMap']
  retainThreads: ThreadSubscriptions['retainThreads']
  bindThread: ThreadSubscriptions['bindThread']
  threadPage: ThreadSubscriptions['threadPage']
  startWorker: ReturnType<typeof createServerWorkers>['startWorker']
}) {
  const oracleSearches = new WeakMap<TitanClient, AbortController>()
  const runCommand = ({
    ws,
    message,
  }: Parameters<typeof attemptCommand>[0]) => attemptCommand({
    ws,
    message,
  })

  const attemptCommand = async ({
    ws,
    message,
  }: {
    ws: TitanClient
    message: {
      id?: unknown
      name?: unknown
      args?: unknown
    }
  }) => {
    const id = typeof message.id === 'string' ? message.id : null
    const started = performance.now()
    const argv = typeof message.name === 'string' && Array.isArray(message.args) && message.args.every(arg => typeof arg === 'string')
      ? [
        message.name,
        ...message.args,
      ]
      : undefined
    let answered = false

    // The command's log line is written when its one receipt or error goes out.
    const send: typeof sendToTab = ({
      ws: tab,
      message: answer,
    }) => {
      const final = answer.type === 'receipt' || answer.type === 'error'

      if (final && !answered && answer.id === id) {
        answered = true
        log({
          operation: 'command.page',
          name: argv ? invocationOf({ argv }).name : String(message.name),
          titanId,
          status: answer.type === 'error' ? 'error' : 'ok',
          code: answer.type === 'error' ? answer.code : undefined,
          ms: performance.now() - started,
        })
      }

      return sendToTab({
        ws: tab,
        message: answer,
      })
    }

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

      if (id && argv) {
        const [
          name,
          ...args
        ] = argv
        const command: SaveCommand = {
          type: 'command',
          id,
          name,
          args,
        }

        if (saveEventId({ command })) {
          try {
            const receipt = savedEvent({
              command,
              state: loadTitan({ titanId }).state,
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
      'page',
      'thread',
      'oracle',
      'reply',
      'task-message',
      'answer',
      'agent',
      'catalog',
      'titans',
      'titan-agent',
      'models',
      'files',
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
          compactCommand({
            ws,
            id,
            args,
            fail,
            send,
            agents,
          })
        } else if (name === 'models') {
          modelsCommand({
            ws,
            id,
            args,
            fail,
            send,
            agents,
          })
        } else if (name === 'files') {
          await filesCommand({
            ws,
            id,
            args,
            send,
            state,
            fileIndex,
          })
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
            titanId,
            searches: oracleSearches,
          })
        } else if (name === 'titan-agent') {
          await titanAgentCommand({
            ws,
            id,
            args,
            send,
            fail,
            titanId,
            agents,
            kick,
          })
        } else if (name === 'titans') {
          await titansCommand({
            ws,
            id,
            args,
            fail,
            send,
            titanId,
            url,
            open,
          })
        } else if (name === 'page') {
          if (args.some(arg => arg === '--titan' || arg.startsWith('--titan='))) {
            return fail({
              error: `--titan is not allowed; this server writes Titan ${titanId}`,
              code: 'VALIDATION_ERROR',
            })
          }

          const {
            interest,
            unavailable,
          } = pageInterest({
            state: state(),
            values: parsePage({ args }).values,
          })
          showPage({
            ws,
            interest,
          })
          send({
            ws,
            message: {
              type: 'receipt',
              id,
              unavailable,
            },
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
            retainThreads,
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
            titanId,
            state,
            closed,
            kick,
            startWorker,
          })
        }
      } catch (error) {
        fail({
          error: (error as Error).message,
          code: error instanceof TitanError ? error.code : 'UNKNOWN',
        })
      }

      return
    }

    cliCommand({
      ws,
      id,
      name,
      args,
      fail,
      send,
      titanId,
      kick,
      startWorker,
    })
  }

  return {
    runCommand,
    closeClient({ ws }: { ws: TitanClient }) {
      oracleSearches.get(ws)?.abort()
      oracleSearches.delete(ws)
    },
  }
}
