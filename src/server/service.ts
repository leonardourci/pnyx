import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { HydraError } from '../core/model.ts'
import { loadHydra, pnyxHome, privateDir } from '../store/hydra-store.ts'
import { canonical } from '../store/paths.ts'
import { DEFAULT_PORT } from './state.ts'

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

// The launchd job or systemd unit of this Pnyx home's login service, named after the home so other homes keep their own.
export function serviceFile({
  userHome = homedir(),
  platform = process.platform,
  configHome = process.env.XDG_CONFIG_HOME,
}: {
  userHome?: string
  platform?: NodeJS.Platform
  configHome?: string
} = {}) {
  const label = `local.pnyx.server.${createHash('sha256').update(pnyxHome())
    .digest('hex')
    .slice(
      0,
      16,
    )}`

  if (platform === 'linux') {
    return {
      label,
      path: join(
        configHome && isAbsolute(configHome) ? configHome : join(
          userHome,
          '.config',
        ),
        'systemd',
        'user',
        `${label}.service`,
      ),
    }
  }

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

const SYSTEMD_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '"': '\\"',
  '%': '%%',
  $: '$$',
}

// ExecStart expands $VARIABLE and every setting expands %specifiers, so both are doubled.
const systemdQuote = ({
  text,
  command = false,
}: {
  text: string
  command?: boolean
}) => `"${text.replace(
  command ? /[\\"%$]/g : /[\\"%]/g,
  character => SYSTEMD_ESCAPES[character]!,
)}"`

const systemdLiteral = ({ text }: { text: string }) => text.replaceAll(
  '%',
  '%%',
)

const systemdWords = ({
  text,
  command = false,
}: {
  text: string
  command?: boolean
}) => [...text.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map(match => match[1] === undefined ? match[2]! : match[1].replace(
  command ? /\\(.)|%%|\$\$/g : /\\(.)|%%/g,
  (
    escape,
    escaped: string | undefined,
  ) => escaped ?? escape[0]!,
))

const systemdSetting = ({
  text,
  key,
  command = false,
}: {
  text: string
  key: string
  command?: boolean
}) => [
  ...text.matchAll(new RegExp(
    `^${key}=(.*)$`,
    'gm',
  )),
].flatMap(match => systemdWords({
  text: match[1]!,
  command,
}))

const SERVICE_DEFINITIONS = {
  launchd: {
    pattern: /^local\.pnyx\.(server|board)\.[0-9a-f]{16}\.plist$/,
    read: ({ text }: { text: string }) => {
      const storedHome = /<key>PNYX_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1]
      const argumentsXml = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? ''

      return {
        storedHome: storedHome === undefined ? undefined : unxml({ text: storedHome }),
        args: [...argumentsXml.matchAll(/<string>([^<]*)<\/string>/g)].map(match => unxml({ text: match[1]! })),
      }
    },
  },
  systemd: {
    pattern: /^local\.pnyx\.server\.[0-9a-f]{16}\.service$/,
    read: ({ text }: { text: string }) => ({
      storedHome: systemdSetting({
        text,
        key: 'Environment',
      }).find(variable => variable.startsWith('PNYX_HOME='))
        ?.slice('PNYX_HOME='.length),
      args: systemdSetting({
        text,
        key: 'ExecStart',
        command: true,
      }),
    }),
  },
}

