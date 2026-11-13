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

function shellLaunch({ options }: { options: unknown }) {
  return typeof options === 'object' && options !== null && 'shell' in options && Boolean(options.shell)
}

function isChrome({ file }: { file: string }) {
  return CHROME_BINARY.test(basename(file))
}

// Chrome reads every argument after `--` as a URL, so the flags go first. With `shell` set, `file` is the whole
// command line and Node appends args to its end, so a shell launch is left as it came.
function guardSync({ launch }: { launch: SyncLaunch }): SyncLaunch {
  // eslint-disable-next-line pnyx/object-params -- Node owns spawnSync's and execFileSync's signatures.
  return function (
    file,
    args,
    options,
  ) {
    const argsGiven = Array.isArray(args)
    const chromeArgs = argsGiven ? args : []
    const optionsSecond = !argsGiven && args !== undefined && args !== null
    const resolvedOptions = optionsSecond ? args : options

    if (!isChrome({ file }) || shellLaunch({ options: resolvedOptions })) {
      return launch(
        file,
        args,
        options,
      )
    }

    return launch(
      file,
      [
        ...KEYCHAIN_FLAGS,
        ...chromeArgs,
      ],
      resolvedOptions,
    )
  }
}

// The guard covers Chrome started with spawn or execFile, which go through ChildProcess.prototype.spawn
// with args starting at argv0, and with spawnSync or execFileSync. It leaves a Chrome started through a
// shell untouched: exec, execSync and `shell: true` hand the command line to /bin/sh, so those callers add
// KEYCHAIN_FLAGS.
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
