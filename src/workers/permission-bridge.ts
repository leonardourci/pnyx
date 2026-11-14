import { randomUUID } from 'node:crypto'
import { permissionAnswer, permissionEvent } from './permission-rules.ts'
import type { PermissionRequest } from './model.ts'
import type { PermissionDecision } from './provider.ts'
import { sessionId } from './session-attachments.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { helperPermission } from '#routine-helper/route.ts'
import { isHelper } from '#routine-helper/leases.ts'
import { findCard } from '#tasks/push-rules.ts'
import type { Card } from '#tasks/model.ts'
import { HydraError } from '#store/errors.ts'
import { HYDRA_ACTOR } from '#app/actors.ts'
import { explained } from '#app/cli-support.ts'
import type { HydraState } from '#app/model.ts'
import { loadHydra } from '#app/store.ts'
import type { Host, Live } from '#app/host-types.ts'
import type { Writer } from '#app/writer.ts'

// A provider's permission prompt as a recorded request on its card, and the waiter its answer resolves.
export function createPermissionBridge({
  hydraId,
  live,
  closing,
  at,
  write,
  note,
}: {
  hydraId: string
  live: Map<string, Live>
  closing(): boolean
  at(): string
  write<T>({ fn }: { fn: ({ writer }: { writer: Writer }) => T }): T
  note({ fn }: { fn: ({ writer }: { writer: Writer }) => void }): void
}) {
  const pending = new Map<string, {
    card: string
    entry: Live
    finish({ result }: { result: PermissionDecision }): void
  }>()

  const expirePermission = ({
    writer,
    card,
    request,
  }: {
    writer: Writer
    card: Card
    request: PermissionRequest
  }) => {
    writer.append({
      event: permissionEvent({
        state: writer.state,
        card,
        request: {
          ...request,
          status: 'expired',
        },
        meta: {
          at: at(),
          actor: 'pnyx',
        },
      }),
    })
  }

  const expire = ({ id }: { id: string }) => {
    const waiting = pending.get(id)

    if (!waiting) {
      return
    }

    waiting.finish({
      result: {
        behavior: 'deny',
        message: 'This permission request expired.',
      },
    })

    // A stop records nothing about running turns; the next start expires what was left waiting, as after a crash.
    if (closing()) {
      return
    }

    note({
      fn: ({ writer }) => {
        const card = writer.state.cards[waiting.card]
        const request = card?.permissions?.find(p => p.id === id && p.status === 'pending')

        if (card && request) {
          expirePermission({
            writer,
            card,
            request,
          })
        }
      },
    })
  }

  const expireEntry = ({ entry }: { entry: Live }) => {
    for (const [
      id,
      waiting,
    ] of pending) {
      if (waiting.entry === entry) {
        expire({ id })
      }
    }
  }

  const askPermission = ({
    id: nativeId,
    key,
    entry,
    tool,
    input,
    signal,
    description,
    questions,
    form,
  }: {
    tool: string
    input: Record<string, unknown>
    signal: AbortSignal
    description?: string
    key: string
    entry: Live
    id: string
  } & Pick<PermissionRequest, 'questions' | 'form'>): Promise<PermissionDecision> => {
    if (closing() || signal.aborted) {
      return Promise.resolve({
        behavior: 'deny',
        message: 'This permission request expired.',
      })
    }

    return new Promise<PermissionDecision>(resolve => {
      const cards = Object.values(loadHydra({ hydraId }).state.cards)
      const previous = cards.flatMap(card => card.permissions ?? [])
        .find(request => {
          const same = request.session === key && request.nativeId === nativeId

          return same && request.status !== 'expired'
        })
      const id = previous?.id ?? randomUUID()
      const abort = () => expire({ id })

      const finish = ({ result }: { result: PermissionDecision }) => {
        pending.delete(id)
        signal.removeEventListener(
          'abort',
          abort,
        )
        resolve(result)
      }

      const request: PermissionRequest = {
        id,
        nativeId,
        session: key,
        tool,
        input,
        status: previous?.status ?? 'pending',
        answers: previous?.answers,
        values: previous?.values,
        ...(description ? { description } : {}),
        ...(questions?.length ? { questions } : {}),
        ...(form ? { form } : {}),
      }
      signal.addEventListener(
        'abort',
        abort,
        { once: true },
      )

      try {
        write({
          fn: ({ writer }) => {
            const session = writer.state.sessions?.[key]
            const current = session?.id === writer.state.config?.hydra.session
              ? writer.state.cards[HYDRA_CARD]
              : session?.taskId ? writer.state.cards[session.taskId] : undefined

            if (!current || current.agent?.host !== 'pnyx' || sessionId({ agent: current.agent }) !== key) {
              throw new HydraError({
                message: 'the agent is no longer attached to this task',
                code: 'NO_ROUTE',
              })
            }

            pending.set(
              id,
              {
                card: current.id,
                entry,
                finish,
              },
            )
            writer.append({
              event: permissionEvent({
                state: writer.state,
                card: current,
                request,
                meta: {
                  at: at(),
                  actor: 'pnyx',
                },
              }),
            })
          },
        })
      } catch (error) {
        finish({
          result: {
            behavior: 'deny',
            message: `Could not record permission: ${(error as Error).message}`,
          },
        })
      }
    })
  }

  const permission: Host['permission'] = ({
    task,
    request: id,
    choice,
    answer,
    actor,
    reason,
    details,
  }) => {
    const why = explained({
      meta: {
        at: at(),
        actor,
        reason,
      },
    })
    const waiting = pending.get(id)
    const result = write({
      fn: ({ writer }) => {
        const card = findCard({
          state: writer.state,
          ref: task,
        })
        const request = card.permissions?.find(p => p.id === id)

        if (!request) {
          throw new HydraError({
            message: `permission request not found: ${id}`,
            code: 'NOT_FOUND',
          })
        }

        if (request.status !== 'pending' && request.delivery !== 'needs_reentry') {
          throw new HydraError({
            message: `permission request is already ${request.status}`,
            code: 'PERMISSION_CLOSED',
          })
        }

        // A question or form is the worker asking; the helper leaves its answer to main or the owner.
        if (isHelper({ actor }) && (!helperPermission({ request }) || answer !== undefined)) {
          throw new HydraError({
            message: 'This request asks a question; leave it to the main Hydra',
            code: 'MAIN_ONLY',
          })
        }

        // Hydra runs pnyx-axi unasked, so it must not clear its own prompts with it.
        if (card.id === HYDRA_CARD && actor === HYDRA_ACTOR) {
          throw new HydraError({
            message: 'Hydra cannot answer its own permission request',
            code: 'NO_ROUTE',
            help: ['The owner answers it in Hydra’s chat'],
          })
        }

        if (!waiting || waiting.card !== card.id || card.agent?.host !== 'pnyx' || sessionId({ agent: card.agent }) !== request.session) {
          expirePermission({
            writer,
            card,
            request,
          })

          return { expired: true as const }
        }

        if (request.delivery === 'needs_reentry' && choice !== request.status) {
          throw new HydraError({
            code: 'PERMISSION_CLOSED',
            message: 'Re-entry supplies missing secret values for the original decision',
          })
        }

        const answered = choice === 'allow' && (request.questions || request.form || answer !== undefined)
          ? permissionAnswer({
            request,
            value: answer,
          })
          : {}

        if (request.delivery === 'needs_reentry' && answered.answers && request.answers) {
          for (const [
            index,
            previous,
          ] of request.answers.entries()) {
            const nextAnswer = answered.answers[index]
            const sameAnswer = JSON.stringify(previous) === JSON.stringify(nextAnswer)

            if (!request.questions?.[index]?.secret && !sameAnswer) {
              throw new HydraError({
                code: 'PERMISSION_CLOSED',
                message: 'Only the missing secret answer can change on re-entry',
              })
            }
          }
        }

        const recorded = answered.answers
          ? {
            answers: answered.answers.map((
              picked,
              i,
            ) => request.questions?.[i]?.secret ? ['(hidden)'] : picked),
          }
          : answered
        writer.append({
          event: permissionEvent({
            state: writer.state,
            card,
            request: {
              ...request,
              status: choice,
              ...recorded,
            },
            meta: {
              at: at(),
              actor,
              reason: why,
              details,
            },
          }),
        })

        return {
          expired: false as const,
          answered,
          receipt: {
            task: card.id,
            request: id,
            status: choice,
            ...recorded,
          },
        }
      },
    })

    if (result.expired) {
      waiting?.finish({
        result: {
          behavior: 'deny',
          message: 'This permission request expired.',
        },
      })
      throw new HydraError({
        message: 'the agent no longer waits for this request',
        code: 'PERMISSION_CLOSED',
      })
    }

    waiting?.finish({
      result: choice === 'allow' ? {
        behavior: 'allow',
        ...result.answered,
      } : {
        behavior: 'deny',
        message: why || 'Permission denied from Pnyx.',
      },
    })

    return result.receipt
  }

  // A waiter whose request was answered elsewhere or whose card moved to another session expires.
  const reconcilePermissions = ({ state }: { state: HydraState }) => {
    for (const [
      id,
      waiting,
    ] of pending) {
      const card = state.cards[waiting.card]
      const request = card?.permissions?.find(p => p.id === id)

      if (!request || request.status !== 'pending' || card?.agent?.host !== 'pnyx' || sessionId({ agent: card.agent }) !== request.session) {
        expire({ id })
      }
    }
  }

  // A request still pending for a session no process runs any more was left by a stop, so it expires.
  const expireOrphans = ({ writer }: { writer: Writer }) => {
    for (const card of Object.values(writer.state.cards)) {
      for (const request of card.permissions ?? []) {
        if (request.status === 'pending' && !pending.has(request.id) && !live.has(request.session)) {
          expirePermission({
            writer,
            card,
            request,
          })
        }
      }
    }
  }

  const denyForMessage = ({
    task,
    actor,
    text,
  }: {
    task: string
    actor: string
    text: string
  }) => {
    const card = loadHydra({ hydraId }).state.cards[task]

    for (const request of card?.permissions ?? []) {
      if (request.status === 'pending' && pending.has(request.id)) {
        permission({
          task,
          request: request.id,
          choice: 'deny',
          actor,
          reason: `The owner answered with a message instead of approving. Their message follows: ${text}`,
        })
      }
    }
  }

  return {
    denyForMessage,
    expireEntry,
    askPermission,
    permission,
    reconcilePermissions,
    expireOrphans,
  }
}
