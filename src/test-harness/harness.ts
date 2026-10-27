// The scenario harness: one disposable Pnyx per test file, a fresh Hydra per scenario, real
// `pnyx-axi` subprocesses, and fake agents replaying recorded sessions. See test/README.md.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before } from 'node:test'
import { WebSocket } from 'ws'
import type { HydraEvent, HydraState } from '../core/model.ts'
import { emptyHydra, reduce } from '../core/reducer.ts'
import { startServer, type RunningServer, type ServerMessage } from '../server/server.ts'
import { localToken } from '../server/state.ts'
import { loadHydra } from '../store/hydra-store.ts'
import { readEvents } from '../app/event-log.ts'
import type { HydraQueue } from '../server/host.ts'
import { scriptPullRequest, type FakePullRequest } from './github.ts'
import { fakeDispatch } from './dispatch-fixture.ts'
import { replayClaude, replayCodex, type AgentSession } from './fake-agents.ts'

const BIN = join(
  import.meta.dirname,
  '..',
  '..',
  'dist',
  'cli',
  'pnyx-axi.js',
)
// Waits end as soon as their condition holds; the bound only has to outlast a loaded machine.
export const TIMEOUT_MS = 30_000
export const POLL_MS = 20
// How often the server reads a followed pull request; the real minute would outlast the waits.
const FOLLOW_MS = 100

// git as a person at the terminal runs it, with a fixed identity.
export function git({
  cwd,
  args,
}: {
  cwd: string
  args: string[]
}): string {
  return execFileSync(
    'git',
    [
      '-C',
      cwd,
      ...args,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    },
  ).trim()
}

