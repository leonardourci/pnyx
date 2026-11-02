import { AxiError } from 'axi-sdk-js'
import { serverPids } from '#app/server.ts'
import { nativePaths } from '#setup/native-host.ts'
import { selectBundle } from '#agent-host/install.ts'
import { PNYX_ROOT } from './runner.ts'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serviceFile } from '#setup/service.ts'
import { pnyxHome } from '#store/storage.ts'

// Sent to a running `pnyx-axi serve` to close it and start it again on the code now on disk.
export const RESTART_SIGNAL = 'SIGUSR2'

// The login service starts the server again by itself; a server started by hand starts its replacement.
// Only launchd's job is recognized: a supervisor on Linux would see two servers race for the port.
export function relaunch() {
  if (process.env.PNYX_SERVICE_ROLE === 'application' || process.env.XPC_SERVICE_NAME === serviceFile().label) {
    return
  }

  const log = openSync(
    join(
      pnyxHome(),
      'service.log',
    ),
    'a',
  )
  spawn(
    process.execPath,
    [
      ...process.execArgv,
      ...process.argv.slice(1),
    ],
    {
      detached: true,
      stdio: [
        'ignore',
        log,
        log,
      ],
    },
  ).unref()
}

export function prepareNativeRestart() {
  const paths = nativePaths()

  if (!existsSync(paths.selected)) {
    return
  }

  const selected = JSON.parse(readFileSync(
    paths.selected,
    'utf8',
  )) as { bundle: string }
  const ledgerPath = join(
    paths.directory,
    'ledger.json',
  )
  let restartInstance: string | undefined

  if (existsSync(ledgerPath)) {
    try {
      const ledger = JSON.parse(readFileSync(
        ledgerPath,
        'utf8',
      )) as { instance?: unknown }

      if (typeof ledger.instance === 'string') {
        restartInstance = ledger.instance
      }
    } catch (error) {
      console.error(
        'Native host restart identity unavailable:',
        error,
      )
    }
  }

  selectBundle({
    path: paths.selected,
    bundle: selected.bundle,
    restartInstance,
  })
}

export async function restartPnyx() {
  const pids = await serverPids()

  for (const pid of pids) {
    process.kill(
      pid,
      RESTART_SIGNAL,
    )
  }

  if (pids.length) {
    return {
      server: 'restarting',
      native: 'restarts when idle and outcomes are applied',
    }
  }

  prepareNativeRestart()
  const log = openSync(
    join(
      pnyxHome(),
      'service.log',
    ),
    'a',
    0o600,
  )

  try {
    const child = spawn(
      process.execPath,
      [
        join(
          PNYX_ROOT,
          'dist/cli/pnyx-axi.js',
        ),
        'serve',
      ],
      {
        detached: true,
        stdio: [
          'ignore',
          log,
          log,
        ],
      },
    )
    child.on(
      'error',
      error => process.stderr.write(`Pnyx start failed: ${error.message}\n`),
    )
    child.unref()
  } finally {
    closeSync(log)
  }

  return {
    server: 'starting',
    help: ['Read service.log in PNYX_HOME if startup fails'],
  }
}

export const RESTART_HELP = `usage: pnyx-axi restart
Restart the application on its current code, or start it if stopped. A responsive native host switches bundles once live turns, background work and pending outcomes settle.
A host that fails its handshake is stopped only when its process identity is verified. Its sessions then recover as after a crash; an unverified owner remains pending.
No upgrade, model call or agent instruction is involved. /restart in Hydra's composer does the same.
`

// eslint-disable-next-line pnyx/object-params -- runAxiCli owns the command signature.
export async function restart(args: string[]): Promise<Record<string, unknown>> {
  if (args.length) {
    throw new AxiError(
      'restart takes no arguments',
      'VALIDATION_ERROR',
      ['Run `pnyx-axi restart`'],
    )
  }

  const actor = process.env.PNYX_ACTOR ?? 'cli'

  if (actor !== 'cli' && actor !== 'owner') {
    throw new AxiError(
      'Only the owner can restart Pnyx',
      'OWNER_ONLY',
    )
  }

  return restartPnyx()
}
