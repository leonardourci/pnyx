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
  await startNativeHost({
    source,
    paths,
  })

  return nativeProviders({
    ...paths,
    reconnect: () => startNativeHost({
      source,
      paths,
    }),
  })
}

async function startNativeHost({
  source,
  paths,
}: {
  source: string
  paths: ReturnType<typeof nativePaths>
}) {
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

    return
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
