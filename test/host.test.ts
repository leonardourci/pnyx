import { incorporateInboxNotice } from './inbox-fixture.ts'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import type { Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { commands } from '../src/cli/commands.ts'
import { ingestSpool } from '../src/integrations/hooks/ingest.ts'
import { sendReply } from '../src/cli/reply.ts'
import { startTask } from '../src/cli/start.ts'
import { fakeDispatch } from './dispatch-fixture.ts'
import { decideOutcome, decidePush, decideSession } from '../src/core/decide.ts'
import type { Card } from '../src/core/model.ts'
import type { QueryFn } from '../src/server/host.ts'
import { hostObserver } from './host-observer.ts'
import type { RunningServer } from '../src/server/server.ts'
import { askHost } from '../src/server/state.ts'
import { loadHydra, spoolWrite, withWriter } from '../src/store/hydra-store.ts'

const meta = {
  at: '2026-10-15T00:00:00Z',
  actor: 'test',
}
let server: RunningServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

// Claude Code as the Agent SDK presents it: each message runs a turn that ends at
// once, or waits for release() while hold is set.
function fakeSdk() {
  const calls: {
    options: Options
    messages: string[]
    set: string[]
    closed: boolean
  }[] = []
  const gates: (() => void)[] = []
  const control: {
    hold: boolean
    permission: boolean
    tool?: [string, Record<string, unknown>]
  } = {
    hold: false,
    permission: false,
  }
  const permissions: PermissionResult[] = []
  const aborts: AbortController[] = []

  const query = (({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<{ message: { content: unknown } }>
    options: Options
  }) => {
    if (options.persistSession === false) {
      return {
        supportedModels: async () => [
          'opus',
          'sonnet',
          'haiku',
          'fable',
        ].map(value => ({
          value,
          displayName: value,
          description: '',
        })),
        close: () => {},
      }
    }

    const call = {
      options,
      messages: [] as string[],
      set: [] as string[],
      closed: false,
    }
    calls.push(call)

    async function* run() {
      for await (const message of prompt) {
        call.messages.push(incorporateInboxNotice({
          text: String(message.message.content),
          env: options.env ?? process.env,
        }))
        yield {
          type: 'system',
          subtype: 'session_state_changed',
          state: 'running',
        }

        if (control.permission) {
          const abort = new AbortController()
          aborts.push(abort)
          const [
            tool,
            input,
          ] = control.tool ?? [
            'Bash',
            { command: 'touch allowed.txt' },
          ]
          const result = await options.canUseTool!(
            tool,
            input,
            {
              signal: abort.signal,
              toolUseID: 'tool-1',
              requestId: 'sdk-request',
              decisionReason: 'Run a shell command',
            },
          )
          assert.ok(result)
          permissions.push(result)
        }

        if (control.hold) {
          await new Promise<void>(resolve => gates.push(resolve))
        }

        yield {
          type: 'system',
          subtype: 'session_state_changed',
          state: 'idle',
        }
      }
    }

    return Object.assign(
      run(),
      {
        setModel: async (model: string) => {
          call.set.push(`model ${model}`)
        },
        setPermissionMode: async (mode: string) => {
          call.set.push(`mode ${mode}`)
        },
        applyFlagSettings: async (settings: Record<string, unknown>) => {
          call.set.push(`effort ${String(settings.effortLevel)}`)
        },
        close: () => {
          call.closed = true
        },
      },
    )
  }) as unknown as QueryFn

  return {
    query,
    calls,
    control,
    permissions,
    aborts,
    release: () => gates.splice(0).forEach(open => open()),
  }
}

const {
  startServer,
  createHost,
  until,
} = hostObserver({ describe: () => loadHydra({ hydraId: 'lab' }).state })

async function lab() {
  const root = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-host-',
  )))
  process.env.PNYX_HOME = join(
    root,
    'pnyx',
  )
  fakeDispatch({ root })
  process.env.CLAUDE_CONFIG_DIR = join(
    root,
    'claude',
  )
  const folder = join(
    root,
    'work',
  )
  mkdirSync(folder)
  await commands.hydra([
    'create',
    'lab',
    '--hydra',
    'lab',
  ])
  await commands.task([
    'create',
    '--title',
    'Ship it',
    '--key',
    'ship',
    '--folder',
    folder,
    '--hydra',
    'lab',
  ])
  await commands.task([
    'brief',
    'ship',
    '--brief',
    'Release the canary.',
    '--hydra',
    'lab',
  ])

  const task = () => {
    const state = loadHydra({ hydraId: 'lab' }).state

    return state.cards[state.keys.ship!]! as Card
  }

  return {
    folder,
    task,
    cards: () => Object.keys(loadHydra({ hydraId: 'lab' }).state.cards).length,
  }
}

