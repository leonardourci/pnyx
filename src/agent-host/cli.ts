import { randomUUID } from 'node:crypto'
import { AxiError } from 'axi-sdk-js'
import { checked } from './remote.ts'
import { stopNative, nativeClient } from '#setup/native-maintenance.ts'

export const NATIVE_HELP = `usage: pnyx-axi native status|stop
status reads native readiness, pending work and unapplied outcomes.
stop ends an idle host only after queued input, permissions, controls, background work and unapplied outcomes are clear. Busy or uncertain ownership defers the stop. Host updates are manual and separate from app upgrades.
`

// eslint-disable-next-line pnyx/object-params -- runAxiCli owns this signature.
export async function native(args: string[]): Promise<Record<string, unknown>> {
  const [
    command,
    ...extra
  ] = args

  if (extra.length || ![
    'status',
    'stop',
  ].includes(command ?? '')) {
    throw new AxiError(
      'Expected native status or stop',
      'VALIDATION_ERROR',
      ['Run `pnyx-axi native --help`'],
    )
  }

  const actor = process.env.PNYX_ACTOR ?? 'cli'

  if (command !== 'status' && actor !== 'cli' && actor !== 'owner') {
    throw new AxiError(
      'Only the owner can stop the native host',
      'OWNER_ONLY',
    )
  }

  const client = await nativeClient()

  try {
    if (command === 'stop') {
      return { native: await stopNative({ client }) }
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
