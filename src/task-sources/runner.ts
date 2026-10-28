import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { sendReply } from '#workers/reply.ts'
import type { Card } from '#tasks/model.ts'
import type { HydraState } from '#app/model.ts'
import type { SteeringMessage } from '#workers/model.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { enqueueSteering, recordSteeringAttempt } from '#workers/inbox.ts'
import { sameClaim, steeringClaim } from '#workers/steering.ts'
import type { ChildResult } from './child.ts'
import { bufferCapture, bufferedCaptures, commitCapture } from './capture.ts'
import type { ExternalSource, SourceResult } from './model.ts'
import { appendSource, captureResult, resultText, sourceById } from './sources.ts'
import { sourceHeld } from './state.ts'

interface RunningSource {
  card: string
  source: string
  run: string
  registration: string
  stop(): void
  finished: Promise<void>
}

const CAPTURE_RETRY_MS = 1000
const STEP_DETAILS = {
  interrupted: 'Previous server lost the listener; verify the external job before registering again',
  expired: 'Registration expired',
  stale: 'The registered worker assignment ended',
} as const

function startSourceChild({ entry }: { entry: URL }) {
  return fork(
    entry,
    [],
    {
      stdio: [
        'ignore',
        'ignore',
        'ignore',
        'ipc',
      ],
    },
  )
}