const hook = ({
  id,
  event,
  session,
  cwd,
}: {
  id: string
  event: string
  session: string
  cwd: string
}) => {
  spoolWrite({
    hydraId: 'lab',
    entry: {
      v: 1,
      id,
      at: meta.at,
      harness: 'claude',
      event,
      payload: {
        session_id: session,
        cwd,
        prompt: 'Release the canary.',
      },
    },
  })
  ingestSpool({ hydraId: 'lab' })
}

const reply = ({
  text,
  card = 'ship',
}: {
  text: string
  card?: string
}) => sendReply({
  hydraId: 'lab',
  request: {
    card,
    text,
    homes: [],
    actor: 'test',
  },
})

const permission = ({ args }: { args: string[] }) => commands.task([
  'permission',
  ...args,
  '--hydra',
  'lab',
])

const start = ({ id }: { id: string }) => startTask({
  hydraId: 'lab',
  task: 'ship',
  meta: {
    ...meta,
    id,
  },
})

test(
  'the host keeps the server\'s own context out of the agent, and refuses what it cannot run',
  async () => {
    const {
      folder,
      task,
    } = await lab()
    const sdk = fakeSdk()
    process.env.PNYX_ACTOR = 'hydra'
    process.env.TMUX_PANE = '%9'

    try {
      server = await startServer({
        hydraId: 'lab',
        query: sdk.query,
      })
      await start({ id: 'start-1' })
    } finally {
      delete process.env.PNYX_ACTOR
      delete process.env.TMUX_PANE
    }

    await until({ check: () => sdk.calls[0]?.messages.length === 1 })
    const env = sdk.calls[0]!.options.env!
    assert.deepEqual(
      [
        env.PNYX_ACTOR,
        env.TMUX_PANE,
        env.PNYX_HYDRA,
      ],
      [
        `worker:${task().id}`,
        undefined,
        'lab',
      ],
    )

    const unauthorized = await fetch(
      new URL(
        'host',
        server.url,
      ),
      {
        method: 'POST',
        body: JSON.stringify({
          action: 'send',
          card: 'ship',
          text: 'hi',
        }),
      },
    )
    assert.equal(
      unauthorized.status,
      401,
    )
    await assert.rejects(
      askHost({
        hydraId: 'lab',
        body: {
          action: 'set',
          card: 'ship',
          setting: 'effort',
          value: 'huge',
        },
      }),
      /effort cannot be huge/,
    )
    await assert.rejects(
      askHost({
        hydraId: 'lab',
        body: {
          action: 'start',
          task: 'ship',
          prompt: 'Go',
          id: 'rel',
          folder: 'work',
        },
      }),
      /absolute path/,
    )

    // A gone folder fails the send and leaves the task as it was.
    await until({ check: () => task().sessionActivity === 'finished' })
    await server.close()
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    rmSync(
      folder,
      { recursive: true },
    )
    const lost = await reply({ text: 'Still there?' })
    assert.equal(
      lost.state,
      'failed',
    )
    assert.match(
      lost.detail!,
      /folder .* is gone/,
    )
    assert.equal(
      task().sessionActivity,
      'finished',
    )
  },
)

