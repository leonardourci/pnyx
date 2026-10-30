import { randomUUID } from 'node:crypto'
import { deferred } from './deferred.ts'
import type { HostClient } from './client.ts'
import type { Fact, Mutation, Result, Snapshot, Summary, ToClient } from './protocol.ts'
import { fail } from './protocol.ts'
import { eventClass } from '#workers/native-session.ts'
import type { AskPermission, HostedEvent, HostedSession, PermissionDecision, TurnOutcome } from '#workers/provider.ts'

const MAX_PENDING = 2048

export function checked({ result }: { result: Result }): Exclude<Result, { kind: 'error' }> {
  if (result.kind === 'error') {
    fail({
      code: result.code,
      message: result.message,
    })
  }

  return result
}

export async function remoteSession({
  client,
  summary,
  recovered,
  persistAnswer,
  completedAnswer,
  context,
  readOnly = false,
}: {
  client: HostClient
  summary: Summary
  recovered: boolean
  context?(): string
  readOnly?: boolean
  persistAnswer({
    permission,
    decision,
  }: {
    permission: string
    decision: PermissionDecision
  }): Promise<string>
  completedAnswer({
    answerId,
    phase,
  }: {
    answerId: string
    phase: string
  }): Promise<void>
}): Promise<HostedSession> {
  const attached = checked({
    result: await client.call({
      id: randomUUID(),
      operation: {
        kind: 'attach',
        scope: {
          kind: 'session',
          ref: summary.ref,
        },
        expectedRevision: summary.controllerRevision,
      },
    }),
  })

  if (attached.kind !== 'attached') {
    throw new Error('Missing session controller')
  }

  const controller = attached.control.generation
  let publishedContext: string | undefined
  let contextWrite = Promise.resolve()
  let baseline: Snapshot | undefined
  const started = deferred<void>(), replay = deferred<void>()
  let boundary = 0, through = 0, detached = false, failure: Error | undefined
  let wake = deferred<void>()
  const queue: {
    event: HostedEvent
    fact?: Fact
  }[] = []
  const known = new Set<number>()
  const admitted = new Set<string>()
  const permissions = new Map<string, AbortController>()
  let permission: AskPermission | undefined
  let current: Fact | undefined
  let outcome: TurnOutcome | undefined

  const call = async ({
    operation,
    id = randomUUID(),
  }: {
    operation: Mutation extends infer M ? M extends Mutation ? Omit<M, 'ref' | 'controller'> : never : never
    id?: string
  }) => checked({
    result: await client.call({
      id,
      operation: {
        ...operation,
        ref: summary.ref,
        controller,
      },
    }),
  })

  const refreshContext = async () => {
    if (readOnly) {
      return
    }

    const text = context?.()

    if (text === undefined || text === publishedContext) {
      return contextWrite
    }

    publishedContext = text
    contextWrite = contextWrite.catch(() => {}).then(async () => {
      try {
        await call({
          operation: {
            kind: 'context',
            text,
          },
        })
      } catch (error) {
        if (publishedContext === text) {
          publishedContext = undefined
        }

        throw error
      }
    })

    return contextWrite
  }

  await refreshContext()

  const enqueue = ({
    event,
    fact,
  }: {
    event: HostedEvent
    fact?: Fact
  }) => {
    if (fact && (fact.seq <= through || known.has(fact.seq))) {
      return
    }

    if (fact) {
      known.add(fact.seq)
    }

    if (queue.length >= MAX_PENDING) {
      failure = new Error('Native reader fell behind; reconnect to retained facts')
      detach()

      return
    }

    queue.push({
      event,
      fact,
    })
    wake.resolve()
  }

  const receive = ({ frame }: { frame: ToClient }) => {
    if (!('ref' in frame) || frame.ref.id !== summary.ref.id || frame.ref.epoch !== summary.ref.epoch) {
      return
    }

    if (frame.type === 'snapshot') {
      baseline = frame.snapshot

      for (const id of frame.snapshot.admittedInputIds) {
        admitted.add(id)
      }

      boundary = Math.max(
        0,
        ...frame.pendingFacts.map(fact => fact.seq),
      )

      for (const fact of frame.pendingFacts) {
        enqueue({
          event: fact.event,
          fact,
        })
      }

      for (const text of frame.snapshot.text) {
        enqueue({
          event: {
            type: 'text',
            ...text,
          },
        })
      }

      if (frame.snapshot.usage) {
        enqueue({
          event: {
            type: 'usage',
            ...frame.snapshot.usage,
          },
        })
      }

      if (frame.snapshot.native) {
        enqueue({
          event: {
            type: 'work',
            work: frame.snapshot.native.work,
          },
        })
      }

      if (frame.snapshot.activity === 'working') {
        enqueue({ event: 'working' })
      }

      started.resolve()

      if (!boundary) {
        replay.resolve()
      }
    } else if (frame.type === 'event') {
      const critical = eventClass({ event: frame.event }) === 'critical'
      enqueue({
        event: frame.event,
        fact: critical ? frame as Fact : undefined,
      })
    }
  }

  const unsubscribe = client.subscribe({ receive })
  const unwatchDisconnect = client.onDisconnect({
    receive() {
      failure = new Error('Native host unavailable; retained ownership must be reconciled')
      started.reject(failure)
      replay.reject(failure)
      wake.resolve()
    },
  })
  replay.promise.catch(() => {})

  const detach = () => {
    detached = true
    unsubscribe()
    unwatchDisconnect()
    // Detachment abandons only application callbacks; no decision is sent to the native owner.
    permissions.clear()
    wake.resolve()
  }

  client.watch({ ref: summary.ref })
  await started.promise

  if (readOnly && !queue.some(item => typeof item.event === 'object' && item.event.type === 'turn-ended')) {
    detach()
    fail({
      code: 'RECOVERY_REQUIRED',
      message: 'The retained native turn has no terminal outcome; preserve its unresolved ownership',
    })
  }

  const decide = ({ request }: { request: Extract<HostedEvent, { type: 'permission' }>['request'] }) => {
    if (!permission || permissions.has(request.id)) {
      return
    }

    const abort = new AbortController()
    permissions.set(
      request.id,
      abort,
    )

    const answer = async () => {
      const decision = await permission!({
        ...request,
        signal: abort.signal,
      })

      if (detached) {
        return
      }

      const answerId = await persistAnswer({
        permission: request.id,
        decision,
      })
      const result = await call({
        id: answerId,
        operation: {
          kind: 'answer',
          answerId,
          permission: request.id,
          decision,
        },
      })

      if (result.kind === 'answer') {
        await completedAnswer({
          answerId,
          phase: result.receipt.phase,
        })
      }
    }

    answer().catch(error => {
      failure = error instanceof Error ? error : new Error('Native permission delivery failed')
      wake.resolve()
    })
  }

  const applied = async () => {
    if (!current || current.seq <= through) {
      return
    }

    checked({
      result: await client.acknowledge({
        ref: summary.ref,
        controller,
        through: current.seq,
      }),
    })
    through = current.seq
    known.delete(through)

    if (through >= boundary) {
      replay.resolve()
    }
  }

  const events = async function* () {
    await started.promise

    for (;;) {
      if (failure) {
        throw failure
      }

      if (detached) {
        return
      }

      const next = queue.shift()

      if (!next) {
        if (readOnly) {
          return
        }

        wake = deferred<void>()
        await wake.promise
        continue
      }

      current = next.fact
      const { event } = next

      if (typeof event === 'object') {
        if (event.type === 'compaction') {
          await refreshContext()
        }

        if (event.type === 'permission') {
          decide({ request: event.request })
        }

        if (event.type === 'permission-ended') {
          permissions.get(event.id)?.abort()
          permissions.delete(event.id)
        }

        if (event.type === 'answer') {
          await completedAnswer({
            answerId: event.receipt.answerId,
            phase: event.receipt.phase,
          })
        }

        if (baseline?.native && event.type === 'work') {
          baseline.native.work = event.work
        }

        if (event.type === 'turn-ended') {
          outcome = event.outcome
        }
      }

      yield event

      if (next.fact) {
        await applied()
      }

      current = undefined

      if (typeof event === 'object' && event.type === 'ended') {
        return
      }
    }
  }

  const session: HostedSession = {
    remote: true,
    incarnation: summary.ref.epoch,
    recovered,
    accepted: ({ id }) => recovered && admitted.has(id),
    id: summary.nativeId!,
    path: summary.path,
    replayed: () => replay.promise,
    refreshContext,
    applied,
    fact: () => current ? {
      id: `${current.ref.epoch}:${current.seq}`,
      at: current.at,
    } : undefined,
    detach,
    snapshot: () => ({
      work: baseline!.native?.work ?? {
        runningTurns: [],
        runningTools: [],
        unsettledInputs: [],
        pendingControls: [],
        queue: { knowledge: 'unknown' },
        background: {
          knowledge: 'unknown',
          reason: 'No native baseline',
        },
      },
      permissions: baseline!.native?.permissions ?? [],
      answers: baseline!.native?.answers ?? [],
      outcome,
    }),
    run({
      input,
      permission: ask,
    }) {
      permission = ask

      for (const request of baseline?.native?.permissions ?? []) {
        decide({ request })
      }

      const feed = async () => {
        if (readOnly) {
          return
        }

        for await (const original of input) {
          if (detached) {
            return
          }

          if (recovered && admitted.has(original.id)) {
            continue
          }

          const message = original
          await refreshContext()
          await call({
            id: `${summary.ref.epoch}:input:${message.id}`,
            operation: {
              kind: 'input',
              input: message,
            },
          })
          admitted.add(message.id)
        }
      }

      feed().catch(error => {
        failure = error; wake.resolve()
      })

      return events()
    },
    attach: events,
    async set({
      setting,
      value,
    }) {
      await call({
        operation: {
          kind: 'set',
          setting,
          value,
        },
      })
    },
    async interrupt() {
      const turn = session.snapshot().work.runningTurns[0]

      if (turn) {
        await call({
          operation: {
            kind: 'interrupt',
            expectedTurn: turn,
          },
        })
      }
    },
    async commands() {
      const result = checked({
        result: await client.call({
          id: randomUUID(),
          operation: {
            kind: 'commands',
            ref: summary.ref,
          },
        }),
      })

      return result.kind === 'commands' ? result.commands : []
    },
    close() {
      if (readOnly) {
        detach()

        return Promise.resolve()
      }

      const closing = call({
        operation: {
          kind: 'close',
          expectedIdle: false,
        },
      }).then(() => {
        summary.phase = 'closed'
      })
      // Callers that do not await shutdown still receive its failure through the reader.
      closing.catch(error => {
        failure = error; wake.resolve()
      })

      return closing
    },
  }

  return session
}
