// The real server in the test's process, fake agents at the provider boundary, driven through pnyx-axi and the page's socket.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decode } from '@toon-format/toon'
import { WebSocket } from 'ws'
import { afterAll } from 'vitest'
import { startServer } from '#app/server-daemon.ts'
import { localToken } from '#app/server-state.ts'
import type { RunningServer, ServerMessage } from '#app/server-transport.ts'
import { query } from '#store/postgres.ts'
import { writeDocument } from '#workers/dispatch-config.ts'
import { fakeClaude, fakeCodex, type AgentSession } from './agents.ts'

export type { AgentSession }

const CLI = join(
  import.meta.dirname,
  '..',
  '..',
  'dist',
  'cli',
  'pnyx-axi.js',
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
  stdout: string
  stderr: string
}

// One `pnyx-axi` process. Async, so the server in this process keeps answering it.
export function pnyxAxi({
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
      status => resolve({
        status,
        stdout,
        stderr,
      }),
    )
  })
}

// The CLI's TOON output as data; each test reads the fields of the command it ran.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- every command prints its own shape.
export type Output = Record<string, any>

export const parsed = ({ stdout }: { stdout: string }): Output => decode(stdout.trimEnd()) as Output

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
  zeroCache?: boolean
  upgradeRoot?: string
  restart?(): void | Promise<void>
}

export type Pnyx = Awaited<ReturnType<typeof startPnyx>>

// Starts the server once for a test file; it stops when the file ends.
export async function startPnyx({
  zeroCache = false,
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
  const codex = fakeCodex()
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

  await start()
  afterAll(async () => {
    await server?.close()
  })

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
      await server?.close()
      server = undefined
      await whileStopped?.()
      await start()
    },
    start,
    // A Hydra of its own, created through the CLI and served once the server mounts it.
    hydra: async ({ id = `h${++hydras}` }: { id?: string } = {}) => {
      const hydra = hydraClient({
        hydraId: id,
        root,
        sessions,
        port: () => server!.port,
      })
      await hydra.owner({
        args: [
          'hydra',
          'create',
          id,
          '--helper',
          'off',
        ],
      })
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
  }) => pnyxAxi({
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
      throw new Error(`pnyx-axi ${args.join(' ')} exited ${run.status}:\n${run.stdout}${run.stderr}`)
    }

    return parsed(run)
  }

  // A refusal's code and error, as pnyx-axi prints them.
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
      throw new Error(`pnyx-axi ${args.join(' ')} succeeded:\n${run.stdout}`)
    }

    const output = parsed(run)

    return {
      status: run.status,
      code: output.code as string | undefined,
      error: output.error as string | undefined,
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

  return {
    id: hydraId,
    folder,
    owner: ({
      args,
      input,
    }: {
      args: string[]
      input?: string
    }) => succeeds({
      args,
      input,
      env: ownerEnv(),
    }),
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
    // pnyx-axi as an agent runs it, with the environment Pnyx started that agent with.
    as: ({ session }: { session: AgentSession }) => ({
      run: ({ args }: { args: string[] }) => succeeds({
        args,
        env: session.env,
      }),
      refused: ({ args }: { args: string[] }) => refused({
        args,
        env: session.env,
      }),
    }),
    agent,
    // The owner writes in Hydra's chat; resolves with Hydra's session once it heard the text.
    chat: async ({ text }: { text: string }) => {
      const before = new Map(sessions().map(session => [
        session,
        session.received.length,
      ]))
      await succeeds({
        args: [
          'hydra',
          'send',
          '--text',
          text,
        ],
        env: ownerEnv(),
      })

      return until({
        what: `Hydra to hear "${text}"`,
        check: () => sessions().findLast(session => session.env.PNYX_HYDRA === hydraId
          && session.env.PNYX_ACTOR === 'hydra'
          && session.received.slice(before.get(session) ?? 0).some(heard => heard.includes(text))),
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
}: {
  port: number
  hydraId: string
  cards?: string[]
  token?: string
}) {
  const opened = cards ? `&page=${encodeURIComponent(JSON.stringify(cards))}` : ''
  const socket = new WebSocket(`ws://127.0.0.1:${port}/hydra/${hydraId}/ws?token=${token}${opened}`)
  const answers = new Map<string, ServerMessage>()
  socket.on(
    'message',
    (data: unknown) => {
      const message = JSON.parse(String(data)) as ServerMessage

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
