import { applyPageUpdate } from '#app/page-state.ts'
import { createThreadReceiver } from '#hydra/thread-receive.ts'
import { randomUUID } from 'node:crypto'
// The flow harness: one disposable Pnyx for the whole run (see pnyx.ts), a fresh Hydra per flow, real
// `pnyx-axi` subprocesses, and fake agents replaying recorded sessions. See docs/testing.md.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before } from 'node:test'
import { WebSocket } from 'ws'
import type { HydraEvent, HydraState } from '#app/model.ts'
import { emptyHydra } from '#app/reducer.ts'
import { startServer } from '#app/server-daemon.ts'
import type { RunningServer, ServerMessage } from '#app/server-transport.ts'
import { localToken } from '#app/server-state.ts'
import { loadHydra } from '#app/store.ts'
import { readEvents } from '#app/event-log.ts'
import type { HydraQueue } from '#hydra/wakes.ts'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import { scriptPullRequest, type FakePullRequest } from './github.ts'
import { fakeDispatch } from './dispatch-fixture.ts'
import { keepChromeOffKeychain } from './chrome-keychain.ts'
import { upgradeRepo } from './upgrade-fixture.ts'
import { replayClaude, replayCodex, type AgentSession } from './fake-agents.ts'
import type { Settings } from '#settings/model.ts'
import type { CurrentAction } from '#hydra/calls.ts'

