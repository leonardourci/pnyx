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
