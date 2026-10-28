import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { AxiError } from 'axi-sdk-js'
import { SERVE_OPTIONS, serverPids } from './server.ts'
import { flagError } from './cli-support.ts'
import { DEFAULT_PORT, infoPath, type ServerInfo } from './server-state.ts'
import { STOP_TIMEOUT_MS, type RunningServer } from './server-transport.ts'
import { startServer } from './server-daemon.ts'
import { PNYX_ROOT } from '../upgrade/runner.ts'
import { HydraError } from '../core/model.ts'
import { resolveHome } from '../integrations/firstmate/home.ts'
import { watchHomes } from '../integrations/firstmate/cli.ts'
import { RESTART_SIGNAL, relaunch } from '../upgrade/restart.ts'
import { hydraIds } from './home-migration.ts'

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
      options: SERVE_OPTIONS,
    })
  }
}

export async function serve(args: string[]): Promise<Record<string, unknown>> {
  const values = serveFlags({ args })
  const hydraId = values.hydra ?? 'default'

  // portless hands the app its port in PORT.
  const source = values.port === undefined && process.env.PORT !== undefined ? 'PORT' : '--port'
  values.port ??= process.env.PORT

  if (values.port !== undefined && !/^\d+$/.test(values.port)) {
    throw new AxiError(
      `${source} must be a number`,
      'VALIDATION_ERROR',
    )
  }

  const port = Number(values.port ?? DEFAULT_PORT)
  let server: RunningServer

  try {
    server = await startServer({
      hydraId,
      port,
      homes: values.home,
      upgradeRoot: PNYX_ROOT,
    })
  } catch (error) {
    if (error instanceof HydraError) {
      throw new AxiError(
        error.message,
        error.code,
        error.help,
      )
    }

    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new AxiError(
        `port ${port} is in use`,
        'PORT_IN_USE',
        [`Stop what holds port ${port}, or pick another --port`],
      )
    }

    throw error
  }

  // Homes given here are watched for this Hydra; a Hydra's recorded home is watched by the server itself.
  const homes = (values.home ?? []).map(path => resolveHome({ path }))
  const firstmate = homes.length > 0 ? watchHomes({
    hydraId,
    list: homes,
  }) : undefined
  const watching = homes.length > 0 ? `firstmate: ${JSON.stringify(`watching ${homes.length} home${homes.length === 1 ? '' : 's'}`)}\n` : ''
  const skipped = Object.entries(server.skipped).map(([
    id,
    reason,
  ]) => `skipped: ${JSON.stringify(`Hydra ${id}: ${reason}`)}\n`)
    .join('')
  process.stdout.write(`server: running\nhydra: ${hydraId}\nurl: ${JSON.stringify(server.url)}\n${watching}${skipped}help[1]: Run \`pnyx-axi stop\` to stop it\n`)
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
  const watched = firstmate?.close()
  await server.close()

  if (signal === RESTART_SIGNAL) {
    relaunch()
  }

  return {
    server: signal === RESTART_SIGNAL ? 'restarting' : 'stopped',
    ...(watched ? { firstmate: watched } : {}),
  }
}

export async function stop(args: string[]): Promise<Record<string, unknown>> {
  if (args.length > 0) {
    throw new AxiError(
      `unexpected argument: ${args[0]}`,
      'VALIDATION_ERROR',
      ['Run `pnyx-axi stop`; it stops the one server of every Hydra'],
    )
  }

  const pids = await serverPids()

  if (pids.length === 0) {
    return {
      server: 'none: not running',
      help: ['Run `pnyx-axi serve` to start it'],
    }
  }

  for (const pid of pids) {
    process.kill(
      pid,
      'SIGTERM',
    )
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS

  // Files and pids, not /health, so a stopping server too busy to answer cannot outlast the deadline.
  const recorded = () => new Set(hydraIds().flatMap(hydraId => {
    try {
      const { pid } = JSON.parse(readFileSync(
        infoPath({ hydraId }),
        'utf8',
      )) as ServerInfo
      process.kill(
        pid,
        0,
      )

      return [pid]
    } catch {
      return []
    }
  }))

  for (let left = pids; left.length > 0; left = left.filter(pid => recorded().has(pid))) {
    if (Date.now() > deadline) {
      throw new AxiError(
        `server pid ${left.join(', ')} did not stop`,
        'TIMEOUT',
        [`Check process ${left.join(', ')}`],
      )
    }

    await new Promise(r => setTimeout(
      r,
      25,
    ))
  }

  return { server: 'stopped' }
}
