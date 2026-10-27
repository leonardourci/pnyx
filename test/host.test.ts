import { incorporateInboxNotice } from '../src/test-harness/inbox-fixture.ts'
import { hydraSdk } from '../src/test-harness/hydra-host-fixture.ts'
import { inboxCommand } from '../src/task-inbox/cli.ts'
import { taskTimeline } from '../web/src/hydra/task-updates.ts'
import { configPath, writeConfig, effectiveDispatch } from '../src/dispatch/config.ts'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import type { Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { fakeCodex } from '../src/test-harness/codex-fixture.ts'
import { commands } from '../src/app/cli.ts'
import { ingestSpool } from '../src/integrations/hooks/ingest.ts'
import { agent, sendReply } from '../src/cli/reply.ts'
import { startTask } from '../src/cli/start.ts'
import { dispatchCommands } from '../src/dispatch/cli.ts'
import { fakeDispatch } from '../src/test-harness/dispatch-fixture.ts'
import { decideOutcome, decidePush, decideSession } from '../src/core/decide.ts'
import type { Card } from '../src/core/model.ts'
import { HYDRA_CARD, hydraConfig, hydraEvent } from '../src/core/hydra.ts'
import type { QueryFn } from '../src/server/host.ts'
import { hostObserver } from '../src/test-harness/host-observer.ts'
import type { RunningServer } from '../src/app/server-transport.ts'
import { askHost } from '../src/server/state.ts'
import { permissionEvent } from '../src/core/permissions.ts'
import { spoolWrite } from '../src/app/spool.ts'
import { withWriter } from '../src/app/writer.ts'
import { loadHydra } from '../src/app/store.ts'
import { readEvents } from '../src/app/event-log.ts'

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
  'worker compact gates inbox reads and preserves selected-message acknowledgement order',
  async () => {
    const {
      folder,
      task,
    } = await lab()
    await dispatchCommands.rule([
      'set',
      'default',
      '--harness',
      'codex',
      '--model',
      'gpt-6-luna',
      '--hydra',
      'lab',
    ])
    const codex = fakeCodex({
      root: folder,
      compact: 'hold',
      models: ['gpt-6-luna'],
    })
    server = await startServer({
      hydraId: 'lab',
      spawnCodex: codex.spawnCodex,
    })
    await start({ id: 'start-worker' })
    await until({ check: () => task().sessionActivity === 'finished' })
    await reply({ text: '/compact' })
    await until({ check: () => task().compaction?.operations.at(-1)?.state === 'running' })
    assert.equal(
      task().steering?.some(message => message.text === '/compact') ?? false,
      false,
    )

    for (const [
      id,
      text,
    ] of [
        [
          'held-first',
          'First',
        ],
        [
          'held-second',
          'Second',
        ],
      ]) {
      await sendReply({
        hydraId: 'lab',
        request: {
          card: task().id,
          text: text!,
          homes: [],
          actor: 'test',
          id,
        },
      })
    }

    await until({ check: () => task().compaction?.inputs.length === 2 })
    const read = inboxCommand({
      args: [
        'read',
        'ship',
        '--hydra',
        'lab',
      ],
    }) as { messages: unknown }
    assert.equal(
      read.messages,
      'none: no pending steering',
    )
    await agent([
      'ship',
      '--send-now',
      'held-second',
      '--hydra',
      'lab',
    ])
    await until({
      check: () => task().steering?.filter(message => message.ack).length === 2
      && task().compaction?.inputs.length === 0,
    })
    const acknowledgements = readEvents({ hydraId: 'lab' }).filter(event => event.type === 'task.steering.handled')
    assert.deepEqual(
      acknowledgements.map(event => event.data.message),
      [
        'held-second',
        'held-first',
      ],
    )
    assert.equal(
      task().compaction!.operations.at(-1)!.state,
      'cancelled',
    )
  },
)

test(
  'a queued direct compact stays durable until the provider reads it',
  async t => {
    const { task } = await lab()
    const sdk = hydraSdk()
    let unblock = () => {}, blocked = () => {}
    const gate = new Promise<void>(resolve => unblock = resolve)
    const waiting = new Promise<void>(resolve => blocked = resolve)

    const query = ((args: Parameters<QueryFn>[0]) => {
      if (typeof args.prompt === 'string') {
        return sdk.query(args)
      }

      const prompt = args.prompt

      return sdk.query({
        ...args,
        prompt: (async function* () {
          for await (const message of prompt) {
            yield message

            if (message.message.content === '/compact') {
              blocked()
              await gate
            }
          }
        })(),
      })
    }) as QueryFn
    server = await startServer({
      hydraId: 'lab',
      query,
    })
    await start({ id: 'direct-queue-worker' })
    await until({ check: () => task().sessionActivity === 'finished' })
    sdk.control.hold = true
    await reply({ text: '/compact' })
    await until({ check: () => task().compaction?.operations.at(-1)?.state === 'running' })
    await sendReply({
      hydraId: 'lab',
      request: {
        card: task().id,
        text: '/compact',
        homes: [],
        actor: 'test',
        id: 'queued-compact',
      },
    })
    t.mock.timers.enable({ apis: ['setTimeout'] })

    try {
      sdk.release()
      await waiting
      t.mock.timers.tick(0)
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(
        task().compaction?.inputs[0]?.id,
        'queued-compact',
      )
      await server.close()
      t.mock.timers.reset()
      unblock()
      const resumed = hydraSdk()
      server = await startServer({
        hydraId: 'lab',
        query: resumed.query,
      })
      await until({ check: () => task().compaction?.operations.length === 2 && task().compaction?.operations.at(-1)?.state === 'done' })
      assert.equal(
        resumed.calls[0]!.raw.filter(text => text === '/compact').length,
        1,
      )
      assert.equal(
        task().compaction!.inputs.length,
        0,
      )
    } finally {
      t.mock.timers.reset()
      unblock()
    }
  },
)