function requireAvailableServicePort({
  agents,
  home,
  port,
  definition,
}: {
  agents: string
  home: string
  port: number
  definition: typeof SERVICE_DEFINITIONS[keyof typeof SERVICE_DEFINITIONS]
}) {
  if (!existsSync(agents)) {
    return
  }

  for (const name of readdirSync(agents).filter(name => definition.pattern.test(name))) {
    const {
      storedHome,
      args,
    } = definition.read({
      text: readFileSync(
        join(
          agents,
          name,
        ),
        'utf8',
      ),
    })
    const otherHome = storedHome ?? join(
      homedir(),
      '.pnyx',
    )

    if (canonical({ path: otherHome }) === canonical({ path: home })) {
      continue
    }

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

type ServiceResult = {
  service: string
  path: string
  log?: string
  plist?: string
  unit?: string
  replaces?: string[]
  replaced?: string[]
  unrecorded?: {
    hydra: string
    home: string
  }[]
  help?: string[]
}

const INSTALLED_HELP = [
  'The server of every Hydra starts at login and restarts after exit',
  'Run `pnyx-axi setup service --remove` to stop and uninstall it',
]

// A systemd unit does not inherit the login shell's environment, so it carries the PATH and login folders setup ran with.
function setupSystemdService({
  label,
  path,
  args,
  cli,
  home,
  log,
  searchPath,
  environment,
  remove,
  preview,
  run,
}: {
  label: string
  path: string
  args: string[]
  cli: string
  home: string
  log: string
  searchPath: string
  environment: NodeJS.ProcessEnv
  remove: boolean
  preview: boolean
  run({ args }: { args: string[] }): string
}): ServiceResult {
  const unitName = `${label}.service`
  const variables = [
    `PNYX_HOME=${home}`,
    `PATH=${searchPath}`,
    ...[
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
    ].filter(name => environment[name])
      .map(name => `${name}=${environment[name]}`),
  ]
  const unit = `[Unit]
Description=Pnyx server

[Service]
ExecStart=${args.map(arg => systemdQuote({
  text: arg,
  command: true,
})).join(' ')}
${variables.map(variable => `Environment=${systemdQuote({ text: variable })}`).join('\n')}
WorkingDirectory=${systemdLiteral({ text: home })}
Restart=always
RestartSec=5
StandardOutput=append:${systemdLiteral({ text: log })}
StandardError=append:${systemdLiteral({ text: log })}

[Install]
WantedBy=default.target
`

  if (preview) {
    return {
      service: remove ? 'would remove' : 'would install',
      path,
      unit: remove ? undefined : unit,
    }
  }

  if (!remove && !existsSync(cli)) {
    throw new HydraError({
      message: 'build Pnyx before installing its login service',
      code: 'NOT_BUILT',
    })
  }

  const systemctl = ({
    commands,
    failure,
  }: {
    commands: string[][]
    failure: string
  }) => {
    try {
      for (const command of commands) {
        run({
          args: [
            '--user',
            ...command,
          ],
        })
      }
    } catch (error) {
      throw new HydraError({
        message: `${failure}: ${(error as Error).message}`,
        code: 'SERVICE_ERROR',
        help: [
          `Run \`systemctl --user status ${unitName}\` to inspect it`,
          `Read ${log}`,
        ],
      })
    }
  }

  if (remove) {
    if (existsSync(path)) {
      systemctl({
        commands: [
          [
            'disable',
            '--now',
            unitName,
          ],
        ],
        failure: `systemd did not stop the running service ${label}`,
      })
      rmSync(
        path,
        { force: true },
      )
      systemctl({
        commands: [['daemon-reload']],
        failure: `systemd did not forget the removed service ${label}`,
      })
    }

    return {
      service: 'removed',
      path,
    }
  }

  privateDir({ dir: home })
  mkdirSync(
    dirname(path),
    { recursive: true },
  )
  writeFileSync(
    path,
    unit,
    { mode: 0o600 },
  )
  // restart starts a stopped unit and replaces a running one with the unit just written.
  systemctl({
    commands: [
      ['daemon-reload'],
      [
        'enable',
        unitName,
      ],
      [
        'restart',
        unitName,
      ],
    ],
    failure: 'systemd could not start the Pnyx server',
  })

  return {
    service: 'installed',
    path,
    log,
    help: INSTALLED_HELP,
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
  environment = process.env,
  run = ({ args }) => execFileSync(
    platform === 'darwin' ? 'launchctl' : 'systemctl',
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
  environment?: NodeJS.ProcessEnv
  run?({ args }: { args: string[] }): string
  sleep?({ ms }: { ms: number }): unknown
}): ServiceResult {
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new HydraError({
      message: 'the login service requires macOS launchd or Linux systemd',
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
  } = serviceFile({
    userHome,
    platform,
    configHome: environment.XDG_CONFIG_HOME,
  })
  const agents = dirname(path)

  if (!remove) {
    requireAvailableServicePort({
      agents,
      home,
      port,
      definition: SERVICE_DEFINITIONS[platform === 'linux' ? 'systemd' : 'launchd'],
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

  if (platform === 'linux') {
    return setupSystemdService({
      label,
      path,
      args,
      cli,
      home,
      log,
      searchPath,
      environment,
      remove,
      preview,
      run,
    })
  }

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
      ...INSTALLED_HELP,
    ],
  }
}
