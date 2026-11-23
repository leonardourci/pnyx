import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { TitanError } from '#store/errors.ts'
import { othrysHome, privateDir } from '#store/storage.ts'
import { canonical } from '#store/paths.ts'
import { DEFAULT_PORT } from '#app/server-state.ts'
import { SOURCE_CONDITIONS } from '#app/source-conditions.ts'
import { runProcess } from '#app/run-process.ts'

const SERVICE_RESTART_SECONDS = 5

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

// The launchd job or systemd unit of this Othrys home's login service, named after the home so other homes keep their own.
export function serviceFile({
  userHome = homedir(),
  platform = process.platform,
  configHome = process.env.XDG_CONFIG_HOME,
}: {
  userHome?: string
  platform?: NodeJS.Platform
  configHome?: string
} = {}) {
  const label = `local.othrys.server.${createHash('sha256').update(othrysHome())
    .digest('hex')
    .slice(
      0,
      16,
    )}`

  const agents = platform === 'linux' ? join(
    configHome && isAbsolute(configHome) ? configHome : join(
      userHome,
      '.config',
    ),
    'systemd',
    'user',
  ) : join(
    userHome,
    'Library',
    'LaunchAgents',
  )
  const extension = platform === 'linux' ? '.service' : '.plist'
  const path = join(
    agents,
    `${label}${extension}`,
  )

  if (!existsSync(path) && existsSync(agents)) {
    const definition = SERVICE_DEFINITIONS[platform === 'linux' ? 'systemd' : 'launchd']
    const legacy = readdirSync(agents).sort()
      .find(name => {
        if (!name.endsWith(extension) || !/^local\.pnyx\.server\.[0-9a-f]{16}\.(plist|service)$/.test(name)) {
          return false
        }

        const stored = definition.read({
          text: readFileSync(
            join(
              agents,
              name,
            ),
            'utf8',
          ),
        })
        const storedHome = stored.storedHome ?? join(
          userHome,
          '.pnyx',
        )

        return canonical({ path: storedHome }) === canonical({ path: othrysHome() })
      })

    if (legacy) {
      return {
        label: basename(
          legacy,
          extension,
        ),
        path: join(
          agents,
          legacy,
        ),
      }
    }
  }

  return {
    label,
    path,
  }
}

// Starts this home's installed login service, so the server it runs keeps the service's supervision,
// arguments and environment. A job launchd has not loaded is loaded, which starts it.
export async function startService() {
  const {
    label,
    path,
  } = serviceFile()

  if (process.platform === 'linux') {
    const started = await runProcess({
      command: 'systemctl',
      args: [
        '--user',
        'start',
        `${label}.service`,
      ],
    })

    if (started.status !== 0) {
      throw new Error(started.stderr.trim() || 'systemd could not start the Othrys server')
    }

    return
  }

  const domain = `gui/${process.getuid!()}`
  const kicked = await runProcess({
    command: 'launchctl',
    args: [
      'kickstart',
      `${domain}/${label}`,
    ],
  })

  if (kicked.status === 0) {
    return
  }

  const loaded = await runProcess({
    command: 'launchctl',
    args: [
      'bootstrap',
      domain,
      path,
    ],
  })

  if (loaded.status !== 0) {
    throw new Error(loaded.stderr.trim() || 'launchd could not start the Othrys server')
  }
}

const systemdLiteral = ({ text }: { text: string }) => {
  if (/[\r\n]/.test(text)) {
    throw new TitanError({
      message: 'login service paths and environment values must fit on one line',
      code: 'VALIDATION_ERROR',
    })
  }

  return text.replaceAll(
    '%',
    '%%',
  )
}

// ExecStart expands $VARIABLE and every setting expands %specifiers, so both are doubled.
const systemdQuote = ({
  text,
  command = false,
}: {
  text: string
  command?: boolean
}) => {
  let escaped = systemdLiteral({ text }).replaceAll(
    '\\',
    '\\\\',
  )
    .replaceAll(
      '"',
      '\\"',
    )

  if (command) {
    escaped = escaped.replaceAll(
      '$',
      () => '$$',
    )
  }

  return `"${escaped}"`
}

const systemdWords = ({
  text,
  command = false,
}: {
  text: string
  command?: boolean
}) => [...text.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map(match => {
  const quoted = match[1]

  if (quoted === undefined) {
    return match[0]
  }

  return quoted.replace(
    command ? /\\(.)|%%|\$\$/g : /\\(.)|%%/g,
    (
      escape: string,
      escaped: string | undefined,
    ) => {
      if (escaped !== undefined) {
        return escaped
      }

      return escape.charAt(0)
    },
  )
})

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
    `^${key}=.*$`,
    'gm',
  )),
].flatMap(match => systemdWords({
  text: match[0].slice(key.length + 1),
  command,
}))