test(
  'restart during automatic compaction resumes the unfinished worker turn',
  async () => {
    const {
      folder,
      task,
    } = await lab()
    await dispatchCommands.rule([
      'set',
      'default',
      '--harness',
      'codex',
      '--model',
      'gpt-6-luna',
      '--hydra',
      'lab',
    ])
    commands.task([
      'brief',
      'ship',
      '--brief',
      'AUTO_COMPACT_HOLD',
      '--hydra',
      'lab',
    ])
    const first = fakeCodex({
      root: folder,
      models: ['gpt-6-luna'],
    })
    server = await startServer({
      hydraId: 'lab',
      spawnCodex: first.spawnCodex,
    })
    await start({ id: 'auto-worker' })
    await until({ check: () => task().compaction?.operations.at(-1)?.trigger === 'auto' })
    await server.close()
    const resumed = fakeCodex({
      root: folder,
      models: ['gpt-6-luna'],
    })
    server = await startServer({
      hydraId: 'lab',
      spawnCodex: resumed.spawnCodex,
    })
    await until({ check: () => resumed.messages().some(message => message.method === 'turn/start') && task().sessionActivity === 'finished' })
    assert.equal(
      resumed.messages().filter(message => message.method === 'turn/start').length,
      1,
    )
    assert.match(
      JSON.stringify(resumed.messages()),
      /Pnyx restarted during your turn/,
    )
    assert.equal(
      resumed.messages().some(message => message.method === 'thread/compact/start'),
      false,
    )
    assert.equal(
      task().compaction!.operations.at(-1)!.state,
      'failed',
    )
  },
)

test(
  'a compacting session moves its running status to the current task and retains old instructions',
  async () => {
    const {
      folder,
      task,
    } = await lab()
    await dispatchCommands.rule([
      'set',
      'default',
      '--harness',
      'codex',
      '--model',
      'gpt-6-luna',
      '--hydra',
      'lab',
    ])
    const codex = fakeCodex({
      root: folder,
      compact: 'hold',
      models: ['gpt-6-luna'],
    })
    server = await startServer({
      hydraId: 'lab',
      spawnCodex: codex.spawnCodex,
    })
    await start({ id: 'start-moving-worker' })
    await until({ check: () => task().sessionActivity === 'finished' })
    await reply({ text: '/compact' })
    await until({ check: () => task().compaction?.operations.at(-1)?.state === 'running' })
    await reply({ text: 'Instruction for the original task' })
    await until({ check: () => task().compaction?.inputs.length === 1 })
    const session = task().sessionIds![0]!
    commands.task([
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

    const destination = () => {
      const state = loadHydra({ hydraId: 'lab' }).state

      return state.cards[state.keys.destination!]!
    }

    await until({ check: () => destination().compaction?.operations.at(-1)?.state === 'running' })
    assert.equal(
      task().compaction!.operations.at(-1)!.state,
      'failed',
    )
    assert.equal(
      task().compaction!.inputs.length,
      1,
    )
    assert.equal(
      task().steering!.some(message => message.ack),
      false,
    )
    await agent([
      'destination',
      '--cancel-compact',
      '--hydra',
      'lab',
    ])
    await until({ check: () => destination().compaction?.operations.at(-1)?.state === 'cancelled' })
    assert.equal(
      task().compaction!.inputs.length,
      1,
    )
  },
)

test(
  'task start runs Claude Code through the server, records it on the task and takes replies',
  async () => {
    const {
      folder,
      task,
    } = await lab()
    await dispatchCommands.rule([
      'set',
      'default',
      '--harness',
      'claude',
      '--model',
      'opus',
      '--effort',
      'high',
      '--mode',
      'acceptEdits',
      '--hydra',
      'lab',
    ])
    const sdk = fakeSdk()
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })

    const started = await start({ id: 'start-1' })
    assert.equal(
      (started.agent as { host: string }).host,
      'pnyx',
    )
    assert.equal(
      task().status?.state,
      'working',
    )
    assert.equal(
      task().column,
      loadHydra({ hydraId: 'lab' }).state.config?.columns.find(c => c.role === 'in_progress')?.id,
    )
    const agentRef = task().agent!
    assert.deepEqual(
      [
        agentRef.host,
        agentRef.provider,
        agentRef.cwd,
      ],
      [
        'pnyx',
        'claude-code',
        folder,
      ],
    )
    assert.deepEqual(
      task().settings,
      {
        model: 'opus',
        effort: 'high',
        mode: 'acceptEdits',
      },
    )
    assert.match(
      task().launch?.dispatch ?? '',
      /default: opus on claude:test/,
    )
    await until({ check: () => sdk.calls[0]?.messages.length === 1 })

    const {
      options,
      messages,
    } = sdk.calls[0]!
    assert.match(
      messages[0]!,
      /^<pnyx-worker [^>]*>[\s\S]*<\/pnyx-worker>\n\nRelease the canary\.\n\nYou are the Pnyx worker for task/,
    )
    assert.equal(
      agentRef.loginFolder,
      join(
        folder,
        '..',
        'claude',
      ),
    )
    // Bypass is allowed from the start, so a picker can still switch to it.
    assert.deepEqual(
      {
        sessionId: options.sessionId,
        resume: options.resume,
        cwd: options.cwd,
        login: options.env?.CLAUDE_CONFIG_DIR,
        settingSources: options.settingSources,
        permissionPrompts: options.permissionPrompts,
        model: options.model,
        effort: options.effort,
        permissionMode: options.permissionMode,
        allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions,
      },
      {
        sessionId: agentRef.sessionId,
        resume: undefined,
        cwd: folder,
        login: agentRef.loginFolder,
        settingSources: [
          'user',
          'project',
          'local',
        ],
        permissionPrompts: 'host',
        model: 'opus',
        effort: 'high',
        permissionMode: 'acceptEdits',
        allowDangerouslySkipPermissions: true,
      },
    )
    assert.ok(options.allowedTools?.includes('Bash(pnyx-axi task status:*)'))
    assert.ok(
      !options.allowedTools?.some(tool => /agent|permission|rule/.test(tool)),
      'a worker never changes its own mode or answers itself unasked',
    )
    await until({ check: () => task().sessionActivity === 'finished' })

    // A repeated start never starts a second agent.
    assert.equal(
      (await start({ id: 'start-1' })).event,
      'none: duplicate',
    )
    assert.equal(
      sdk.calls.length,
      1,
    )

    sdk.control.hold = true
    assert.equal(
      (await reply({ text: 'Also tag it' })).state,
      'delivered',
    )
    await until({ check: () => sdk.calls[0]!.messages.length === 2 })
    assert.equal(
      sdk.calls[0]!.messages[1],
      'Also tag it',
    )
    assert.equal(
      task().sessionActivity,
      'working',
    )
    sdk.release()
    await until({ check: () => task().sessionActivity === 'finished' })
    assert.equal(
      sdk.calls.length,
      1,
    )
  },
)

