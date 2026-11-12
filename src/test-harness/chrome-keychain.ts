import childProcess, { ChildProcess } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'

// Tests point HOME at a temporary folder. A Chrome started there finds no login keychain, and macOS then
// asks the machine owner on screen to create one. These flags keep Chrome's password store off the Keychain.
export const KEYCHAIN_FLAGS = [
  '--use-mock-keychain',
  '--password-store=basic',
]
const CHROME_BINARY = /^(google[ -]chrome.*|chromium(-browser)?|chrome|chrome-headless-shell)$/i

// eslint-disable-next-line pnyx/object-params -- Node owns ChildProcess.prototype.spawn's signature.
type SpawnCall = (
  this: ChildProcess,
  options: {
    file: string
    args: string[]
  },
) => unknown

// eslint-disable-next-line pnyx/object-params -- Node owns spawnSync's and execFileSync's signatures.
type SyncLaunch = (
  file: string,
  args?: unknown,
  options?: unknown,
) => unknown

let guardInstalled = false

function isChrome({ file }: { file: string }) {
  return CHROME_BINARY.test(basename(file))
}

// Chrome reads every argument after `--` as a URL, so the flags go first.
function guardSync({ launch }: { launch: SyncLaunch }): SyncLaunch {
  // eslint-disable-next-line pnyx/object-params -- Node owns spawnSync's and execFileSync's signatures.
  return function (
    file,
    args,
    options,
  ) {
    if (!isChrome({ file })) {
      return launch(
        file,
        args,
        options,
      )
    }

    if (Array.isArray(args)) {
      return launch(
        file,
        [
          ...KEYCHAIN_FLAGS,
          ...args,
        ],
        options,
      )
    }

    // Without an argument list, the second argument is the options.
    return launch(
      file,
      [...KEYCHAIN_FLAGS],
      args ?? options,
    )
  }
}

// The guard covers Chrome started with spawn or execFile, which go through ChildProcess.prototype.spawn
// with args starting at argv0, and with spawnSync or execFileSync. It cannot see a Chrome started through
// a shell: exec, execSync or `shell: true` pass the command to /bin/sh, so those callers add KEYCHAIN_FLAGS.
export function keepChromeOffKeychain() {
  if (guardInstalled) {
    return
  }

  guardInstalled = true
  const prototype = ChildProcess.prototype as unknown as { spawn: SpawnCall }
  const spawn = prototype.spawn

  // eslint-disable-next-line pnyx/object-params -- Node owns ChildProcess.prototype.spawn's signature.
  prototype.spawn = function (options) {
    if (isChrome({ file: options.file })) {
      options.args = [
        options.args[0],
        ...KEYCHAIN_FLAGS,
        ...options.args.slice(1),
      ]
    }

    return spawn.call(
      this,
      options,
    )
  }

  const launches = childProcess as unknown as Record<'spawnSync' | 'execFileSync', SyncLaunch>
  launches.spawnSync = guardSync({ launch: launches.spawnSync })
  launches.execFileSync = guardSync({ launch: launches.execFileSync })
  syncBuiltinESMExports()
}