const SERVICE_DEFINITIONS = {
  launchd: {
    pattern: /^local\.(?:othrys|pnyx)\.(server|board)\.[0-9a-f]{16}\.plist$/,
    read: ({ text }: { text: string }) => {
      const storedHome = /<key>(?:OTHRYS_HOME|PNYX_HOME)<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1]
      const argumentsXml = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? ''

      return {
        storedHome: storedHome === undefined ? undefined : unxml({ text: storedHome }),
        args: [...argumentsXml.matchAll(/<string>([^<]*)<\/string>/g)].map(match => unxml({ text: match[1]! })),
      }
    },
  },
  systemd: {
    pattern: /^local\.(?:othrys|pnyx)\.server\.[0-9a-f]{16}\.service$/,
    read: ({ text }: { text: string }) => ({
      storedHome: systemdSetting({
        text,
        key: 'Environment',
      }).find(variable => /^(?:OTHRYS_HOME|PNYX_HOME)=/.test(variable))
        ?.split('=')
        .slice(1)
        .join('='),
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
  path,
}: {
  path: string
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
      name.startsWith('local.pnyx.') ? '.pnyx' : '.othrys',
    )

    if (canonical({ path: otherHome }) === canonical({ path: home })) {
      if (name !== basename(path) && name.includes('.server.')) {
        throw new TitanError({
          code: 'CONFLICT',
          message: `Multiple login services use this home: ${name} and ${basename(path)}`,
          help: ['Stop and remove the duplicate login service before running setup again'],
        })
      }

      continue
    }

    const portIndex = args.indexOf('--port')
    const portValue = portIndex < 0 ? args.find(arg => arg.startsWith('--port='))?.slice('--port='.length) : args[portIndex + 1]
    const otherPort = portValue === undefined ? DEFAULT_PORT : Number(portValue)

    if (port === otherPort) {
      throw new TitanError({
        message: `port ${port} is reserved by another Othrys home's service: ${otherHome} (${name})`,
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
  help?: string[]
}

const INSTALLED_HELP = [
  'The server of every Titan starts at login and restarts after exit',
  'Run `othrys setup --remove` to stop and uninstall it',
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
    `OTHRYS_HOME=${home}`,
    // Tells the server its service started it, so a restart leaves the replacement to systemd.
    'OTHRYS_SERVICE_ROLE=application',
    `PATH=${searchPath}`,
    ...[
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
    ].filter(name => environment[name])
      .map(name => `${name}=${environment[name]}`),
  ]
  const unit = `[Unit]
Description=Othrys server

[Service]
ExecStart=${args.map(arg => systemdQuote({
  text: arg,
  command: true,
})).join(' ')}
${variables.map(variable => `Environment=${systemdQuote({ text: variable })}`).join('\n')}
WorkingDirectory=${systemdLiteral({ text: home })}
Restart=always
RestartSec=${SERVICE_RESTART_SECONDS}
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
    throw new TitanError({
      message: 'build Othrys before installing its login service',
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
      throw new TitanError({
        message: `${failure}: ${error instanceof Error ? error.message : String(error)}`,
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
    failure: 'systemd could not start the Othrys server',
  })

  return {
    service: 'installed',
    path,
    log,
    help: INSTALLED_HELP,
  }
}

// One login service runs the one server of every Titan in this Othrys home.
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
    throw new TitanError({
      message: 'the login service requires macOS launchd or Linux systemd',
      code: 'UNSUPPORTED_PLATFORM',
    })
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TitanError({
      message: '--port must be 1 to 65535 for a login service',
      code: 'VALIDATION_ERROR',
    })
  }

  const home = othrysHome()
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
      path,
      definition: SERVICE_DEFINITIONS[platform === 'linux' ? 'systemd' : 'launchd'],
    })
  }

  const log = join(
    home,
    'service.log',
  )
  const cli = join(
    import.meta.dirname,
    '..',
    'cli',
    import.meta.url.endsWith('.ts') ? 'othrys.ts' : 'othrys.js',
  )
  const args = [
    stableNode({
      node,
      searchPath,
    }),
    ...SOURCE_CONDITIONS,
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

  const domain = `gui/${process.getuid!()}`
  const homeEntry = `<key>OTHRYS_HOME</key><string>${xml({ text: home })}</string>`
  // Services from before one server ran every Titan each ran one Titan of this home; they are replaced.
  const replaced = (() => {
    try {
      return readdirSync(agents).filter(name => {
        if (!/^local\.(?:othrys|pnyx)\.board\.[0-9a-f]{16}\.plist$/.test(name)) {
          return false
        }

        const stored = SERVICE_DEFINITIONS.launchd.read({
          text: readFileSync(
            join(
              agents,
              name,
            ),
            'utf8',
          ),
        })

        return canonical({
          path: stored.storedHome ?? join(
            userHome,
            '.pnyx',
          ),
        }) === canonical({ path: home })
      })
        .map(name => join(
          agents,
          name,
        ))
    } catch {
      return []
    }
  })()
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml({ text: arg })}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict>${homeEntry}<key>OTHRYS_SERVICE_ROLE</key><string>application</string><key>PATH</key><string>${xml({ text: searchPath })}</string></dict>
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
    }
  }

  if (!remove && !existsSync(cli)) {
    throw new TitanError({
      message: 'build Othrys before installing its login service',
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
          throw new TitanError({
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
      throw new TitanError({
        message: `launchd could not start the Othrys server: ${(error as Error).message}`,
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
    help: INSTALLED_HELP,
  }
}
