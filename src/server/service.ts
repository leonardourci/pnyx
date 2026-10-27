import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { HydraError } from '../core/model.ts'
import { loadHydra } from '../app/store.ts'
import { pnyxHome, privateDir } from '../store/hydra-store.ts'
import { canonical } from '../store/paths.ts'
import { DEFAULT_PORT } from '../app/server-state.ts'

const xml = ({ text }: { text: string }) => text.replaceAll(
  '&',
  '&amp;',
).replaceAll(
  '<',
  '&lt;',
)
  .replaceAll(
    '>',
    '&gt;',
  )
  .replaceAll(
    '"',
    '&quot;',
  )
  .replaceAll(
    "'",
    '&apos;',
  )

const unxml = ({ text }: { text: string }) => text.replaceAll(
  '&lt;',
  '<',
).replaceAll(
  '&gt;',
  '>',
)
  .replaceAll(
    '&quot;',
    '"',
  )
  .replaceAll(
    '&apos;',
    "'",
  )
  .replaceAll(
    '&amp;',
    '&',
  )

const resolve = ({ path }: { path: string }) => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

// A versioned path such as Homebrew's Cellar disappears on upgrade, so prefer a PATH entry that links to the same Node.
const stableNode = ({
  node,
  searchPath,
}: {
  node: string
  searchPath: string
}) => {
  const real = resolve({ path: node })

  return (real && searchPath.split(delimiter).filter(dir => isAbsolute(dir))
    .map(dir => join(
      dir,
      'node',
    ))
    .find(candidate => resolve({ path: candidate }) === real)) || node
}

// The launchd job of this Pnyx home's login service, named after the home so other homes keep their own.
export function serviceFile({ userHome = homedir() }: { userHome?: string } = {}) {
  const label = `local.pnyx.server.${createHash('sha256').update(pnyxHome())
    .digest('hex')
    .slice(
      0,
      16,
    )}`

  return {
    label,
    path: join(
      userHome,
      'Library',
      'LaunchAgents',
      `${label}.plist`,
    ),
  }
}

function requireAvailableServicePort({
  agents,
  home,
  port,
}: {
  agents: string
  home: string
  port: number
}) {
  if (!existsSync(agents)) {
    return
  }

  for (const name of readdirSync(agents).filter(name => /^local\.pnyx\.(server|board)\.[0-9a-f]{16}\.plist$/.test(name))) {
    const text = readFileSync(
      join(
        agents,
        name,
      ),
      'utf8',
    )
    const storedHome = /<key>PNYX_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1]
    const otherHome = storedHome === undefined ? join(
      homedir(),
      '.pnyx',
    ) : unxml({ text: storedHome })

    if (canonical({ path: otherHome }) === canonical({ path: home })) {
      continue
    }

    const argumentsXml = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? ''
    const args = [...argumentsXml.matchAll(/<string>([^<]*)<\/string>/g)].map(match => unxml({ text: match[1]! }))
    const portIndex = args.indexOf('--port')
    const portValue = portIndex < 0 ? args.find(arg => arg.startsWith('--port='))?.slice('--port='.length) : args[portIndex + 1]
    const otherPort = portValue === undefined ? DEFAULT_PORT : Number(portValue)

    if (port === otherPort) {
      throw new HydraError({
        message: `port ${port} is reserved by another Pnyx home's service: ${otherHome} (${name})`,
        code: 'PORT_IN_USE',
        help: ['Choose a different --port; --allow-custom-home does not override a service port conflict'],
      })
    }
  }
}

