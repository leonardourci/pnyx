import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { HydraError } from '../core/model.ts'
import { pnyxHome } from '../store/hydra-store.ts'
import { DEFAULT_PORT } from './state.ts'

const xml = ({ text }: { text: string }) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;')

const resolve = ({ path }: { path: string }) => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

// A versioned path such as Homebrew's Cellar disappears on upgrade, so prefer a PATH entry that links to the same Node.
const stableNode = ({ node, searchPath }: { node: string; searchPath: string }) => {
  const real = resolve({ path: node })

  return (real && searchPath.split(delimiter).filter(dir => isAbsolute(dir))
    .map(dir => join(dir, 'node'))
    .find(candidate => resolve({ path: candidate }) === real)) || node
}

// One login service runs the one server of every Hydra in this Pnyx home.
export function setupService({ port = DEFAULT_PORT, remove = false, preview = false, platform = process.platform, userHome = homedir(), node = process.execPath, searchPath = process.env.PATH ?? '/usr/bin:/bin', run = ({ args }) => execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), sleep = ({ ms }) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }: {
  port?: number
  remove?: boolean
  preview?: boolean
  platform?: NodeJS.Platform
  userHome?: string
  node?: string
  searchPath?: string
  run?({ args }: { args: string[] }): string
  sleep?({ ms }: { ms: number }): unknown
}) {
  if (platform !== 'darwin') {
    throw new HydraError({ message: 'the login service requires macOS launchd', code: 'UNSUPPORTED_PLATFORM' })
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HydraError({ message: '--port must be 1 to 65535 for a login service', code: 'VALIDATION_ERROR' })
  }

  const home = pnyxHome()
  const key = createHash('sha256').update(home)
    .digest('hex')
    .slice(0, 16)
  const label = `local.pnyx.server.${key}`
  const agents = join(userHome, 'Library', 'LaunchAgents')
  const path = join(agents, `${label}.plist`)
  const domain = `gui/${process.getuid!()}`
  const log = join(home, 'service.log')
  const cli = join(import.meta.dirname, '..', 'cli', import.meta.url.endsWith('.ts') ? 'pnyx-axi.ts' : 'pnyx-axi.js')
  const args = [stableNode({ node, searchPath }), cli, 'serve', '--port', String(port)]
  const homeEntry = `<key>PNYX_HOME</key><string>${xml({ text: home })}</string>`
  // Services from before one server ran every Hydra each ran one Hydra of this home; they are replaced.
  const replaced = (() => {
    try {
      return readdirSync(agents).filter(name => /^local\.pnyx\.board\.[0-9a-f]{16}\.plist$/.test(name)
        && readFileSync(join(agents, name), 'utf8').includes(homeEntry))
        .map(name => join(agents, name))
    } catch {
      return []
    }
  })()
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml({ text: arg })}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict>${homeEntry}<key>PATH</key><string>${xml({ text: searchPath })}</string></dict>
<key>WorkingDirectory</key><string>${xml({ text: home })}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>${xml({ text: log })}</string>
<key>StandardErrorPath</key><string>${xml({ text: log })}</string>
</dict></plist>
`

  if (preview) {
    return { service: remove ? 'would remove' : 'would install', path, plist: remove ? undefined : plist, replaces: replaced }
  }

  const stopJob = ({ label }: { label: string }) => {
    const target = `${domain}/${label}`

    const listed = () => {
      try {
        run({ args: ['print', target] })

        return true
      } catch {
        return false
      }
    }

    if (listed()) {
      try {
        run({ args: ['bootout', target] })
      } catch {
        // A concurrent setup may have booted it out already; the listing below decides.
      }

      // launchd finishes a bootout asynchronously, and bootstrapping the same label before it is gone fails with an I/O error.
      for (let attempt = 0; listed(); attempt++) {
        if (attempt === 50) {
          throw new HydraError({ message: `launchd did not stop the running service ${label}`, code: 'SERVICE_ERROR', help: [`Run \`launchctl print ${target}\` to inspect it`, 'Rerun setup once it has stopped'] })
        }

        sleep({ ms: 100 })
      }
    }
  }

  for (const old of replaced) {
    stopJob({ label: basename(old, '.plist') })
    rmSync(old, { force: true })
  }

  stopJob({ label })

  if (remove) {
    rmSync(path, { force: true })

    return { service: 'removed', path, replaced }
  }

  if (!existsSync(cli)) {
    throw new HydraError({ message: 'build Pnyx before installing its login service', code: 'NOT_BUILT' })
  }

  mkdirSync(home, { recursive: true })
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, plist, { mode: 0o600 })

  try {
    run({ args: ['bootstrap', domain, path] })
  } catch {
    sleep({ ms: 1000 })

    try {
      run({ args: ['bootstrap', domain, path] })
    } catch (error) {
      throw new HydraError({ message: `launchd could not start the Pnyx server: ${(error as Error).message}`, code: 'SERVICE_ERROR', help: [`Read ${log}`, 'Stop a manually started server before installing the service'] })
    }
  }

  return { service: 'installed', path, log, replaced, help: ['The server of every Hydra starts at login and restarts after exit', 'Run `pnyx-axi setup service --remove` to stop and uninstall it'] }
}
