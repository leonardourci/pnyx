import { readCommand } from '#cli/reads.ts'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serverOperation } from './operations.ts'
import { WebSocket } from 'ws'
import { afterAll } from 'vitest'
import { startServer } from '#app/server-daemon.ts'
import { localToken } from '#app/server-state.ts'
import type { RunningServer, ServerMessage } from '#app/server-transport.ts'
import { query } from '#store/postgres.ts'
import { writeDocument } from '#workers/dispatch-config.ts'
import { fakeClaude, fakeCodex, type AgentSession } from './agents.ts'

export type { AgentSession }

export const CLI = join(
  import.meta.dirname,
  '..',
  '..',
  'dist',
  'cli',
  'pnyx.js',
)
// Waits end as soon as their condition holds; the bound only has to outlast a loaded machine.
const WAIT_MS = 20_000
const POLL_MS = 20

export async function until<T>({
  what,
  check,
  timeoutMs = WAIT_MS,
}: {
  what: string
  check: () => T | undefined | false | Promise<T | undefined | false>
  timeoutMs?: number
}): Promise<T> {
  const end = performance.now() + timeoutMs
  let value = await check()

  while (value === undefined || value === false) {
    if (performance.now() > end) {
      throw new Error(`timed out waiting for ${what} (last: ${String(value)})`)
    }

    await new Promise(resolve => setTimeout(
      resolve,
      POLL_MS,
    ))
    value = await check()
  }

  return value
}

