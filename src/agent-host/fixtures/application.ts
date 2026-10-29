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