test(
  'a start applies the rule\'s Fast and a checked override from the first turn and records the override',
  async () => {
    const { task } = await lab()
    await dispatchCommands.rule([
      'set',
      'default',
      '--harness',
      'claude',
      '--model',
      'opus',
      '--effort',
      'high',
      '--fast',
      'on',
      '--hydra',
      'lab',
    ])
    const sdk = fakeSdk()
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })

    for (const [
      args,
      refused,
    ] of [
        [
          [
            '--fast',
            'maybe',
          ],
          /--fast takes on or off/,
        ],
        [
          [
            '--model',
            '',
          ],
          /--model needs a value/,
        ],
        [
          [
            '--via',
            'command',
            '--model',
            'sonnet',
          ],
          /apply to an agent Pnyx or Paseo starts/,
        ],
      ] as const) {
      await assert.rejects(
        async () => commands.task([
          'start',
          'ship',
          ...args,
          '--hydra',
          'lab',
        ]),
        refused,
      )
    }

    assert.equal(
      sdk.calls.length,
      0,
    )

    await commands.task([
      'start',
      'ship',
      '--model',
      'sonnet',
      '--effort',
      'low',
      '--hydra',
      'lab',
      '--event-id',
      'override',
    ])
    await until({ check: () => sdk.calls[0]?.messages.length === 1 })
    const { options } = sdk.calls[0]!
    assert.deepEqual(
      [
        options.model,
        options.effort,
        options.settings,
      ],
      [
        'sonnet',
        'low',
        { fastMode: true },
      ],
    )
    assert.deepEqual(
      task().launch?.override,
      {
        model: 'sonnet',
        effort: 'low',
      },
    )
    assert.match(
      task().launch?.dispatch ?? '',
      /default: sonnet on claude:test; .*override model sonnet, effort low/,
    )
    assert.deepEqual(
      task().settings,
      {
        model: 'sonnet',
        effort: 'low',
        fast: 'true',
      },
    )
  },
)

