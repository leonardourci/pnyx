import { nativeProviders } from '#app/native-provider.ts'
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

  return call(request)
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

const server = await startServer({
  port: 0,
  native,
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
    if ((message as { kind: string }).kind === 'stop') {
      await server.close()
      native.detach()
      process.disconnect()
    }
  },
)
