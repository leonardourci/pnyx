import type { Writable } from 'node:stream'
import { parseArgs } from 'node:util'
import { SERVE_OPTIONS } from './server.ts'
import { flagError } from './cli-support.ts'
import { DEFAULT_PORT } from './server-state.ts'
import { type RunningServer } from './server-transport.ts'
import { startServer } from './server-daemon.ts'
import { PNYX_ROOT } from '#upgrade/runner.ts'
import { HydraError } from '#store/errors.ts'
import { RESTART_SIGNAL } from '#upgrade/restart.ts'
import { stopOldHost } from '#workers/children.ts'

function serveFlags({ args }: { args: string[] }) {
  try {
    return parseArgs({
      args,
      options: SERVE_OPTIONS,
      strict: true,
    }).values
  } catch (error) {
    throw flagError({
      error,
    })
  }
}

export async function serve({
  args,
  stdout,
  json,
}: {
  args: string[]
  stdout: Writable
  json: boolean
}): Promise<Record<string, unknown>> {
  const values = serveFlags({ args })
  const hydraId = values.hydra ?? 'default'

  // portless hands the app its port in PORT.
  const source = values.port === undefined && process.env.PORT !== undefined ? 'PORT' : '--port'
  values.port ??= process.env.PORT

  if (values.port !== undefined && !/^\d+$/.test(values.port)) {
    throw new HydraError({
      message: `${source} must be a number`,
      code: 'VALIDATION_ERROR',
    })
  }

  const port = Number(values.port ?? DEFAULT_PORT)
  let server: RunningServer

  try {
    await stopOldHost()
    server = await startServer({
      hydraId,
      port,
      upgradeRoot: PNYX_ROOT,
      zeroCache: true,
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new HydraError({
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
  ]) => `skipped: ${JSON.stringify(`Hydra ${id}: ${reason}`)}\n`)
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