export interface Run {
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export function pnyx({
  args,
  env,
  input,
}: {
  args: string[]
  env: NodeJS.ProcessEnv
  input?: string
}): Promise<Run> {
  return new Promise((
    resolve,
    reject,
  ) => {
    const child = spawn(
      process.execPath,
      [
        CLI,
        ...args,
      ],
      {
        env,
        timeout: WAIT_MS,
      },
    )
    child.stdin.end(input)
    let stdout = ''
    let stderr = ''
    child.stdout.on(
      'data',
      data => stdout += String(data),
    )
    child.stderr.on(
      'data',
      data => stderr += String(data),
    )
    child.once(
      'error',
      reject,
    )
    child.once(
      'close',
      (
        status,
        signal,
      ) => resolve({
        status,
        signal,
        stdout,
        stderr,
      }),
    )
  })
}

export const operation = async ({
  args,
  env,
  input,
}: {
  args: string[]
  env: NodeJS.ProcessEnv
  input?: string
}): Promise<Run> => {
  const options = {
    args,
    env,
    input,
  }

  if ([
    'setup',
    'serve',
  ].includes(options.args[0] ?? '')) {
    const result = await pnyx({
      ...options,
      args: [
        ...options.args,
        '--json',
      ],
    })

    return {
      ...result,
      stdout: result.stdout || result.stderr,
    }
  }

  if (args[0] === 'hydra' && args[1] === 'digest') {
    return pnyx(options)
  }

  if (readCommand({ argv: args })) {
    const result = await pnyx({
      ...options,
      args: [
        ...args,
        '--json',
      ],
    })

    return {
      ...result,
      stdout: result.stdout || result.stderr,
    }
  }

  if (options.args.includes('--help')) {
    return pnyx(options)
  }

  return serverOperation(options)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- every command prints its own shape.
export type Output = Record<string, any>

export const parsed = ({ stdout }: { stdout: string }): Output =>
  JSON.parse(stdout.trimEnd()) as Output

// Rows of this file's own database, for the facts a command saved.
export function rows<Row = Record<string, unknown>>({
  text,
  values,
}: {
  text: string
  values?: unknown[]
}): Row[] {
  return query({
    statements: [
      {
        text,
        values,
      },
    ],
  })[0] as Row[]
}

// The owner's terminal: no agent identity.
const ownerEnv = () => {
  const env = { ...process.env }
  delete env.PNYX_ACTOR
  delete env.PNYX_TASK
  delete env.PNYX_HYDRA

  return env
}

// Logins for both harnesses and a quota-axi that reports them usable.
function fakeLogins({ root }: { root: string }) {
  const bin = join(
    root,
    'bin',
  )
  const claude = join(
    root,
    'claude-login',
  )
  const codex = join(
    root,
    'codex-login',
  )

  for (const folder of [
    bin,
    claude,
    codex,
  ]) {
    mkdirSync(
      folder,
      { recursive: true },
    )
  }

  const quota = join(
    bin,
    'quota-axi',
  )
  writeFileSync(
    quota,
    `#!/usr/bin/env node
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const provider = process.argv[process.argv.indexOf('--provider') + 1]
// A login folder holding a file named \`exhausted\` has no quota left.
const folder = process.env.CLAUDE_CONFIG_DIR ?? process.env.CODEX_HOME ?? ''
const spent = existsSync(join(folder, 'exhausted'))
const effectiveAvailability = spent ? [{ scope: 'all_models', status: 'known', effectivePercentRemaining: 0 }] : []
if (process.argv.includes('models')) console.log('{}')
else console.log(JSON.stringify({ providers: [{ provider, state: { status: 'fresh', authStatus: 'usable' }, quotaSemantics: { effectiveAvailability } }] }))
`,
  )
  chmodSync(
    quota,
    0o755,
  )
  process.env.PATH = `${bin}:${process.env.PATH}`
  writeDocument({
    document: {
      rules: {},
      main: 'claude:test',
      default: [{ harness: 'claude' }],
      workers: {
        claude: ['claude:test'],
        codex: ['codex:test'],
      },
      projects: {},
      accounts: {
        'claude:test': {
          provider: 'claude',
          folder: claude,
        },
        'codex:test': {
          provider: 'codex',
          folder: codex,
        },
      },
    },
  })
}

export interface PnyxOptions {
  codexConfig?: Record<string, unknown>
  zeroCache?: boolean
  upgradeRoot?: string
  restart?(): void | Promise<void>
}

export type Pnyx = Awaited<ReturnType<typeof startPnyx>>

// Starts the server once for a test file; it stops when the file ends.
export async function startPnyx({
  zeroCache = false,
  codexConfig,
  upgradeRoot,
  restart,
}: PnyxOptions = {}) {
  const root = join(
    process.env.TMPDIR!,
    'pnyx-run',
  )
  mkdirSync(
    root,
    { recursive: true },
  )
  fakeLogins({ root })
  const claude = fakeClaude()
  const codex = fakeCodex({ config: codexConfig })
  let server: RunningServer | undefined
  let hydras = 0
  // Kept across stops, so an open page reconnects to the server that replaces this one.
  let port: number | undefined

  const start = async () => {
    server = await startServer({
      port,
      query: claude.query,
      spawnCodex: codex.spawnCodex,
      wakeDelay: 50,
      // Retries wait longer than a test file, so only the owner's messages try a failed start again.
      retryDelays: [600_000],
      followDelay: 100,
      recoveryPause: 100,
      zeroCache,
      upgradeRoot: upgradeRoot ?? join(
        root,
        'no-upgrade-folder',
      ),
      restart,
    })
    port = server.port
  }

  const stop = async () => {
    await server?.close()
    server = undefined
  }

  await start()
  afterAll(stop)

  const sessions = () => [
    ...claude.sessions,
    ...codex.sessions,
  ]

  return {
    claude,
    codex,
    port: () => server!.port,
    // Stops the server and starts it again on the same home and port, as a restart does.
    restart: async ({ whileStopped }: { whileStopped?(): void | Promise<void> } = {}) => {
      await stop()
      await whileStopped?.()
      await start()
    },
    start,
    stop,
    // A Hydra of its own, created through the CLI and served once the server mounts it.
    hydra: async ({
      id = `h${++hydras}`,
      create = true,
    }: {
      id?: string
      create?: boolean
    } = {}) => {
      const hydra = hydraClient({
        hydraId: id,
        root,
        sessions,
        port: () => server!.port,
      })

      if (create) {
        await hydra.owner({
          args: [
            'hydra',
            'create',
            id,
            '--helper',
            'off',
          ],
        })
      }

      await server!.open({ id })

      return hydra
    },
  }
}

export type Hydra = ReturnType<typeof hydraClient>

function hydraClient({
  hydraId,
  root,
  sessions,
  port,
}: {
  hydraId: string
  root: string
  sessions: () => AgentSession[]
  port: () => number
}) {
  const cli = ({
    args,
    env,
    input,
  }: {
    args: string[]
    env: NodeJS.ProcessEnv
    input?: string
  }) => operation({
    args: [
      ...args,
      '--hydra',
      hydraId,
    ],
    env,
    input,
  })

  const succeeds = async ({
    args,
    env,
    input,
  }: {
    args: string[]
    env: NodeJS.ProcessEnv
    input?: string
  }) => {
    const run = await cli({
      args,
      env,
      input,
    })

    if (run.status !== 0) {
      const outcome = run.status === null ? `signal ${run.signal}` : `status ${run.status}`

      throw new Error(`pnyx ${args.join(' ')} exited with ${outcome}:\n${run.stdout}${run.stderr}`)
    }

    return parsed(run)
  }

  const refused = async ({
    args,
    env,
    input,
  }: {
    args: string[]
    env: NodeJS.ProcessEnv
    input?: string
  }) => {
    const run = await cli({
      args,
      env,
      input,
    })

    if (run.status === 0) {
      throw new Error(`pnyx ${args.join(' ')} succeeded:\n${run.stdout}`)
    }

    const output = parsed(run)

    return {
      status: run.status,
      code: output.code as string | undefined,
      error: output.error as string | undefined,
      help: output.help as string[] | undefined,
    }
  }

  const agent = ({
    cwd,
    hydra,
  }: {
    cwd?: string
    hydra?: boolean
  }) => until({
    what: cwd ? `an agent in ${cwd}` : `Hydra ${hydraId}'s agent`,
    check: () => sessions().findLast(s => s.env.PNYX_HYDRA === hydraId
      && (hydra ? s.env.PNYX_ACTOR === 'hydra' : s.cwd === cwd)),
  })

  const folder = ({ name }: { name: string }) => {
    const path = join(
      root,
      hydraId,
      name,
    )
    mkdirSync(
      path,
      { recursive: true },
    )

    return path
  }

  const owner = ({
    args,
    input,
  }: {
    args: string[]
    input?: string
  }) => succeeds({
    args,
    input,
    env: ownerEnv(),
  })

  // The id of the column with this role on the Hydra's board.
  const column = async ({ role }: { role: 'queued' | 'in_progress' | 'needs_you' | 'parked' | 'done' }) => (await owner({
    args: [
      'column',
      'list',
    ],
  })).columns.find((candidate: { role: string }) => candidate.role === role).id as string

  // The task as `task show` prints it.
  const task = async ({ key }: { key: string }) => (await owner({
    args: [
      'task',
      'show',
      key,
    ],
  })).task

  // Creates a task in its own folder, starts its worker and waits for the worker's first turn.
  const startTask = async ({
    key,
    harness = 'claude',
  }: {
    key: string
    harness?: 'claude' | 'codex'
  }) => {
    const path = folder({ name: key })
    await owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        `Task ${key}`,
        '--key',
        key,
        '--folder',
        path,
        '--brief',
        `Brief for ${key}`,
      ],
    })
    await owner({
      args: [
        'task',
        'start',
        key,
        '--harness',
        harness,
      ],
    })
    const worker = await agent({ cwd: path })
    await until({
      what: `${key}'s first turn`,
      check: () => worker.answered === 1,
    })