test(
  'a worker takes a hosted Hydra’s permission mode unless its rule names one, and never plan',
  async () => {
    const { folder } = await lab()
    await dispatchCommands.rule([
      'set',
      'default',
      '--harness',
      'claude',
      '--model',
      'opus',
      '--hydra',
      'lab',
    ])
    const sdk = fakeSdk()
    const codex = fakeCodex({ root: dirname(folder) })
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
      spawnCodex: codex.spawnCodex,
    })

    const configure = ({ hydra }: { hydra: Record<string, unknown> }) => withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const config = hydraConfig({
          state: writer.state,
          id: 'lab',
        })
        const decision = hydraEvent({
          state: writer.state,
          meta,
          cardId: HYDRA_CARD,
          change: {
            type: 'board.configured',
            data: {
              ...config,
              hydra: {
                ...config.hydra,
                ...hydra,
              },
            },
          },
        })

        if ('event' in decision) {
          writer.append({ event: decision.event })
        }
      },
    })

    const hydraMode = ({ mode }: { mode: string }) => {
      withWriter({
        hydraId: 'lab',
        fn: ({ writer }) => {
          const session = decidePush({
            state: writer.state,
            key: 'claude:hydra-session',
            input: {
              agent: {
                provider: 'claude-code',
                sessionId: 'hydra-session',
                cwd: folder,
                host: 'pnyx',
              },
              title: 'Hydra',
              settings: { mode },
              source: {
                adapter: 'pnyx',
                objectId: 'hydra-session',
                observedAt: meta.at,
              },
            },
            meta,
          })
          assert.ok('event' in session); writer.append({ event: session.event })
        },
      })
      configure({ hydra: { session: 'claude-code:hydra-session' } })
    }

    const worker = async ({ key }: { key: string }) => {
      await commands.task([
        'create',
        '--title',
        key,
        '--key',
        key,
        '--folder',
        folder,
        '--hydra',
        'lab',
      ])
      await startTask({
        hydraId: 'lab',
        task: key,
        meta: {
          ...meta,
          id: `start-${key}`,
        },
      })
    }

    const mode = async ({ key }: { key: string }) => {
      await worker({ key })
      await until({ check: () => sdk.calls.length === Number(key.slice(-1)) })

      return sdk.calls.at(-1)!.options.permissionMode
    }

    hydraMode({ mode: 'bypassPermissions' })
    assert.equal(
      await mode({ key: 'worker-1' }),
      'bypassPermissions',
    )
    hydraMode({ mode: 'plan' })
    assert.equal(
      await mode({ key: 'worker-2' }),
      undefined,
    )
    hydraMode({ mode: 'bypassPermissions' })
    await dispatchCommands.rule([
      'set',
      'default',
      '--harness',
      'claude',
      '--model',
      'opus',
      '--mode',
      'acceptEdits',
      '--hydra',
      'lab',
    ])
    assert.equal(
      await mode({ key: 'worker-3' }),
      'acceptEdits',
    )
    await dispatchCommands.rule([
      'set',
      'default',
      '--harness',
      'claude',
      '--model',
      'opus',
      '--mode',
      '',
      '--hydra',
      'lab',
    ])

    // A Codex worker takes a Claude Hydra's bypass as never with full access.
    configure({
      hydra: {
        agent: {
          harness: 'claude',
          mode: 'bypassPermissions',
        },
      },
    })
    await dispatchCommands.rule([
      'set',
      'default',
      '--harness',
      'codex',
      '--model',
      'gpt-catalog-one',
      '--hydra',
      'lab',
    ])
    await worker({ key: 'codex-worker' })
    const thread = codex.messages().find(m => m.method === 'thread/start')!
    assert.deepEqual(
      [
        thread.params!.approvalPolicy,
        thread.params!.sandbox,
      ],
      [
        'never',
        'danger-full-access',
      ],
    )
  },
)

test(
  'a start that overrides only settings keeps quota picking the candidate and runs it with those settings',
  async () => {
    const {
      folder,
      task,
    } = await lab()
    // Claude's only account is spent but still ranks by a known priority above Codex's unknown quota.
    writeFileSync(
      join(
        dirname(folder),
        'claude',
        'quota.json',
      ),
      JSON.stringify({
        provider: {
          quotaSemantics: {
            effectiveAvailability: [
              {
                scope: 'all_models',
                status: 'known',
                effectivePercentRemaining: 0,
                runway: { status: 'exhausted_now' },
                selection: {
                  status: 'known',
                  spendPriority: -100,
                },
              },
            ],
          },
        },
      }),
    )
    await dispatchCommands.rule([
      'set',
      'default',
      '--candidates',
      JSON.stringify([
        {
          harness: 'claude',
          model: 'opus',
        },
        {
          harness: 'codex',
          model: 'gpt-catalog-one',
        },
      ]),
      '--hydra',
      'lab',
    ])
    const sdk = fakeSdk()
    const codex = fakeCodex({ root: dirname(folder) })
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
      spawnCodex: codex.spawnCodex,
    })
    await startTask({
      hydraId: 'lab',
      task: 'ship',
      override: {
        effort: 'low',
        mode: 'never',
      },
      meta,
    })
    await until({ check: () => codex.messages().some(m => m.method === 'turn/start') })
    const thread = codex.messages().find(m => m.method === 'thread/start')!.params!
    const turn = codex.messages().find(m => m.method === 'turn/start')!.params!
    assert.deepEqual(
      [
        sdk.calls.length,
        thread.approvalPolicy,
        turn.effort,
        task().settings?.mode,
      ],
      [
        0,
        'never',
        'low',
        'never',
      ],
    )
    assert.doesNotMatch(
      task().launch?.dispatch ?? '',
      /owner override/,
    )
  },
)

