import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { nativeProviders } from '#app/native-provider.ts'
import { hydraIds } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { connectHost } from '#agent-host/client.ts'
import { installBundle, selectBundle } from '#agent-host/install.ts'
import { validateBundle } from '#agent-host/bundle.ts'
import { processStart } from '#agent-host/discovery.ts'
import { fail } from '#agent-host/protocol.ts'
import { pnyxHome, privateDir } from '#store/storage.ts'

const READY_MS = 30000
const POLL_MS = 50

export function nativePaths() {
  privateDir({ dir: pnyxHome() })
  const home = realpathSync(pnyxHome())
  const directory = join(
    home,
    'native',
  )
  privateDir({ dir: directory })
  const installationPath = join(
    directory,
    'installation',
  )

  if (!existsSync(installationPath)) {
    let fd: number | undefined

    try {
      fd = openSync(
        installationPath,
        'wx',
        0o600,
      )
      writeFileSync(
        fd,
        randomUUID(),
      )
      fsyncSync(fd)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    } finally {
      if (fd !== undefined) {
        closeSync(fd)
      }
    }
  }

  if (!lstatSync(installationPath).isFile()) {
    fail({
      code: 'INVALID_DIRECTORY',
      message: 'The native installation identity must be a private regular file',
    })
  }

  return {
    directory,
    installation: readFileSync(
      installationPath,
      'utf8',
    ),
    bundles: join(
      home,
      'native-bundles',
    ),
    selected: join(
      home,
      'native-bundle.json',
    ),
    journal: join(
      home,
      'native-bindings',
    ),
    log: join(
      home,
      'native.log',
    ),
  }
}

export function requireSafeActivation() {
  for (const hydraId of hydraIds()) {
    const server = join(
      pnyxHome(),
      'hydras',
      hydraId,
      'server.json',
    )

    if (existsSync(server)) {
      const previous = JSON.parse(readFileSync(
        server,
        'utf8',
      )) as { pid: number }

      if (processStart({ pid: previous.pid })) {
        fail({
          code: 'NATIVE_MIGRATION_BUSY',
          message: 'Stop the previous application at a safe native-session boundary before first activation',
        })
      }
    }

    const state = loadHydra({ hydraId }).state
    const working = Object.values(state.sessions ?? {}).some(session => session.agent.host === 'pnyx' && (session.sessionActivity ?? session.activity) === 'working')

    if (working || Object.keys(state.helper?.runs ?? {}).length) {
      fail({
        code: 'NATIVE_MIGRATION_BUSY',
        message: 'Finish the existing in-process turns before activating the native host',
      })
    }
  }
}

export function selectedNativeBundle({ source }: { source: string }): {
  bundle: string
  entry: string
} {
  const paths = nativePaths()
  let bundle: string

  if (existsSync(paths.selected)) {
    bundle = JSON.parse(readFileSync(
      paths.selected,
      'utf8',
    )).bundle
  } else {
    requireSafeActivation()
    bundle = installBundle({
      source,
      directory: paths.bundles,
    })
    selectBundle({
      path: paths.selected,
      bundle,
    })
  }

  const manifest = validateBundle({ directory: bundle })

  return {
    bundle,
    entry: join(
      bundle,
      manifest.entry,
    ),
  }
}

export async function ensureNativeHost({
  source,
}: {
  source: string
}) {
  const paths = nativePaths()
  const connect = () => connectHost({
    socket: join(
      paths.directory,
      'host.sock',
    ),
    token: readFileSync(
      join(
        paths.directory,
        'token',
      ),
      'utf8',
    ),
    installation: paths.installation,
  })

  try {
    const client = await connect()
    client.detach()

    return await nativeProviders(paths)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code

    if (code !== 'ENOENT' && code !== 'ECONNREFUSED') {
      throw error
    }
  }

  let owned = false
  const ownerPath = join(
    paths.directory,
    'owner.json',
  )

  if (existsSync(ownerPath)) {
    const owner = JSON.parse(readFileSync(
      ownerPath,
      'utf8',
    )) as {
      pid: number
      start: string
    }
    const start = processStart({ pid: owner.pid })

    if (start) {
      if (start !== owner.start) {
        fail({
          code: 'RECOVERY_REQUIRED',
          message: 'Native host PID ownership is uncertain',
        })
      }

      owned = true
    }
  }

  if (!owned) {
    const {
      bundle,
      entry,
    } = selectedNativeBundle({ source })
    const log = openSync(
      paths.log,
      'a',
      0o600,
    )

    try {
      const child = spawn(
        process.execPath,
        [
          entry,
          bundle,
          paths.directory,
          paths.installation,
        ],
        {
          detached: true,
          stdio: [
            'ignore',
            log,
            log,
          ],
        },
      )
      child.on(
        'error',
        error => process.stderr.write(`Native host start failed: ${error.message}\n`),
      )
      child.unref()
    } finally {
      closeSync(log)
    }
  }

  const deadline = Date.now() + READY_MS
  let last: unknown

  while (Date.now() < deadline) {
    try {
      return await nativeProviders(paths)
    } catch (error) {
      last = error
      const code = (error as NodeJS.ErrnoException).code

      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') {
        throw error
      }

      await delay(POLL_MS)
    }
  }

  fail({
    code: 'NATIVE_UNAVAILABLE',
    message: `The native host did not become ready: ${last instanceof Error ? last.message : 'unknown start result'}`,
  })
}
