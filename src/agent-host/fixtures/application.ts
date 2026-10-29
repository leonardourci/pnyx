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
const call = native.client.call
const acknowledge = native.client.acknowledge
const completions = new Set<string>()

native.client.subscribe({
  receive: ({ frame }) => {
    if (frame.type === 'event' && typeof frame.event === 'object' && frame.event.type === 'turn-ended') {
      completions.add(`${frame.ref.id}:${frame.seq}`)
    }
  },
})

native.client.acknowledge = async ({ ...request }) => {
  const completion = completions.has(`${request.ref.id}:${request.through}`)

  if (process.env.PNYX_FIXTURE_HOLD_COMPLETION_ACKS === 'true' && completion) {
    await new Promise<void>(() => {})
  }

  return acknowledge(request)
}

native.client.call = async ({ ...request }) => {
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
  const result = await call(request)
  measurements.push({
    operation: request.operation.kind,
    ms: performance.now() - started,
  })

  return result
}

if (process.env.PNYX_TEST_VERBOSE === '1') {
  for (const [
    provider,
    adapter,
  ] of Object.entries(native.providers)) {
    const open = adapter.open

    adapter.open = async ({ ...options }) => {
      const actor = options.env.PNYX_ACTOR
      console.error(
        'fixture application open',
        process.pid,
        provider,
        actor,
        options.agent?.sessionId,
      )
      const session = await open(options)
      console.error(
        'fixture application bound',
        actor,
        session.id,
        session.remote,
        session.recovered,
      )
      const run = session.run

      session.run = ({ ...options }) => {
        const stream = run(options)

        return (async function* () {
          for await (const event of stream) {
            console.error(
              'fixture application event',
              actor,
              typeof event === 'string' ? event : event.type,
            )
            yield event
          }
        })()
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
  native: { providers },
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

    if (request.kind === 'metrics') {
      process.send?.({
        id: request.id,
        measurements,
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