test(
  'after a server restart the task keeps its agent and its cut turn continues once by itself',
  async () => {
    const {
      folder,
      task,
    } = await lab()
    const first = fakeSdk()
    first.control.hold = true
    server = await startServer({
      hydraId: 'lab',
      query: first.query,
    })
    await start({ id: 'start-1' })
    await until({ check: () => first.calls[0]?.messages.length === 1 })
    const agentRef = task().agent!
    // Claude Code wrote its transcript, so the session can be resumed.
    mkdirSync(
      dirname(agentRef.transcriptPath!),
      { recursive: true },
    )
    writeFileSync(
      agentRef.transcriptPath!,
      '',
    )
    // A mode picked mid-session is kept for the session that resumes it.
    await agent([
      'ship',
      'mode',
      'bypassPermissions',
      '--hydra',
      'lab',
    ])

    await server.close()
    assert.equal(
      first.calls[0]!.closed,
      true,
    )
    // Claude Code reports its session ended when its process stops; the hosted session goes on.
    hook({
      id: 'end',
      event: 'SessionEnd',
      session: agentRef.sessionId,
      cwd: folder,
    })
    assert.notEqual(
      task().activity,
      'ended',
    )
    assert.equal(
      task().outcome,
      undefined,
    )

    // The cut turn continues once, in the same session and mode.
    const second = fakeSdk()
    second.control.hold = true
    server = await startServer({
      hydraId: 'lab',
      query: second.query,
    })
    await until({ check: () => second.calls[0]?.messages.length === 1 })
    assert.deepEqual(
      [
        task().agent?.sessionId,
        second.calls[0]!.messages[0],
        second.calls[0]!.options.resume,
        second.calls[0]!.options.sessionId,
        second.calls[0]!.options.permissionMode,
        task().attention.some(a => a.key === 'pnyx:interrupted'),
      ],
      [
        agentRef.sessionId,
        'Pnyx restarted during your turn; continue from where you stopped.',
        agentRef.sessionId,
        undefined,
        'bypassPermissions',
        false,
      ],
    )

    // A restart that cuts the resumed turn too leaves it interrupted until someone writes.
    await server.close()
    const third = fakeSdk()
    server = await startServer({
      hydraId: 'lab',
      query: third.query,
    })
    assert.deepEqual(
      [
        task().activity,
        task().attention[0]?.key,
        third.calls.length,
      ],
      [
        'interrupted',
        'pnyx:interrupted',
        0,
      ],
    )
    assert.equal(
      (await reply({ text: 'Carry on' })).state,
      'delivered',
    )
    await until({ check: () => third.calls[0]?.messages.length === 1 })
    assert.equal(
      task().attention.some(a => a.key === 'pnyx:interrupted'),
      false,
    )
    await until({ check: () => task().sessionActivity === 'finished' })
  },
)

test(
  'pickers set a hosted agent directly, and a stopped server refuses the send',
  async () => {
    await lab()
    const sdk = fakeSdk()
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    await start({ id: 'start-1' })
    await until({ check: () => sdk.calls[0]?.messages.length === 1 })

    const changed = await agent([
      'ship',
      'model',
      'sonnet',
      '--hydra',
      'lab',
    ]) as {
      agent: {
        sent: string
        confirmed: boolean
      }
    }
    assert.deepEqual(
      [
        changed.agent.sent,
        changed.agent.confirmed,
        sdk.calls[0]!.set,
      ],
      [
        'delivered',
        true,
        ['model sonnet'],
      ],
    )
    await assert.rejects(
      agent([
        'ship',
        'model',
        'gpt',
        '--hydra',
        'lab',
      ]),
      /offers no model gpt/,
    )

    await server.close()
    server = undefined
    const receipt = await reply({ text: 'Anyone there?' })
    assert.equal(
      receipt.state,
      'failed',
    )
    assert.match(
      receipt.detail!,
      /not running; nothing was sent/,
    )
  },
)

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
  'a new agent on the task does not inherit the old one\'s interrupted turn',
  async () => {
    const {
      folder,
      task,
    } = await lab()
    const sdk = fakeSdk()
    sdk.control.hold = true
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    await start({ id: 'start-1' })
    await until({ check: () => sdk.calls[0]?.messages.length === 1 })
    await server.close()
    // The first restart continues the cut turn once; the second leaves it interrupted.
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    await until({ check: () => sdk.calls[1]?.messages.length === 1 })
    await server.close()
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    assert.equal(
      task().attention[0]?.key,
      'pnyx:interrupted',
    )

    await commands.task([
      'detach',
      'ship',
      '--hydra',
      'lab',
    ])
    assert.equal(
      task().attention.some(a => a.key === 'pnyx:interrupted'),
      false,
    )
    sdk.control.hold = false
    await startTask({
      hydraId: 'lab',
      task: 'ship',
      folder,
      meta: {
        ...meta,
        id: 'start-2',
      },
    })
    await until({ check: () => sdk.calls.length === 3 && task().sessionActivity === 'finished' })
    assert.equal(
      task().attention.some(a => a.key === 'pnyx:interrupted'),
      false,
    )
  },
)

