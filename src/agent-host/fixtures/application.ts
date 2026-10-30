import { AsyncLocalStorage } from 'node:async_hooks'
import { nativeProviders } from '#app/native-provider.ts'
import { fixtureProvider, states } from './provider.ts'
import { performance } from 'node:perf_hooks'
import { startServer } from '#app/server-daemon.ts'

const [
  directory,
  journal,
] = process.argv.slice(2)
const native = await nativeProviders({
  directory,
  journal,
  installation: 'fixture-installation',
})

const measurements: {
  operation: string
  ms: number
}[] = []
const opening = new AsyncLocalStorage<number>()
let openAttempt = 0
const traces: {
  kind: string
  details: unknown
}[] = []
const tracing = process.env.PNYX_TEST_VERBOSE === '1' || process.env.PNYX_FIXTURE_TRACE_OPENS === 'true'

const trace = ({
  kind,
  details,
}: {
  kind: string
  details: unknown
}) => {
  if (tracing) {
    traces.push({
      kind,
      details,
    })
  }

  if (process.env.PNYX_TEST_VERBOSE === '1') {
    console.error(
      kind,
      JSON.stringify(details),
    )
  }
}

let holdAnswers = false, holdDecisions = false, heldDecisions = 0, heldAnswers = 0
const call = native.client.call
const acknowledge = native.client.acknowledge
const completions = new Set<string>()

native.client.subscribe({
  receive: ({ frame }) => {
    if (frame.type === 'snapshot') {
      for (const fact of frame.pendingFacts) {
        if (fact.event.type === 'turn-ended') {
          completions.add(`${fact.ref.id}:${fact.seq}`)
        }
      }
    }

    if (frame.type === 'event' && typeof frame.event === 'object' && frame.event.type === 'turn-ended') {
      completions.add(`${frame.ref.id}:${frame.seq}`)
    }
  },
})

native.client.acknowledge = async ({ ...request }) => {
  const completion = completions.has(`${request.ref.id}:${request.through}`)

  if (process.env.PNYX_FIXTURE_CRASH_COMPLETION_ACKS === 'true' && completion) {
    process.kill(
      process.pid,
      'SIGKILL',
    )
    await new Promise<void>(() => {})
  }

  if (process.env.PNYX_FIXTURE_HOLD_COMPLETION_ACKS === 'true' && completion) {
    await new Promise<void>(() => {})
  }

  return acknowledge(request)
}

native.client.call = async ({ ...request }) => {
  if (request.operation.kind === 'answer' && holdAnswers) {
    heldAnswers++
    await new Promise<void>(() => {})
  }

  const holding = process.env.PNYX_FIXTURE_HOLD_INPUTS
  const holdInput = request.operation.kind === 'input'
    && (holding === 'true' || (holding === 'wake' && request.operation.input.id.startsWith('wake:')))

  if (holdInput && request.operation.kind === 'input') {
    process.send?.({
      type: 'input-held',
      epoch: request.operation.ref.epoch,
      inputId: request.operation.input.id,
    })
    await new Promise<void>(() => {})
  }

  const started = performance.now()
  trace({
    kind: 'rpc-start',
    details: {
      open: opening.getStore(),
      id: request.id,
      kind: request.operation.kind,
      session: 'ref' in request.operation ? request.operation.ref : undefined,
    },
  })
  let result

  try {
    result = await call(request)
    trace({
      kind: 'rpc-end',
      details: {
        open: opening.getStore(),
        id: request.id,
        result,
      },
    })
  } catch (error) {
    trace({
      kind: 'rpc-failed',
      details: {
        open: opening.getStore(),
        id: request.id,
        error: String(error),
      },
    })
    throw error
  }

  measurements.push({
    operation: request.operation.kind,
    ms: performance.now() - started,
  })

  return result
}

for (const adapter of Object.values(native.providers)) {
  const open = adapter.open

  adapter.open = async ({ ...options }) => {
    const session = await open(options)
    const run = session.run
    session.run = ({ ...options }) => run({
      ...options,
      permission: async ({ ...request }) => {
        const decision = await options.permission(request)

        if (holdDecisions) {
          heldDecisions++
          await new Promise<void>(() => {})
        }

        return decision
      },
    })

    return session
  }
}