    return {
      folder: path,
      worker,
    }
  }

  return {
    id: hydraId,
    folder,
    column,
    task,
    startTask,
    owner,
    ownerRefused: ({
      args,
      input,
    }: {
      args: string[]
      input?: string
    }) => refused({
      args,
      input,
      env: ownerEnv(),
    }),
    as: ({
      session,
      env = session.env,
    }: {
      session: AgentSession
      env?: NodeJS.ProcessEnv
    }) => ({
      run: ({
        args,
        input,
      }: {
        args: string[]
        input?: string
      }) => succeeds({
        args,
        env,
        input,
      }),
      refused: ({
        args,
        input,
      }: {
        args: string[]
        input?: string
      }) => refused({
        args,
        env,
        input,
      }),
    }),
    agent,
    // The owner writes in Hydra's chat; resolves with Hydra's session once it heard the text.
    chat: async ({ text }: { text: string }) => {
      const before = new Map(sessions().map(session => [
        session,
        session.received.length,
      ]))
      const sent = await pnyx({
        args: [
          'send',
          '--text',
          text,
          '--hydra',
          hydraId,
          '--json',
        ],
        env: ownerEnv(),
      })

      if (sent.status !== 0) {
        throw new Error(`Hydra send failed: ${sent.stderr}`)
      }

      return until({
        what: `Hydra to hear "${text}"`,
        check: () => sessions().findLast(session => session.env.PNYX_HYDRA === hydraId
          && session.env.PNYX_ACTOR === 'hydra'
          && session.received.slice(before.get(session) ?? 0).some(heard => heard.endsWith(text) || heard.includes(`${text}\n<pnyx-wake>`))),
      })
    },
    page: ({ cards }: { cards?: string[] } = {}) => openPage({
      port: port(),
      hydraId,
      cards,
    }),
  }
}

// The owner's page over its WebSocket, sending commands as the page does.
export async function openPage({
  port,
  hydraId,
  cards,
  token = localToken(),
  receive,
}: {
  port: number
  hydraId: string
  cards?: string[]
  token?: string
  receive?({ message }: { message: ServerMessage }): void
}) {
  const opened = cards ? `&page=${encodeURIComponent(JSON.stringify(cards))}` : ''
  const socket = new WebSocket(`ws://127.0.0.1:${port}/hydra/${hydraId}/ws?token=${token}${opened}`)
  const answers = new Map<string, ServerMessage>()
  socket.on(
    'message',
    (data: unknown) => {
      const message = JSON.parse(String(data)) as ServerMessage
      receive?.({ message })

      if ((message.type === 'receipt' || message.type === 'error') && message.id) {
        answers.set(
          message.id,
          message,
        )
      }
    },
  )
  await new Promise((
    resolve,
    reject,
  ) => {
    socket.once(
      'open',
      resolve,
    )
    socket.once(
      'error',
      reject,
    )
  })

  const send = ({
    name,
    args,
  }: {
    name: string
    args: string[]
  }) => {
    const id = `page-${randomUUID()}`
    socket.send(JSON.stringify({
      type: 'command',
      id,
      name,
      args,
    }))

    return until({
      what: `the answer to ${name} ${args.join(' ')}`,
      check: () => answers.get(id),
    })
  }

  return {
    send,
    close: () => socket.close(),
  }
}