test(
  'hosted Hydra runs pnyx-axi unasked, as itself, and leaves its other prompts to the owner',
  async () => {
    await lab()
    const sdk = fakeSdk()
    sdk.control.permission = true
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    const hydra = () => loadHydra({ hydraId: 'lab' }).state.cards.$hydra!
    await commands.hydra([
      'send',
      '--text',
      'Start the canary',
      '--event-id',
      'hydra-ask',
      '--hydra',
      'lab',
    ])
    await until({ check: () => hydra().permissions?.[0]?.status === 'pending' })
    const { options } = sdk.calls[0]!
    assert.deepEqual(
      options.allowedTools,
      ['Bash(pnyx-axi:*)'],
    )
    assert.equal(
      options.env?.PNYX_ACTOR,
      'hydra',
    )
    const request = hydra().permissions![0]!
    await assert.rejects(
      async () => permission({
        args: [
          '$hydra',
          request.id,
          'allow',
          '--actor',
          'hydra',
          '--reason',
          'Mine',
        ],
      }),
      /own permission request/,
    )
    await permission({
      args: [
        '$hydra',
        request.id,
        'allow',
        '--actor',
        'web',
      ],
    })
    await until({ check: () => sdk.permissions.length === 1 })
    assert.deepEqual(
      sdk.permissions[0],
      { behavior: 'allow' },
    )
  },
)

test(
  'hosted permissions survive hooks, accept exactly one answer and hold the task in Needs you until answered',
  async () => {
    const {
      folder,
      task,
    } = await lab()
    const sdk = fakeSdk()
    sdk.control.permission = true
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    await start({ id: 'permission-start' })
    await until({ check: () => task().permissions?.[0]?.status === 'pending' })
    const request = task().permissions![0]!
    const column = ({ role }: { role: string }) => loadHydra({ hydraId: 'lab' }).state.config?.columns.find(c => c.role === role)?.id
    assert.equal(
      task().column,
      column({ role: 'needs_you' }),
    )
    assert.deepEqual(
      [
        request.tool,
        request.input,
        sdk.permissions.length,
      ],
      [
        'Bash',
        { command: 'touch allowed.txt' },
        0,
      ],
    )
    hook({
      id: 'permission-hook',
      event: 'PreToolUse',
      session: task().agent!.sessionId,
      cwd: folder,
    })
    assert.equal(
      task().attention.some(a => a.key.endsWith(request.id) && a.blocking),
      true,
    )
    await assert.rejects(
      async () => permission({
        args: [
          'ship',
          request.id,
          'allow',
          '--actor',
          'hydra',
        ],
      }),
      /need --reason/,
    )
    assert.equal(
      task().permissions![0]!.status,
      'pending',
    )

    const answers = await Promise.allSettled([
      permission({
        args: [
          'ship',
          request.id,
          'allow',
          '--actor',
          'hydra',
          '--reason',
          'The command is scoped to this worktree',
        ],
      }),
      permission({
        args: [
          'ship',
          request.id,
          'deny',
          '--actor',
          'web',
        ],
      }),
    ])
    assert.equal(
      answers.filter(a => a.status === 'fulfilled').length,
      1,
    )
    await until({ check: () => sdk.permissions.length === 1 })
    const status = task().permissions![0]!.status
    assert.equal(
      sdk.permissions[0]!.behavior,
      status,
    )
    assert.equal(
      task().column,
      column({ role: 'in_progress' }),
    )
    assert.equal(
      task().attention.some(a => a.key.endsWith(request.id)),
      false,
    )
    assert.equal(
      readEvents({ hydraId: 'lab' }).filter(e => e.type === 'task.permission' && e.data.status !== 'pending').length,
      1,
    )

    if (status === 'allow') {
      assert.deepEqual(
        sdk.permissions[0],
        { behavior: 'allow' },
      )
      const recorded = readEvents({ hydraId: 'lab' }).findLast(event =>
        event.type === 'task.permission' && event.data.status === 'allow')
      assert.equal(
        recorded?.reason,
        'The command is scoped to this worktree',
      )
      assert.equal(
        loadHydra({ hydraId: 'lab' }).state.hydraMessages?.length ?? 0,
        0,
      )
    }
  },
)

test(
  'an AskUserQuestion request keeps the answer and Hydra’s reason on the task event',
  async () => {
    const { task } = await lab()
    const sdk = fakeSdk()
    const input = {
      questions: [
        {
          question: 'Cover http links?',
          header: 'Scheme',
          multiSelect: false,
          options: [
            {
              label: 'Yes',
              description: 'Both',
            },
            {
              label: 'No',
              description: 'Only https',
            },
          ],
        },
        {
          question: 'Which cases?',
          header: 'Cases',
          multiSelect: true,
          options: [
            'Null',
            'Empty',
            'Long',
          ].map(label => ({
            label,
            description: '',
          })),
        },
      ],
    }
    sdk.control.permission = true
    sdk.control.tool = [
      'AskUserQuestion',
      input,
    ]
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    await start({ id: 'question-start' })
    await until({ check: () => task().permissions?.[0]?.status === 'pending' })
    const request = task().permissions![0]!
    assert.equal(
      request.questions?.length,
      2,
    )
    assert.match(
      task().attention.find(a => a.key.endsWith(request.id))!.text!,
      /Cover http links\?/,
    )
    await assert.rejects(
      async () => permission({
        args: [
          'ship',
          request.id,
          'allow',
        ],
      }),
      /needs an answer/,
    )
    await assert.rejects(
      async () => permission({
        args: [
          'ship',
          request.id,
          'allow',
          '--answer',
          '{"answers":[{"pick":[1,2]},{"pick":[1]}]}',
        ],
      }),
      /takes one option/,
    )
    const receipt = await permission({
      args: [
        'ship',
        request.id,
        'allow',
        '--answer',
        '{"answers":[{"text":"Only for the README"},{"pick":[3,1]}]}',
        '--actor',
        'hydra',
        '--reason',
        'The owner already chose',
      ],
    })
    const picked = [
      ['Only for the README'],
      [
        'Null',
        'Long',
      ],
    ]
    assert.deepEqual(
      receipt.answers,
      picked,
    )
    await until({ check: () => sdk.permissions.length === 1 })
    assert.deepEqual(
      sdk.permissions[0],
      {
        behavior: 'allow',
        updatedInput: {
          ...input,
          answers: {
            'Cover http links?': 'Only for the README',
            'Which cases?': 'Null, Long',
          },
        },
      },
    )
    assert.deepEqual(
      task().permissions![0]!.answers,
      picked,
    )
    const answered = readEvents({ hydraId: 'lab' }).findLast(event =>
      event.type === 'task.permission' && event.data.status === 'allow')
    assert.ok(answered?.type === 'task.permission')
    assert.equal(
      answered.cardId,
      task().id,
    )
    assert.ok(answered.reason)
    assert.match(
      answered.reason,
      /The owner already chose/,
    )
    assert.deepEqual(
      answered.data.answers,
      picked,
    )
    assert.equal(
      loadHydra({ hydraId: 'lab' }).state.hydraMessages?.length ?? 0,
      0,
    )
  },
)

