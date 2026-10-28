import { createServer as createSocketServer, type Server as SocketServer } from 'node:net'
import { rmSync, chmodSync } from 'node:fs'
import { socketPath } from '../../app/server-state.ts'
import { MAX_BODY } from '../../app/server-transport.ts'

// Hook events, one JSON object per line. Null when the socket cannot be bound
// (a path too long for a Unix socket, say); hooks then spool and the watcher drains it.
export async function listenIngest(
  {
    hydraId,
    onLine,
  }: {
    hydraId: string
    onLine: ({ line }: { line: string }) => void
  },
): Promise<SocketServer | null> {
  const path = socketPath({ hydraId })
  // Left by a server that did not stop cleanly; startServer already checked none is running.
  rmSync(
    path,
    { force: true },
  )
  const server = createSocketServer(conn => {
    let buffered = ''
    conn.setEncoding('utf8')
    conn.on(
      'data',
      (chunk: string) => {
        buffered += chunk

        if (buffered.length > MAX_BODY) {
          return conn.destroy()
        }

        for (let i = buffered.indexOf('\n'); i >= 0; i = buffered.indexOf('\n')) {
          onLine({
            line: buffered.slice(
              0,
              i,
            ),
          })
          buffered = buffered.slice(i + 1)
        }
      },
    )
    conn.on(
      'end',
      () => {
        if (buffered.trim()) {
          onLine({ line: buffered })
        }

        conn.end()
      },
    )
    conn.on(
      'error',
      () => {},
    )
  })

  try {
    await new Promise<void>((
      resolve,
      reject,
    ) => {
      server.once(
        'error',
        reject,
      )
      server.listen(
        path,
        () => resolve(),
      )
    })
  } catch {
    return null
  }

  chmodSync(
    path,
    0o600,
  )

  return server
}
