import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { serviceFile, setupService } from './service.ts'

test(
  'one login service runs the server of every Hydra, replaces the per-Hydra services of this home, survives exit and uninstalls through launchd',
  () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-service-',
    ))
    process.env.PNYX_HOME = join(
      root,
      'pnyx & Hydra',
    )
    const agents = join(
      root,
      'Library',
      'LaunchAgents',
    )
    mkdirSync(
      agents,
      { recursive: true },
    )

    const legacy = ({
      key,
      home,
      args = '',
    }: {
      key: string
      home: string
      args?: string
    }) => {
      const path = join(
        agents,
        `local.pnyx.board.${key}.plist`,
      )
      writeFileSync(
        path,
        `<array><string>serve</string>${args}</array><key>EnvironmentVariables</key><dict><key>PNYX_HOME</key><string>${home}</string></dict>`,
      )

      return path
    }

    // Its --home reached the work Hydra only through this job, so setup names it.
    const ours = legacy({
      key: '0123456789abcdef',
      home: join(
        root,
        'pnyx &amp; Hydra',
      ),
      args: '<string>--hydra</string><string>work</string><string>--home</string><string>/fm &amp; home</string>',
    })
    const theirs = legacy({
      key: 'fedcba9876543210',
      home: join(
        root,
        'other',
      ),
    })
    const calls: string[][] = []
    const loaded = new Set(['local.pnyx.board.0123456789abcdef'])

    const run = ({ args }: { args: string[] }) => {
      calls.push(args)
      const label = args.at(-1)!.split('/').at(-1)!.replace(
        /\.plist$/,
        '',
      )

      if (args[0] === 'print' && !loaded.has(label)) {
        throw new Error('not loaded')
      }

      if (args[0] === 'bootstrap') {
        loaded.add(label)
      }

      if (args[0] === 'bootout') {
        loaded.delete(label)
      }

      return ''
    }

    const options = {
      port: 49123,
      platform: 'darwin' as const,
      userHome: root,
      run,
      sleep: () => assert.fail('an immediate bootout needs no wait'),
    }
    const preview = setupService({
      ...options,
      preview: true,
    })
    assert.equal(
      calls.length,
      0,
    )
    assert.equal(
      existsSync(preview.path),
      false,
    )
    assert.deepEqual(
      preview.replaces,
      [ours],
    )
    assert.deepEqual(
      preview.unrecorded,
      [
        {
          hydra: 'work',
          home: '/fm & home',
        },
      ],
    )
    const installed = setupService(options)
    assert.deepEqual(
      installed.replaced,
      [ours],
    )
    assert.equal(
      existsSync(ours),
      false,
    )
    assert.equal(
      existsSync(theirs),
      true,
    )
    assert.deepEqual(
      calls.filter(args => args[0] === 'bootout').map(args => args[1]),
      [`gui/${process.getuid!()}/local.pnyx.board.0123456789abcdef`],
    )
    const plist = readFileSync(
      installed.path,
      'utf8',
    )
    assert.match(
      installed.path,
      /local\.pnyx\.server\.[0-9a-f]{16}\.plist$/,
    )
    assert.match(
      plist,
      /<key>RunAtLoad<\/key><true\/>/,
    )
    assert.match(
      plist,
      /<key>KeepAlive<\/key><true\/>/,
    )
    assert.match(
      plist,
      /<string>serve<\/string><string>--port<\/string><string>49123<\/string><\/array>/,
    )
    assert.match(
      plist,
      /pnyx &amp; Hydra/,
    )
    assert.equal(
      calls.at(-1)?.[0],
      'bootstrap',
    )
    setupService({
      ...options,
      remove: true,
    })
    assert.deepEqual(
      calls.slice(-2).map(args => args[0]),
      [
        'bootout',
        'print',
      ],
    )
    assert.equal(
      existsSync(installed.path),
      false,
    )
    assert.throws(
      () => setupService({
        ...options,
        platform: 'win32',
      }),
      /requires macOS launchd or Linux systemd/,
    )
    assert.throws(
      () => setupService({
        ...options,
        port: 0,
      }),
      /1 to 65535/,
    )
  },
)