test(
  'moving a live session expires its old permission and routes its next request to its current task',
  async () => {
    const { task } = await lab()
    const sdk = fakeSdk()
    sdk.control.permission = true
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    await start({ id: 'move-start' })
    await until({ check: () => task().permissions?.length === 1 })
    const request = task().permissions![0]!
    const session = task().sessionIds![0]!
    await commands.task([
      'create',
      '--title',
      'Destination',
      '--key',
      'destination',
      '--hydra',
      'lab',
    ])
    await commands.task([
      'attach',
      'destination',
      '--session',
      session,
      '--hydra',
      'lab',
    ])
    await assert.rejects(
      async () => permission({
        args: [
          'ship',
          request.id,
          'allow',
        ],
      }),
      /expired|no longer waits/,
    )
    await until({ check: () => sdk.permissions.length === 1 })
    assert.deepEqual(
      [
        sdk.permissions[0]!.behavior,
        task().permissions![0]!.status,
      ],
      [
        'deny',
        'expired',
      ],
    )
    assert.equal(
      task().attention.some(a => a.key.endsWith(request.id)),
      false,
    )
    await reply({
      text: 'Continue here',
      card: 'destination',
    })

    const destination = () => {
      const state = loadHydra({ hydraId: 'lab' }).state

      return state.cards[state.keys.destination!]!
    }

    await until({ check: () => destination().permissions?.length === 1 })
    const next = destination().permissions![0]!
    assert.equal(
      next.session,
      session,
    )
    await permission({
      args: [
        'destination',
        next.id,
        'allow',
      ],
    })
    await until({ check: () => sdk.permissions.length === 2 })
    assert.equal(
      sdk.permissions[1]!.behavior,
      'allow',
    )
    await reply({
      text: 'Ask before detaching',
      card: 'destination',
    })
    await until({ check: () => destination().permissions?.length === 2 })
    await commands.task([
      'detach',
      'destination',
      '--hydra',
      'lab',
    ])
    await until({ check: () => sdk.permissions.length === 3 })
    assert.deepEqual(
      [
        destination().permissions![1]!.status,
        sdk.permissions[2]!.behavior,
        sdk.calls.length,
      ],
      [
        'expired',
        'deny',
        2,
      ],
    )
    assert.equal(
      sdk.calls[0]!.closed,
      true,
    )
    assert.equal(
      sdk.calls[1]!.options.env?.PNYX_ACTOR,
      `worker:${destination().id}`,
    )
  },
)

function outside({
  folder,
  provider = 'claude-code',
  pid,
  transcriptPath,
}: {
  folder: string
  provider?: string
  pid?: string
  transcriptPath?: string
}) {
  withWriter({
    hydraId: 'lab',
    fn: ({ writer }) => {
      const stamp = {
        ...meta,
        at: new Date().toISOString(),
      }
      const pushed = decidePush({
        state: writer.state,
        newCardId: `c${writer.state.seq + 1}`,
        key: 'outside',
        input: {
          agent: {
            provider,
            sessionId: 'native-session',
            cwd: folder,
            ...(transcriptPath ? { transcriptPath } : {}),
          },
          terminal: {
            tty: '/dev/ttys123',
            ...(pid ? { pid } : {}),
          },
          settings: provider === 'codex' ? {
            model: 'gpt-6.1-sol',
            effort: 'high',
            mode: 'never',
          } : {
            model: 'sonnet',
            effort: 'high',
          },
          activity: 'ended',
          source: {
            adapter: 'hooks',
            instanceId: provider === 'codex' ? 'codex' : 'claude',
            objectId: 'native-session',
            observedAt: stamp.at,
          },
        },
        meta: stamp,
      })
      assert.ok('event' in pushed); writer.append({ event: pushed.event })
      const ended = decideOutcome({
        state: writer.state,
        ref: 'outside',
        outcome: { state: 'ended' },
        source: 'hooks',
        meta: stamp,
      })
      assert.ok('event' in ended); writer.append({ event: ended.event })
      const attached = decideSession({
        state: writer.state,
        ref: `${provider}:native-session`,
        task: writer.state.keys.ship!,
        meta: stamp,
      })
      assert.ok('event' in attached); writer.append({ event: attached.event })
    },
  })
}