test(
  'denial tells the provider why and neither denied nor unknown requests can be answered again',
  async () => {
    const { task } = await lab()
    const sdk = fakeSdk()
    sdk.control.permission = true
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    await start({ id: 'deny-start' })
    await until({ check: () => task().permissions?.length === 1 })
    const request = task().permissions![0]!
    await commands.task([
      'create',
      '--title',
      'Other task',
      '--key',
      'other',
      '--hydra',
      'lab',
    ])

    for (const [
      args,
      refused,
    ] of [
        [
          [
            'ship',
            request.id,
            'always',
          ],
          /allow\|deny/,
        ],
        [
          [
            'ship',
            'unknown',
            'allow',
          ],
          /not found/,
        ],
        [
          [
            'other',
            request.id,
            'allow',
          ],
          /not found/,
        ],
      ] as const) {
      await assert.rejects(
        async () => permission({ args: [...args] }),
        refused,
      )
    }

    await permission({
      args: [
        'ship',
        request.id,
        'deny',
        '--actor',
        'hydra',
        '--reason',
        'Do not write that file',
      ],
    })
    await until({ check: () => sdk.permissions.length === 1 })
    assert.deepEqual(
      sdk.permissions,
      [
        {
          behavior: 'deny',
          message: 'Do not write that file',
        },
      ],
    )
    const denied = readEvents({ hydraId: 'lab' }).findLast(event =>
      event.type === 'task.permission' && event.data.status === 'deny')
    assert.equal(
      denied?.reason,
      'Do not write that file',
    )
    assert.equal(
      loadHydra({ hydraId: 'lab' }).state.hydraMessages?.length ?? 0,
      0,
    )
    await assert.rejects(
      async () => permission({
        args: [
          'ship',
          request.id,
          'allow',
        ],
      }),
      /already deny/,
    )
  },
)

