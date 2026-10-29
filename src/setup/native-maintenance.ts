import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { connectHost, type HostClient } from '#agent-host/client.ts'
import { checked } from '#agent-host/remote.ts'
import { installBundle, selectBundle } from '#agent-host/install.ts'
import { validateBundle } from '#agent-host/bundle.ts'
import { processStart } from '#agent-host/discovery.ts'
import { replaceFile } from '#agent-host/output.ts'
import { fail } from '#agent-host/protocol.ts'
import { ensureNativeHost, nativePaths } from './native-host.ts'
import { nativeServiceFile, setupNativeService } from './service.ts'

const EXIT_MS = 10000
const POLL_MS = 25
export type ReplacementRuntime = {
  stop(): Promise<void>
  start({ bundle }: { bundle: string }): Promise<HostClient>
}

export async function nativeClient() {
  const paths = nativePaths()

  return connectHost({
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
    capabilities: ['quiescent-maintenance'],
  })
}

export async function drainNative({ client }: { client: HostClient }) {
  const attached = checked({
    result: await client.call({
      id: randomUUID(),
      operation: {
        kind: 'attach',
        scope: { kind: 'host' },
        expectedRevision: client.ready.hostControllerRevision,
      },
    }),
  })

  if (attached.kind !== 'attached') {
    throw new Error('Missing native maintenance controller')
  }

  const controller = attached.control.generation
  const result = checked({
    result: await client.call({
      id: randomUUID(),
      operation: {
        kind: 'drain',
        controller,
      },
    }),
  })

  if (result.kind !== 'maintenance' || !result.status.drain) {
    throw new Error('Missing native drain barrier')
  }

  return {
    controller,
    status: result.status,
  }
}

export async function replaceNative({
  client,
  candidate,
  previous,
  selected,
  marker,
  ownerPath,
  runtime,
}: {
  client: HostClient
  candidate: string
  previous: string
  selected: string
  marker: string
  ownerPath: string
  runtime: ReplacementRuntime
}) {
  validateBundle({ directory: candidate })
  validateBundle({ directory: previous })
  const {
    controller,
    status,
  } = await drainNative({ client })
  replaceFile({
    path: marker,
    text: JSON.stringify({
      instance: client.ready.instance,
      candidate,
      previous,
    }),
  })
  const result = checked({
    result: await client.call({
      id: randomUUID(),
      operation: {
        kind: 'shutdown',
        controller,
        drain: status.drain!,
        when: 'quiescent',
      },
    }),
  })

  if (result.kind === 'maintenance') {
    return {
      state: 'draining' as const,
      status: result.status,
    }
  }

  if (result.kind !== 'shutdown') {
    throw new Error('Native shutdown was not established')
  }

  const owner = existsSync(ownerPath) ? JSON.parse(readFileSync(
    ownerPath,
    'utf8',
  )) as {
    pid: number
    start: string
  } : undefined
  const deadline = Date.now() + EXIT_MS

  while (owner && processStart({ pid: owner.pid }) === owner.start) {
    if (Date.now() >= deadline) {
      fail({
        code: 'MAINTENANCE_PENDING',
        message: 'The drained native owner has not exited; no replacement was started',
      })
    }

    await delay(POLL_MS)
  }

  client.detach()
  await runtime.stop()
  selectBundle({
    path: selected,
    bundle: candidate,
  })
  let replacement: HostClient | undefined
  let ownershipUnknown = false

  try {
    replacement = await runtime.start({ bundle: candidate })

    if (!replacement.ready.capabilities.includes('quiescent-maintenance') || replacement.ready.ledger === 'recovery_required' && !replacement.ready.predecessor) {
      fail({
        code: 'INCOMPATIBLE_HOST',
        message: 'The replacement cannot prove a clean compatible handoff',
      })
    }

    if (replacement.ready.sessions.some(session => session.phase !== 'closed' && session.phase !== 'failed')) {
      ownershipUnknown = true
      fail({
        code: 'RECOVERY_REQUIRED',
        message: 'Unexpected native ownership after replacement',
      })
    }

    replacement.detach()
    rmSync(
      marker,
      { force: true },
    )

    return {
      state: 'replaced' as const,
      build: replacement.ready.build,
    }
  } catch (error) {
    replacement?.detach()

    if (ownershipUnknown) {
      throw error
    }

    await runtime.stop()
    selectBundle({
      path: selected,
      bundle: previous,
    })
    const restored = await runtime.start({ bundle: previous })
    restored.detach()
    rmSync(
      marker,
      { force: true },
    )

    return {
      state: 'rolled_back' as const,
      error: error instanceof Error ? error.message : 'Replacement did not become ready',
    }
  }
}

export async function maintainNative({ source }: { source: string }) {
  const paths = nativePaths()
  const candidate = installBundle({
    source,
    directory: paths.bundles,
  })
  const previous = JSON.parse(readFileSync(
    paths.selected,
    'utf8',
  )).bundle as string
  const service = nativeServiceFile()
  const installed = existsSync(service.path)
  let runningJob = installed

  const job = ({ start }: { start: boolean }) => {
    if (!installed) {
      return
    }

    if (!start && !runningJob) {
      return
    }

    if (start) {
      const bundle = JSON.parse(readFileSync(
        paths.selected,
        'utf8',
      )).bundle as string
      const manifest = validateBundle({ directory: bundle })
      setupNativeService({
        replace: true,
        nativeBundle: () => ({
          ...paths,
          bundle,
          entry: join(
            bundle,
            manifest.entry,
          ),
        }),
      })
      runningJob = true
    } else if (process.platform === 'darwin') {
      execFileSync(
        'launchctl',
        [
          'bootout',
          `gui/${process.getuid!()}/${service.label}`,
        ],
        { stdio: 'pipe' },
      )
    } else {
      execFileSync(
        'systemctl',
        [
          '--user',
          'stop',
          `${service.label}.service`,
        ],
        { stdio: 'pipe' },
      )
    }

    if (!start) {
      runningJob = false
    }
  }

  const client = await nativeClient()

  try {
    return await replaceNative({
      client,
      candidate,
      previous,
      selected: paths.selected,
      marker: join(
        paths.directory,
        'maintenance.json',
      ),
      ownerPath: join(
        paths.directory,
        'owner.json',
      ),
      runtime: {
        async stop() {
          job({ start: false })

          if (installed) {
            return
          }

          const ownerPath = join(
            paths.directory,
            'owner.json',
          )

          if (!existsSync(ownerPath)) {
            return
          }

          const owner = JSON.parse(readFileSync(
            ownerPath,
            'utf8',
          )) as {
            pid: number
            start: string
          }

          if (processStart({ pid: owner.pid }) === owner.start) {
            process.kill(
              owner.pid,
              'SIGTERM',
            )
            const deadline = Date.now() + EXIT_MS

            while (processStart({ pid: owner.pid }) === owner.start) {
              if (Date.now() >= deadline) {
                fail({
                  code: 'MAINTENANCE_PENDING',
                  message: 'The isolated replacement did not stop; rollback remains blocked',
                })
              }

              await delay(POLL_MS)
            }
          }
        },
        async start() {
          job({ start: true })
          const native = await ensureNativeHost({
            source,
            maintenance: true,
            launch: !installed,
          })

          return native.client
        },
      },
    })
  } finally {
    client.detach()
  }
}
