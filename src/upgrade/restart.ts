import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { join } from 'node:path'
import { serviceFile } from '../server/service.ts'
import { pnyxHome } from '../store/hydra-store.ts'

// Sent to a running `pnyx-axi serve` to close it and start it again on the code now on disk.
export const RESTART_SIGNAL = 'SIGUSR2'

// The login service starts the server again by itself; a server started by hand starts its replacement.
// Only launchd's job is recognized: a supervisor on Linux would see two servers race for the port.
export function relaunch() {
  if (process.env.XPC_SERVICE_NAME === serviceFile().label) {
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