export async function until<T>({
  what,
  check,
}: {
  what: string
  check: () => T | undefined | false
}): Promise<T> {
  for (const end = Date.now() + TIMEOUT_MS; ;) {
    const value = check()

    if (value !== undefined && value !== false) {
      return value
    }

    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`)
    }

    await new Promise(resolve => setTimeout(
      resolve,
      POLL_MS,
    ))
  }
}

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

// One `pnyx-axi` process. Async, so the server in this process keeps answering it.
function pnyxAxi({
  args,
  env,
  input,
}: {
  args: string[]
  env: NodeJS.ProcessEnv
  input?: string
}): Promise<Run> {
  assert.notEqual(
    args[0],
    'setup',
    'a scenario never runs pnyx-axi setup',
  )

  return new Promise((
    resolve,
    reject,
  ) => {
    const child = spawn(
      process.execPath,
      [
        BIN,
        ...args,
      ],
      {
        env,
        timeout: TIMEOUT_MS,
        stdio: [
          'pipe',
          'pipe',
          'pipe',
        ],
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

// The owner's page: the snapshot it gets, kept current with the events that follow, and its commands.
export async function openPage({
  port,
  hydraId,
}: {
  port: number
  hydraId: string
}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/hydra/${hydraId}/ws?token=${localToken()}`)
  let state: HydraState | undefined
  const answers = new Map<string, ServerMessage>()
  const queues: HydraQueue[] = []
  ws.on(
    'message',
    (data: unknown) => {
      const message = JSON.parse(String(data)) as ServerMessage

      if (message.type === 'hydraQueue') {
        queues.push(message.queue)
      } else if (message.type === 'snapshot') {
        state = message.state
      } else if (message.type === 'event') {
        state = reduce({
          state: state ?? emptyHydra(),
          event: message.event,
        })
      } else if ((message.type === 'receipt' || message.type === 'error') && message.id) {
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
    ws.once(
      'open',
      resolve,
    )
    ws.once(
      'error',
      reject,
    )
  })
  let next = 0

  return {
    queues,
    shows: <T>({
      what,
      check,
    }: {
      what: string
      check: ({ state }: { state: HydraState }) => T | undefined | false
    }) => until({
      what,
      check: () => state && check({ state }),
    }),
    // A command as the page sends it; resolves with its receipt and fails on an error.
    command: async ({
      name,
      args,
    }: {
      name: string
      args: string[]
    }) => {
      const id = `page-${next++}`
      ws.send(JSON.stringify({
        type: 'command',
        id,
        name,
        args,
      }))
      const answer = await until({
        what: `the answer to ${name} ${args.join(' ')}`,
        check: () => answers.get(id),
      })
      assert.equal(
        answer.type,
        'receipt',
        JSON.stringify(answer),
      )

      return answer as Record<string, unknown>
    },
    close: () => ws.close(),
  }
}

// Starts one disposable Pnyx for the test file (temporary PNYX_HOME, random port, fake agents);
// call it at the top level of the file. Nothing outside its temporary folder is read or written.
export function scenarioGroup({
  retryDelays,
  incorporateSteering = false,
}: {
  incorporateSteering?: boolean
  // How long a failed Hydra start waits before each retry.
  retryDelays?: number[]
} = {}) {
  const root = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-scenario-',
  )))
  Object.assign(
    process.env,
    {
      // Anything that reaches for the owner's home folder gets this one instead.
      HOME: join(
        root,
        'home',
      ),
      PNYX_HOME: join(
        root,
        'pnyx',
      ),
      // Semantic search would start its model worker.
      PNYX_SEMANTIC: 'off',
      // Pull request state comes from the fake gh-axi, never GitHub, scripted by s.pullRequest.
      PNYX_GH_AXI: join(
        import.meta.dirname,
        '../../test/fixtures/github/gh-axi.sh',
      ),
      PNYX_FAKE_GITHUB: join(
        root,
        'github',
      ),
      // Keeps the default-login fallback away from the real harness logins.
      CLAUDE_CONFIG_DIR: join(
        root,
        'no-login/claude',
      ),
      CODEX_HOME: join(
        root,
        'no-login/codex',
      ),
    },
  )

  // A worker or Hydra running these tests must not lend them its identity.
  for (const name of [
    'PNYX_ACTOR',
    'PNYX_HYDRA',
    'PNYX_TASK',
  ]) {
    delete process.env[name]
  }

  mkdirSync(process.env.HOME!)
  // Accounts claude:test and codex:test, and a quota-axi on PATH that reports them usable.
  fakeDispatch({ root })
  // Agents get no PNYX_ variables of the server's, so their own pnyx-axi finds the fake gh-axi on PATH
  // and the semantic setting in the home.
  writeFileSync(
    join(
      root,
      'fake-bin',
      'gh-axi',
    ),
    `#!/bin/sh\nPNYX_FAKE_GITHUB='${process.env.PNYX_FAKE_GITHUB}' exec '${process.env.PNYX_GH_AXI}' "$@"\n`,
    { mode: 0o755 },
  )
  mkdirSync(
    process.env.PNYX_HOME!,
    { recursive: true },
  )
  writeFileSync(
    join(
      process.env.PNYX_HOME!,
      'settings.json',
    ),
    JSON.stringify({ 'search.semantic': 'off' }),
  )
  const claude = replayClaude({ incorporateSteering })
  const codex = replayCodex({ incorporateSteering })
  let server: RunningServer | undefined
  let scenarios = 0

  const start = async ({ port }: { port?: number }) => {
    server = await startServer({
      port,
      query: claude.query,
      spawnCodex: codex.spawnCodex,
      wakeDelay: 50,
      retryDelays,
      followDelay: FOLLOW_MS,
    })
  }

  before(() => start({}))
  after(async () => {
    await server?.close()
    rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    )
  })

  return {
    codex,
    claude,
    port: () => server!.port,
    // Stops the server and starts it again on the same files and port, as a Pnyx restart does,
    // so an open page reconnects to it.
    restart: async ({ whileStopped }: { whileStopped?(): void | Promise<void> } = {}) => {
      const { port } = server!
      await server!.close()
      await whileStopped?.()
      await start({ port })
    },
    // A Hydra of its own for one scenario, created through the CLI and served once the server mounts it.
    scenario: async () => {
      const hydraId = `s${++scenarios}`
      const s = hydraScenario({
        hydraId,
        root,
        sessions: () => [
          ...claude.sessions,
          ...codex.sessions,
        ],
      })
      await s.owner({
        args: [
          'hydra',
          'create',
          hydraId,
          '--helper',
          'off',
        ],
      })
      await server!.open({ id: hydraId })

      return s
    },
  }
}

