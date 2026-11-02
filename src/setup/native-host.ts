import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { nativeProviders } from '#app/native-provider.ts'
import { hydraDir, hydraIds } from '#app/home-migration.ts'
import { connectHost } from '#agent-host/client.ts'
import { installBundle, selectBundle } from '#agent-host/install.ts'
import { validateBundle } from '#agent-host/bundle.ts'
import { processStart } from '#agent-host/discovery.ts'
import { CAPABILITIES, fail } from '#agent-host/protocol.ts'
import { pnyxHome, privateDir } from '#store/storage.ts'

const READY_MS = 30000
const STOP_MS = 2000
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
      hydraDir({ hydraId }),
      'server.json',
    )

    if (existsSync(server)) {
      const previous = JSON.parse(readFileSync(
        server,
        'utf8',
      )) as { pid: number }

      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) {
        fail({
          code: 'RECOVERY_REQUIRED',
          message: 'The previous application PID is not verifiable',
        })
      }

      if (previous.pid === process.pid) {
        continue
      }

      try {
        process.kill(
          previous.pid,
          0,
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          continue
        }

        throw error
      }

      fail({
        code: 'NATIVE_MIGRATION_BUSY',
        message: 'Stop the previous application at a safe native-session boundary before first activation',
      })
    }
  }
}

export function selectedNativeBundle({ source }: { source: string }): {
  bundle: string
  build: string
  entry: string
  restartInstance?: string
} {
  const paths = nativePaths()
  let restartInstance: string | undefined

  if (!existsSync(paths.selected)) {
    requireSafeActivation()
  } else {
    restartInstance = JSON.parse(readFileSync(
      paths.selected,
      'utf8',
    )).restartInstance
  }

  const bundle = installBundle({
    source,
    directory: paths.bundles,
  })
  selectBundle({
    path: paths.selected,
    bundle,
    restartInstance,
  })

  const manifest = validateBundle({ directory: bundle })

  return {
    bundle,
    build: manifest.build,
    restartInstance,
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
  const selected = selectedNativeBundle({ source })

  try {
    await startNativeHost({ paths })
  } catch (error) {
    console.error(
      'Native host startup deferred:',
      error,
    )
  }

  return nativeProviders({
    ...paths,
    desiredBuild: selected.build,
    restartInstance: selected.restartInstance,
    reconnect: () => startNativeHost({
      paths,
    }),
  })
}

async function startNativeHost({
  paths,
}: {
  paths: ReturnType<typeof nativePaths>
}) {
  const socket = join(
    paths.directory,
    'host.sock',
  )
  const connect = () => connectHost({
    socket,
    token: readFileSync(
      join(
        paths.directory,
        'token',
      ),
      'utf8',
    ),
    installation: paths.installation,
    capabilities: CAPABILITIES,
  })

  let failedHandshake: boolean

  try {
    const client = await connect()
    client.detach()

    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code

    failedHandshake = code !== 'ENOENT' && code !== 'ECONNREFUSED'
      || code === 'ENOENT' && existsSync(socket)
  }

  let owned = false
  const ownerPath = join(
    paths.directory,
    'owner.json',
  )

  if (existsSync(ownerPath)) {
    let owner: {
      pid: number
      start: string
      installation: string
    }
    let saved: string

    try {
      saved = readFileSync(
        ownerPath,
        'utf8',
      )
      owner = JSON.parse(saved)
    } catch {
      return fail({
        code: 'RECOVERY_REQUIRED',
        message: 'Native host identity is not verifiable',
      })
    }

    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.pid === process.pid
      || typeof owner.start !== 'string' || !owner.start || owner.installation !== paths.installation) {
      return fail({
        code: 'RECOVERY_REQUIRED',
        message: 'Native host identity is not verifiable',
      })
    }

    const start = processStart({ pid: owner.pid })
    let alive = false

    try {
      process.kill(
        owner.pid,
        0,
      )
      alive = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        return fail({
          code: 'RECOVERY_REQUIRED',
          message: 'Native host identity is not verifiable',
        })
      }
    }

    if (alive && start !== owner.start) {
      return fail({
        code: 'RECOVERY_REQUIRED',
        message: 'Native host PID ownership is uncertain',
      })
    }

    if (alive && failedHandshake) {
      const stillOwned = () => {
        try {
          return readFileSync(
            ownerPath,
            'utf8',
          ) === saved && processStart({ pid: owner.pid }) === owner.start
        } catch {
          return false
        }
      }

      if (!stillOwned()) {
        return fail({
          code: 'RECOVERY_REQUIRED',
          message: 'Native host ownership changed during recovery',
        })
      }

      process.kill(
        owner.pid,
        'SIGTERM',
      )
      const deadline = Date.now() + STOP_MS

      while (Date.now() < deadline && stillOwned()) {
        await delay(POLL_MS)
      }

      if (stillOwned()) {
        process.kill(
          owner.pid,
          'SIGKILL',
        )
      }

      const stopped = Date.now() + STOP_MS

      while (Date.now() < stopped && processStart({ pid: owner.pid }) === owner.start) {
        await delay(POLL_MS)
      }

      if (processStart({ pid: owner.pid }) === owner.start) {
        return fail({
          code: 'RECOVERY_REQUIRED',
          message: 'Native host did not stop after failed handshake',
        })
      }
    } else {
      owned = alive
    }
  } else if (failedHandshake) {
    return fail({
      code: 'RECOVERY_REQUIRED',
      message: 'Native host identity is not verifiable',
    })
  }

  if (!owned) {
    const bundle = JSON.parse(readFileSync(
      paths.selected,
      'utf8',
    )).bundle as string
    const manifest = validateBundle({ directory: bundle })
    const entry = join(
      bundle,
      manifest.entry,
    )
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
      child.once(
        'exit',
        (
          code,
          signal,
        ) => {
          try {
            appendFileSync(
              paths.log,
              `${new Date().toISOString()} Native host ${child.pid} exited code=${code} signal=${signal}\n`,
            )
          } catch (error) {
            process.stderr.write(`Native host exit log failed: ${String(error)}\n`)
          }
        },
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
      const client = await connect()
      client.detach()

      return
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