const BIN = join(
  import.meta.dirname,
  '..',
  '..',
  'dist',
  'cli',
  'pnyx-axi.js',
)
// Waits end as soon as their condition holds; the bound only has to outlast a loaded machine.
const TIMEOUT_MS = 30_000
const POLL_MS = 20
// The flows' server writes its process line this often instead of every 30 seconds.
const FLOW_PROCESS_LINE_MS = 200
// Idle means no such work for this long, several turns of the 500 ms polling a crowded server falls back to.
export const QUIET_MS = 2500
// How often the server reads a followed pull request; the real minute would outlast the waits.
const FOLLOW_MS = 100
export const RECOVERY_TEST_PAUSE_MS = 100

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
  // The monotonic clock keeps the bound when a flow holds Date.
  for (const end = performance.now() + TIMEOUT_MS; ;) {
    const value = check()

    if (value !== undefined && value !== false) {
      return value
    }

    if (performance.now() > end) {
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
export function pnyxAxi({
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
// `page` names the cards it opens with, as page command arguments in its socket address.
export async function openPage({
  port,
  hydraId,
  page,
}: {
  port: number
  hydraId: string
  page?: string[]
}) {
  const opened = page ? `&page=${encodeURIComponent(JSON.stringify(page))}` : ''
  const ws = new WebSocket(`ws://127.0.0.1:${port}/hydra/${hydraId}/ws?token=${localToken()}${opened}`)
  let state: HydraState | undefined
  let snapshots = 0
  const answers = new Map<string, ServerMessage>()
  const queues: HydraQueue[] = []
  const threads: ThreadPage[] = []
  const threadReceiver = createThreadReceiver()
  // Pushed deltas the page could not apply. This socket never backs up, so each one is a server fault.
  const gaps: string[] = []
  const usages: Record<string, import('#workers/provider.ts').AgentUsage> = {}
  const actions: Record<string, CurrentAction | null> = {}
  const upgrades: UpgradeStatus[] = []
  const settings: Settings[] = []
  ws.on(
    'message',
    (data: unknown) => {
      const received = JSON.parse(String(data)) as ServerMessage
      const message = threadReceiver.receive({ message: received })

      if (!message) {
        if (received.type === 'thread.delta') {
          const held = threadReceiver.read({ card: received.delta.page.card })
          gaps.push(`${received.delta.page.card} delta ${received.delta.base} to ${received.delta.page.version} on version ${held?.version}`)
        }

        ws.send(JSON.stringify({ type: 'resync' }))

        return
      }

      if (message.type === 'latest') {
        Object.assign(
          actions,
          message.actions,
        )

        if (message.usage) {
          Object.assign(
            usages,
            message.usage,
          )
        }
      } else if (message.type === 'upgrade') {
        upgrades.push(message.upgrade)
      } else if (message.type === 'settings') {
        settings.push(message.settings)
      } else if (message.type === 'hydraQueue') {
        queues.push(message.queue)
      } else if (message.type === 'thread') {
        threads.push(message.thread)
      } else if (message.type === 'snapshot') {
        snapshots += 1
        state = {
          ...message.state,
          eventIds: {},
        }
      } else if (message.type === 'page.event') {
        if (!state) {
          state = emptyHydra()
        }

        applyPageUpdate({
          state,
          update: message.update,
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

  const ask = ({
    name,
    args,
  }: {
    name: string
    args: string[]
  }) => {
    const id = `page-${randomUUID()}`
    ws.send(JSON.stringify({
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
    // How many snapshots the server has sent this page.
    snapshots: () => snapshots,
    queues,
    // Every thread page the server pushed to the subscribed tab, in order.
    threads,
    usages,
    actions,
    upgrades,
    // Every shared settings push, in order: one on connect, then one per change.
    settings,
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
      const answer = await ask({
        name,
        args,
      })
      assert.equal(
        answer.type,
        'receipt',
        JSON.stringify(answer),
      )

      return answer as Record<string, unknown>
    },
    // A command the server refuses; resolves with its error and fails on a receipt.
    refusal: async ({
      name,
      args,
    }: {
      name: string
      args: string[]
    }) => {
      const answer = await ask({
        name,
        args,
      })
      assert.equal(
        answer.type,
        'error',
        JSON.stringify(answer),
      )

      return answer as Extract<ServerMessage, { type: 'error' }>
    },
    // A batch of lines as the page's logger sends them.
    log: ({ lines }: { lines: Record<string, unknown>[] }) => ws.send(JSON.stringify({
      type: 'log',
      lines,
    })),
    // Fails the flow when the server pushed a delta the page could not apply.
    close: () => {
      ws.close()
      const following = threads.at(-1)
      assert.equal(
        gaps.length,
        0,
        `thread deltas the page could not apply: ${gaps.join(', ')}; the page that followed: ${following?.card} version ${following?.version}`,
      )
    },
  }
}

// A line as the server's log files hold it.
export type LogRecord = {
  [field: string]: unknown
  operation: string
  at: string
  level?: string
  hydraId?: string
  operationId?: string
  eventSeq?: number
  error?: {
    name?: string
    message?: string
    code?: string
    stack?: string
  }
}

// Every line in the server's log files, oldest day first.
export function logLines(): LogRecord[] {
  const dir = join(
    process.env.PNYX_HOME!,
    'logs',
  )

  if (!existsSync(dir)) {
    return []
  }

  return readdirSync(dir).toSorted()
    .flatMap(name => readFileSync(
      join(
        dir,
        name,
      ),
      'utf8',
    ).split('\n')
      .flatMap(line => {
        // A line the server is still writing is read on the next look.
        try {
          return [JSON.parse(line) as LogRecord]
        } catch {
          return []
        }
      }))
}

// Starts one disposable Pnyx (temporary PNYX_HOME, random port, fake agents); pnyx.ts calls it once
// for every flow, since it sets process.env. Nothing outside its temporary folder is read or written.
export function scenarioGroup({
  retryDelays,
  upgradeRoot,
}: {
  // How long a failed Hydra start waits before each retry.
  retryDelays?: number[]
  upgradeRoot?: string
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
      // Pull request state comes from the fake gh-axi, never GitHub, scripted by s.pullRequest.
      PNYX_GH_AXI: join(
        import.meta.dirname,
        'fakes/gh-axi.sh',
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
      // Every pnyx-axi run reuses the compiled CLI instead of compiling it again.
      NODE_COMPILE_CACHE: join(
        root,
        'compile-cache',
      ),
    },
  )

  keepChromeOffKeychain()

  // A worker or Hydra running these tests must not lend them its identity.
  for (const name of [
    'PNYX_ACTOR',
    'PNYX_HYDRA',
    'PNYX_TASK',
  ]) {
    delete process.env[name]
  }

  // The flows share one test process, whose test-runner flags would turn a forked helper, such as an
  // external source's supervisor, into a test run.
  process.execArgv = process.execArgv.filter(flag => !flag.startsWith('--test'))
  mkdirSync(process.env.HOME!)
  // Accounts claude:test and codex:test, and a quota-axi on PATH that reports them usable.
  fakeDispatch({ root })
  // Agents inherit none of the server's PNYX_ variables, so their own pnyx-axi finds the fake gh-axi on PATH.
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
  let scenarios = 0
  const currentHydra = () => `s${scenarios}`
  const claude = replayClaude({ hydra: currentHydra })
  const codex = replayCodex({ hydra: currentHydra })
  // The Pnyx folder /upgrade pulls into: a throwaway clone of its own local origin.
  const upgrade = upgradeRepo({ root })
  // A real restart signals this process, which the flows share; a flow restarts with pnyx.restart() instead.
  let restarts = 0
  let restartFailure: {
    message: string
    after?: Promise<void>
  } | undefined
  let server: RunningServer | undefined

  const start = async ({ port }: { port?: number }) => {
    server = await startServer({
      port,
      query: claude.query,
      spawnCodex: codex.spawnCodex,
      wakeDelay: 50,
      retryDelays,
      followDelay: FOLLOW_MS,
      recoveryPause: RECOVERY_TEST_PAUSE_MS,
      processLineMs: FLOW_PROCESS_LINE_MS,
      upgradeRoot: upgradeRoot ?? upgrade.install,
      restart: () => {
        restarts++

        if (!restartFailure) {
          return
        }

        const {
          message,
          after,
        } = restartFailure
        restartFailure = undefined

        if (after) {
          return after.then(() => {
            throw new Error(message)
          })
        }

        throw new Error(message)
      },
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
    upgrade,
    // How many times an upgrade asked the server to restart.
    restarts: () => restarts,
    // The next restart fails with this message; given after, once after resolves.
    failRestart: ({
      message,
      after,
    }: {
      message: string
      after?: Promise<void>
    }) => {
      restartFailure = {
        message,
        after,
      }
    },
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
      scenarios += 1
      const hydraId = currentHydra()
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
    // Messages the agents in this folder received whose turn ended, across restarts and resumed sessions.
    answered: ({ cwd }: { cwd: string }) => sessions().filter(s => s.cwd === cwd)
      .reduce(
        (
          sum,
          s,
        ) => sum + s.answered,
        0,
      ),
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
