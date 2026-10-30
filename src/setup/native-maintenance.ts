import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { connectHost, type HostClient } from '#agent-host/client.ts'
import { checked } from '#agent-host/remote.ts'
import { nativePaths } from './native-host.ts'

export async function nativeClient() {
  const paths = nativePaths()

  return connectHost({
    socket: join(
      paths.directory,
      'host.sock',
    ),
    token: readFileSync(
      join(
        paths.directory,
        'token',
      ),
      'utf8',
    ),
    installation: paths.installation,
    capabilities: ['idle-stop'],
  })
}

export async function stopNative({ client }: { client: HostClient }) {
  const attached = checked({
    result: await client.call({
      id: randomUUID(),
      operation: {
        kind: 'attach',
        scope: { kind: 'host' },
        expectedRevision: client.ready.hostControllerRevision,
      },
    }),
  })

  if (attached.kind !== 'attached') {
    throw new Error('Missing native host controller')
  }

  return checked({
    result: await client.call({
      id: randomUUID(),
      operation: {
        kind: 'shutdown',
        controller: attached.control.generation,
        when: 'quiescent',
      },
    }),
  })
}