test(
  'Continue in Pnyx adopts the same native session lazily, survives restart and routes replies and settings to it',
  async () => {
    const {
      folder,
      task,
      cards,
    } = await lab()
    outside({ folder })
    const count = cards()
    const sdk = fakeSdk()
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    await commands.task([
      'status',
      'ship',
      'paused',
      '--note',
      'Outside hold',
      '--until',
      'in 2 hours',
      '--hydra',
      'lab',
    ])
    const paused = task().status?.id
    assert.equal(
      (await commands.task([
        'continue',
        'ship',
        '--check',
        '--hydra',
        'lab',
      ])).canContinue,
      true,
    )
    assert.equal(
      task().agent?.host,
      undefined,
    )
    assert.equal(
      task().status?.id,
      paused,
    )
    const adopted = await commands.task([
      'continue',
      'ship',
      '--event-id',
      'adopt-1',
      '--hydra',
      'lab',
    ])
    assert.equal(
      (adopted.agent as { session: string }).session,
      'native-session',
    )
    assert.equal(
      task().status?.state,
      'working',
    )
    assert.equal(
      task().column,
      loadHydra({ hydraId: 'lab' }).state.config?.columns.find(c => c.role === 'in_progress')?.id,
    )
    assert.equal(
      task().status?.until,
      undefined,
    )
    const agentRef = task().agent!
    assert.deepEqual(
      {
        host: agentRef.host,
        resume: agentRef.resume,
        cwd: agentRef.cwd,
        outcome: task().outcome,
        activity: task().sessionActivity,
        via: task().launch?.via,
        terminal: task().terminal,
        settings: task().settings,
        calls: sdk.calls.length,
      },
      {
        host: 'pnyx',
        resume: true,
        cwd: folder,
        outcome: undefined,
        activity: 'finished',
        via: 'pnyx',
        terminal: {},
        settings: {
          model: 'sonnet',
          effort: 'high',
        },
        calls: 0,
      },
    )
    assert.equal(
      (await commands.task([
        'continue',
        'ship',
        '--event-id',
        'adopt-1',
        '--hydra',
        'lab',
      ])).event,
      'none: duplicate',
    )
    assert.equal(
      cards(),
      count,
    )
    await server.close()
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    assert.equal(
      task().agent?.host,
      'pnyx',
    )
    sdk.control.permission = true
    assert.equal(
      (await reply({ text: 'Continue the release' })).state,
      'delivered',
    )
    await until({ check: () => task().permissions?.[0]?.status === 'pending' })
    const request = task().permissions![0]!
    assert.equal(
      request.session,
      'claude-code:native-session',
    )
    await permission({
      args: [
        'ship',
        request.id,
        'allow',
      ],
    })
    await until({ check: () => sdk.permissions.length === 1 })
    assert.equal(
      sdk.permissions[0]!.behavior,
      'allow',
    )
    await until({ check: () => sdk.calls[0]?.messages.length === 1 })
    const { options } = sdk.calls[0]!
    assert.deepEqual(
      [
        options.resume,
        options.sessionId,
        options.cwd,
      ],
      [
        'native-session',
        undefined,
        folder,
      ],
    )
    await askHost({
      hydraId: 'lab',
      body: {
        action: 'set',
        card: 'ship',
        setting: 'model',
        value: 'opus',
      },
    })
    assert.deepEqual(
      sdk.calls[0]!.set,
      ['model opus'],
    )
    hook({
      id: 'adopted-hook',
      event: 'UserPromptSubmit',
      session: 'native-session',
      cwd: folder,
    })
    assert.equal(
      task().agent?.host,
      'pnyx',
    )
    assert.equal(
      cards(),
      count,
    )
  },
)

test(
  'continuation refuses running and unknown presence without changing the session',
  async () => {
    const {
      folder,
      task,
    } = await lab()
    outside({
      folder,
      pid: '123',
    })

    for (const state of [
      'present',
      'unknown',
    ] as const) {
      const host = createHost({
        hydraId: 'lab',
        changed: () => {},
        presence: () => ({
          state,
          detail: 'fixture presence',
        }),
      })
      const refused = state === 'present' ? /still runs/ : /cannot confirm/
      const before = loadHydra({ hydraId: 'lab' }).state.seq
      assert.equal(
        host.continue({
          task: 'ship',
          id: 'read',
          actor: 'test',
          check: true,
        }).canContinue,
        false,
      )
      assert.throws(
        () => host.continue({
          task: 'ship',
          id: 'adopt',
          actor: 'test',
        }),
        refused,
      )
      assert.equal(
        loadHydra({ hydraId: 'lab' }).state.seq,
        before,
      )
      assert.equal(
        task().agent?.host,
        undefined,
      )
      await assert.rejects(
        host.start({
          task: 'ship',
          replacement: 'claude-code:native-session',
          id: 'fresh',
          actor: 'test',
          settings: {},
          folder,
          prompt: 'Fresh',
        }),
        refused,
      )
      assert.equal(
        task().agent?.sessionId,
        'native-session',
      )
      host.close()
    }
  },
)

