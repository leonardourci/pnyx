import { AxiError } from 'axi-sdk-js'
import { INHERITED } from '#workers/host.ts'
import { AUTH_ENV } from '#workers/dispatch.ts'
import { IDENTITY } from '#app/request-context.ts'
import { infoPath, processStart, type ServerInfo } from '#app/server-state.ts'
import { PNYX_ROOT } from './runner.ts'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serviceFile, startService } from '#setup/service.ts'
import { pnyxHome } from '#store/storage.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { Socket } from 'node:net'
import { requestEnv } from '#app/request-context.ts'

// Sent to a running `pnyx-axi serve` to close it and start it again on the code now on disk.
export const RESTART_SIGNAL = 'SIGUSR2'

// A server Pnyx starts never takes the caller's Pnyx or terminal identity, nor a worker's or Hydra's login,
// so its agents get the owner's environment plus what their card names.
export function serverEnvironment(): NodeJS.ProcessEnv {
  const actor = process.env.PNYX_ACTOR ?? ''
  const agent = /^(worker:|helper:|hydra$)/.test(actor) || process.env.PNYX_HOSTED !== undefined
    || process.env.PNYX_TASK !== undefined

  // Pnyx's own settings, such as PNYX_HOME, stay; only who the caller is and its terminal go.
  const identity = ({ name }: { name: string }) => INHERITED.test(name)
    && (!name.startsWith('PNYX_') || (IDENTITY as readonly string[]).includes(name))

  return Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !identity({ name }) && !(agent && AUTH_ENV.test(name))))
}

const STOP_MS = 5000
const START_MS = 120000
const POLL_MS = 100
// How often an upgrade from a terminal asks whether an agent is still mid-turn.
const IDLE_POLL_MS = 1000

type Running = {
  info: ServerInfo
  start: string
}

function running(): Running | undefined {
  let info: ServerInfo

  try {
    info = JSON.parse(readFileSync(
      infoPath(),
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
        pnyxHome(),
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
          ...serverEnvironment(),
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

export function requestRestart() {
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
          ...serverEnvironment(),
          PNYX_ACTOR: 'cli',
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

// A running server's agents get to finish their turns before an upgrade restarts it: this waits until none is
// mid-turn, or until the deadline. With no server running there is nothing to wait for.
export async function untilAgentsIdle({ deadline }: { deadline: number }) {
  while (Date.now() < deadline) {
    const found = running()

    if (!found) {
      return
    }

    try {
      const response = await fetch(
        `http://127.0.0.1:${found.info.port}/health`,
        { signal: AbortSignal.timeout(POLL_MS * 10) },
      )
      const health = await response.json() as { midTurn?: boolean }

      if (!health.midTurn) {
        return
      }
    } catch {
      // A server that does not answer has no agent to wait for; restart deals with it.
      return
    }

    await delay(IDLE_POLL_MS)
  }
}

export async function restartPnyx() {
  const found = running()
  const unique = found ? [found] : []
  const target = found
  const installed = existsSync(serviceFile().path)
  // A running server says whether its service started it; with none running, an installed service starts the next.
  const managed = target ? target.info.service ?? installed : installed

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
    let candidate: Running | undefined

    try {
      candidate = running()
    } catch {
      return false
    }

    const replaced = unique.some(item =>
      item.info.pid === candidate?.info.pid && item.start === candidate.start)

    if (!candidate || replaced) {
      return false
    }

    try {
      const response = await fetch(
        `http://127.0.0.1:${candidate.info.port}/health`,
        { signal: AbortSignal.timeout(1000) },
      )
      const health = await response.json() as { pid?: number }

      return response.ok && health.pid === candidate.info.pid
    } catch {
      // The new application is not ready yet.
      return false
    }
  }

  if (managed && !target) {
    await startService()
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
  }
}

export const RESTART_HELP = `usage: pnyx-axi restart
Restart the application on its current code, or start it if stopped. Its agents stop with it; on start, a turn the restart cut resumes once from its saved session.
A stuck application is stopped only when its process identity is verified; restart confirms the replacement is ready.
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

  const actor = requestEnv().PNYX_ACTOR ?? 'cli'

  if (actor !== 'cli' && actor !== 'owner') {
    throw new AxiError(
      'Only the owner can restart Pnyx',
      'OWNER_ONLY',
    )
  }

  return restartPnyx()
}
