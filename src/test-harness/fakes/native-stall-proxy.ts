import { createConnection, createServer, type Socket } from 'node:net'
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'

const [
  socket,
  upstream,
  ownerPath,
  mode,
] = process.argv.slice(2)
const owner = JSON.parse(readFileSync(
  ownerPath!,
  'utf8',
)) as { pid: number }
const peers = new Set<Socket>()
const server = createServer(client => {
  const host = createConnection(upstream!)
  peers.add(client)
  peers.add(host)
  host.pipe(client)
  let buffered = ''
  client.on(
    'data',
    chunk => {
      buffered += chunk.toString()
      let newline = buffered.indexOf('\n')

      while (newline >= 0) {
        const line = buffered.slice(
          0,
          newline,
        )
        buffered = buffered.slice(newline + 1)
        const frame = JSON.parse(line)
        const operation = frame.type === 'call' ? frame.operation : undefined
        const stalled = mode === 'claim' ? operation?.kind === 'attach' && operation.scope?.kind === 'host'
          : operation?.kind === 'status'

        if (!stalled) {
          host.write(`${line}\n`)
        }

        newline = buffered.indexOf('\n')
      }
    },
  )
  client.on(
    'error',
    () => host.destroy(),
  )
  host.on(
    'error',
    () => client.destroy(),
  )
  client.on(
    'close',
    () => {
      peers.delete(client); host.destroy()
    },
  )
  host.on(
    'close',
    () => {
      peers.delete(host); client.destroy()
    },
  )
})
server.listen(
  socket!,
  () => process.send?.({ type: 'ready' }),
)
let inode: number | undefined
server.on(
  'listening',
  () => {
    inode = lstatSync(socket!).ino
  },
)

const cleanup = () => {
  for (const peer of peers) {
    peer.destroy()
  }

  server.close()

  if (existsSync(socket!) && lstatSync(socket!).ino === inode) {
    rmSync(socket!)
  }

  process.exit()
}

setInterval(
  () => {
    try {
      process.kill(
        owner.pid,
        0,
      )
    } catch {
      cleanup()
    }
  },
  100,
).unref()
process.on(
  'SIGTERM',
  cleanup,
)
process.on(
  'disconnect',
  cleanup,
)
