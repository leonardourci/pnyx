import { randomUUID } from 'node:crypto'
import { AxiError } from 'axi-sdk-js'
import { checked } from './remote.ts'
import { drainNative, maintainNative, nativeClient } from '#setup/native-maintenance.ts'
import { PNYX_ROOT } from '#upgrade/runner.ts'
import { serverPids } from '#app/server.ts'
import { RESTART_SIGNAL } from '#upgrade/restart.ts'

export const NATIVE_HELP = `usage: pnyx-axi native status|drain|replace
status reads native readiness, pending work and unapplied critical facts.
drain freezes every new native input and open; answers, interrupts and replay remain available.
replace stages this build, drains, and replaces only a quiescent host with every critical fact applied. Rerun while draining to check again. A failed replacement restores the previous bundle. Successful replacement restarts the application to reconnect.
`

// eslint-disable-next-line pnyx/object-params -- runAxiCli owns this signature.
export async function native(args: string[]): Promise<Record<string, unknown>> {
  const [
    command,
    ...extra
  ] = args

  if (extra.length || ![
    'status',
    'drain',
    'replace',
  ].includes(command ?? '')) {
    throw new AxiError(
      'Expected native status, drain or replace',
      'VALIDATION_ERROR',
      ['Run `pnyx-axi native --help`'],
    )
  }

  const actor = process.env.PNYX_ACTOR ?? 'cli'

  if (command !== 'status' && actor !== 'cli' && actor !== 'owner') {
    throw new AxiError(
      'Only the owner can drain or replace the native host',
      'OWNER_ONLY',
    )
  }

  if (command === 'replace') {
    const result = await maintainNative({ source: PNYX_ROOT })

    if (result.state !== 'draining') {
      for (const pid of await serverPids()) {
        process.kill(
          pid,
          RESTART_SIGNAL,
        )
      }
    }

    return { native: result }
  }

  const client = await nativeClient()

  try {
    if (command === 'drain') {
      return { native: (await drainNative({ client })).status }
    }

    const result = checked({
      result: await client.call({
        id: randomUUID(),
        operation: { kind: 'status' },
      }),
    })

    if (result.kind !== 'maintenance') {
      throw new Error('Missing native status')
    }

    return {
      native: {
        instance: client.ready.instance,
        build: client.ready.build,
        ...result.status,
      },
    }
  } finally {
    client.detach()
  }
}