test(
  'reinstalling a running service waits for launchd to finish the bootout and retries a failed bootstrap once',
  () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-service-reinstall-',
    ))
    process.env.PNYX_HOME = join(
      root,
      'pnyx',
    )
    const calls: string[] = []
    const waits: number[] = []
    let listed = true
    let unloading = 0
    let refusals = 0

    const run = ({ args }: { args: string[] }) => {
      calls.push(args[0])

      if (args[0] === 'print') {
        if (unloading > 0) {
          unloading--
        } else if (!listed) {
          throw new Error('Could not find service')
        }

        return ''
      }

      if (args[0] === 'bootout') {
        listed = false
        unloading = 3
      }

      if (args[0] === 'bootstrap') {
        if (unloading > 0 || refusals-- > 0) {
          throw new Error(`Command failed: launchctl bootstrap ${args[1]} ${args[2]}\nBootstrap failed: 5: Input/output error`)
        }

        listed = true
      }

      return ''
    }

    const options = {
      platform: 'darwin' as const,
      userHome: root,
      run,
      sleep: ({ ms }: { ms: number }) => waits.push(ms),
    }
    setupService(options)
    assert.deepEqual(
      calls,
      [
        'print',
        'bootout',
        'print',
        'print',
        'print',
        'print',
        'bootstrap',
      ],
    )
    assert.deepEqual(
      waits,
      [
        100,
        100,
        100,
      ],
    )
    assert.equal(
      listed,
      true,
    )

    calls.length = 0
    waits.length = 0
    refusals = 1
    const { path } = setupService(options)
    assert.deepEqual(
      calls.slice(-2),
      [
        'bootstrap',
        'bootstrap',
      ],
    )
    assert.equal(
      waits.at(-1),
      1000,
    )
    assert.equal(
      listed,
      true,
    )

    refusals = 2
    assert.throws(
      () => setupService(options),
      (error: Error & { code?: string }) => error.code === 'SERVICE_ERROR' && error.message.includes('Bootstrap failed: 5: Input/output error'),
    )

    const plist = readFileSync(
      path,
      'utf8',
    )
    const stuck = {
      ...options,
      run: ({ args }: { args: string[] }) => args[0] === 'bootstrap' ? assert.fail('a stuck job must not be replaced') : '',
    }

    for (const remove of [
      false,
      true,
    ]) {
      assert.throws(
        () => setupService({
          ...stuck,
          remove,
        }),
        (error: Error & { code?: string }) => error.code === 'SERVICE_ERROR' && /did not stop/.test(error.message),
      )
    }

    assert.equal(
      readFileSync(
        path,
        'utf8',
      ),
      plist,
    )
  },
)

test(
  'login service runs Node through a PATH link that survives a Homebrew upgrade',
  () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-service-node-',
    ))
    process.env.PNYX_HOME = join(
      root,
      'pnyx',
    )
    const cellar = join(
      root,
      'Cellar',
      'node',
      '26.4.0',
      'bin',
    )
    const other = join(
      root,
      'other',
    )
    const bin = join(
      root,
      'bin',
    )

    for (const dir of [
      cellar,
      other,
      bin,
    ]) {
      mkdirSync(
        dir,
        { recursive: true },
      )
    }

    writeFileSync(
      join(
        cellar,
        'node',
      ),
      '',
    )
    writeFileSync(
      join(
        other,
        'node',
      ),
      '',
    )
    symlinkSync(
      join(
        cellar,
        'node',
      ),
      join(
        bin,
        'node',
      ),
    )
    const options = {
      platform: 'darwin' as const,
      userHome: root,
      preview: true,
      node: join(
        cellar,
        'node',
      ),
      run: () => '',
    }
    const linked = setupService({
      ...options,
      searchPath: [
        'relative',
        other,
        bin,
      ].join(delimiter),
    }).plist!
    assert.ok(linked.includes(`<array><string>${join(
      bin,
      'node',
    )}</string>`))
    const unlinked = setupService({
      ...options,
      searchPath: other,
    }).plist!
    assert.ok(unlinked.includes(`<array><string>${join(
      cellar,
      'node',
    )}</string>`))
  },
)

