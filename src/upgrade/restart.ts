import { AxiError } from 'axi-sdk-js'
import { hydraDir, hydraIds } from '#app/home-migration.ts'
import { infoPath, processStart, type ServerInfo } from '#app/server-state.ts'
import { nativePaths } from '#setup/native-host.ts'
import { selectBundle } from '#agent-host/install.ts'
import { PNYX_ROOT } from './runner.ts'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serviceFile } from '#setup/service.ts'
import { pnyxHome } from '#store/storage.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { Socket } from 'node:net'

// Sent to a running `pnyx-axi serve` to close it and start it again on the code now on disk.
export const RESTART_SIGNAL = 'SIGUSR2'
const NATIVE_IDLE_WAIT_MS = 5000

export function prepareNativeRestart({ force = false }: { force?: boolean } = {}) {
  const paths = nativePaths()

  if (!existsSync(paths.selected)) {
    return
  }

  const selected = JSON.parse(readFileSync(
    paths.selected,
    'utf8',
  )) as { bundle: string }
  const ledgerPath = join(
    paths.directory,
    'ledger.json',
  )
  let restartInstance: string | undefined

  if (existsSync(ledgerPath)) {
    try {
      const ledger = JSON.parse(readFileSync(
        ledgerPath,
        'utf8',
      )) as { instance?: unknown }

      if (typeof ledger.instance === 'string') {
        restartInstance = ledger.instance
      }
    } catch (error) {
      console.error(
        'Native host restart identity unavailable:',
        error,
      )
    }
  }

  selectBundle({
    path: paths.selected,
    bundle: selected.bundle,
    restartInstance,
    restartDeadline: force && restartInstance ? Date.now() + NATIVE_IDLE_WAIT_MS : undefined,
  })
}

const STOP_MS = 5000
const START_MS = 45000
const POLL_MS = 100

type Running = {
  info: ServerInfo
  start: string
}

function running({ hydraId }: { hydraId: string }): Running | undefined {
  let info: ServerInfo

  try {
    info = JSON.parse(readFileSync(
      infoPath({ hydraId }),
      'utf8',
    ))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }

    throw error
  }

  if (!Number.isSafeInteger(info.pid) || info.pid <= 0 || info.pid === process.pid) {
    throw new AxiError(
      'The application process identity is not verifiable',
      'SERVER_UNAVAILABLE',
    )
  }

  const start = processStart({ pid: info.pid })

  if (!start) {
    return undefined
  }

  let claim: {
    pid?: number
    processStart?: string
  }

  try {
    claim = JSON.parse(readFileSync(
      join(
        hydraDir({ hydraId }),
        'server.lock',
      ),
      'utf8',
    ))
  } catch {
    throw new AxiError(
      'The application process identity is not verifiable',
      'SERVER_UNAVAILABLE',
    )
  }

  if (claim.pid !== info.pid || claim.processStart !== start) {
    throw new AxiError(
      'The application process identity is not verifiable',
      'SERVER_UNAVAILABLE',
    )
  }

  return {
    info,
    start,
  }
}

async function waitFor({
  check,
  timeout,
}: {
  check(): boolean | Promise<boolean>
  timeout: number
}) {
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    if (await check()) {
      return true
    }

    await delay(POLL_MS)
  }

  return false
}

function launch({ args }: { args: string[] }) {
  const log = openSync(
    join(
      pnyxHome(),
      'service.log',
    ),
    'a',
    0o600,
  )

  try {
    const child = spawn(
      process.execPath,
      [
        join(
          PNYX_ROOT,
          'dist/cli/pnyx-axi.js',
        ),
        ...args,
      ],
      {
        detached: true,
        env: {
          ...process.env,
          PNYX_ACTOR: 'cli',
        },
        stdio: [
          'ignore',
          log,
          log,
        ],
      },
    )
    child.on(
      'error',
      error => process.stderr.write(`Pnyx start failed: ${error.message}\n`),
    )
    child.unref()
  } finally {
    closeSync(log)
  }
}

export function requestRestart({ force }: { force: boolean }) {
  const log = openSync(
    join(
      pnyxHome(),
      'service.log',
    ),
    'a',
    0o600,
  )
  let child: ReturnType<typeof spawn>

  try {
    child = spawn(
      process.execPath,
      [
        join(
          PNYX_ROOT,
          'dist/cli/pnyx-axi.js',
        ),
        'restart',
      ],
      {
        detached: true,
        env: {
          ...process.env,
          PNYX_ACTOR: 'cli',
          PNYX_RESTART_SAFE: force ? '0' : '1',
        },
        stdio: [
          'ignore',
          'pipe',
          log,
        ],
      },
    )
  } finally {
    closeSync(log)
  }

  child.unref()
  let output = ''

  if (child.stdout instanceof Socket) {
    child.stdout.unref()
  }

  child.stdout?.on(
    'data',
    chunk => {
      output = (output + String(chunk)).slice(-8192)
    },
  )

  return new Promise<void>((
    resolve,
    reject,
  ) => {
    child.once(
      'error',
      reject,
    )
    child.once(
      'close',
      code => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(output.trim() || 'The restart process failed'))
        }
      },
    )
  })
}

