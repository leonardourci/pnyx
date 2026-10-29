import { randomUUID } from 'node:crypto'
import type { AskPermission, HostedEvent, HostedFact, HostedInput, HostedSession, HostedUsage, NativePermission, NativeWork, TurnOutcome, AnswerReceipt } from './provider.ts'

export type NativeResult = {
  type: 'result'
  turn: string
  inputIds: string[]
  status: TurnOutcome['status']
  final?: string
  queued?: number
  error?: string
}
export type NativeEvent = HostedEvent | NativeResult | {
  type: 'turn-started'
  turn: string
} | {
  type: 'answer-submitted'
  id: string
} | {
  type: 'background'
  background: NativeWork['background']
}
export interface NativeSession extends Omit<HostedSession, 'run' | 'attach' | 'snapshot'> {
  run({
    input,
    permission,
    emit,
  }: {
    input: AsyncIterable<HostedInput>
    permission: AskPermission
    emit({ event }: { event: NativeEvent }): void
  }): AsyncIterable<NativeEvent>
}

const MAX_PENDING_EVENTS = 1024

type EventType = Exclude<HostedEvent, string>['type']
type CriticalType = HostedFact['type'] | 'structured' | 'compaction'
const EVENT_CLASSES: { [Type in EventType]: Type extends CriticalType ? 'critical' : 'view' } = {
  input: 'critical',
  permission: 'critical',
  answer: 'critical',
  'permission-ended': 'critical',
  'turn-ended': 'critical',
  ended: 'critical',
  structured: 'critical',
  compaction: 'critical',
  text: 'view',
  usage: 'view',
  tool: 'view',
  thinking: 'view',
  work: 'view',
}

export function eventClass({ event }: { event: HostedEvent }): 'critical' | 'view' {
  if (typeof event === 'string') {
    return 'view'
  }

  return EVENT_CLASSES[event.type]
}

export function nativeIdle({ work }: { work: NativeWork }): boolean {
  const foregroundIdle = work.runningTurns.length === 0 && work.runningTools.length === 0
  const settled = work.unsettledInputs.length === 0 && work.pendingControls.length === 0
  const queueIdle = work.queue.knowledge === 'known' && work.queue.count === 0
  const backgroundIdle = work.background.knowledge === 'known' && work.background.tasks.length === 0

  return foregroundIdle && settled && queueIdle && backgroundIdle
}

