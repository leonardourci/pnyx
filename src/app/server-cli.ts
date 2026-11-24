import type { Writable } from 'node:stream'
import { SERVE_OPTIONS } from './server.ts'
import { parse } from './cli-support.ts'
import { DEFAULT_PORT } from './server-state.ts'
import { type RunningServer } from './server-transport.ts'
import { startServer } from './server-daemon.ts'
import { OTHRYS_ROOT } from '#upgrade/runner.ts'
import { TitanError } from '#store/errors.ts'
import { RESTART_SIGNAL } from '#upgrade/restart.ts'
import { stopOldHost } from '#workers/children.ts'

const MAX_PORT = 65535

export async function serve({
  args,
  stdout,
  json,
}: {
  args: string[]
  stdout: Writable
  json: boolean
}): Promise<Record<string, unknown>> {
  const { values } = parse({
    args,
    options: SERVE_OPTIONS,
    positionals: 0,
  })
  const hydraId = (values.hydra as string | undefined) ?? 'default'
  const portFlag = values.port as string | undefined
  const rawPort = portFlag ?? process.env.PORT
  const source = portFlag === undefined ? 'PORT' : '--port'

  if (rawPort !== undefined && (!/^\d+$/.test(rawPort) || Number(rawPort) > MAX_PORT)) {
    throw new TitanError({
      message: `${source} must be a port from 0 to ${MAX_PORT}`,
      code: 'VALIDATION_ERROR',
    })
  }

  const port = Number(rawPort ?? DEFAULT_PORT)
  let server: RunningServer

  try {
    await stopOldHost()
    server = await startServer({
      hydraId,
      port,
      upgradeRoot: OTHRYS_ROOT,
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new TitanError({
        message: `port ${port} is in use`,
        code: 'PORT_IN_USE',
        help: [`Stop what holds port ${port}, or pick another --port`],
      })
    }

    throw error
  }

  const skipped = Object.entries(server.skipped).map(([
    id,
    reason,
  ]) => `skipped: ${JSON.stringify(`Titan ${id}: ${reason}`)}\n`)
    .join('')
  stdout.write(json ? `${JSON.stringify({
    server: 'running',
    hydra: hydraId,
    url: server.url,
    skipped: server.skipped,
  })}\n`
    : `server: running\nhydra: ${hydraId}\nurl: ${JSON.stringify(server.url)}\n${skipped}`)
  const signal = await new Promise<NodeJS.Signals>(resolve => {
    for (const name of [
      'SIGINT',
      'SIGTERM',
      RESTART_SIGNAL,
    ] as const) {
      process.once(
        name,
        resolve,
      )
    }
  })

  await server.close()

  return { server: signal === RESTART_SIGNAL ? 'restarting' : 'stopped' }
}