// One login service runs the one server of every Hydra in this Pnyx home.
export function setupService({
  port = DEFAULT_PORT,
  remove = false,
  preview = false,
  platform = process.platform,
  userHome = homedir(),
  node = process.execPath,
  searchPath = process.env.PATH ?? '/usr/bin:/bin',
  run = ({ args }) => execFileSync(
    'launchctl',
    args,
    {
      encoding: 'utf8',
      stdio: [
        'ignore',
        'pipe',
        'pipe',
      ],
    },
  ),
  sleep = ({ ms }) => Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    ms,
  ),
}: {
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
    throw new HydraError({
      message: 'the login service requires macOS launchd',
      code: 'UNSUPPORTED_PLATFORM',
    })
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HydraError({
      message: '--port must be 1 to 65535 for a login service',
      code: 'VALIDATION_ERROR',
    })
  }

  const home = pnyxHome()
  const {
    label,
    path,
  } = serviceFile({ userHome })
  const agents = dirname(path)

  if (!remove) {
    requireAvailableServicePort({
      agents,
      home,
      port,
    })
  }

  const domain = `gui/${process.getuid!()}`
  const log = join(
    home,
    'service.log',
  )
  const cli = join(
    import.meta.dirname,
    '..',
    'cli',
    import.meta.url.endsWith('.ts') ? 'pnyx-axi.ts' : 'pnyx-axi.js',
  )
  const args = [
    stableNode({
      node,
      searchPath,
    }),
    cli,
    'serve',
    '--port',
    String(port),
  ]
  const homeEntry = `<key>PNYX_HOME</key><string>${xml({ text: home })}</string>`
  // Services from before one server ran every Hydra each ran one Hydra of this home; they are replaced.
  const replaced = (() => {
    try {
      return readdirSync(agents).filter(name => /^local\.pnyx\.board\.[0-9a-f]{16}\.plist$/.test(name)
        && readFileSync(
          join(
            agents,
            name,
          ),
          'utf8',
        ).includes(homeEntry))
        .map(name => join(
          agents,
          name,
        ))
    } catch {
      return []
    }
  })()
  // A replaced job's --home reached its Hydra only through that job; the server now watches only recorded homes.
  const unrecorded = replaced.flatMap(file => {
    const text = readFileSync(
      file,
      'utf8',
    )
    const flag = ({ name }: { name: string }) => [
      ...text.matchAll(new RegExp(
        `<string>--${name}</string><string>([^<]*)</string>`,
        'g',
      )),
    ].map(m => unxml({ text: m[1]! }))
    const hydraId = flag({ name: 'hydra' })[0] ?? 'default'
    let recorded: string | undefined

    try {
      const hydra = loadHydra({ hydraId }).state.config?.hydra
      recorded = hydra?.kind === 'firstmate' ? canonical({ path: hydra.home }) : undefined
    } catch { /* An unreadable Hydra records nothing. */ }

    return flag({ name: 'home' }).filter(h => canonical({ path: h }) !== recorded)
      .map(h => ({
        hydra: hydraId,
        home: h,
      }))
  })
  const relink = unrecorded.map(({
    hydra,
    home: h,
  }) => `Run \`pnyx-axi setup hydra --home ${h} --hydra ${hydra}\` so the server watches that Firstmate home again`)
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
    return {
      service: remove ? 'would remove' : 'would install',
      path,
      plist: remove ? undefined : plist,
      replaces: replaced,
      unrecorded,
      help: relink,
    }
  }

  if (!remove && !existsSync(cli)) {
    throw new HydraError({
      message: 'build Pnyx before installing its login service',
      code: 'NOT_BUILT',
    })
  }

  const stopJob = ({ label }: { label: string }) => {
    const target = `${domain}/${label}`

    const listed = () => {
      try {
        run({
          args: [
            'print',
            target,
          ],
        })

        return true
      } catch {
        return false
      }
    }

    if (listed()) {
      try {
        run({
          args: [
            'bootout',
            target,
          ],
        })
      } catch {
        // A concurrent setup may have booted it out already; the listing below decides.
      }

      // launchd finishes a bootout asynchronously, and bootstrapping the same label before it is gone fails with an I/O error.
      for (let attempt = 0; listed(); attempt++) {
        if (attempt === 50) {
          throw new HydraError({
            message: `launchd did not stop the running service ${label}`,
            code: 'SERVICE_ERROR',
            help: [
              `Run \`launchctl print ${target}\` to inspect it`,
              'Rerun setup once it has stopped',
            ],
          })
        }

        sleep({ ms: 100 })
      }
    }
  }

  for (const old of replaced) {
    stopJob({
      label: basename(
        old,
        '.plist',
      ),
    })
    rmSync(
      old,
      { force: true },
    )
  }

  stopJob({ label })

  if (remove) {
    rmSync(
      path,
      { force: true },
    )

    return {
      service: 'removed',
      path,
      replaced,
      unrecorded,
      help: relink,
    }
  }

  privateDir({ dir: home })
  mkdirSync(
    dirname(path),
    { recursive: true },
  )
  writeFileSync(
    path,
    plist,
    { mode: 0o600 },
  )

  try {
    run({
      args: [
        'bootstrap',
        domain,
        path,
      ],
    })
  } catch {
    sleep({ ms: 1000 })

    try {
      run({
        args: [
          'bootstrap',
          domain,
          path,
        ],
      })
    } catch (error) {
      throw new HydraError({
        message: `launchd could not start the Pnyx server: ${(error as Error).message}`,
        code: 'SERVICE_ERROR',
        help: [
          `Read ${log}`,
          'Stop a manually started server before installing the service',
        ],
      })
    }
  }

  return {
    service: 'installed',
    path,
    log,
    replaced,
    unrecorded,
    help: [
      ...relink,
      'The server of every Hydra starts at login and restarts after exit',
      'Run `pnyx-axi setup service --remove` to stop and uninstall it',
    ],
  }
}
