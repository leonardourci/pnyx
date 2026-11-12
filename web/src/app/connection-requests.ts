import type { ServerMessage } from '#app/server-transport.ts'
import type { HydraSummary } from '#app/server-hydras.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import { DISPATCH_CHANGED } from '#web-workers/heads-dispatch.ts'
import { reminderTime } from '#tasks/time.ts'
import { saveEventId, savedReceipt } from '#app/save-receipts.ts'
import { commandTimeout, retryable } from './connection-protocol.ts'
import { argument, currentRevision, optimisticState } from '#web-tasks/optimistic.ts'
import { commandArguments, editTargets } from './pending-state.ts'
import { CommandFailure } from '#web-shared/pending-intents.ts'
import type { Scope, Request, HydraListResource } from './connection-model.ts'
import type { Receipt } from './connection.ts'

export function createConnectionRequests({
  connection,
  scopes,
  requests,
  hydras,
  publish,
  subscribe,
  persistSaves,
  send,
  updateHydras,
}: {
  connection: { readonly socket: WebSocket | null }
  scopes: Map<string, Scope>
  requests: Map<string, Request>
  hydras: HydraListResource
  publish(): void
  subscribe({ scope }: { scope: Scope }): void
  persistSaves({ scope }: { scope: Scope }): void
  updateHydras({ rows }: { rows: HydraSummary[] }): void
  send({ message }: { message: unknown }): void
}) {
  const flush = () => {
    if (connection.socket?.readyState !== WebSocket.OPEN) {
      return
    }

    const editing = new Set<Scope>()

    for (const scope of scopes.values()) {
      if (scope.resource.snapshot().intents.some(intent => intent.stage === 'accepted')) {
        editing.add(scope)
      }
    }

    for (const request of requests.values()) {
      if (request.sent && request.optimistic) {
        editing.add(request.scope)
      }
    }

    for (const request of requests.values()) {
      const waitingForTarget = request.scope.resource.snapshot().intents.some(intent =>
        request.dependencies.includes(intent.id) && intent.stage !== 'confirmed')
      const blocked = waitingForTarget || (request.optimistic && editing.has(request.scope))

      if (request.sent || !request.scope.ready || blocked) {
        continue
      }

      const intent = request.scope.resource.snapshot().intents
        .find(intent => intent.id === request.id)

      if (intent?.stage === 'refused') {
        continue
      }

      if (request.optimistic) {
        editing.add(request.scope)
        request.args = currentRevision({
          state: request.scope.resource.snapshot().confirmed,
          edit: request,
        })
        request.scope.resource.sending({ id: request.id })
      }

      request.sent = true
      request.timer = setTimeout(
        () => {
          const error = new CommandFailure({
            message: 'Send could not be confirmed. Check its outcome before retrying.',
            code: 'TIMEOUT',
            outcome: 'unknown',
          })

          if (request.saveId || (request.checking && request.retry)) {
            request.checking = true
            request.unconfirmed()
            request.sent = false
            publish()
            flush()

            return
          }

          if (request.optimistic || request.creation) {
            request.scope.resource.unknown({
              id: request.id,
              error,
            })

            if (request.creation) {
              hydras.unknown({
                id: request.creation,
                error,
              })
            }

            connection.socket?.close()
          } else {
            requests.delete(request.id)
            request.reject({ error })
            request.scope.error = error.message
          }

          publish()
        },
        commandTimeout(request),
      )
      send({
        message: {
          type: 'command',
          scope: request.scope.id,
          id: request.id,
          name: request.name,
          args: request.args,
        },
      })
    }
  }

  function command({
    scope,
    name,
    args,
    creation,
    onChecking,
    savedId,
  }: {
    scope: Scope
    name: string
    args: string[]
    creation?: string
    onChecking?(): void
    savedId?: string
  }): Promise<Receipt> {
    return new Promise((
      resolve,
      reject,
    ) => {
      if (!document.querySelector<HTMLMetaElement>('meta[name=pnyx-token]')?.content) {
        reject(new CommandFailure({
          message: 'Open this Hydra through pnyx-axi serve to send. Draft kept.',
          code: 'UNAUTHORIZED',
        }))

        return
      }

      if (name === 'task' && args[0] === 'remind' && args[2] !== 'clear') {
        args = [...args]
        args[2] = reminderTime({
          when: args[2] ?? '',
          now: new Date().toISOString(),
        })
      }

      if (name === 'task' && args[0] === 'defer-question') {
        const until = argument({
          args,
          flag: '--until',
        })

        if (until !== undefined && until !== 'clear') {
          const normalized = reminderTime({
            when: until,
            now: new Date().toISOString(),
          })
          const original = args
          args = original.map((
            value,
            index,
          ) => {
            if (original[index - 1] === '--until') {
              return normalized
            }

            if (value.startsWith('--until=')) {
              return `--until=${normalized}`
            }

            return value
          })
        }
      }

      const id = savedId ?? crypto.randomUUID()
      const confirmed = savedReceipt({
        command: {
          type: 'command',
          id,
          name,
          args,
        },
        state: scope.resource.snapshot().confirmed,
      })

      if (confirmed) {
        resolve(confirmed)

        return
      }

      let optimistic: boolean

      try {
        const view = scope.resource.snapshot().view
        optimistic = optimisticState({
          state: view,
          edit: {
            name,
            args,
          },
        }) !== view
        args = commandArguments({
          id,
          edit: {
            name,
            args,
          },
          persisted: optimistic,
          scope: scope.id,
        })
      } catch (error) {
        reject(error)

        return
      }

      const retry = optimistic || !!creation || retryable({
        name,
        args,
      })

      if ((!scope.ready || connection.socket?.readyState !== WebSocket.OPEN) && !retry) {
        reject(new CommandFailure({
          message: 'This Hydra is still connecting. Try again when it is ready.',
          code: 'NOT_RUNNING',
        }))

        return
      }

      const dependencies = scope.resource.snapshot().intents.filter(intent => {
        const isPending = ![
          'refused',
          'confirmed',
        ].includes(intent.stage)
        const isCreation = [
          'column',
          'task',
        ].includes(intent.patch.name)
          && intent.patch.args[0] === 'create'
        const targetsArgument = args.some(arg => intent.targets.includes(arg))

        return isPending && isCreation && targetsArgument
      }).map(intent => intent.id)

      if (optimistic) {
        const edit = {
          name,
          args,
        }
        const targets = editTargets({ edit })

        scope.resource.enqueue({
          id,
          targets,
          patch: edit,
          dependencies,
          delivery: 'idempotent',
        })
      }

      const saveId = saveEventId({
        command: {
          type: 'command',
          id,
          name,
          args,
        },
      })
      requests.set(
        id,
        {
          id,
          scope,
          name,
          args,
          optimistic,
          dependencies,
          retry,
          sent: false,
          creation,
          saveId,
          unconfirmed: () => onChecking?.(),
          resolve: ({ receipt }) => resolve(receipt),
          reject: ({ error }) => reject(error),
        },
      )

      if (optimistic || creation || saveId) {
        scope.error = ''
      }

      persistSaves({ scope })
      publish(); subscribe({ scope }); flush()
    })
  }

  const respond = ({
    scope,
    id,
    message,
  }: {
    scope: Scope
    id: string
    message: Extract<ServerMessage, { type: 'receipt' | 'error' }>
  }) => {
    const request = requests.get(id)

    if (!request || request.scope !== scope) {
      publish(); flush()

      return
    }

    if (request.name === 'hydras' && message.type === 'receipt' && Array.isArray(message.hydras)) {
      updateHydras({ rows: message.hydras as HydraSummary[] })
    }

    if (message.type === 'error' && request.saveId && message.saved !== false) {
      request.checking = true
      request.unconfirmed()
      publish()

      return
    }

    clearTimeout(request.timer)
    requests.delete(id)
    persistSaves({ scope })

    if (message.type === 'error') {
      const error = new CommandFailure({
        message: message.error,
        code: message.code,
        help: message.help,
      })

      if (request.optimistic) {
        scope.resource.refuse({
          id: request.id,
          error,
        })
      }

      if (request.creation) {
        hydras.refuse({
          id: request.creation,
          error,
        })
      }

      const cancelledSearch = request.name === 'oracle' && message.code === 'CANCELLED'

      if (!cancelledSearch) {
        scope.error = message.error
      }

      request.reject({ error })
    } else {
      if (request.optimistic) {
        scope.resource.accept({
          id: request.id,
          complete: message.event === 'none: unchanged',
        })
      }

      if ([
        'rule',
        'account',
      ].includes(request.name) && request.args[0] !== 'list') {
        window.dispatchEvent(new Event(DISPATCH_CHANGED))
      }

      if (request.name === 'thread' && (message.thread as ThreadPage | undefined)?.card === HYDRA_CARD) {
        scope.thread = message.thread as ThreadPage
      }

      request.resolve({ receipt: message })
    }

    publish(); flush()
  }

  const disconnectRequests = () => {
    for (const request of requests.values()) {
      clearTimeout(request.timer)

      if (request.retry) {
        if (request.saveId || request.optimistic) {
          request.checking = true
          request.unconfirmed()
        }

        if (request.sent) {
          const error = new CommandFailure({
            message: 'Connection lost before confirmation.',
            code: 'DISCONNECTED',
            outcome: 'unknown',
          })

          if (request.optimistic) {
            request.scope.resource.unknown({
              id: request.id,
              error,
            })
          }

          if (request.creation) {
            hydras.unknown({
              id: request.creation,
              error,
            })
          }
        }

        request.sent = false
      } else {
        requests.delete(request.id)
        request.reject({
          error: new CommandFailure({
            message: 'Send interrupted. Draft kept; check the outcome before retrying.',
            code: 'DISCONNECTED',
            outcome: 'unknown',
          }),
        })
      }
    }
  }

  return {
    command,
    flush,
    respond,
    disconnectRequests,
  }
}