function hydraScenario({
  hydraId,
  root,
  sessions,
}: {
  hydraId: string
  root: string
  sessions: () => AgentSession[]
}) {
  // The owner's terminal: no agent identity.
  const ownerEnv = () => {
    const env = { ...process.env }
    delete env.PNYX_ACTOR

    return env
  }

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

  const mustSucceed = async ({
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
    assert.equal(
      run.status,
      0,
      `pnyx-axi ${args.join(' ')} failed:\n${run.stdout}${run.stderr}`,
    )

    return run.stdout
  }

  // A refusal's code and its error line, as pnyx-axi prints them.
  const refusal = async ({
    args,
    env,
  }: {
    args: string[]
    env: NodeJS.ProcessEnv
  }) => {
    const run = await cli({
      args,
      env,
    })
    assert.notEqual(
      run.status,
      0,
      `pnyx-axi ${args.join(' ')} succeeded:\n${run.stdout}`,
    )
    const line = /^error: (.*)$/m.exec(run.stdout)?.[1]
    const quoted = line?.startsWith('"')

    return {
      code: /^code: (\w+)$/m.exec(run.stdout)?.[1],
      error: quoted ? JSON.parse(line!) as string : line,
    }
  }

  const mustBeRefused = async ({
    args,
    env,
  }: {
    args: string[]
    env: NodeJS.ProcessEnv
  }) => (await refusal({
    args,
    env,
  })).code

  const state = () => loadHydra({ hydraId }).state

  // The agent session Pnyx started in this folder (a worker), or for this Hydra (Hydra itself).
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

  // This scenario's repository on the fake GitHub.
  const repo = join(
    process.env.PNYX_FAKE_GITHUB!,
    'o',
    hydraId,
  )

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
    hydraId,
    folder,
    // A git project with one commit pushed to its own bare origin, attached with `project add` and these flags.
    project: async ({
      name,
      flags = [],
    }: {
      name: string
      flags?: string[]
    }) => {
      const path = folder({ name })
      const origin = `${path}.git`
      git({
        cwd: path,
        args: [
          'init',
          '-q',
          '--bare',
          '-b',
          'main',
          origin,
        ],
      })
      git({
        cwd: path,
        args: [
          'init',
          '-q',
          '-b',
          'main',
        ],
      })
      writeFileSync(
        join(
          path,
          'README.md',
        ),
        `${name}\n`,
      )

      for (const args of [
        [
          'add',
          '.',
        ],
        [
          'commit',
          '-q',
          '-m',
          'init',
        ],
        [
          'remote',
          'add',
          'origin',
          origin,
        ],
        [
          'push',
          '-q',
          '-u',
          'origin',
          'main',
        ],
      ]) {
        git({
          cwd: path,
          args,
        })
      }

      await mustSucceed({
        args: [
          'project',
          'add',
          path,
          ...flags,
        ],
        env: ownerEnv(),
      })

      return path
    },
    // A pull request on this scenario's own GitHub repository, as the fake gh-axi reports it; call again to change it.
    pullRequest: ({ ...input }: FakePullRequest) => scriptPullRequest({
      repo,
      hydraId,
      ...input,
    }),
    mergeArguments: ({ number }: { number: number }) => {
      const file = join(
        repo,
        `${number}.arguments`,
      )

      return existsSync(file) ? readFileSync(
        file,
        'utf8',
      ).trim()
        .split('\n')
        .map(line => JSON.parse(line) as string[]) : []
    },
    // Accepted requests include queued merges, so this detects duplicate submissions.
    merges: ({ number }: { number: number }) => {
      const log = join(
        repo,
        `${number}.merges`,
      )

      if (!existsSync(log)) {
        return 0
      }

      const lines = readFileSync(
        log,
        'utf8',
      ).split('\n')

      return lines.filter(Boolean).length
    },
    owner: ({
      args,
      input,
    }: {
      args: string[]
      input?: string
    }) => mustSucceed({
      args,
      input,
      env: ownerEnv(),
    }),
    ownerRefused: ({ args }: { args: string[] }) => mustBeRefused({
      args,
      env: ownerEnv(),
    }),
    ownerRefusal: ({ args }: { args: string[] }) => refusal({
      args,
      env: ownerEnv(),
    }),
    // An agent runs pnyx-axi with the environment Pnyx started it with, so its identity is its own.
    as: ({ agent }: { agent: AgentSession }) => ({
      run: ({ args }: { args: string[] }) => mustSucceed({
        args,
        env: agent.env,
      }),
      refused: ({ args }: { args: string[] }) => mustBeRefused({
        args,
        env: agent.env,
      }),
      refusal: ({ args }: { args: string[] }) => refusal({
        args,
        env: agent.env,
      }),
    }),
    agent,
    // The owner says this in Hydra's chat, which starts Hydra when it is not running; resolves with Hydra's session once it heard it.
    chat: async ({ text }: { text: string }) => {
      await mustSucceed({
        args: [
          'hydra',
          'send',
          '--text',
          text,
        ],
        env: ownerEnv(),
      })
      const session = await agent({ hydra: true })
      await until({
        what: 'Hydra to hear the owner',
        check: () => session.received.some(t => t.includes(text)),
      })

      return session
    },
    // Every message the agents in this folder received, across restarts and resumed sessions.
    received: ({ cwd }: { cwd: string }) => sessions().filter(s => s.cwd === cwd)
      .flatMap(s => s.received),
    state,
    task: ({ key }: { key: string }) => {
      const {
        cards,
        keys,
      } = state()

      return cards[keys[key]!]!
    },
    column: ({ role }: { role: string }) => state().config?.columns.find(c => c.role === role)?.id,
    events: (): HydraEvent[] => readEvents({ hydraId }),
  }
}