export function createSourceRunner({
  hydraId,
  changed,
  spawnSource = startSourceChild,
  commit = commitCapture,
  tell = sendReply,
  state: shared,
}: {
  hydraId: string
  changed(): void
  spawnSource?: typeof startSourceChild
  commit?: typeof commitCapture
  tell?: typeof sendReply
  // The Hydra the server already holds.
  state(): HydraState
}) {
  const server = randomUUID()
  const running = new Map<string, RunningSource>()
  let closed = false
  let reconciling: Promise<void> | undefined
  let capturePending = false
  const metadata = () => ({
    actor: 'pnyx',
    at: new Date().toISOString(),
  })
  const key = ({
    card,
    source,
  }: {
    card: string
    source: string
  }) => `${card}:${source}`

  const capture = ({
    job,
    result,
  }: {
    job: RunningSource
    result: ChildResult
  }) => {
    const captured = {
      card: job.card,
      source: job.source,
      registration: job.registration,
      run: job.run,
      at: new Date().toISOString(),
      result,
    }
    const path = bufferCapture({
      hydraId,
      capture: captured,
    })
    capturePending = true

    try {
      commit({
        hydraId,
        path,
        capture: captured,
      })
    } finally {
      changed()
    }
  }

  const launch = ({
    card,
    source,
  }: {
    card: Card
    source: ExternalSource
  }) => {
    const run = source.run!
    const entry = new URL(
      import.meta.url.endsWith('.ts') ? './child.ts' : './child.js',
      import.meta.url,
    )
    const child = spawnSource({ entry })
    let received: ChildResult | undefined
    let failure: Error | undefined
    let stopRequested = false
    let finish!: () => void
    const finished = new Promise<void>(resolve => {
      finish = resolve
    })
    const job: RunningSource = {
      card: card.id,
      source: source.id,
      run: run.id,
      registration: source.registration,
      finished,
      stop() {
        stopRequested = true

        if (child.connected) {
          child.disconnect()
        }
      },
    }
    const jobKey = key({
      card: card.id,
      source: source.id,
    })
    running.set(
      jobKey,
      job,
    )
    child.once(
      'message',
      (result: ChildResult) => {
        received = result

        try {
          capture({
            job,
            result,
          })
        } catch (error) {
          console.error(`pnyx-axi source: ${(error as Error).message}`)
        }
      },
    )

    const settle = () => {
      try {
        capture({
          job,
          result: received ?? {
            outcome: 'interrupted',
            stdout: '',
            stderr: '',
            detail: stopRequested ? 'Server stopped the listener; captured results remain owed'
              : `Listener ended without a result: ${failure?.message ?? 'unknown child outcome'}`,
          },
        })
      } catch (error) {
        console.error(`pnyx-axi source: ${(error as Error).message}`)
      } finally {
        running.delete(jobKey)
        finish()
      }
    }

    // The supervisor's last IPC message can still be unread when its exit is reaped. The channel
    // disconnects only after delivering it, or when the server stops the listener.
    let pending = 2

    const oneEnded = () => {
      pending--

      if (pending === 0) {
        settle()
      }
    }

    child.once(
      'exit',
      oneEnded,
    )
    child.once(
      'disconnect',
      oneEnded,
    )
    child.once(
      'error',
      error => {
        failure = error
        settle()
      },
    )
    child.send(
      source,
      // Node owns the IPC callback's positional error parameter.
      // eslint-disable-next-line pnyx/object-params
      error => {
        if (error) {
          failure = error
          job.stop()
        }
      },
    )
  }

  const flushCaptures = () => {
    const pending = new Set<string>()
    let committed = false

    for (const buffered of bufferedCaptures({ hydraId })) {
      try {
        commit({
          hydraId,
          path: buffered.path,
          capture: buffered.capture,
        })
        committed = true
      } catch (error) {
        pending.add(buffered.capture.run)
        console.error(`pnyx-axi source capture: ${(error as Error).message}`)
      }
    }

    capturePending = pending.size > 0

    return {
      pending,
      committed,
    }
  }

  const endReason = ({
    card,
    source,
  }: {
    card: Card
    source: ExternalSource
  }) => {
    if (Date.parse(source.expiresAt) <= Date.now()) {
      return 'expired'
    }

    const currentOwner = sameClaim({
      current: steeringClaim({ card }),
      claim: source.owner,
    })
    const inactiveTask = card.hidden || card.expired || card.status?.state === 'done'

    return currentOwner && !inactiveTask ? undefined : 'stale'
  }

  // What a pass owes a registered source, decided the same way before taking the lock and under it.
  const sourceStep = ({
    card,
    source,
    pending,
  }: {
    card: Card
    source: ExternalSource
    pending: Set<string>
  }) => {
    if (source.run && pending.has(source.run.id)) {
      return undefined
    }

    const job = running.get(key({
      card: card.id,
      source: source.id,
    }))

    const missingListener = source.run?.server !== server || !job

    if (source.state === 'running' && missingListener) {
      return 'interrupted'
    }

    if (source.state !== 'registered' && source.state !== 'running') {
      return undefined
    }

    const reason = endReason({
      card,
      source,
    })

    if (reason) {
      return reason
    }

    if (source.state !== 'registered' || sourceHeld({ card }) || job) {
      return undefined
    }

    const predecessor = source.lavish?.after

    if (predecessor) {
      const previousSource = card.externalSources?.find(
        source => source.id === predecessor.source,
      )
      const previousResult = previousSource?.results.find(
        result => result.sequence === predecessor.sequence,
      )

      if (!previousResult?.handled) {
        return undefined
      }
    }

    return 'start'
  }

  const prepare = ({ pending }: { pending: Set<string> }) => {
    const state = shared()

    // Stopping a listener writes nothing, so it runs before taking the lock.
    for (const card of Object.values(state.cards)) {
      for (const source of card.externalSources ?? []) {
        const job = running.get(key({
          card: card.id,
          source: source.id,
        }))

        if (job && (source.run?.id !== job.run || endReason({
          card,
          source,
        }))) {
          job.stop()
        }
      }
    }

    const owed = Object.values(state.cards).some(card => (card.externalSources ?? [])
      .some(source => sourceStep({
        card,
        source,
        pending,
      })))

    if (!owed) {
      return {
        locked: false,
        launches: [],
      }
    }

    const launches = withWriter({
      hydraId,
      fn: ({ writer }) => {
        const launches: {
          card: Card
          source: ExternalSource
        }[] = []

        for (const original of Object.values(writer.state.cards)) {
          for (const registered of original.externalSources ?? []) {
            const card = writer.state.cards[original.id]!
            const source = sourceById({
              card,
              id: registered.id,
            })
            const step = sourceStep({
              card,
              source,
              pending,
            })

            if (!step) {
              continue
            }

            if (step !== 'start') {
              captureResult({
                writer,
                card,
                source,
                run: source.run?.id ?? randomUUID(),
                outcome: step,
                detail: STEP_DETAILS[step],
                meta: metadata(),
              })
              continue
            }

            appendSource({
              writer,
              card,
              meta: metadata(),
              change: {
                type: 'task.source.started',
                data: {
                  source: source.id,
                  run: {
                    id: randomUUID(),
                    server,
                    at: new Date().toISOString(),
                  },
                },
              },
            })
            launches.push({
              card: writer.state.cards[card.id]!,
              source: sourceById({
                card: writer.state.cards[card.id]!,
                id: source.id,
              }),
            })
          }
        }

        return launches
      },
    })

    return {
      locked: true,
      launches,
    }
  }

  const alertNeeded = ({
    card,
    source,
    result,
  }: {
    card: Card
    source: ExternalSource
    result: SourceResult
  }) => {
    const stale = !sameClaim({
      current: steeringClaim({ card }),
      claim: source.owner,
    })
    const existing = card.steering?.find(message => message.id === result.message)
    const workerFinished = card.sessionActivity === 'finished' || card.sessionActivity === 'ended'
    const handlingOwed = Boolean(existing?.ack && workerFinished)

    const failed = result.outcome !== 'completed'

    return failed || sourceHeld({ card }) || stale || handlingOwed
      || Boolean(card.hidden)
  }

  // The worker claim a result's queued message still has to reach, if any.
  const undeliveredClaim = ({
    card,
    message,
  }: {
    card: Card
    message: SteeringMessage
  }) => {
    const claim = steeringClaim({ card })

    if (!claim || sourceHeld({ card }) || message.ack) {
      return undefined
    }

    const tried = message.attempts.some(attempt => sameClaim({
      current: attempt.claim,
      claim,
    }))

    return tried ? undefined : claim
  }

  // Decided before taking the lock, so a result already announced and delivered takes none.
  const announcementOwed = ({
    card,
    source,
    result,
  }: {
    card: Card
    source: ExternalSource
    result: SourceResult
  }) => {
    if (!result.alerted && alertNeeded({
      card,
      source,
      result,
    })) {
      return true
    }

    if (card.hidden) {
      return false
    }

    const message = card.steering?.find(message => message.id === result.message)

    if (!message) {
      return true
    }

    return undeliveredClaim({
      card,
      message,
    }) !== undefined
  }

  const announce = ({
    cardId,
    id,
    sequence,
  }: {
    cardId: string
    id: string
    sequence: number
  }) =>
    withWriter({
      hydraId,
      fn: ({ writer }) => {
        const card = writer.state.cards[cardId]!
        const source = sourceById({
          card,
          id,
        })
        const result = source.results.find(result => result.sequence === sequence)!

        if (result.handled) {
          return
        }

        if (!result.alerted && alertNeeded({
          card,
          source,
          result,
        })) {
          const detail = `External source ${id}, result ${sequence}: ${result.outcome}. ${result.detail}`
            + ' Read the result; it remains owed until its worker acknowledges and handles it.'
          appendSource({
            writer,
            card,
            meta: metadata(),
            change: {
              type: 'task.source.alerted',
              data: {
                source: id,
                sequence,
                detail,
              },
            },
          })
        }

        if (card.hidden) {
          return
        }

        enqueueSteering({
          writer,
          ref: card.id,
          id: result.message,
          text: resultText({
            source,
            result,
          }),
          source: `external:${source.registration}`,
          meta: metadata(),
        })
        const messages = writer.state.cards[cardId]!.steering!
        const message = messages.find(message => message.id === result.message)!
        const claim = undeliveredClaim({
          card,
          message,
        })

        if (!claim) {
          return
        }

        return {
          card: cardId,
          claim,
          message: result.message,
        }
      },
    })

  const deliver = async ({
    card,
    claim,
    message,
  }: {
    card: string
    claim: NonNullable<ReturnType<typeof steeringClaim>>
    message: string
  }) => {
    let result: 'delivered' | 'unknown' | 'failed' = 'unknown'
    let detail = ''

    try {
      const receipt = await tell({
        hydraId,
        request: {
          card,
          expectedSession: claim.session,
          id: `source-notice:${message}:${claim.generation}`,
          text: `External result waiting in your durable inbox: ${message}. Run task inbox read ${card}, then task source read ${card} <source-id>. Handle the inbox in order; a notification is not an acknowledgement.`,
          actor: 'pnyx',
          homes: [],
        },
      })
      result = receipt.state === 'delivered' ? 'delivered' : 'unknown'
      detail = receipt.detail ?? receipt.state
    } catch (error) {
      result = 'failed'
      detail = (error as Error).message
    }

    withWriter({
      hydraId,
      fn: ({ writer }) => {
        const current = writer.state.cards[card]
        const pending = current?.steering?.find(item => item.id === message)

        if (!current || pending?.ack || !sameClaim({
          current: steeringClaim({ card: current }),
          claim,
        })) {
          return
        }

        recordSteeringAttempt({
          writer,
          ref: card,
          id: message,
          meta: metadata(),
          attempt: {
            id: `source-notice:${message}:${claim.generation}`,
            at: new Date().toISOString(),
            actor: 'pnyx',
            claim,
            result,
            detail,
          },
        })

        if (result !== 'delivered') {
          const sources = writer.state.cards[card]!.externalSources ?? []

          for (const source of sources) {
            const captured = source.results.find(result => result.message === message)

            if (captured && !captured.alerted) {
              appendSource({
                writer,
                card: current,
                meta: metadata(),
                change: {
                  type: 'task.source.alerted',
                  data: {
                    source: source.id,
                    sequence: captured.sequence,
                    detail: `External result ${message} is unread; its worker notification ${result}: ${detail}. Read task source ${source.id} and restore worker delivery.`,
                  },
                },
              })
            }
          }
        }
      },
    })
  }

  const reconcile = async () => {
    const flushed = flushCaptures()
    const prepared = prepare({ pending: flushed.pending })

    for (const launchSource of prepared.launches) {
      if (!closed) {
        try {
          launch(launchSource)
        } catch (error) {
          const {
            card,
            source,
          } = launchSource
          capture({
            job: {
              card: card.id,
              source: source.id,
              registration: source.registration,
              run: source.run!.id,
              stop() {},
              finished: Promise.resolve(),
            },
            result: {
              outcome: 'failed',
              stdout: '',
              stderr: '',
              detail: `Listener could not start: ${(error as Error).message}`,
            },
          })
        }
      }
    }

    const wrote = flushed.committed || prepared.locked
    // What this pass wrote is not in the shared state yet, so its results come from disk.
    const state = wrote ? loadHydra({ hydraId }).state : shared()

    for (const card of Object.values(state.cards)) {
      for (const source of card.externalSources ?? []) {
        for (const result of source.results.filter(result => !result.handled)) {
          if (closed) {
            return
          }

          if (!announcementOwed({
            card,
            source,
            result,
          })) {
            continue
          }

          try {
            const notification = announce({
              cardId: card.id,
              id: source.id,
              sequence: result.sequence,
            })

            if (notification) {
              await deliver(notification)
            }
          } catch (error) {
            console.error(`pnyx-axi source notification: ${(error as Error).message}`)
          }
        }
      }
    }
  }

  return {
    deadline() {
      return capturePending ? Date.now() + CAPTURE_RETRY_MS : undefined
    },
    reconcile() {
      if (closed || reconciling) {
        return
      }

      reconciling = (async () => {
        try {
          await reconcile()
        } catch (error) {
          console.error(`pnyx-axi source: ${(error as Error).message}`)
        } finally {
          reconciling = undefined
        }
      })()
    },
    async close() {
      closed = true
      await reconciling

      for (const job of running.values()) {
        job.stop()
      }

      await Promise.all([...running.values()].map(job => job.finished))
    },
  }
}
