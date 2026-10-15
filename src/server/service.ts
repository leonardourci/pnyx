import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { BoardError } from '../core/model.ts'
import { boardDir, pnyxHome, privateDir } from '../store/board-store.ts'
import { DEFAULT_PORT } from './state.ts'

const xml = ({ text }: { text: string }) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;')

// A versioned path such as Homebrew's Cellar disappears on upgrade, so prefer a PATH entry that links to the same Node.
const stableNode = ({ node, searchPath }: { node: string; searchPath: string }) => {
  const real = realpathSync(node)

  return searchPath.split(delimiter).filter(dir => isAbsolute(dir))
    .map(dir => join(dir, 'node'))
    .find(candidate => {
      try {
        return realpathSync(candidate) === real
      } catch {
        return false
      }
    }) ?? node
}

export function setupService({ board, port = DEFAULT_PORT, homes = [], remove = false, preview = false, platform = process.platform, userHome = homedir(), node = process.execPath, searchPath = process.env.PATH ?? '/usr/bin:/bin', run = ({ args }) => execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }: {
  board: string
  port?: number
  homes?: string[]
  remove?: boolean
  preview?: boolean
  platform?: NodeJS.Platform
  userHome?: string
  node?: string
  searchPath?: string
  run?({ args }: { args: string[] }): string
}) {
  if (platform !== 'darwin') {
    throw new BoardError({ message: 'the login service requires macOS launchd', code: 'UNSUPPORTED_PLATFORM' })
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BoardError({ message: '--port must be 1 to 65535 for a login service', code: 'VALIDATION_ERROR' })
  }

  const home = pnyxHome()
  const key = createHash('sha256').update(`${home}/${board}`)
    .digest('hex')
    .slice(0, 16)
  const label = `local.pnyx.board.${key}`
  const path = join(userHome, 'Library', 'LaunchAgents', `${label}.plist`)
  const domain = `gui/${process.getuid!()}`
  const target = `${domain}/${label}`
  const log = join(boardDir({ board }), 'service.log')
  const cli = join(import.meta.dirname, '..', 'cli', import.meta.url.endsWith('.ts') ? 'pnyx-axi.ts' : 'pnyx-axi.js')
  const args = [stableNode({ node, searchPath }), cli, 'serve', '--board', board, '--port', String(port), ...homes.flatMap(h => ['--home', h])]
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml({ text: arg })}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict><key>PNYX_HOME</key><string>${xml({ text: home })}</string><key>PATH</key><string>${xml({ text: searchPath })}</string></dict>
<key>WorkingDirectory</key><string>${xml({ text: home })}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>${xml({ text: log })}</string>
<key>StandardErrorPath</key><string>${xml({ text: log })}</string>
</dict></plist>
`

  if (preview) {
    return { service: remove ? 'would remove' : 'would install', path, plist: remove ? undefined : plist }
  }

  let loaded = false

  try {
    run({ args: ['print', target] })
    loaded = true
  } catch { /* An uninstalled service has no launchd record. */ }

  if (loaded) {
    run({ args: ['bootout', target] })
  }

  if (remove) {
    rmSync(path, { force: true })

    return { service: 'removed', board, path }
  }

  if (!existsSync(cli)) {
    throw new BoardError({ message: 'build Pnyx before installing its login service', code: 'NOT_BUILT' })
  }

  privateDir({ dir: boardDir({ board }) })
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, plist, { mode: 0o600 })

  try {
    run({ args: ['bootstrap', domain, path] })
  } catch (error) {
    throw new BoardError({ message: `launchd could not start the board: ${(error as Error).message}`, code: 'SERVICE_ERROR', help: [`Read ${log}`, 'Stop a manually started server before installing the service'] })
  }

  return { service: 'installed', board, path, log, help: ['The board starts at login and restarts after exit', `Run \`pnyx-axi setup service --remove --board ${board}\` to stop and uninstall it`] }
}