// Execution has one owner. Readers can leave without returning the provider's iterator.
export function nativeSession({ native }: { native: NativeSession }): HostedSession {
  const work: NativeWork = {
    runningTurns: [],
    runningTools: [],
    unsettledInputs: [],
    pendingControls: [],
    queue: {
      knowledge: 'known',
      count: 0,
    },
    background: {
      knowledge: 'known',
      tasks: [],
    },
  }
  const permissions = new Map<string, NativePermission>()
  const answers = new Map<string, AnswerReceipt>()
  const texts = new Map<string, string>()
  const confirmed = new Map<string, string>()
  let structured: unknown, usage: Omit<HostedUsage, 'type'> | undefined
  let outcome: TurnOutcome | undefined, started = false, ended = false
  let finishing = false
  let observe: (({ event }: { event: HostedEvent }) => string | void) | undefined
  let stopError: Error | undefined
  let failure: Error | undefined
  const readers = new Set<{
    queue: HostedEvent[]
    wake(): void
    error?: Error
  }>()

  const broadcast = ({ event }: { event: HostedEvent }) => {
    const stop = observe?.({ event })

    if (stop && !stopError) {
      stopError = new Error(stop)
      queueMicrotask(() => {
        try {
          native.close()
        } catch {
          stopError = new Error('Native close failed after output retention exhausted')
        } finally {
          finish({ error: stopError })
        }
      })
    }

    for (const reader of readers) {
      if (reader.queue.length >= MAX_PENDING_EVENTS) {
        reader.error = new Error('The native session reader fell behind; attach again and read its snapshot')
        reader.queue.length = 0
        readers.delete(reader)
      } else {
        reader.queue.push(event)
      }

      reader.wake()
    }
  }

  const publishWork = () => broadcast({
    event: {
      type: 'work',
      work: structuredClone(work),
    },
  })

  const complete = ({
    result,
    settled = true,
  }: {
    result: NativeResult
    settled?: boolean
  }) => {
    const consumed = [...confirmed].filter(([
      , turn,
    ]) => turn === result.turn).map(([id]) => id)
    const inputIds = [
      ...new Set([
        ...consumed,
        ...result.inputIds,
      ]),
    ]
    outcome = {
      turn: result.turn,
      inputIds,
      status: result.status,
      at: new Date().toISOString(),
      assistant: [...texts].map(([
        id,
        text,
      ]) => ({
        id,
        text,
      })),
      structured,
      usage,
      error: result.error,
      result: result.final,
    }
    broadcast({
      event: {
        type: 'turn-ended',
        outcome: structuredClone(outcome),
      },
    })
    texts.clear()
    structured = undefined
    work.runningTurns = []
    work.queue = { knowledge: 'unknown' }

    if (result.queued !== undefined) {
      work.queue = {
        knowledge: 'known',
        count: result.queued,
      }
    }

    for (const inputId of inputIds) {
      if (settled) {
        work.unsettledInputs = work.unsettledInputs.filter(id => id !== inputId)
        confirmed.delete(inputId)
        broadcast({
          event: {
            type: 'input',
            receipt: {
              inputId,
              phase: 'settled',
              turn: result.turn,
            },
          },
        })
      }
    }

    publishWork()
  }

  const emit = ({ event }: { event: NativeEvent }) => {
    if (ended || stopError && !finishing) {
      return
    }

    if (event === 'working' && work.runningTurns.length === 0) {
      work.runningTurns = [randomUUID()]
      texts.clear()
      structured = undefined
    }

    if (typeof event === 'object') {
      if (event.type === 'tool') {
        work.runningTools = work.runningTools.filter(id => id !== event.id)

        if (event.running) {
          work.runningTools.push(event.id)
        }
      }

      if (event.type === 'turn-started') {
        work.runningTurns = [event.turn]
        texts.clear()
        structured = undefined
        publishWork()

        return
      }

      if (event.type === 'result') {
        complete({ result: event })

        return
      }

      if (event.type === 'answer-submitted') {
        const received = [...answers.values()].find(receipt => receipt.permission === event.id)

        if (received && received.phase === 'received') {
          emit({
            event: {
              type: 'answer',
              receipt: {
                ...received,
                phase: 'submitted',
              },
            },
          })
        }

        endPermission({ id: event.id })

        return
      }

      if (event.type === 'background') {
        work.background = event.background
        publishWork()

        return
      }

      if (event.type === 'input' && event.receipt.phase === 'confirmed' && event.receipt.turn) {
        if (work.runningTurns.length === 0) {
          texts.clear()
          structured = undefined
        }

        confirmed.set(
          event.receipt.inputId,
          event.receipt.turn,
        )
        work.runningTurns = [event.receipt.turn]
      }

      if (event.type === 'text') {
        let text = event.text

        if (event.append) {
          text = (texts.get(event.id) ?? '') + text
        }

        texts.set(
          event.id,
          text,
        )
      } else if (event.type === 'structured') {
        structured = event.value
      } else if (event.type === 'usage') {
        const update: Partial<HostedUsage> = { ...event }
        delete update.type
        usage = {
          ...usage,
          ...update,
        }
      } else if (event.type === 'answer') {
        answers.set(
          event.receipt.answerId,
          event.receipt,
        )
      }
    }

    broadcast({ event })

    if (typeof event === 'string' || event.type === 'input' || event.type === 'permission'
      || event.type === 'permission-ended' || event.type === 'answer' || event.type === 'tool') {
      publishWork()
    }
  }

  const endPermission = ({ id }: { id: string }) => {
    if (!permissions.delete(id)) {
      return
    }

    work.pendingControls = work.pendingControls.filter(pending => pending !== id)
    emit({
      event: {
        type: 'permission-ended',
        id,
      },
    })
  }

  const finish = ({ error }: { error?: Error }) => {
    if (ended || finishing) {
      return
    }

    finishing = true

    if (work.runningTurns.length) {
      complete({
        settled: false,
        result: {
          type: 'result',
          turn: work.runningTurns[0]!,
          inputIds: [...confirmed.keys()],
          status: error ? 'failed' : 'interrupted',
          error: error?.message,
        },
      })
    }

    for (const inputId of work.unsettledInputs) {
      broadcast({
        event: {
          type: 'input',
          receipt: {
            inputId,
            phase: 'unknown',
          },
        },
      })
    }

    for (const id of permissions.keys()) {
      endPermission({ id })
    }

    work.queue = { knowledge: 'unknown' }
    publishWork()
    failure = error
    const event: HostedFact = {
      type: 'ended',
      reason: 'closed',
      error: error?.message,
    }

    if (error) {
      event.reason = 'failed'
    }

    broadcast({ event })
    ended = true
    finishing = false
  }

  const attach = (): AsyncIterableIterator<HostedEvent> => {
    const reader = {
      queue: [] as HostedEvent[],
      wake: () => {},
      error: undefined as Error | undefined,
    }
    let detached = false
    readers.add(reader)

    return {
      [Symbol.asyncIterator]() {
        return this
      },
      async next() {
        while (!detached) {
          if (reader.error) {
            throw reader.error
          }

          const event = reader.queue.shift()

          if (event !== undefined) {
            return {
              done: false,
              value: event,
            }
          }

          if (ended) {
            if (failure) {
              throw failure
            }

            return {
              done: true,
              value: undefined,
            }
          }

          await new Promise<void>(resolve => {
            reader.wake = resolve
          })
        }

        return {
          done: true,
          value: undefined,
        }
      },
      async return() {
        detached = true
        reader.queue.length = 0
        readers.delete(reader)
        reader.wake()

        return {
          done: true,
          value: undefined,
        }
      },
    }
  }

  const control = async ({ run }: { run(): Promise<void> }) => {
    const id = randomUUID()
    work.pendingControls.push(id)
    publishWork()

    try {
      await run()
    } finally {
      work.pendingControls = work.pendingControls.filter(pending => pending !== id)
      publishWork()
    }
  }

  return {
    id: native.id,
    path: native.path,
    commands: native.commands?.bind(native),
    set: ({
      setting,
      value,
    }) => control({
      run: () => native.set({
        setting,
        value,
      }),
    }),
    interrupt: () => control({ run: () => native.interrupt() }),
    close() {
      try {
        native.close()
      } finally {
        finish({})
      }
    },
    snapshot() {
      return structuredClone({
        work,
        permissions: [...permissions.values()],
        answers: [...answers.values()],
        outcome,
      })
    },
    attach,
    run({
      input,
      permission,
      observe: sink,
    }) {
      if (started) {
        throw new Error('The native session is already running; attach another reader instead')
      }

      started = true
      observe = sink
      const stream = attach()

      const messages = async function* () {
        for await (const message of input) {
          work.unsettledInputs.push(message.id)
          emit({
            event: {
              type: 'input',
              receipt: {
                inputId: message.id,
                phase: 'queued',
              },
            },
          })
          yield message
        }
      }

      const ask: AskPermission = async ({ ...request }) => {
        const {
          signal,
          ...pending
        } = request
        const answerId = randomUUID()
        permissions.set(
          request.id,
          pending,
        )
        work.pendingControls.push(request.id)
        emit({
          event: {
            type: 'permission',
            request: pending,
          },
        })

        const abort = () => endPermission({ id: request.id })

        signal.addEventListener(
          'abort',
          abort,
          { once: true },
        )

        try {
          const decision = await permission(request)
          let phase: AnswerReceipt['phase'] = 'received'

          if (signal.aborted) {
            phase = 'aborted'
          }

          emit({
            event: {
              type: 'answer',
              receipt: {
                answerId,
                permission: request.id,
                phase,
              },
            },
          })

          if (signal.aborted) {
            abort()
          }

          return decision
        } catch (error) {
          emit({
            event: {
              type: 'answer',
              receipt: {
                answerId,
                permission: request.id,
                phase: 'failed',
              },
            },
          })
          endPermission({ id: request.id })
          throw error
        } finally {
          signal.removeEventListener(
            'abort',
            abort,
          )
        }
      }

      const pump = async () => {
        try {
          for await (const event of native.run({
            input: messages(),
            permission: ask,
            emit,
          })) {
            emit({ event })
          }

          finish({})
        } catch (error) {
          finish({ error: error as Error })
        }
      }

      // The owner catches failure and delivers it to each reader, including one that attaches later.
      pump().catch(error => finish({ error: error as Error }))

      return stream
    },
  }
}