test(
  'another home reserves its service port without touching launchd or files',
  () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-service-conflict-',
    ))
    process.env.PNYX_HOME = join(
      root,
      'ours',
    )
    const options = {
      platform: 'darwin' as const,
      userHome: root,
      preview: true,
      run: () => assert.fail('a conflict or preview must never call launchctl'),
    }
    const previewPlan = setupService(options)
    const agents = join(
      root,
      'Library',
      'LaunchAgents',
    )
    mkdirSync(
      agents,
      { recursive: true },
    )
    const other = join(
      agents,
      'local.pnyx.server.0123456789abcdef.plist',
    )
    const original = previewPlan.plist!.replaceAll(
      process.env.PNYX_HOME,
      join(
        root,
        'theirs &amp; home',
      ),
    )
    writeFileSync(
      other,
      original,
    )

    for (const previewMode of [
      false,
      true,
    ]) {
      assert.throws(
        () => setupService({
          ...options,
          preview: previewMode,
        }),
        { code: 'PORT_IN_USE' },
      )
      assert.equal(
        existsSync(join(
          root,
          'ours',
        )),
        false,
      )
      assert.equal(
        readFileSync(
          other,
          'utf8',
        ),
        original,
      )
    }

    assert.equal(
      existsSync(previewPlan.path),
      false,
    )
    assert.ok(setupService({
      ...options,
      port: 49124,
    }).plist!.includes('49124'))
    assert.equal(
      setupService({
        ...options,
        remove: true,
      }).service,
      'would remove',
    )

    writeFileSync(
      other,
      original.replace(
        /<string>--port<\/string><string>4747<\/string>/,
        '',
      ),
    )
    assert.throws(
      () => setupService(options),
      { code: 'PORT_IN_USE' },
    )
    writeFileSync(
      other,
      original.replace(
        '<string>--port</string><string>4747</string>',
        '<string>--port=4747</string>',
      ),
    )
    assert.throws(
      () => setupService(options),
      { code: 'PORT_IN_USE' },
    )

    writeFileSync(
      other,
      previewPlan.plist!,
    )
    assert.equal(
      setupService(options).service,
      'would install',
    )
  },
)

test(
  'on Linux a systemd user unit carries the setup PATH and login folders, restarts after exit and uninstalls through systemctl --user',
  () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-service-linux-',
    ))
    process.env.PNYX_HOME = join(
      root,
      'pnyx 100% Hydra',
    )
    const configHome = join(
      root,
      'config',
    )
    const calls: string[][] = []
    const options = {
      node: '/opt/node $HOME % bin/node',
      port: 49125,
      platform: 'linux' as const,
      userHome: root,
      searchPath: '/opt/tools/bin:/usr/bin',
      environment: {
        XDG_CONFIG_HOME: configHome,
        CLAUDE_CONFIG_DIR: '/logins/claude',
      },
      run: ({ args }: { args: string[] }) => {
        calls.push(args)

        return ''
      },
    }
    const ours = process.env.PNYX_HOME
    process.env.PNYX_HOME = join(
      root,
      'theirs',
    )
    const theirs = setupService({
      ...options,
      preview: true,
    })
    process.env.PNYX_HOME = ours
    const { label } = serviceFile({
      userHome: root,
      platform: 'linux',
      configHome,
    })
    const unitName = `${label}.service`
    const preview = setupService({
      ...options,
      preview: true,
    })
    assert.equal(
      preview.path,
      join(
        configHome,
        'systemd',
        'user',
        unitName,
      ),
    )
    assert.equal(
      existsSync(preview.path),
      false,
    )
    assert.equal(
      calls.length,
      0,
    )

    assert.ok(preview.unit)
    assert.match(
      preview.unit,
      /^ExecStart="\/opt\/node \$\$HOME %% bin\/node" "--conditions=source" .* "serve" "--port" "49125"$/m,
    )
    assert.match(
      preview.unit,
      /^Environment="PNYX_HOME=[^"]*pnyx 100%% Hydra"$/m,
    )
    assert.match(
      preview.unit,
      /^Environment="PATH=\/opt\/tools\/bin:\/usr\/bin"$/m,
    )
    assert.match(
      preview.unit,
      /^Environment="CLAUDE_CONFIG_DIR=\/logins\/claude"$/m,
    )
    assert.match(
      preview.unit,
      /^WorkingDirectory=.*pnyx 100%% Hydra$/m,
    )
    assert.match(
      preview.unit,
      /^StandardOutput=append:.*pnyx 100%% Hydra\/service\.log$/m,
    )
    assert.match(
      preview.unit,
      /^StandardError=append:.*pnyx 100%% Hydra\/service\.log$/m,
    )
    assert.match(
      preview.unit,
      /^Restart=always$/m,
    )
    assert.match(
      preview.unit,
      /^RestartSec=5$/m,
    )
    assert.match(
      preview.unit,
      /^WantedBy=default\.target$/m,
    )

    assert.doesNotMatch(
      preview.unit,
      /CODEX_HOME/,
    )

    setupService(options)
    assert.equal(
      readFileSync(
        preview.path,
        'utf8',
      ),
      preview.unit,
    )
    assert.deepEqual(
      calls,
      [
        [
          '--user',
          'daemon-reload',
        ],
        [
          '--user',
          'enable',
          unitName,
        ],
        [
          '--user',
          'restart',
          unitName,
        ],
      ],
    )

    setupService({
      ...options,
      port: 49126,
    })
    assert.match(
      readFileSync(
        preview.path,
        'utf8',
      ),
      /"--port" "49126"$/m,
    )
    assert.deepEqual(
      calls.slice(3),
      [
        [
          '--user',
          'daemon-reload',
        ],
        [
          '--user',
          'enable',
          unitName,
        ],
        [
          '--user',
          'restart',
          unitName,
        ],
      ],
    )
    assert.ok(theirs.unit)
    writeFileSync(
      theirs.path,
      theirs.unit,
    )
    assert.throws(
      () => setupService(options),
      { code: 'PORT_IN_USE' },
    )

    calls.length = 0
    setupService({
      ...options,
      remove: true,
    })
    assert.deepEqual(
      calls,
      [
        [
          '--user',
          'disable',
          '--now',
          unitName,
        ],
        [
          '--user',
          'daemon-reload',
        ],
      ],
    )
    assert.equal(
      existsSync(preview.path),
      false,
    )
  },
)