test(
  'continuation reports a missing folder with a fresh-start hint and rejects unsupported sessions',
  async () => {
    const {
      folder,
      task,
    } = await lab()
    outside({ folder })
    const host = createHost({
      hydraId: 'lab',
      changed: () => {},
    })
    rmSync(
      folder,
      { recursive: true },
    )
    assert.equal(
      host.continue({
        task: 'ship',
        id: 'read',
        actor: 'test',
        check: true,
      }).folderMissing,
      true,
    )
    assert.throws(
      () => host.continue({
        task: 'ship',
        id: 'adopt',
        actor: 'test',
      }),
      (error: unknown) => {
        assert.match(
          (error as Error).message,
          /folder .* is gone/,
        )
        assert.match(
          JSON.stringify(error),
          /start fresh from the brief/,
        )

        return true
      },
    )
    assert.equal(
      task().agent?.host,
      undefined,
    )
    await commands.task([
      'detach',
      'ship',
      '--hydra',
      'lab',
    ])

    // Neither a task without a session nor one with an unsupported session can continue.
    for (const provider of [
      undefined,
      'unsupported',
    ]) {
      if (provider) {
        outside({
          folder,
          provider,
        })
      }

      assert.throws(
        () => host.continue({
          task: 'ship',
          id: `continue-${provider}`,
          actor: 'test',
        }),
        /outside Claude Code/,
      )
    }

    host.close()
  },
)

test(
  'starting fresh validates the replacement before detaching and starts once from the saved brief',
  async () => {
    const {
      folder,
      task,
    } = await lab()
    outside({ folder })
    const sdk = fakeSdk()
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    const replacement = 'claude-code:native-session'
    const before = loadHydra({ hydraId: 'lab' }).state.seq
    const fresh = ({
      id,
      ...rest
    }: {
      id: string
      replacement?: string
      folder?: string
      via?: string
    }) => startTask({
      hydraId: 'lab',
      task: 'ship',
      replacement,
      folder,
      ...rest,
      meta: {
        ...meta,
        id,
      },
    })
    await assert.rejects(
      fresh({
        id: 'fresh-1',
        folder: join(
          folder,
          'missing',
        ),
      }),
      /folder not found/,
    )
    assert.equal(
      task().agent?.sessionId,
      'native-session',
    )
    assert.equal(
      loadHydra({ hydraId: 'lab' }).state.seq,
      before,
    )
    await assert.rejects(
      fresh({
        id: 'stale',
        replacement: 'claude-code:other',
      }),
      /different session/,
    )
    await assert.rejects(
      fresh({
        id: 'paseo',
        via: 'paseo',
      }),
      /uses Pnyx/,
    )
    assert.equal(
      sdk.calls.length,
      0,
    )
    await commands.task([
      'status',
      'ship',
      'blocked',
      '--note',
      'waiting on the canary',
      '--hydra',
      'lab',
    ])
    const started = await fresh({ id: 'fresh-1' })
    assert.equal(
      task().status?.state,
      'working',
    )
    assert.equal(
      task().column,
      loadHydra({ hydraId: 'lab' }).state.config?.columns.find(c => c.role === 'in_progress')?.id,
    )
    assert.equal(
      (started.agent as { host: string }).host,
      'pnyx',
    )
    assert.notEqual(
      task().agent?.sessionId,
      'native-session',
    )
    assert.equal(
      loadHydra({ hydraId: 'lab' }).state.sessions?.[replacement]?.taskId,
      null,
    )
    await until({ check: () => sdk.calls[0]?.messages.length === 1 })
    assert.match(
      sdk.calls[0]!.messages[0]!,
      /^<pnyx-worker [^>]*>[\s\S]*<\/pnyx-worker>\n\nRelease the canary\./,
    )
    assert.match(
      sdk.calls[0]!.messages[0]!,
      /replaces the lost session claude-code:native-session; your folder keeps its work[\s\S]*Its last declaration was blocked: waiting on the canary\./,
    )
    assert.equal(
      sdk.calls[0]!.options.resume,
      undefined,
    )
    assert.equal(
      (await fresh({ id: 'fresh-1' })).event,
      'none: duplicate',
    )
    assert.equal(
      sdk.calls.length,
      1,
    )
  },
)