if (tracing) {
  for (const [
    provider,
    adapter,
  ] of Object.entries(native.providers)) {
    const open = adapter.open

    adapter.open = async ({ ...options }) => {
      const actor = options.env.PNYX_ACTOR
      const attempt = ++openAttempt
      trace({
        kind: 'open-start',
        details: {
          attempt,
          provider,
          actor,
          nativeId: options.agent?.sessionId,
          caller: new Error().stack,
        },
      })
      let session

      try {
        session = await opening.run(
          attempt,
          () => open(options),
        )
        trace({
          kind: 'open-end',
          details: {
            attempt,
            nativeId: session.id,
            recovered: session.recovered,
          },
        })
      } catch (error) {
        trace({
          kind: 'open-failed',
          details: {
            attempt,
            error: String(error),
          },
        })
        throw error
      }

      return session
    }
  }
}

let heldCompletions = 0

if (process.env.PNYX_FIXTURE_HOLD_HELPER_COMPLETION === '1') {
  for (const adapter of Object.values(native.providers)) {
    const open = adapter.open

    adapter.open = async ({ ...options }) => {
      const session = await open(options)

      if (options.env.PNYX_ACTOR?.startsWith('helper:')) {
        session.applied = async () => {
          heldCompletions++
          await new Promise<void>(() => {})
        }
      }

      return session
    }
  }
}

const forbidden = () => {
  throw new Error('Fixture application cannot launch native providers')
}

const providers = process.env.PNYX_FIXTURE_LOCAL === '1'
  ? {
    'claude-code': fixtureProvider(),
    codex: fixtureProvider(),
  }
  : native.providers
const server = await startServer({
  port: 0,
  native: {
    ...native,
    providers,
  },
  query: forbidden,
  spawnCodex: forbidden,
  wakeDelay: 10,
})
process.send?.({
  type: 'ready',
  port: server.port,
})
process.on(
  'message',
  async message => {
    const request = message as {
      kind: string
      id: string
      nativeId?: string
      text?: string
    }

    if (request.kind === 'hold-decision') {
      holdDecisions = true
      process.send?.({
        id: request.id,
        ok: true,
      })

      return
    }

    if (request.kind === 'hold-answer') {
      holdAnswers = true
      process.send?.({
        id: request.id,
        ok: true,
      })

      return
    }

    if (request.kind === 'trace') {
      process.send?.({
        id: request.id,
        traces,
      })

      return
    }

    if (request.kind === 'connection') {
      process.send?.({
        id: request.id,
        available: native.client.available(),
        instance: native.client.ready.instance,
      })

      return
    }

    if (request.kind === 'metrics') {
      process.send?.({
        id: request.id,
        measurements,
        heldCompletions,
        heldDecisions,
        heldAnswers,

      })

      return
    }

    if (request.kind === 'stats') {
      process.send?.({
        id: request.id,
        states: [...states.values()].map(state => ({
          id: state.id,
          input: state.input,
          closed: state.closed,
          turn: state.turn,
        })),
      })

      return
    }

    if (request.kind === 'ask') {
      const state = states.get(request.nativeId!)!
      await state.permission!({
        id: 'native-ask',
        tool: 'Question',
        input: { prompt: 'Benchmark permission' },
        signal: new AbortController().signal,
      })
      state.emit?.({
        event: {
          type: 'answer-submitted',
          id: 'native-ask',
        },
      })
      process.send?.({
        id: request.id,
        ok: true,
      })

      return
    }

    if (request.kind === 'emit') {
      states.get(request.nativeId!)?.emit?.({
        event: {
          type: 'text',
          id: 'bench',
          text: request.text!,
        },
      })
      process.send?.({
        id: request.id,
        ok: true,
      })

      return
    }

    if (request.kind === 'stop') {
      await server.close()
      native.detach()
      process.disconnect()
    }
  },
)