test(
  'provider abort, server close and crash recovery expire pending requests and release the provider',
  async () => {
    const { task } = await lab()
    const sdk = fakeSdk()
    sdk.control.permission = true
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    await start({ id: 'abort-start' })
    await until({ check: () => task().permissions?.length === 1 })
    sdk.aborts[0]!.abort()
    await until({ check: () => sdk.permissions.length === 1 })
    assert.deepEqual(
      [
        task().permissions![0]!.status,
        sdk.permissions[0]!.behavior,
      ],
      [
        'expired',
        'deny',
      ],
    )
    await reply({ text: 'Try another command' })
    await until({ check: () => task().permissions?.length === 2 })
    await server.close()
    server = undefined
    assert.equal(
      task().permissions![1]!.status,
      'expired',
    )
    assert.equal(
      task().attention.some(a => a.key.startsWith('pnyx:permission:')),
      false,
    )

    // A crash leaves a request pending; the next start expires it without starting an agent.
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => writer.append({
        event: permissionEvent({
          state: writer.state,
          card: task(),
          request: {
            id: 'left-pending',
            session: task().sessionIds![0]!,
            tool: 'Bash',
            input: { command: 'pwd' },
            status: 'pending',
          },
          meta,
        }),
      }),
    })
    const resumed = fakeSdk()
    server = await startServer({
      hydraId: 'lab',
      query: resumed.query,
    })
    assert.equal(
      resumed.calls.length,
      0,
    )
    assert.equal(
      task().permissions![2]!.status,
      'expired',
    )
    await assert.rejects(
      async () => permission({
        args: [
          'ship',
          'left-pending',
          'allow',
        ],
      }),
      /already expired/,
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

test(
  'an ended outside Codex thread continues lazily in Pnyx through the same thread, and its native hooks leave it hosted',
  async () => {
    const {
      folder,
      task,
      cards,
    } = await lab()
    const fixture = fakeCodex({ root: dirname(folder) })
    outside({
      folder,
      provider: 'codex',
      transcriptPath: fixture.transcript,
    })
    const count = cards()
    server = await startServer({
      hydraId: 'lab',
      spawnCodex: fixture.spawnCodex,
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
    await commands.task([
      'continue',
      'ship',
      '--event-id',
      'adopt-codex',
      '--hydra',
      'lab',
    ])
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
    assert.deepEqual(
      [
        task().agent?.host,
        task().agent?.sessionId,
        task().agent?.transcriptPath,
        fixture.children.length,
      ],
      [
        'pnyx',
        'native-session',
        fixture.transcript,
        0,
      ],
    )
    assert.equal(
      (await reply({ text: 'ALLOW' })).state,
      'delivered',
    )
    await until({ check: () => task().permissions?.[0]?.status === 'pending' })
    const request = task().permissions![0]!
    assert.equal(
      request.session,
      'codex:native-session',
    )
    await permission({
      args: [
        'ship',
        request.id,
        'allow',
      ],
    })
    await until({ check: () => task().sessionActivity === 'finished' })
    assert.equal(
      fixture.messages().find(m => m.method === 'thread/resume')?.params?.threadId,
      'native-session',
    )
    assert.equal(
      fixture.messages().some(m => m.method === 'thread/start'),
      false,
    )
    spoolWrite({
      hydraId: 'lab',
      entry: {
        v: 1,
        id: 'codex-adopted-hook',
        at: new Date().toISOString(),
        harness: 'codex',
        event: 'SessionEnd',
        payload: {
          session_id: 'native-session',
          cwd: folder,
        },
      },
    })
    ingestSpool({ hydraId: 'lab' })
    assert.equal(
      task().agent?.host,
      'pnyx',
    )
    assert.notEqual(
      task().sessionActivity,
      'ended',
    )
    assert.equal(
      cards(),
      count,
    )
  },
)

test(
  'hosted account fallback is recorded and retained across hooks and a server restart',
  async () => {
    const {
      folder,
      task,
    } = await lab()
    const spent = join(
      folder,
      '..',
      'claude-work',
    )
    mkdirSync(spent)
    writeFileSync(
      join(
        spent,
        'quota.json',
      ),
      JSON.stringify({
        provider: {
          quotaSemantics: {
            effectiveAvailability: [
              {
                scope: 'all_models',
                status: 'known',
                effectivePercentRemaining: 0,
                runway: { status: 'exhausted_now' },
              },
            ],
          },
        },
      }),
    )
    const config = effectiveDispatch({
      hydraId: 'lab',
      state: loadHydra({ hydraId: 'lab' }).state,
    })
    writeConfig({
      path: configPath({
        hydraId: 'lab',
        accounts: true,
      }),
      accounts: true,
      value: {
        accounts: {
          ...config.accounts,
          'claude:work': {
            provider: 'claude',
            folder: spent,
          },
        },
      },
    })
    writeConfig({
      path: configPath({ hydraId: 'lab' }),
      value: {
        main: 'claude:test',
        workers: {
          claude: [
            'claude:work',
            'claude:test',
          ],
        },
      },
    })
    const sdk = fakeSdk()
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    await start({ id: 'fallback' })
    await until({ check: () => task().sessionActivity === 'finished' })
    const chosenFolder = task().agent?.loginFolder
    assert.equal(
      chosenFolder,
      join(
        folder,
        '..',
        'claude',
      ),
    )
    assert.match(
      task().launch?.dispatch ?? '',
      /claude:work: 0%/,
    )
    hook({
      id: 'fallback-hook',
      event: 'PostToolUse',
      session: task().agent!.sessionId,
      cwd: folder,
    })
    assert.equal(
      task().agent?.loginFolder,
      chosenFolder,
    )
    assert.match(
      task().launch?.dispatch ?? '',
      /on claude:test/,
    )
    await server.close()
    process.env.CLAUDE_CONFIG_DIR = spent
    const resumed = fakeSdk()
    server = await startServer({
      hydraId: 'lab',
      query: resumed.query,
    })
    await reply({ text: 'Continue' })
    await until({ check: () => resumed.calls.length === 1 })
    assert.equal(
      resumed.calls[0]?.options.env?.CLAUDE_CONFIG_DIR,
      chosenFolder,
    )
  },
)

test(
  'ordinary feedback to a worker note never fabricates an owner decision',
  async () => {
    const { task } = await lab()
    const sdk = fakeSdk()
    server = await startServer({
      hydraId: 'lab',
      query: sdk.query,
    })
    await start({ id: 'declared-question' })
    await commands.task([
      'status',
      'ship',
      'needs_you',
      '--note',
      'Which layout?',
      '--hydra',
      'lab',
    ])
    const question = task().status!
    const receipt = await sendReply({
      hydraId: 'lab',
      request: {
        card: task().id,
        text: 'Use layout A',
        actor: 'hydra',
        homes: [],
        id: 'layout-answer',
      },
    })
    assert.equal(
      receipt.state,
      'delivered',
    )
    const timeline = taskTimeline({
      card: task(),
      events: readEvents({ hydraId: 'lab' }).map(event => ({
        ...event,
        data: { ...event.data },
        summary: '',
      })),
      columns: [],
    })
    assert.deepEqual(
      timeline.filter(update => update.id === question.id && update.decision),
      [],
    )
  },
)