export async function restartPnyx({ force = false }: { force?: boolean } = {}) {
  const ids = [
    ...new Set([
      'default',
      ...hydraIds(),
    ]),
  ]
  const found = ids.map(hydraId => running({ hydraId }))
    .filter((item): item is Running => item !== undefined)
  const unique = [
    ...new Map(found.map(item => [
      item.info.pid,
      item,
    ])).values(),
  ]
  const target = unique[0]
  const managed = target ? target.info.service ?? existsSync(serviceFile().path) : false
  prepareNativeRestart({ force })

  for (const item of unique) {
    if (processStart({ pid: item.info.pid }) === item.start) {
      process.kill(
        item.info.pid,
        RESTART_SIGNAL,
      )
    }
  }

  const stopped = () => unique.every(item => processStart({ pid: item.info.pid }) !== item.start)

  if (!await waitFor({
    check: stopped,
    timeout: STOP_MS,
  })) {
    for (const item of unique) {
      if (processStart({ pid: item.info.pid }) === item.start) {
        process.kill(
          item.info.pid,
          'SIGKILL',
        )
      }
    }

    if (!await waitFor({
      check: stopped,
      timeout: STOP_MS,
    })) {
      throw new AxiError(
        'The application did not stop',
        'SERVER_UNAVAILABLE',
      )
    }
  }

  const ready = async () => {
    for (const hydraId of ids) {
      let candidate: Running | undefined

      try {
        candidate = running({ hydraId })
      } catch {
        continue
      }

      if (!candidate) {
        continue
      }

      const {
        info,
        start,
      } = candidate

      if (unique.some(item => item.info.pid === info.pid && item.start === start)) {
        continue
      }

      try {
        const response = await fetch(
          `http://127.0.0.1:${candidate.info.port}/hydra/${encodeURIComponent(hydraId)}/health`,
          {
            signal: AbortSignal.timeout(1000),
          },
        )
        const health = await response.json() as {
          pid?: number
          hydraId?: string
        }

        if (response.ok && health.pid === candidate.info.pid && health.hydraId === hydraId) {
          return true
        }
      } catch { /* The new application is not ready yet. */ }
    }

    return false
  }

  if (!managed) {
    const args = [
      'serve',
      ...target?.info.serveArgs ?? [],
    ]

    if (target?.info.port !== undefined && !target.info.serveArgs?.some(arg => arg === '--port' || arg.startsWith('--port='))) {
      args.push(
        '--port',
        String(target.info.port),
      )
    }

    launch({ args })
  }

  const started = await waitFor({
    check: ready,
    timeout: START_MS,
  })

  if (!started) {
    throw new AxiError(
      'The application did not become ready after restart',
      'SERVER_UNAVAILABLE',
      ['Read service.log in PNYX_HOME'],
    )
  }

  return {
    server: unique.length ? 'restarting: ready' : 'starting: ready',
    native: force ? 'restarts when idle or forces verified host recovery after a short wait' : 'restarts when idle and outcomes are applied',
  }
}

export const RESTART_HELP = `usage: pnyx-axi restart
Restart the application on its current code, or start it if stopped. The native host switches bundles when idle; after a short wait, a verified busy host is stopped and its sessions recover as after a crash.
A stuck application is stopped only when its process identity is verified; restart confirms the replacement is ready. A host that fails its handshake or stalls on claim or status is stopped only when its identity is verified. Its sessions then recover as after a crash; an unverified owner remains pending.
No upgrade, model call or agent instruction is involved. /restart in Hydra's composer does the same.
`

// eslint-disable-next-line pnyx/object-params -- runAxiCli owns the command signature.
export async function restart(args: string[]): Promise<Record<string, unknown>> {
  if (args.length) {
    throw new AxiError(
      'restart takes no arguments',
      'VALIDATION_ERROR',
      ['Run `pnyx-axi restart`'],
    )
  }

  const actor = process.env.PNYX_ACTOR ?? 'cli'

  if (actor !== 'cli' && actor !== 'owner') {
    throw new AxiError(
      'Only the owner can restart Pnyx',
      'OWNER_ONLY',
    )
  }

  return restartPnyx({ force: process.env.PNYX_RESTART_SAFE !== '1' })
}
