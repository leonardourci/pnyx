import { ChildProcess } from 'node:child_process'
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

let kept = false

// Every asynchronous spawn, execFile, exec and fork goes through ChildProcess.prototype.spawn, whose args
// start with argv0. Chrome reads switches anywhere before `--`, so appended flags win over earlier ones.
// spawnSync and shell command strings bypass it, so a test starts Chrome with spawn or execFile.
export function keepChromeOffKeychain() {
  if (kept) {
    return
  }

  kept = true
  const prototype = ChildProcess.prototype as unknown as { spawn: SpawnCall }
  const spawn = prototype.spawn

  // eslint-disable-next-line pnyx/object-params -- Node owns ChildProcess.prototype.spawn's signature.
  prototype.spawn = function (options) {
    if (CHROME_BINARY.test(basename(options.file))) {
      options.args = [
        ...options.args,
        ...KEYCHAIN_FLAGS,
      ]
    }

    return spawn.call(
      this,
      options,
    )
  }
}