test(
  'Linux service refuses multiline values before writing a unit or calling systemctl',
  () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-service-lines-',
    ))
    process.env.PNYX_HOME = join(
      root,
      'pnyx',
    )
    const options = {
      platform: 'linux' as const,
      userHome: root,
      environment: { CLAUDE_CONFIG_DIR: '/logins/claude\nRestart=no' },
      run: () => assert.fail('invalid settings must not call systemctl'),
    }
    const { path } = serviceFile({
      userHome: root,
      platform: 'linux',
      configHome: 'relative',
    })
    assert.throws(
      () => setupService(options),
      { code: 'VALIDATION_ERROR' },
    )
    assert.equal(
      existsSync(path),
      false,
    )
  },
)

test(
  'Linux service uses the user config fallback and preserves failures until setup succeeds',
  () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-service-errors-',
    ))
    process.env.PNYX_HOME = join(
      root,
      'pnyx',
    )
    const options = {
      platform: 'linux' as const,
      userHome: root,
      environment: {
        XDG_CONFIG_HOME: 'relative',
        CODEX_HOME: '/logins/codex "100%" \\ home',
      },
      run: () => {
        throw new Error('Failed to connect to bus')
      },
    }
    const preview = setupService({
      ...options,
      preview: true,
    })
    assert.ok(preview.unit)
    assert.equal(
      preview.path,
      join(
        root,
        '.config',
        'systemd',
        'user',
        `${serviceFile({ platform: 'linux' }).label}.service`,
      ),
    )
    assert.equal(
      setupService({
        ...options,
        environment: {},
        preview: true,
      }).path,
      preview.path,
    )
    assert.match(
      preview.unit,
      /^Environment="CODEX_HOME=\/logins\/codex \\"100%%\\" \\\\ home"$/m,
    )
    assert.throws(
      () => setupService(options),
      {
        code: 'SERVICE_ERROR',
        message: 'systemd could not start the Pnyx server: Failed to connect to bus',
        help: [
          `Run \`systemctl --user status ${serviceFile({ platform: 'linux' }).label}.service\` to inspect it`,
          `Read ${join(
            root,
            'pnyx',
            'service.log',
          )}`,
        ],
      },
    )
    assert.equal(
      readFileSync(
        preview.path,
        'utf8',
      ),
      preview.unit,
    )
    assert.throws(
      () => setupService({
        ...options,
        remove: true,
      }),
      { code: 'SERVICE_ERROR' },
    )
    assert.equal(
      existsSync(preview.path),
      true,
    )
    assert.equal(
      setupService({
        ...options,
        run: () => '',
      }).service,
      'installed',
    )
    assert.equal(
      setupService({
        ...options,
        run: () => '',
        remove: true,
      }).service,
      'removed',
    )
    assert.equal(
      existsSync(preview.path),
      false,
    )
    assert.equal(
      setupService({
        ...options,
        remove: true,
      }).service,
      'removed',
    )
  },
)
