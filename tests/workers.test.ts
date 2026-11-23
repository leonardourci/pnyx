import { loadHydra } from '#app/store.ts'
import { taskChildren } from '#app/task-runtime.ts'
import { localToken } from '#app/server-state.ts'
import { foldWorkerLog } from '#workers/worker-log.ts'
import { withWriter } from '#app/writer.ts'
import { quietNativeWatch } from './setup/watch.ts'
import { workerLine } from './setup/worker-log.ts'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { WAIT_MS } from './setup/until.ts'
import { once } from 'node:events'
import { constants, openSync, appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, expect, onTestFinished, test, vi } from 'vitest'
import { base } from '#app/command-meta.ts'
import type { HydraState } from '#app/model.ts'
import { emptyHydra, replayOwned } from '#app/reducer.ts'
import { EVENT_VERSION } from '#store/events.ts'
import { applySessionMove } from '#workers/reduce.ts'
import { applySessionFacts } from '#workers/session-facts.ts'
import { inbox } from '#hydra/update-queue.ts'
import { readTranscriptRecord } from '#workers/transcripts.ts'
import { WORKER_RESUME } from '#workers/host.ts'
import { claudeProvider } from '#workers/claude.ts'
import { codexProvider } from '#workers/codex.ts'
import { codexProcesses } from '#workers/codex-processes.ts'
import { confirms, findOption, harnessControls } from '#workers/controls.ts'
import type { HostedEvent, HostedSession } from '#workers/provider.ts'
import { fakeClaude, fakeCodex } from './setup/agents.ts'
import { CLI, pnyx as runPnyx, parsed, operation, startPnyx, until, type AgentSession, type Hydra, type Pnyx } from './setup/pnyx.ts'

const REPLY_ID = '0b9e6a52-3c1d-4c8f-9a51-2f7f1d3c6e10'

vi.mock(
  'node:fs',
  async () => {
    const filesystem = await vi.importActual<typeof import('node:fs')>('node:fs')

    return {
      ...filesystem,
      openSync: vi.fn(filesystem.openSync),
    }
  },
)

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx({
    codexConfig: {
      features: {
        apps: true,
        plugins: true,
        image_generation: true,
      },
      web_search: 'live',
      mcp_servers: { example: { command: 'example' } },
      plugins: {
        example: {
          enabled: true,
          mcp_servers: { bundled: {} },
        },
      },
    },
  })
})

test(
  'replaying an attachment to a missing or occupied task preserves its sessions and undo state',
  () => {
    const session = 'codex:worker'
    const state: HydraState = {
      v: EVENT_VERSION,
      seq: 0,
      cards: {},
      keys: {},
      eventIds: {},
      undone: {},
      sessions: {
        [session]: {
          id: session,
          agent: {
            provider: 'codex',
            sessionId: 'worker',
          },
          originCardId: 'original',
          taskId: null,
          attention: [],
          sourceRefs: [],
        },
      },
    }
    applySessionMove({
      state,
      event: {
        ...base({
          state,
          cardId: 'missing',
          meta: {
            at: '2026-01-01T00:00:00.000Z',
            actor: 'owner',
            id: 'undo-detach',
          },
        }),
        type: 'task.session',
        undoes: 'detach',
        data: {
          session,
          before: null,
          after: 'missing',
        },
      },
    })

    expect(state.sessions?.[session]?.taskId).toBeNull()
    expect(state.undone).toEqual({})

    const task = 'occupied'
    const current = 'codex:current'
    const meta = {
      at: '2026-01-01T00:00:00.000Z',
      actor: 'owner',
    }
    replayOwned({
      state,
      events: [
        {
          ...base({
            state,
            cardId: task,
            meta: {
              ...meta,
              id: 'create-occupied-task',
            },
          }),
          type: 'task.created',
          data: {
            key: task,
            title: 'Occupied task',
          },
        },
      ],
    })
    applySessionMove({
      state,
      event: {
        ...base({
          state,
          cardId: task,
          meta: {
            ...meta,
            id: 'start-current-worker',
          },
        }),
        type: 'task.session',
        data: {
          session: current,
          before: null,
          after: task,
          started: {
            agent: {
              provider: 'codex',
              sessionId: 'current',
              host: 'pnyx',
            },
            settings: {},
          },
        },
      },
    })
    applySessionMove({
      state,
      event: {
        ...base({
          state,
          cardId: task,
          meta: {
            ...meta,
            id: 'undo-detach-into-occupied-task',
          },
        }),
        type: 'task.session',
        undoes: 'detach',
        data: {
          session,
          before: null,
          after: task,
        },
      },
    })

    expect(state.cards[task]?.agent?.sessionId).toBe('current')
    expect(state.sessions?.[current]?.taskId).toBe(task)
    expect(state.sessions?.[session]?.taskId).toBeNull()
    expect(state.undone).toEqual({})
  },
)

test(
  'Hydra delivery remembers the latest finished boundary after a completed turn',
  () => {
    const state = emptyHydra()
    const agent = {
      provider: 'codex',
      sessionId: 'hydra',
      host: 'pnyx',
    } as const

    for (const activity of [
      'working',
      'finished',
    ]) {
      replayOwned({
        state,
        events: [
          {
            ...base({
              state,
              cardId: '$sessions',
              meta: {
                id: activity,
                actor: 'pnyx',
                at: '2026-01-01T00:00:00.000Z',
              },
            }),
            type: 'session.observed',
            data: {
              fields: {
                agent,
                activity,
              },
            },
          },
        ],
      })
    }

    const finished = state.seq
    replayOwned({
      state,
      events: [
        {
          ...base({
            state,
            cardId: '$hydra',
            meta: {
              id: 'next:hosted',
              actor: 'pnyx',
              at: '2026-01-01T00:00:01.000Z',
            },
          }),
          type: 'hydra.delivered',
          data: { session: 'codex:hydra' },
        },
      ],
    })
    expect(state.sessions?.['codex:hydra']?.hydraTurn?.finishedThrough).toBe(finished)
  },
)

test(
  'a new resume attempt replaces a still-working turn once and repeated working reports retain it',
  () => {
    const agent = {
      provider: 'codex',
      sessionId: 'cut',
      host: 'pnyx',
    } as const
    const session = 'codex:cut'
    const state: HydraState = {
      v: EVENT_VERSION,
      seq: 5,
      cards: {},
      keys: {},
      eventIds: {},
      undone: {},
      sessions: {
        [session]: {
          id: session,
          agent,
          originCardId: 'task',
          taskId: null,
          attention: [],
          sourceRefs: [],
          sessionActivity: 'working',
          turn: {
            id: 'initial',
            seq: 5,
            resumes: 0,
            finishedThrough: 0,
          },
        },
      },
    }
    const working = ({
      id,
      seq,
    }: {
      id: string
      seq: number
    }) => applySessionFacts({
      state,
      event: {
        v: EVENT_VERSION,
        id,
        seq,
        at: '2026-01-01T00:00:00.000Z',
        actor: 'pnyx',
        cardId: '$sessions',
        type: 'session.observed',
        data: {
          fields: {
            agent,
            activity: 'working',
          },
        },
      },
    })
    working({
      id: 'resume:5',
      seq: 6,
    })
    expect(state.sessions?.[session]?.turn).toMatchObject({
      id: 'resume:5',
      seq: 6,
      resumes: 1,
    })
    working({
      id: 'resume:5',
      seq: 7,
    })
    working({
      id: 'tool-progress',
      seq: 8,
    })
    expect(state.sessions?.[session]?.turn).toMatchObject({
      id: 'resume:5',
      seq: 6,
      resumes: 1,
    })
    working({
      id: 'resume:6',
      seq: 9,
    })
    expect(state.sessions?.[session]?.turn).toMatchObject({
      id: 'resume:6',
      seq: 9,
      resumes: 2,
    })
  },
)

test(
  'replaying an undone task edit with an earlier session records its undo',
  () => {
    const state: HydraState = {
      v: EVENT_VERSION,
      seq: 0,
      cards: {},
      keys: {},
      eventIds: {},
      undone: {},
    }
    const meta = {
      at: '2026-01-01T00:00:00.000Z',
      actor: 'owner',
    }
    replayOwned({
      state,
      events: [
        {
          ...base({
            state,
            cardId: 'task',
            meta: {
              ...meta,
              id: 'create',
            },
          }),
          type: 'task.created',
          data: {
            key: 'task',
            title: 'Changed',
          },
        },
      ],
    })
    replayOwned({
      state,
      events: [
        {
          ...base({
            state,
            cardId: 'task',
            meta: {
              ...meta,
              id: 'undo-edit',
            },
          }),
          type: 'task.edited',
          undoes: 'edit',
          data: {
            key: 'task',
            title: 'Original',
            agent: {
              provider: 'codex',
              sessionId: 'earlier',
            },
            before: { title: 'Changed' },
          },
        },
      ],
    })

    expect(state.cards.task?.title).toBe('Original')
    expect(state.undone.edit).toBe('undo-edit')
  },
)

test(
  'a reused provider session keeps its current worker and a retry starts the requested task',
  async () => {
    const hydra = await pnyx.hydra()
    const { worker } = await hydra.startTask({
      key: 'original-worker',
      harness: 'codex',
    })
    const folder = hydra.folder({ name: 'next-worker' })
    const created = await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Next worker',
        '--folder',
        folder,
      ],
    })
    const task = created.card.id as string
    const args = [
      'task',
      'start',
      task,
      '--harness',
      'codex',
      '--event-id',
      'reused-provider',
    ]
    pnyx.codex.reuseNextSession({ id: worker.id })
    const pending = await hydra.owner({ args })
    expect(pending).toMatchObject({
      task,
      launch: 'pending',
      session: `codex:${worker.id}`,
    })
    expect(pending.information).toContain('existing session')
    expect(pending.help).toEqual(expect.arrayContaining([expect.stringContaining('Retry the same start request')]))
    expect((await hydra.task({ key: 'original-worker' })).worker).toBe(`codex:${worker.id}`)
    expect((await hydra.task({ key: task })).worker).toBe('none: not started, no reason given')
    expect(worker.closed).toBe(false)
    await hydra.owner({ args })
    const next = await until({
      what: 'the retry to start a fresh worker',
      check: () => pnyx.codex.sessions.find(session =>
        session.cwd === folder && !session.closed && session.answered === 1),
    })
    expect(next.id).not.toBe(worker.id)
    expect((await hydra.task({ key: task })).worker).toBe(`codex:${next.id}`)
    expect((await hydra.task({ key: 'original-worker' })).worker).toBe(`codex:${worker.id}`)
    const followUp = 'Continue on the original worker.'
    await hydra.owner({
      args: [
        'reply',
        'original-worker',
        '--text',
        followUp,
      ],
    })
    await until({
      what: 'the original worker to receive its follow-up',
      check: () => worker.received.some(text => text.includes(followUp)),
    })
  },
)

test(
  'a detached hosted worker finishes without changing its old task and keeps its activity after restart',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'detached-worker' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'detached-worker',
        '--title',
        'Detached worker',
        '--folder',
        folder,
      ],
    })
    const held = pnyx.claude.plan({
      hydra: hydra.id,
      partial: 'Still checking the export',
      hold: true,
    })
    onTestFinished(() => held.release())
    await hydra.owner({
      args: [
        'task',
        'start',
        'detached-worker',
      ],
    })
    const worker = await hydra.agent({ cwd: folder })
    const session = `claude-code:${worker.id}`
    const activity = () => (loadHydra({
      hydraId: hydra.id,
    }).state.sessions?.[session]?.sessionActivity)
    await until({
      what: 'the held worker turn',
      check: () => worker.received.length === 1,
    })
    expect(activity()).toBe('working')
    await hydra.owner({
      args: [
        'task',
        'detach',
        'detached-worker',
      ],
    })
    held.release()
    await until({
      what: 'the detached session to finish',
      check: () => activity() === 'finished',
    })
    expect((await hydra.task({ key: 'detached-worker' })).worker).toMatch(/^none(?::|$)/)
    await pnyx.restart()
    expect(activity()).toBe('finished')
    expect((await hydra.task({ key: 'detached-worker' })).worker).toMatch(/^none(?::|$)/)
  },
)

test(
  'registered hosted workers keep native features and connections without grants, while browser remains opt-in',
  async () => {
    process.env.PASEO_PASSWORD = 'synthetic-paseo-password'
    onTestFinished(() => {
      delete process.env.PASEO_PASSWORD
    })
    const hydra = await pnyx.hydra()
    const { worker: codex } = await hydra.startTask({
      key: 'native-codex',
      harness: 'codex',
    })
    expect(codex.env.PASEO_PASSWORD).toBeUndefined()
    expect(codex.env.CODEX_HOME).toBe(join(
      process.env.TMPDIR!,
      'pnyx-run',
      'codex-login',
    ))
    expect(codex.config).not.toHaveProperty('features.apps')
    expect(codex.config).not.toHaveProperty('features.plugins')
    expect(codex.config).not.toHaveProperty('features.image_generation')
    expect(codex.config).not.toHaveProperty('features.default_mode_request_user_input')
    expect(codex.config).not.toHaveProperty('web_search')
    expect(codex.config).not.toHaveProperty('mcp_servers')
    expect(codex.config).not.toHaveProperty('plugins')
    expect(codex.config).not.toHaveProperty('skills.config')
    expect(codex.env.CHROME_DEVTOOLS_AXI_SESSION).toBeUndefined()
    expect(codex.instructions).toContain('append needs-you: <request> to worker.log')

    const { worker: claude } = await hydra.startTask({ key: 'native-claude' })
    expect(claude.config).toMatchObject({
      tools: {
        type: 'preset',
        preset: 'claude_code',
      },
      settingSources: [
        'user',
        'project',
        'local',
      ],
    })
    expect(claude.config?.strictMcpConfig).toBeUndefined()
    expect(claude.config?.mcpServers).toBeUndefined()
    expect(claude.config?.plugins).toBeUndefined()
    expect(claude.config?.settings).not.toHaveProperty('enabledPlugins')

    expect((await hydra.owner({
      args: [
        'task',
        'tools',
        'native-codex',
        '--available',
      ],
    })).tools).toEqual(['browser'])
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'tools',
        'native-codex',
        '--grant',
        'mcp:example',
      ],
    })).code).toBe('VALIDATION_ERROR')
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'tools',
        'native-codex',
        '--grant',
        'plugin:example',
      ],
    })).code).toBe('VALIDATION_ERROR')
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'tools',
        'native-codex',
        '--revoke',
        'mcp:example',
      ],
    })).code).toBe('VALIDATION_ERROR')
    await hydra.owner({
      args: [
        'task',
        'tools',
        'native-codex',
        '--grant',
        'browser',
      ],
    })
    const browser = await until({
      what: 'browser selection to reach the resumed worker',
      check: () => pnyx.codex.sessions.find(session =>
        session.resumed && session.cwd === codex.cwd && session.env.CHROME_DEVTOOLS_AXI_SESSION),
    })
    expect(browser.env.CHROME_DEVTOOLS_AXI_HEADED).toBe('0')
    expect(browser.instructions).toContain('Use chrome-devtools-axi')
    expect(browser.instructions).not.toContain('append needs-you: <request> to worker.log')
    expect(browser.config).not.toHaveProperty('mcp_servers')
    expect(browser.config).not.toHaveProperty('plugins')
  },
)

test(
  'Codex routine helpers still disable configured services, skills and web search',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--helper',
        'codex',
        '--helper-model',
        'gpt-6-luna',
      ],
    })
    const main = await hydra.chat({ text: 'Watch native helper scope' })
    await until({
      what: 'Hydra first turn',
      check: () => main.answered === 1,
    })
    const retiredSkills = [
      'pnyx-firstmate-as-hydra',
      'pnyx-hydra-firstmate',
    ].map(name => join(
      main.cwd,
      '..',
      'helper',
      '.agents',
      'skills',
      name,
    ))

    for (const folder of retiredSkills) {
      mkdirSync(
        folder,
        { recursive: true },
      )
      writeFileSync(
        join(
          folder,
          'SKILL.md',
        ),
        'Retired Firstmate integration',
      )
    }

    await hydra.startTask({ key: 'routine-scope' })
    await workerLine({
      hydra,
      key: 'routine-scope',
      line: 'blocked: Check the worker scope',
    })
    const helper = await until({
      what: 'server-started Codex routine helper',
      check: () => pnyx.codex.sessions.find(session => session.env.PNYX_HYDRA === hydra.id
        && session.env.PNYX_ACTOR?.startsWith('helper:') && session.answered > 0),
    })

    for (const folder of retiredSkills) {
      expect(existsSync(folder)).toBe(false)
    }

    expect(helper.config).toMatchObject({
      'features.apps': false,
      'features.plugins': false,
      'skills.config': [],
      'skills.bundled.enabled': false,
      'skills.include_instructions': false,
      'features.sleep_tool': false,
      'features.default_mode_request_user_input': false,
      'tools.update_plan.enabled': false,
      web_search: 'disabled',
      mcp_servers: { example: { enabled: false } },
      plugins: {
        _default: { enabled: false },
        example: {
          enabled: false,
          mcp_servers: { bundled: { enabled: false } },
        },
      },
    })
  },
)

const times = ({
  sessions,
  text,
}: {
  sessions: AgentSession[]
  text: string
}) => sessions.flatMap(session => session.received).filter(message => message.includes(text)).length

test(
  'a started worker runs in its task\'s folder with its brief, and each owner reply reaches it once under the owner\'s id with a delivered receipt and shows once in the task\'s chat',
  async () => {
    const hydra = await pnyx.hydra()
    const {
      folder,
      worker,
    } = await hydra.startTask({
      key: 'export',
    })
    expect(worker.cwd).toBe(folder)
    expect(worker.env).toMatchObject({
      PNYX_HYDRA: hydra.id,
      PNYX_HOME: process.env.PNYX_HOME,
    })
    expect(worker.received[0]).toContain(`<pnyx-worker task="${(await hydra.owner({
      args: [
        'task',
        'show',
        'export',
      ],
    })).task.id}" hydra="${hydra.id}">`)
    expect(worker.received[0]).toContain('Brief for export')

    const sent = await hydra.owner({
      args: [
        'reply',
        'export',
        '--text',
        'Use semicolons as separators',
        '--idempotency-key',
        REPLY_ID,
      ],
    })
    expect(sent.reply).toMatchObject({
      sent: true,
      state: 'delivered',
    })
    await until({
      what: 'the reply to reach the worker',
      check: () => worker.answered === 2,
    })
    expect(times({
      sessions: [worker],
      text: 'Use semicolons as separators',
    })).toBe(1)
    expect(worker.uuids).toContain(REPLY_ID)

    const { thread } = await hydra.owner({
      args: [
        'task',
        'chat',
        'export',
      ],
    })
    expect((thread.entries as { role: string }[]).filter(entry => entry.role === 'You' || entry.role === 'user')).toEqual([
      expect.objectContaining({
        role: 'You',
        text: 'Use semicolons as separators',
        receipt: 'delivered',
      }),
    ])
    expect((await hydra.as({ session: worker }).run({
      args: [
        'task',
        'inbox',
        'read',
        'export',
      ],
    })).pending).toBe(0)
  },
)

test(
  'moving a native worker preserves its session, pending permission and later message delivery',
  async () => {
    const target = await pnyx.hydra()
    const source = await pnyx.hydra()
    const {
      worker,
      folder,
    } = await source.startTask({ key: 'moving-permission' })
    const task = (await source.owner({
      args: [
        'task',
        'show',
        'moving-permission',
        '--full',
      ],
    })).task
    const child = spawn(
      process.execPath,
      [
        '-e',
        'setInterval(() => {}, 1000)',
      ],
      {
        detached: true,
        stdio: 'ignore',
      },
    )
    onTestFinished(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return
      }

      const exited = once(
        child,
        'exit',
      )
      child.kill('SIGKILL')
      await exited
    })
    const children = taskChildren({
      hydraId: source.id,
      task: task.id,
    })
    children.spawned({ child })
    children.associate({
      pid: child.pid!,
      task: task.id,
    })
    const decision = worker.useTool!({
      tool: 'Bash',
      input: { command: 'echo moved-worker' },
    })
    const cancellation = new AbortController()
    onTestFinished(() => cancellation.abort())
    const cancelled = worker.useTool!({
      tool: 'Bash',
      input: { command: 'echo provider-cancelled' },
      signal: cancellation.signal,
    })

    try {
      const request = await until({
        what: 'the native permission before moving',
        check: async () => (await source.owner({
          args: [
            'task',
            'show',
            task.id,
            '--full',
          ],
        })).task.permissions?.find((request: {
          status: string
          input: { command?: string }
        }) => request.status === 'pending' && request.input.command === 'echo moved-worker'),
      })
      const pending = await until({
        what: 'the source records the cancellable permission before moving',
        check: async () => (await source.owner({
          args: [
            'task',
            'show',
            task.id,
            '--full',
          ],
        })).task.permissions?.find((candidate: {
          status: string
          input: { command?: string }
        }) => candidate.status === 'pending' && candidate.input.command === 'echo provider-cancelled'),
      })
      await source.owner({
        args: [
          'task',
          'move',
          task.id,
          '--to-hydra',
          target.id,
        ],
      })
      expect(worker.closed).toBe(false)
      const moved = (await target.owner({
        args: [
          'task',
          'show',
          task.id,
          '--full',
        ],
      })).task
      expect(moved.agent.sessionId).toBe(worker.id)
      expect(moved.agent.cwd).toBe(folder)
      expect(moved.permissions).toContainEqual(expect.objectContaining({
        id: request.id,
        status: 'pending',
      }))
      await source.owner({
        args: [
          'hydra',
          'remove',
          source.id,
        ],
      })
      await until({
        what: 'the source Hydra unmounts without closing the moved worker',
        check: async () => {
          const response = await fetch(`http://127.0.0.1:${pnyx.port()}/health`)
          const health = await response.json() as { hydras: string[] }

          return !health.hydras.includes(source.id)
        },
      })
      expect(worker.closed).toBe(false)
      expect(child.exitCode).toBeNull()
      expect(child.signalCode).toBeNull()

      for (const actor of [
        worker.env.PNYX_ACTOR,
        'worker:',
      ]) {
        const response = await fetch(
          `http://127.0.0.1:${pnyx.port()}/api/run`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${localToken()}`,
            },
            body: JSON.stringify({
              argv: [
                'board',
                '--json',
              ],
              cwd: folder,
              env: {
                PNYX_ACTOR: actor,
                PNYX_TASK: task.id,
                PNYX_HYDRA: source.id,
                PNYX_STEERING_WORKER: worker.env.PNYX_STEERING_WORKER,
              },
            }),
          },
        )
        const command = await response.json() as {
          exitCode: number
          stdout: string
        }
        expect(command.exitCode).toBe(0)
        expect(JSON.parse(command.stdout).hydraId).toBe(target.id)
        expect(JSON.parse(command.stdout).cards)
          .toContainEqual(expect.objectContaining({ id: task.id }))
      }

      appendFileSync(
        join(
          worker.env.PNYX_TASK_DIR!,
          'worker.log',
        ),
        'note: reported after the source was removed\n',
      )
      await until({
        what: 'the destination receives the original worker log',
        check: async () => (await target.task({ key: task.id })).latest === 'reported after the source was removed',
      })
      await target.owner({
        args: [
          'task',
          'permission',
          task.id,
          request.id,
          'allow',
          '--reason',
          'Allow the moved worker to continue',
        ],
      })
      expect(await decision).toMatchObject({ behavior: 'allow' })
      cancellation.abort()
      expect(await cancelled).toMatchObject({ behavior: 'deny' })
      await until({
        what: 'provider cancellation expires the destination permission after source removal',
        check: async () => (await target.owner({
          args: [
            'task',
            'show',
            task.id,
            '--full',
          ],
        })).task.permissions?.some((candidate: {
          id: string
          status: string
        }) => candidate.id === pending.id && candidate.status === 'expired'),
      })
      await target.owner({
        args: [
          'reply',
          task.id,
          '--text',
          'Continue on the destination Hydra',
        ],
      })
      await until({
        what: 'the original worker receives the destination message',
        check: () => worker.received.some(text => text.includes('Continue on the destination Hydra')),
      })
      expect(worker.received.filter(text => text.includes('Continue on the destination Hydra'))).toHaveLength(1)
      await until({
        what: 'the destination records the moved worker acknowledgement',
        check: async () => (await target.owner({
          args: [
            'task',
            'show',
            task.id,
            '--full',
          ],
        }))
          .task.steering?.some((message: {
            text: string
            ack?: unknown
          }) =>
            message.text === 'Continue on the destination Hydra' && message.ack !== undefined),
      })
      expect(worker.closed).toBe(false)
      expect((await target.owner({
        args: [
          'task',
          'show',
          task.id,
          '--full',
        ],
      })).task.agent.sessionId).toBe(worker.id)
      await target.owner({
        args: [
          'hydra',
          'remove',
          target.id,
        ],
      })
      await until({
        what: 'destination removal stops the moved tools',
        check: () => child.signalCode !== null || child.exitCode !== null,
      })
    } finally {
      await Promise.allSettled([
        source.owner({
          args: [
            'task',
            'stop',
            task.id,
          ],
        }),
        target.owner({
          args: [
            'task',
            'stop',
            task.id,
          ],
        }),
      ])
    }
  },
)

test(
  'moving a compacting worker keeps its held message until the original session finishes compaction',
  async () => {
    const source = await pnyx.hydra()
    const target = await pnyx.hydra()
    const key = 'moving-compaction'
    const { worker } = await source.startTask({ key })
    const held = pnyx.claude.plan({
      hydra: source.id,
      text: '/compact',
      compacting: true,
      hold: true,
    })
    onTestFinished(() => held.release())
    await reply({
      hydra: source,
      key,
      text: '/compact',
    })
    const task = await until({
      what: 'the worker starts compaction before moving',
      check: async () => {
        const task = (await source.owner({
          args: [
            'task',
            'show',
            key,
            '--full',
          ],
        })).task

        return task.compaction?.operations.some((operation: { state: string }) => operation.state === 'running') && task
      },
    })
    const text = 'Deliver this after compaction on the destination'
    await reply({
      hydra: source,
      key,
      text,
    })
    await until({
      what: 'compaction holds the message before moving',
      check: async () => (await source.owner({
        args: [
          'task',
          'show',
          key,
          '--full',
        ],
      })).task.compaction?.inputs.length === 1,
    })
    await source.owner({
      args: [
        'task',
        'move',
        task.id,
        '--to-hydra',
        target.id,
      ],
    })
    await source.owner({
      args: [
        'hydra',
        'remove',
        source.id,
      ],
    })
    expect(worker.closed).toBe(false)
    expect(worker.received.some(message => message.includes(text))).toBe(false)
    held.release()
    await until({
      what: 'the original worker receives the held message after moving',
      check: () => worker.received.some(message => message.includes(text)),
    })
    await until({
      what: 'the destination settles compaction and its input',
      check: async () => {
        const moved = (await target.owner({
          args: [
            'task',
            'show',
            task.id,
            '--full',
          ],
        })).task

        return moved.compaction?.inputs.length === 0 && moved.compaction?.operations.every((operation: { state: string }) => operation.state === 'done')
      },
    })
    expect(worker.received.filter(message => message.includes(text))).toHaveLength(1)
    expect(worker.closed).toBe(false)
  },
)

test(
  'a worker\'s permission request waits on its card until the owner decides it once, and the worker gets that decision',
  async () => {
    const hydra = await pnyx.hydra()
    const { worker } = await hydra.startTask({
      key: 'cleanup',
    })
    const needsYou = await hydra.column({ role: 'needs_you' })

    const denied = worker.useTool!({
      tool: 'Bash',
      input: { command: 'rm -rf build' },
    })
    const [request] = await until({
      what: 'the request on the card',
      check: async () => (await hydra.owner({
        args: [
          'task',
          'show',
          'cleanup',
          '--full',
        ],
      })).task.permissions,
    })
    expect(request).toMatchObject({
      tool: 'Bash',
      input: { command: 'rm -rf build' },
      status: 'pending',
    })
    expect((await hydra.owner({
      args: [
        'task',
        'show',
        'cleanup',
      ],
    })).task).toMatchObject({
      attention: 'permission',
      column: needsYou,
    })

    const asSession = hydra.as({
      session: worker,
      env: {
        ...worker.env,
        PNYX_ACTOR: `session:${request.session}`,
        PNYX_TASK: undefined,
        PNYX_STEERING_WORKER: undefined,
      },
    })
    expect((await asSession.refused({
      args: [
        'task',
        'permission',
        'cleanup',
        request.id,
        'allow',
        '--actor',
        'cli',
      ],
    })).code).toBe('NO_ROUTE')
    const outsideTask = await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Outside permission',
        '--key',
        'outside-self-approval',
      ],
    })
    await hydra.owner({
      args: [
        'push',
        '--key',
        'outside-self-approval',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent: {
          provider: 'claude-code',
          sessionId: 'outside-self-approval',
          cwd: hydra.folder({ name: 'outside-self-approval' }),
        },
        terminal: {
          tmux: '/tmp/pnyx-outside-test',
          tmuxPane: '%9',
          tty: '/dev/ttys99999',
          pid: '999999',
        },
        attention: [
          {
            key: 'hook:tool:Bash',
            kind: 'permission',
            text: 'Read the test fixture?',
            blocking: true,
          },
        ],
      }),
    })
    const outsideActor = hydra.as({
      session: worker,
      env: {
        ...worker.env,
        PNYX_ACTOR: 'session:claude-code:outside-self-approval',
        PNYX_TASK: undefined,
        PNYX_STEERING_WORKER: undefined,
      },
    })
    expect((await outsideActor.refused({
      args: [
        'reply',
        outsideTask.card.id,
        '--answer',
        'hook:tool:Bash',
        '--json',
        '{"choice":"allow"}',
        '--actor',
        'cli',
      ],
    })).code).toBe('NO_ROUTE')
    expect((await hydra.owner({
      args: [
        'task',
        'show',
        outsideTask.card.id,
        '--full',
      ],
    })).task.attention.find((item: { key: string }) => item.key === 'hook:tool:Bash')).not.toHaveProperty('answered')
    const asWorker = hydra.as({ session: worker })
    expect((await asWorker.refused({
      args: [
        'task',
        'permission',
        'cleanup',
        request.id,
        'allow',
      ],
    })).code).toBe('NO_ROUTE')

    await hydra.owner({
      args: [
        'task',
        'permission',
        'cleanup',
        request.id,
        'deny',
        '--reason',
        'Keep the build folder',
      ],
    })
    expect(await denied).toEqual({
      behavior: 'deny',
      message: 'Keep the build folder',
    })
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'permission',
        'cleanup',
        request.id,
        'allow',
      ],
    })).code).toBe('PERMISSION_CLOSED')
    expect((await hydra.owner({
      args: [
        'task',
        'show',
        'cleanup',
      ],
    })).task.column).not.toBe(needsYou)

    const allowed = worker.useTool!({
      tool: 'Bash',
      input: { command: 'ls build' },
    })
    const second = await until({
      what: 'the second request',
      check: async () => (await hydra.owner({
        args: [
          'task',
          'show',
          'cleanup',
          '--full',
        ],
      })).task.permissions.find((pending: { status: string }) => pending.status === 'pending'),
    })
    expect((await asWorker.refused({
      args: [
        'task',
        'permission',
        'cleanup',
        second.id,
        'allow',
        '--actor',
        'cli',
      ],
    })).code).toBe('NO_ROUTE')
    await hydra.owner({
      args: [
        'task',
        'permission',
        'cleanup',
        second.id,
        'allow',
      ],
    })
    expect(await allowed).toMatchObject({ behavior: 'allow' })
    const promoted = await hydra.owner({
      args: [
        'hydra',
        'set',
        '--session',
        'claude-code:outside-self-approval',
      ],
    })
    expect(promoted.notices).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('detached from its task') }))
    expect((await hydra.task({ key: outsideTask.card.id })).worker).toBe('none')
    expect((await hydra.owner({
      args: [
        'hydra',
        'show',
      ],
    })).hydra.hydra.session).toBe('claude-code:outside-self-approval')

    const outsideFolder = hydra.folder({ name: 'present-outside-session' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'present-outside',
        '--title',
        'Continue outside work',
      ],
    })
    await hydra.owner({
      args: [
        'push',
        '--key',
        'present-outside',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent: {
          provider: 'claude-code',
          sessionId: 'present-outside',
          cwd: outsideFolder,
        },
        terminal: {
          tty: '/dev/ttys99111',
          pid: '989898',
        },
        activity: 'working',
      }),
    })
    await hydra.owner({
      args: [
        'task',
        'hide',
        'present-outside',
      ],
    })
    const psBin = hydra.folder({ name: 'presence-process' })
    writeFileSync(
      join(
        psBin,
        'ps',
      ),
      `#!/usr/bin/env node
if (process.argv.includes('989898')) process.stdout.write('ttys99111\\n')
else {
  const result = require('node:child_process').spawnSync('/bin/ps', process.argv.slice(2))
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  process.exit(result.status ?? 1)
}
`,
      { mode: 0o755 },
    )
    const previousPath = process.env.PATH
    process.env.PATH = `${psBin}:${previousPath}`

    try {
      expect(await hydra.owner({
        args: [
          'task',
          'continue',
          'present-outside',
          '--check',
        ],
      })).toMatchObject({
        canContinue: true,
        state: 'present',
      })
      const continued = await hydra.owner({
        args: [
          'task',
          'continue',
          'present-outside',
        ],
      })
      expect(continued.notices).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('still present') }))
      expect(continued.notices).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('hidden task') }))
    } finally {
      process.env.PATH = previousPath
    }

    await hydra.owner({
      args: [
        'reply',
        'present-outside',
        '--text',
        'Resume the saved outside work',
      ],
    })
    const resumed = await hydra.agent({ cwd: outsideFolder })
    expect(resumed.resumed).toBe(true)
    await until({
      what: 'the resumed outside session to receive its message',
      check: () => resumed.received.some(text => text.includes('Resume the saved outside work')),
    })
  },
)

test(
  'a worker turn a restart cuts resumes in the same session, the owner\'s message interrupts and is delivered once, and the chat shows only that message as the owner\'s, with or without the session named',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'migration' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Long migration',
        '--key',
        'migration',
        '--folder',
        folder,
      ],
    })
    pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('<pnyx-worker'),
      reply: 'Migration finished.',
      partial: 'Migration',
      hold: true,
    })
    await hydra.owner({
      args: [
        'task',
        'start',
        'migration',
      ],
    })
    const cut = await hydra.agent({ cwd: folder })
    pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('Also migrate the archive'),
      partial: 'Archive migration',
      hold: true,
    })
    await hydra.owner({
      args: [
        'reply',
        'migration',
        '--text',
        'Also migrate the archive',
      ],
    })

    await until({
      what: 'the worker to take the owner input',
      check: () => cut.received.some(text => text.includes('Also migrate the archive')),
    })
    await pnyx.restart()
    const resumed = await until({
      what: 'the worker to resume after the restart',
      check: () => pnyx.claude.sessions.find(session => session.cwd === folder && session.resumed),
    })
    const inbox = await hydra.as({ session: resumed }).run({
      args: [
        'task',
        'inbox',
        'read',
        'migration',
      ],
    })
    expect(JSON.stringify(inbox.messages).split('Also migrate the archive')).toHaveLength(2)
    expect((await hydra.as({ session: resumed }).run({
      args: [
        'task',
        'inbox',
        'read',
        'migration',
      ],
    })).messages).toMatch(/^none:/)

    expect(resumed.id).toBe(cut.id)
    expect(resumed.received[0]).toContain('Pnyx restarted')

    for (const named of [
      [],
      [
        '--session',
        `claude-code:${resumed.id}`,
      ],
    ]) {
      const { thread } = await hydra.owner({
        args: [
          'task',
          'chat',
          'migration',
          ...named,
        ],
      })
      expect((thread.entries as {
        role: string
        text: string
      }[]).filter(entry => entry.role === 'You' || entry.role === 'user')
        .map(entry => entry.text)).toEqual(['Also migrate the archive'])
    }

    const sessions = pnyx.claude.sessions.filter(session => session.cwd === folder)
    expect(sessions).toHaveLength(2)
    expect(times({
      sessions,
      text: 'Also migrate the archive',
    })).toBe(1)
    expect(times({
      sessions,
      text: '<pnyx-worker',
    })).toBe(1)
  },
)

test(
  'a completed resume and ID-only inbox notice leave an interrupted instruction unread across restart',
  async () => {
    const hydra = await pnyx.hydra()
    const {
      folder,
      worker,
    } = await hydra.startTask({ key: 'unread-notice' })
    const held = pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('Keep this instruction unread'),
      partial: 'Starting',
      hold: true,
    })
    onTestFinished(() => held.release())
    await hydra.owner({
      args: [
        'reply',
        'unread-notice',
        '--text',
        'Keep this instruction unread',
      ],
    })
    await until({
      what: 'the instruction to reach the interrupted turn',
      check: () => worker.received.some(text => text.includes('Keep this instruction unread')),
    })
    const state = loadHydra({ hydraId: hydra.id }).state
    const task = state.cards[state.keys['unread-notice']!]!
    const path = task.agent!.transcriptPath!
    await pnyx.restart({
      whileStopped: () => {
        const at = new Date().toISOString()
        appendFileSync(
          path,
          `${JSON.stringify({
            type: 'user',
            uuid: '7b87d9bb-d450-4dfd-a5a1-6fc0792b3747',
            timestamp: at,
            message: {
              role: 'user',
              content: WORKER_RESUME,
            },
          })}\n${JSON.stringify({
            type: 'assistant',
            uuid: 'c92141fa-4f76-4305-8ced-075202369db3',
            timestamp: at,
            message: {
              id: 'msg_resume',
              role: 'assistant',
              content: 'Resumed.',
              stop_reason: 'end_turn',
            },
          })}\n`,
        )
      },
    })
    const log = join(
      process.env.PNYX_HOME!,
      'hydras',
      hydra.id,
      'tasks',
      task.id,
      'task.log',
    )
    const records = () => readFileSync(
      log,
      'utf8',
    ).trimEnd()
      .split('\n')
      .map(line => JSON.parse(line))
    const queued = records().find(record => record.event?.type === 'task.steering.queued'
      && record.event.data.message.text === 'Keep this instruction unread')
    expect(queued).toBeDefined()
    const message = queued.event.data.message
    const notice = pnyx.claude.sessions.filter(session => session.cwd === folder)
      .flatMap(session => session.received)
      .find(text => text.startsWith('Pnyx steering inbox has pending instruction IDs '))
    expect(notice).toContain(message.id)
    expect(notice).toContain('pnyx task ack')
    expect(notice).not.toContain('Keep this instruction unread')
    expect(records().filter(record => record.event?.type === 'task.steering.handled')).toEqual([])
    const args = [
      'task',
      'ack',
      task.id,
      message.id,
      '--session',
      message.queuedFor.session,
      '--generation',
      JSON.stringify(message.queuedFor.generation),
      '--hydra',
      hydra.id,
      '--json',
    ]

    for (const identity of [
      '',
      'another-launch',
    ]) {
      const refused = await runPnyx({
        args,
        env: {
          ...worker.env,
          PNYX_STEERING_WORKER: identity,
        },
      })
      expect(refused.status).not.toBe(0)
      expect(JSON.parse(refused.stderr)).toMatchObject({ code: 'STALE_CLAIM' })
    }

    const command = notice!.match(/^pnyx task ack .+$/m)![0]
    const acknowledged = await promisify(execFile)(
      '/bin/sh',
      [
        '-c',
        `pnyx() { "$PNYX_TEST_NODE" "$PNYX_TEST_CLI" "$@"; }\n${command} --json`,
      ],
      {
        env: {
          ...worker.env,
          PNYX_TEST_NODE: process.execPath,
          PNYX_TEST_CLI: CLI,
        },
        timeout: WAIT_MS,
      },
    )
    expect(JSON.parse(acknowledged.stdout)).toMatchObject({
      instruction: message.id,
      acknowledged: 'read',
    })
    expect((await runPnyx({
      args,
      env: worker.env,
    })).status).toBe(0)
    const saved = records().filter(record => record.event?.type === 'task.steering.handled')
    expect(saved).toHaveLength(1)
    await pnyx.restart()
    const retried = await runPnyx({
      args,
      env: worker.env,
    })
    expect(
      retried.status,
      retried.stderr,
    ).toBe(0)
    expect(records().filter(record => record.event?.type === 'task.steering.handled')).toEqual(saved)
    expect(times({
      sessions: pnyx.claude.sessions.filter(session => session.cwd === folder),
      text: 'Keep this instruction unread',
    })).toBe(1)
  },
)

test(
  'an explicit read persists after native input confirmation and stays idempotent across restart',
  async () => {
    const hydra = await pnyx.hydra()
    const { worker } = await hydra.startTask({ key: 'confirmed-read' })
    const task = await hydra.task({ key: 'confirmed-read' })
    await hydra.owner({
      args: [
        'reply',
        task.id,
        '--text',
        'Read this through the native harness',
      ],
    })
    const instruction = await until({
      what: 'native input confirmation to mark the instruction read',
      check: async () => (await hydra.owner({
        args: [
          'task',
          'inbox',
          'read',
          task.id,
          '--all',
        ],
      })).messages
        .find((message: {
          text: string
          ack?: { outcome: string }
        }) =>
          message.text === 'Read this through the native harness' && message.ack?.outcome === 'read'),
    })
    const path = join(
      process.env.PNYX_HOME!,
      'hydras',
      hydra.id,
      'tasks',
      task.id,
      'task.log',
    )
    const records = () => readFileSync(
      path,
      'utf8',
    ).trimEnd()
      .split('\n')
      .map(line => JSON.parse(line))
    const queued = records().find(record => record.event?.type === 'task.steering.queued'
      && record.event.data.message.id === instruction.id).event.data.message
    const acknowledgements = () => records().filter(record => record.event?.type === 'task.steering.handled'
      && record.event.data.message === instruction.id)
    expect(acknowledgements()).toHaveLength(0)
    const args = [
      'task',
      'ack',
      task.id,
      instruction.id,
      '--session',
      queued.queuedFor.session,
      '--generation',
      JSON.stringify(queued.queuedFor.generation),
      '--hydra',
      hydra.id,
      '--json',
    ]
    const accepted = await runPnyx({
      args,
      env: worker.env,
    })
    expect(
      accepted.status,
      accepted.stderr,
    ).toBe(0)
    expect(JSON.parse(accepted.stdout)).toMatchObject({
      instruction: instruction.id,
      acknowledged: 'read',
    })
    const saved = acknowledgements()
    expect(saved).toHaveLength(1)
    await pnyx.restart()
    const retry = await runPnyx({
      args,
      env: worker.env,
    })
    expect(
      retry.status,
      retry.stderr,
    ).toBe(0)
    expect(acknowledgements()).toEqual(saved)
  },
)

test(
  'a Codex worker gets each owner message once, shows it delivered in its task chat, and resumes the same thread after a restart',
  async () => {
    const hydra = await pnyx.hydra()
    const {
      folder,
      worker,
    } = await hydra.startTask({
      key: 'codex',
      harness: 'codex',
    })
    expect(worker.provider).toBe('codex')

    await hydra.owner({
      args: [
        'reply',
        'codex',
        '--text',
        'Add a test for empty input',
      ],
    })
    await until({
      what: 'the reply to reach Codex',
      check: () => worker.answered === 2,
    })
    expect(((await hydra.owner({
      args: [
        'task',
        'chat',
        'codex',
      ],
    })).thread.entries as { role: string }[]).filter(entry => entry.role === 'You' || entry.role === 'user')).toEqual([
      expect.objectContaining({
        text: 'Add a test for empty input',
        receipt: 'delivered',
      }),
    ])

    await pnyx.restart()
    await hydra.owner({
      args: [
        'reply',
        'codex',
        '--text',
        'Now update the docs',
      ],
    })
    const resumed = await until({
      what: 'Codex to resume its thread',
      check: () => pnyx.codex.sessions.find(session => session.cwd === folder && session.resumed
      && session.received.some(message => message.includes('Now update the docs'))),
    })
    expect(resumed.id).toBe(worker.id)
    const sessions = pnyx.codex.sessions.filter(session => session.cwd === folder)
    expect(times({
      sessions,
      text: 'Add a test for empty input',
    })).toBe(1)
    expect(times({
      sessions,
      text: 'Now update the docs',
    })).toBe(1)
  },
)

test(
  'an answer the agent refuses shows as failed in the task chat, reached nobody, and stays failed after a restart',
  async () => {
    const hydra = await pnyx.hydra()
    const { worker } = await hydra.startTask({
      key: 'refused',
      harness: 'codex',
    })
    const asked = await hydra.as({ session: worker }).run({
      args: [
        'task',
        'ask',
        'refused',
        '--question',
        'Which export format?',
      ],
    })
    pnyx.codex.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('Use TSV'),
      refuse: true,
    })

    await hydra.owner({
      args: [
        'task',
        'answer',
        'refused',
        asked.ask,
        '--text',
        'Use TSV',
      ],
    })

    const receipt = async () => (await hydra.owner({
      args: [
        'task',
        'chat',
        'refused',
      ],
    })).thread.entries.find((entry: { text: string }) => entry.text.includes('Use TSV'))?.receipt
    expect(await until({
      what: 'the refused answer to show failed',
      check: async () => await receipt() === 'failed' && 'failed',
    })).toBe('failed')
    expect(worker.answered).toBe(1)

    await pnyx.restart()
    expect(await receipt()).toBe('failed')
  },
)

test(
  'a worker starts on the first account that is neither signed out nor out of quota, an explicit account is honoured, and no usable account refuses the start',
  async () => {
    const hydra = await pnyx.hydra()
    const root = join(
      process.env.TMPDIR!,
      'pnyx-run',
    )
    const usable = join(
      root,
      'claude-login',
    )
    const spent = join(
      root,
      'claude-spent',
    )
    mkdirSync(spent)
    writeFileSync(
      join(
        spent,
        'exhausted',
      ),
      '',
    )

    const order = ({ accounts }: { accounts: string[] }) => hydra.owner({
      args: [
        'rule',
        'accounts',
        '--provider',
        'claude',
        '--order',
        accounts.join(),
      ],
    })

    const start = async ({
      key,
      extra = [],
    }: {
      key: string
      extra?: string[]
    }) => {
      const folder = hydra.folder({ name: key })
      await hydra.owner({
        args: [
          'task',
          'create',
          '--no-start',
          '--title',
          key,
          '--key',
          key,
          '--folder',
          folder,
        ],
      })
      const args = [
        'task',
        'start',
        key,
        ...extra,
      ]

      return {
        folder,
        args,
      }
    }

    for (const [
      name,
      folder,
    ] of [
        [
          'claude:spent',
          spent,
        ],
        [
          'claude:signedout',
          join(
            root,
            'claude-missing',
          ),
        ],
      ]) {
      await hydra.owner({
        args: [
          'account',
          'set',
          name!,
          '--provider',
          'claude',
          '--folder',
          folder!,
        ],
      })
    }

    try {
      // An account out of quota is passed over for the next one in the order.
      await order({
        accounts: [
          'claude:spent',
          'claude:test',
        ],
      })
      const fallback = await start({ key: 'fallback' })
      await hydra.owner({ args: fallback.args })
      expect((await hydra.agent({ cwd: fallback.folder })).env.CLAUDE_CONFIG_DIR).toBe(usable)

      // The owner's explicit account is used even without quota.
      const chosen = await start({
        key: 'chosen',
        extra: [
          '--account',
          'claude:spent',
        ],
      })
      await hydra.owner({ args: chosen.args })
      expect((await hydra.agent({ cwd: chosen.folder })).env.CLAUDE_CONFIG_DIR).toBe(spent)

      // A signed-out account stops a plain start; only an explicit choice passes over it.
      await order({
        accounts: [
          'claude:signedout',
          'claude:test',
        ],
      })
      const signedOut = await start({ key: 'signedout' })
      expect((await hydra.ownerRefused({ args: signedOut.args })).code).toBe('ACCOUNT_SIGNED_OUT')
      expect(pnyx.claude.sessions.some(session => session.cwd === signedOut.folder)).toBe(false)
      await hydra.owner({
        args: [
          ...signedOut.args,
          '--harness',
          'claude',
        ],
      })
      expect((await hydra.agent({ cwd: signedOut.folder })).env.CLAUDE_CONFIG_DIR).toBe(usable)

      // With no usable account the start stops instead of using an unlisted one.
      await order({ accounts: ['claude:spent'] })
      const none = await start({ key: 'none' })
      expect((await hydra.ownerRefused({ args: none.args })).code).toBe('DISPATCH_EXHAUSTED')
      expect(pnyx.claude.sessions.some(session => session.cwd === none.folder)).toBe(false)
    } finally {
      await order({ accounts: ['claude:test'] })

      for (const name of [
        'claude:spent',
        'claude:signedout',
      ]) {
        await hydra.owner({
          args: [
            'account',
            'remove',
            name,
          ],
        })
      }
    }
  },
)

test(
  'Stop on a worker keeps delivered owner input and unread Hydra steering, marks the card stopped, and permits a worker asking to Stop with a notice',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'stoppable' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Stoppable',
        '--key',
        'stoppable',
        '--folder',
        folder,
        '--brief',
        'Long job',
      ],
    })
    pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('<pnyx-worker'),
      partial: 'Working',
      hold: true,
    })
    await hydra.owner({
      args: [
        'task',
        'start',
        'stoppable',
      ],
    })
    const worker = await hydra.agent({ cwd: folder })
    await until({
      what: 'the worker\'s turn to start',
      check: () => worker.received.length === 1,
    })
    const hydraSession = await hydra.chat({ text: 'look at the stoppable task' })

    pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('owner follow-up'),
      partial: 'Following up',
      hold: true,
    })
    await hydra.owner({
      args: [
        'reply',
        'stoppable',
        '--text',
        'owner follow-up',
      ],
    })
    await hydra.as({ session: hydraSession }).run({
      args: [
        'reply',
        'stoppable',
        '--text',
        'hydra follow-up',
      ],
    })

    await until({
      what: 'the worker to take the owner follow-up before Stop',
      check: () => worker.received.some(text => text.includes('owner follow-up')),
    })

    const stopped = await hydra.as({ session: worker }).run({
      args: [
        'task',
        'stop',
        'stoppable',
      ],
    })
    expect(stopped.notices).toBeDefined()
    expect(stopped.stopped).toMatch(/^task-/)
    expect((await hydra.task({ key: 'stoppable' })).status).toBe('ended')
    await until({
      what: 'the owner\'s reply to remain delivered',
      check: async () => (await hydra.owner({
        args: [
          'task',
          'chat',
          'stoppable',
        ],
      })).thread.entries.some((entry: {
        text: string
        receipt?: string
      }) =>
        entry.text === 'owner follow-up' && entry.receipt === 'delivered'),
    })
    expect(JSON.stringify((await hydra.task({ key: 'stoppable' })).attention)).toContain('interrupted')

    const inbox = await hydra.as({ session: worker }).run({
      args: [
        'task',
        'inbox',
        'read',
        'stoppable',
      ],
    })
    expect(JSON.stringify(inbox.messages)).toContain('hydra follow-up')
    expect(JSON.stringify(inbox.messages)).not.toContain('owner follow-up')
    expect(times({
      sessions: [worker],
      text: 'owner follow-up',
    })).toBe(1)
    await hydra.owner({
      args: [
        'task',
        'hold',
        'stoppable',
        '--reason',
        'Keep the next owner instruction unread until Stop',
      ],
    })
    await hydra.owner({
      args: [
        'reply',
        'stoppable',
        '--text',
        'Cancel this unread owner instruction',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'stop',
        'stoppable',
      ],
    })
    const taskId = stopped.stopped as string
    const taskLog = join(
      process.env.PNYX_HOME!,
      'hydras',
      hydra.id,
      'tasks',
      taskId,
      'task.log',
    )
    const records = () => readFileSync(
      taskLog,
      'utf8',
    ).trimEnd()
      .split('\n')
      .map(line => JSON.parse(line))
    const cancelled = records().find(record => record.event?.type === 'task.steering.queued'
      && record.event.data.message.text === 'Cancel this unread owner instruction').event.data.message
    expect(records()).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        type: 'task.steering.stopped',
        data: { messages: expect.arrayContaining([cancelled.id]) },
      }),
    }))
    const handled = records().filter(record => record.event?.type === 'task.steering.handled')
    const delayed = await runPnyx({
      args: [
        'task',
        'ack',
        taskId,
        cancelled.id,
        '--session',
        cancelled.queuedFor.session,
        '--generation',
        JSON.stringify(cancelled.queuedFor.generation),
        '--hydra',
        hydra.id,
        '--json',
      ],
      env: worker.env,
    })
    expect(delayed.status).not.toBe(0)
    expect(JSON.parse(delayed.stderr)).toMatchObject({ code: 'STALE_CLAIM' })
    expect(records().filter(record => record.event?.type === 'task.steering.handled')).toEqual(handled)
  },
)

test(
  'a Fast setting an old harvest stored as on reads as true, and the agent command confirms it by the owner\'s words',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'push',
        '--key',
        'outside',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        title: 'Outside session',
        settings: { fast: 'on' },
      }),
    })
    expect((await hydra.owner({
      args: [
        'task',
        'show',
        'outside',
        '--full',
      ],
    })).task.settings.fast).toBe('true')

    const control = harnessControls({ provider: 'claude-code' })!.controls.find(candidate => candidate.setting === 'fast')!
    const on = findOption({
      provider: 'claude-code',
      setting: 'fast',
      value: 'on',
    })!
    expect(confirms({
      control,
      option: on.option,
      before: 'false',
      after: 'true',
    })).toBe(true)
    expect(confirms({
      control,
      option: on.option,
      before: 'true',
      after: 'false',
    })).toBe(false)
  },
)

// A provider session driven directly, for the cases the server cannot reach without timing luck.
async function driven({
  session,
  onEnd,
  owner = false,
}: {
  owner?: boolean
  session: HostedSession
  onEnd({ end }: { end(): Promise<void> }): void
}) {
  const input = inbox()
  const events: HostedEvent[] = []

  const messages = async function* () {
    for await (const message of input) {
      yield {
        id: message.id!,
        text: message.text,
        images: [],
        ownerMessageId: owner ? message.id : undefined,
      }
    }
  }

  const reading = (async () => {
    for await (const event of session.run({
      input: messages(),
      permission: async () => ({
        behavior: 'deny',
        message: 'unused',
      }),
    })) {
      events.push(event)
    }
  })()
  onEnd({
    end: async () => {
      input.end()
      session.close()
      await reading
    },
  })

  return {
    input,
    events,
  }
}

const refusedAsStopped = ({ events }: { events: HostedEvent[] }) => events.flatMap(event => typeof event === 'object'
  && event.type === 'input' && event.receipt.phase === 'refused' && event.receipt.stopped
  ? [event.receipt.inputId] : [])

const contextCounts = ({ events }: { events: HostedEvent[] }) => events.flatMap(event => typeof event === 'object'
  && event.type === 'usage' && event.used !== undefined
  ? [event.used] : [])

test(
  'a Stop during Claude\'s context render refuses that input, and the next input still carries the context rendered for it',
  async ({ onTestFinished }) => {
    const claude = fakeClaude()
    let renders = 0
    let release = () => {}
    const session = await claudeProvider({ query: claude.query }).open({
      cwd: process.env.TMPDIR!,
      settings: {},
      env: { PNYX_HOME: process.env.PNYX_HOME! },
      signal: new AbortController().signal,
      context: async () => {
        renders++

        if (renders === 1) {
          await new Promise<void>(resolve => {
            release = resolve
          })
        }

        return `Synthetic context ${renders}`
      },
    })
    const {
      input,
      events,
    } = await driven({
      session,
      onEnd: ({ end }) => onTestFinished(end),
    })
    input.push({
      id: 'waiting',
      text: 'must not start',
    })
    await until({
      what: 'the context render to begin',
      check: () => renders === 1,
    })
    await session.interrupt({ cancelQueued: true })
    release()
    await until({
      what: 'the input to be refused as stopped',
      check: () => refusedAsStopped({ events }).length === 1,
    })
    expect(claude.sessions[0]?.received ?? []).toEqual([])

    input.push({
      id: 'next',
      text: 'owner resumes',
    })
    await until({
      what: 'the next input to reach Claude',
      check: () => claude.sessions[0]?.received.length === 1,
    })
    expect(claude.sessions[0]!.received[0]).toMatch(/Synthetic context 1[\s\S]*Synthetic context 2[\s\S]*owner resumes/)
  },
)

test(
  'a Claude interrupt on an idle session does not mark the next turn interrupted, and a Stop after a compaction keeps the compacted context count',
  async ({ onTestFinished }) => {
    const claude = fakeClaude()
    const session = await claudeProvider({ query: claude.query }).open({
      cwd: process.env.TMPDIR!,
      settings: {},
      env: { PNYX_HOME: process.env.PNYX_HOME! },
      signal: new AbortController().signal,
    })
    const {
      input,
      events,
    } = await driven({
      session,
      onEnd: ({ end }) => onTestFinished(end),
    })
    await until({
      what: 'the session to start',
      check: () => claude.sessions.length === 1,
    })
    await session.interrupt({ cancelQueued: false })
    input.push({
      id: 'after',
      text: 'a normal turn',
    })
    await until({
      what: 'the turn to end',
      check: () => session.snapshot().outcome !== undefined,
    })
    expect(session.snapshot().outcome?.status).toBe('completed')

    claude.plan({
      text: '/compact',
      compacting: true,
      compactTo: 3_000,
      hold: true,
    })
    input.push({
      id: 'compact',
      text: '/compact',
    })
    await until({
      what: 'the compacted count before stopping',
      check: () => contextCounts({ events }).at(-1) === 3_000,
    })
    await session.interrupt({ cancelQueued: false })
    await until({
      what: 'the stopped compaction result',
      check: () => session.snapshot().outcome?.status === 'interrupted',
    })
    expect(contextCounts({ events }).at(-1)).toBe(3_000)
  },
)

test(
  'a Codex Stop refuses the inputs it carried for the next turn, as stopped',
  async ({ onTestFinished }) => {
    const codex = fakeCodex()
    const held = codex.plan({
      text: 'start codex',
      hold: true,
    })
    onTestFinished(() => held.release())
    codex.plan({
      text: 'refused steer',
      refuse: true,
    })
    const session = await codexProvider({ spawnCodex: codex.spawnCodex }).open({
      cwd: process.env.TMPDIR!,
      settings: {},
      env: { PNYX_HYDRA: 'codex-carried' },
      signal: new AbortController().signal,
    })
    const {
      input,
      events,
    } = await driven({
      session,
      onEnd: ({ end }) => onTestFinished(end),
    })
    input.push({
      id: 'open',
      text: 'start codex',
    })
    await until({
      what: 'the opening turn',
      check: () => session.snapshot().work.runningTurns.length === 1,
    })
    // Codex refuses to steer this message into the running turn, so it is carried to the next one.
    input.push({
      id: 'carried',
      text: 'refused steer',
    })
    await until({
      what: 'the input to be carried',
      check: () => events.some(event => typeof event === 'object' && event.type === 'input'
        && event.receipt.inputId === 'carried' && event.receipt.phase === 'carried'),
    })
    await session.interrupt({ cancelQueued: true })
    expect(refusedAsStopped({ events })).toEqual(['carried'])
    expect(session.snapshot().work.unsettledInputs).not.toContain('carried')
  },
)

test(
  'a Codex Stop ends the unfinished foreground commands, multi-line and with backslashes, and keeps the earlier and the background ones',
  async ({ onTestFinished }) => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-codex-processes-',
    ))
    onTestFinished(() => rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    ))
    const session = await codexProvider({
      spawnCodex: ({
        cwd,
        env,
      }) => spawn(
        process.execPath,
        [
          join(
            import.meta.dirname,
            'setup',
            'fixtures',
            'codex-stop.mjs',
          ),
        ],
        {
          cwd,
          env,
          stdio: 'pipe',
        },
      ),
    }).open({
      cwd: root,
      settings: {},
      env: {},
      signal: new AbortController().signal,
    })
    const {
      input,
      events,
    } = await driven({
      session,
      onEnd: ({ end }) => onTestFinished(end),
    })
    input.push({
      id: 'foreground',
      text: 'Run the synthetic foreground command',
    })
    await until({
      what: 'the foreground commands to start',
      check: () => existsSync(join(
        root,
        'pids.json',
      )) && existsSync(join(
        root,
        'started',
      )) && session.snapshot().work.runningTurns.length === 1
        && events.some(event => typeof event === 'object' && event.type === 'tool'
          && event.id === 'background' && !event.running),
    })
    const pids = JSON.parse(readFileSync(
      join(
        root,
        'pids.json',
      ),
      'utf8',
    )) as {
      earlier: number
      background: number
      foreground: number
      action: number
    }

    const alive = ({ pid }: { pid: number }) => {
      try {
        process.kill(
          pid,
          0,
        )

        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          return false
        }

        throw error
      }
    }

    onTestFinished(() => {
      for (const pid of [
        pids.earlier,
        pids.background,
        pids.foreground,
        pids.action,
      ]) {
        if (alive({ pid })) {
          process.kill(
            pid,
            'SIGKILL',
          )
        }
      }
    })

    await session.interrupt({ cancelQueued: true })
    await until({
      what: 'the interrupted outcome',
      check: () => session.snapshot().outcome?.status === 'interrupted',
    })
    expect(session.snapshot().outcome?.stoppedProcesses).toEqual(expect.arrayContaining([
      pids.foreground,
      pids.action,
    ]))
    await until({
      what: 'the foreground commands to exit',
      check: () => !alive({ pid: pids.foreground }) && !alive({ pid: pids.action }),
    })
    expect(existsSync(join(
      root,
      'completed',
    ))).toBe(false)
    expect(existsSync(join(
      root,
      'completed-action',
    ))).toBe(false)
    expect(alive({ pid: pids.earlier })).toBe(true)
    expect(alive({ pid: pids.background })).toBe(true)
  },
)

test(
  'Codex process cleanup that cannot read the process table logs and ends nothing instead of throwing',
  async () => {
    const path = process.env.PATH

    const unreadable = async <T>({ run }: { run(): Promise<T> }) => {
      // Without ps, reading the table fails.
      process.env.PATH = '/nonexistent'

      try {
        return await run()
      } finally {
        process.env.PATH = path
      }
    }

    // A table that cannot be read when Stop captures the commands.
    const stopping = codexProcesses({ pid: process.pid })
    stopping.begin()
    await stopping.ready()
    stopping.command({
      id: 'foreground',
      commands: ['sleep 120'],
      completed: false,
    })
    expect(await (await unreadable({ run: () => stopping.capture() }))()).toEqual([])

    // A baseline that could not be read: nothing can be told apart, so nothing is ended even once ps works again.
    const unbased = codexProcesses({ pid: process.pid })
    await unreadable({
      run: async () => {
        unbased.begin()
        await unbased.ready()
      },
    })
    unbased.command({
      id: 'foreground',
      commands: ['sleep 120'],
      completed: false,
    })
    expect(await (await unbased.capture())()).toEqual([])
  },
)

test(
  'Codex Send now interrupts the step and starts a turn that points at the steered message instead of repeating it',
  async ({ onTestFinished }) => {
    const codex = fakeCodex()
    const held = codex.plan({
      text: 'start codex',
      hold: true,
    })
    onTestFinished(() => held.release())
    const session = await codexProvider({ spawnCodex: codex.spawnCodex }).open({
      cwd: process.env.TMPDIR!,
      settings: {},
      env: { PNYX_HYDRA: 'codex-now' },
      signal: new AbortController().signal,
    })
    const {
      input,
      events,
    } = await driven({
      session,
      onEnd: ({ end }) => onTestFinished(end),
    })
    input.push({
      id: 'open',
      text: 'start codex',
    })
    await until({
      what: 'the opening turn',
      check: () => session.snapshot().work.runningTurns.length === 1,
    })
    input.push({
      id: 'steer',
      text: 'answer ONLY LATEST_MESSAGE',
    })
    await until({
      what: 'the steered message to be confirmed',
      check: () => events.some(event => typeof event === 'object' && event.type === 'input'
        && event.receipt.inputId === 'steer' && event.receipt.phase === 'confirmed'),
    })
    const nativeInputs = readFileSync(
      session.path!,
      'utf8',
    ).trim()
      .split('\n')
      .map(line => readTranscriptRecord({ record: JSON.parse(line) }))
      .filter(record => record.role === 'user')
      .flatMap(record => record.messages.map(message => message.text))
    expect(nativeInputs.filter(text => text.includes('LATEST_MESSAGE'))).toHaveLength(1)
    await session.interrupt({ cancelQueued: false })
    await until({
      what: 'the continuation turn to start',
      check: () => codex.sessions[0]!.received.length === 3,
    })
    expect(codex.sessions[0]!.received[2]).toContain('Answer their latest message above')
    expect(codex.sessions[0]!.received[2]).not.toContain('LATEST_MESSAGE')
  },
)

test(
  'a failed Claude context read reaches the session reader without delivering input',
  async () => {
    const claude = fakeClaude()
    const session = await claudeProvider({ query: claude.query }).open({
      cwd: process.env.TMPDIR!,
      settings: {},
      env: { PNYX_HOME: process.env.PNYX_HOME! },
      signal: new AbortController().signal,
      context: async () => {
        throw new Error('Memory access kept changing; retry the command')
      },
    })

    const input = async function* () {
      yield {
        id: 'rejected-context',
        text: 'must not arrive',
        images: [],
      }
    }

    const read = async () => {
      for await (const event of session.run({
        input: input(),
        permission: async () => ({
          behavior: 'deny',
          message: 'unused',
        }),
      })) {
        expect(event).not.toMatchObject({
          type: 'input',
          receipt: { phase: 'taken' },
        })
      }
    }

    try {
      await expect(read()).rejects.toThrow('Memory access kept changing; retry the command')
      expect(claude.sessions[0]?.received ?? []).toEqual([])
    } finally {
      session.close()
    }
  },
)

type ContextReading = {
  used: number
  window?: number
}

// Waits until the owner's usage view of the task shows a context that check accepts.
const contextReported = ({
  hydra,
  key,
  what,
  check,
}: {
  hydra: Hydra
  key: string
  what: string
  check({ context }: { context: ContextReading }): boolean
}) => until({
  what,
  check: async () => {
    const { context } = await hydra.owner({
      args: [
        'hydra',
        'usage',
        '--task',
        key,
      ],
    }) as { context?: ContextReading }

    return context !== undefined && check({ context })
  },
})

const reply = ({
  hydra,
  key,
  text,
}: {
  hydra: Hydra
  key: string
  text: string
}) => hydra.owner({
  args: [
    'reply',
    key,
    '--text',
    text,
  ],
})

test(
  'Claude\'s context reading takes the compacted size at once, keeps it across a restart, has its window while the resumed turn runs and follows a new window once a turn ends',
  async () => {
    const hydra = await pnyx.hydra()
    const key = 'claude-context'
    const { worker } = await hydra.startTask({ key })
    const recorded = pnyx.claude.context
    await contextReported({
      hydra,
      key,
      what: 'the first turn\'s context',
      check: ({ context }) => context.used === recorded.used && context.window === recorded.window,
    })

    const compactionTurn = pnyx.claude.plan({
      hydra: hydra.id,
      text: '/compact',
      compacting: true,
      compactTo: 3_000,
      hold: true,
    })
    await reply({
      hydra,
      key,
      text: '/compact',
    })

    await contextReported({
      hydra,
      key,
      what: 'the compacted size before the turn ends',
      check: ({ context }) => context.used === 3_000,
    })
    expect(worker.answered).toBe(1)

    compactionTurn.release()
    await until({
      what: 'the compaction turn to end',
      check: () => worker.answered === 2,
    })

    await pnyx.restart()
    await contextReported({
      hydra,
      key,
      what: 'the compacted size from the transcript after the restart',
      check: ({ context }) => context.used === 3_000,
    })

    const resumedTurn = pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('carry on'),
      hold: true,
      window: 200_000,
    })
    await reply({
      hydra,
      key,
      text: 'carry on',
    })
    const resumedSession = await until({
      what: 'the session to resume',
      check: () => pnyx.claude.sessions.find(({
        id,
        resumed,
      }) => id === worker.id && resumed),
    })
    await contextReported({
      hydra,
      key,
      what: 'the window while the resumed turn runs',
      check: ({ context }) => context.window === recorded.window,
    })
    expect(resumedSession.answered).toBe(0)

    resumedTurn.release()
    await contextReported({
      hydra,
      key,
      what: 'the window of the model the turn switched to',
      check: ({ context }) => context.window === 200_000,
    })
  },
)

test(
  'Codex\'s context reading follows the count it reports after an auto-compaction and in a resumed thread',
  async () => {
    const hydra = await pnyx.hydra()
    const key = 'codex-context'
    const { worker } = await hydra.startTask({
      key,
      harness: 'codex',
    })
    const recorded = pnyx.codex.context
    await contextReported({
      hydra,
      key,
      what: 'the first turn\'s context',
      check: ({ context }) => context.used === recorded.used && context.window === recorded.window,
    })

    pnyx.codex.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('keep going'),
      compactTo: 9_000,
    })
    await reply({
      hydra,
      key,
      text: 'keep going',
    })
    await contextReported({
      hydra,
      key,
      what: 'the count after the compaction',
      check: ({ context }) => context.used === 9_000 && context.window === recorded.window,
    })

    await pnyx.restart()
    await reply({
      hydra,
      key,
      text: 'after the restart',
    })
    await until({
      what: 'the thread to resume',
      check: () => pnyx.codex.sessions.find(({
        id,
        resumed,
      }) => id === worker.id && resumed),
    })
    await contextReported({
      hydra,
      key,
      what: 'the resumed thread\'s count',
      check: ({ context }) => context.used === recorded.used && context.window === recorded.window,
    })
  },
)

test(
  'worker log catch-up commits bounded batches and recovers after an oversized partial line across restart',
  async () => {
    const hydra = await pnyx.hydra()
    const { worker } = await hydra.startTask({ key: 'bounded-log' })
    const task = await hydra.task({ key: 'bounded-log' })
    const path = join(
      worker.env.PNYX_TASK_DIR!,
      'worker.log',
    )
    const burst = Array.from(
      { length: 1000 },
      (
        _,
        index,
      ) => `note: batch entry ${index} ${'x'.repeat(1024)}\n`,
    ).join('')
    const first = await withWriter({
      hydraId: hydra.id,
      fn: ({ writer }) => {
        writeFileSync(
          path,
          burst,
        )
        const from = writer.state.seq
        foldWorkerLog({
          writer,
          task: task.id,
        })

        return {
          off: writer.state.cards[task.id]!.workerLog!.latest.off,
          events: writer.state.seq - from,
        }
      },
    })
    expect(first.off).toBeLessThan(Buffer.byteLength(burst))
    expect(first.off).toBeLessThanOrEqual(64 * 1024)
    expect(first.events).toBeLessThanOrEqual(256)
    await until({
      what: 'all remaining batches fold without another append',
      check: async () => (await hydra.task({ key: task.id })).latest?.startsWith('batch entry 999 '),
    })
    const shortLine = 'note: short report\n'
    const shortBurst = shortLine.repeat(256)
    const shortBatchBytes = await withWriter({
      hydraId: hydra.id,
      fn: ({ writer }) => {
        appendFileSync(
          path,
          shortBurst,
        )
        foldWorkerLog({
          writer,
          task: task.id,
        })

        return writer.state.cards[task.id]!.workerLog!.latest.off - Buffer.byteLength(burst)
      },
    })
    expect(shortBatchBytes).toBe(128 * Buffer.byteLength(shortLine))
    appendFileSync(
      path,
      `note: oversized complete ${'x'.repeat(17 * 1024)}\nnote: valid after complete line\n`,
    )
    await until({
      what: 'a valid line follows an oversized complete report',
      check: async () => (await hydra.task({ key: task.id })).latest === 'valid after complete line',
    })
    appendFileSync(
      path,
      'note: ' + 'x'.repeat(200_000),
    )
    await until({
      what: 'an oversized incomplete line produces a visible warning',
      check: async () => (await hydra.task({ key: task.id })).latest?.includes('exceeds the worker.log line limit'),
    })
    await until({
      what: 'the incomplete line is drained before restart',
      check: async () => (await hydra.owner({
        args: [
          'task',
          'show',
          task.id,
          '--full',
        ],
      })).task.workerLog?.latest.off === readFileSync(path).length,
    })
    await pnyx.restart()
    appendFileSync(
      path,
      'note: this is still the discarded line\nnote: valid after the oversized line\n',
    )
    await until({
      what: 'the next valid line survives after restart',
      check: async () => (await hydra.task({ key: task.id })).latest === 'valid after the oversized line',
    })
    const history = (await hydra.owner({
      args: [
        'task',
        'history',
        task.id,
        '--limit',
        '100',
      ],
    })).events
    expect(JSON.stringify(history)).not.toContain('this is still the discarded line')
    expect(JSON.stringify(history)).not.toContain('oversized complete')
  },
)

test(
  'an existing Hydra-local worker report is read after moving the task',
  async () => {
    const source = await pnyx.hydra()
    const target = await pnyx.hydra()
    const created = await source.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Keep the existing worker report',
      ],
    })
    const task = created.card.id as string
    const directory = join(
      process.env.PNYX_HOME!,
      'hydras',
      source.id,
      'tasks',
      task,
    )
    const report = join(
      directory,
      'worker.log',
    )
    mkdirSync(
      directory,
      { recursive: true },
    )
    writeFileSync(
      report,
      'note: report written before upgrading\n',
    )
    await source.owner({
      args: [
        'task',
        'move',
        task,
        '--to-hydra',
        target.id,
      ],
    })
    appendFileSync(
      join(
        process.env.PNYX_HOME!,
        'hydras',
        target.id,
        'tasks',
        task,
        'worker.log',
      ),
      'note: report written after moving\n',
    )
    await until({
      what: 'the destination reads the existing worker report',
      check: async () => (await target.task({ key: task })).latest === 'report written after moving',
    })
  },
)

test(
  'worker log status and complete lines survive restarts',
  async () => {
    const hydra = await pnyx.hydra()
    const taskRoot = join(
      process.env.PNYX_HOME!,
      'runtime',
      'tasks',
    )
    quietNativeWatch({ root: taskRoot })
    const { worker } = await hydra.startTask({ key: 'facts' })
    await until({
      what: 'idle worker status',
      check: async () => (await hydra.task({ key: 'facts' })).status === 'idle',
    })
    const path = join(
      worker.env.PNYX_TASK_DIR!,
      'worker.log',
    )
    writeFileSync(
      path,
      'blocked: waiting for access\n',
    )
    await until({
      what: 'worker log block',
      check: async () => (await hydra.task({ key: 'facts' })).status === 'blocked',
    })
    expect((await hydra.task({ key: 'facts' })).column).toBe(await hydra.column({ role: 'in_progress' }))
    writeFileSync(
      path,
      'note: reviewed café\u2028failure\nneeds-you: choose an account',
      { flag: 'a' },
    )
    const blocked = await until({
      what: 'note folded without a partial status line',
      check: async () => {
        const result = await hydra.owner({
          args: [
            'task',
            'show',
            'facts',
            '--full',
          ],
        })

        return result.task.workerLog?.latest.text === 'reviewed café\u2028failure' && result.task
      },
    })
    expect(blocked.workerLog.status.code).toBe('blocked')
    writeFileSync(
      path,
      '\n',
      { flag: 'a' },
    )
    await until({
      what: 'completed needs-you line',
      check: async () => (await hydra.task({ key: 'facts' })).status === 'needs you',
    })
    expect((await hydra.task({ key: 'facts' })).latest).toBe('choose an account')
    writeFileSync(
      path,
      'link: https://example.com/preview Preview\ndone: implementation complete\n',
      { flag: 'a' },
    )
    await until({
      what: 'done worker log',
      check: async () => (await hydra.owner({
        args: [
          'task',
          'show',
          'facts',
          '--full',
        ],
      })).task.workerLog?.status.code === 'done',
    })
    const done = await hydra.owner({
      args: [
        'task',
        'show',
        'facts',
        '--full',
      ],
    })
    expect(done.task.links).toContainEqual({
      kind: 'url',
      url: 'https://example.com/preview',
      title: 'Preview',
      src: 'worker',
    })
    expect(done.task.workerLog.latest.off).toBe(Buffer.byteLength(readFileSync(
      path,
      'utf8',
    )))
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'unreadable-log',
        '--title',
        'Unreadable worker log',
      ],
    })
    const unreadable = await hydra.task({ key: 'unreadable-log' })
    const unreadableDir = join(
      taskRoot,
      unreadable.id,
    )
    mkdirSync(
      unreadableDir,
      { recursive: true },
    )
    const unreadableLog = join(
      unreadableDir,
      'worker.log',
    )
    const unavailable = await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Unavailable worker log directory',
      ],
    })
    const unavailableDir = join(
      taskRoot,
      unavailable.card.id,
    )
    const filesystem = await vi.importActual<typeof import('node:fs')>('node:fs')
    const taskLog = join(
      process.env.PNYX_HOME!,
      'hydras',
      hydra.id,
      'tasks',
      done.task.id,
      'task.log',
    )
    let attempts = 0
    // eslint-disable-next-line pnyx/object-params -- Node owns openSync's positional signature.
    vi.mocked(openSync).mockImplementation((...args) => {
      const [
        file,
        flags,
      ] = args

      if (String(file) === taskLog && typeof flags === 'number' && (flags & constants.O_APPEND)) {
        attempts++

        if (attempts === 1) {
          throw Object.assign(
            new Error('injected initial worker log append failure'),
            { code: 'EIO' },
          )
        }
      }

      return filesystem.openSync(...args)
    })
    onTestFinished(() => {
      vi.mocked(openSync).mockImplementation(filesystem.openSync)
    })
    await pnyx.restart({
      whileStopped: () => {
        rmSync(
          unavailableDir,
          {
            recursive: true,
            force: true,
          },
        )
        writeFileSync(
          unavailableDir,
          'A file occupies the task directory',
        )
        rmSync(
          unreadableLog,
          { force: true },
        )
        symlinkSync(
          'worker.log',
          unreadableLog,
        )
        writeFileSync(
          path,
          'note: completed offline\nnote: partial',
          { flag: 'a' },
        )
      },
    })
    rmSync(unreadableLog)
    rmSync(unavailableDir)
    const restored = await until({
      what: 'the offline line to recover after its first write fails',
      check: async () => {
        const shown = await hydra.owner({
          args: [
            'task',
            'show',
            'facts',
            '--full',
          ],
        })

        return shown.task.workerLog?.latest.text === 'completed offline' && shown
      },
    })
    expect(attempts).toBeGreaterThan(1)
    expect(restored.task.workerLog.status).toEqual(done.task.workerLog.status)
    expect(restored.task.workerLog.latest.text).toBe('completed offline')
    writeFileSync(
      path,
      ' suffix\n',
      { flag: 'a' },
    )
    await until({
      what: 'partial offline line to complete',
      check: async () => (await hydra.task({ key: 'facts' })).latest === 'partial suffix',
    })
    const history = await hydra.owner({
      args: [
        'task',
        'history',
        'facts',
        '--limit',
        '100',
      ],
    })
    const lines = history.events.filter((event: { type: string }) => event.type === 'task.worker-line')
    expect(lines).toHaveLength(7)
    expect(new Set(lines.map((event: { id: string }) => event.id)).size).toBe(7)
    await workerLine({
      hydra,
      key: 'facts',
      line: 'unknown: visible warning',
    })
    const invalid = await hydra.owner({
      args: [
        'task',
        'show',
        'facts',
        '--full',
      ],
    })
    expect(invalid.task.workerLog.latest).toMatchObject({
      code: 'invalid',
      text: 'unknown: visible warning',
    })
    expect(invalid.task.workerLog.status.code).toBe('done')
    expect((await hydra.task({ key: 'facts' })).latest).toContain('Invalid worker.log line')
    await workerLine({
      hydra,
      key: 'facts',
      line: 'blocked: bad\0input',
    })
    expect(await hydra.task({ key: 'facts' })).toMatchObject({
      status: 'idle',
      latest: 'Invalid worker.log line: blocked: bad\\0input',
    })
    await workerLine({
      hydra,
      key: 'facts',
      line: 'link: javascript:alert(1)',
    })
    expect((await hydra.owner({
      args: [
        'task',
        'show',
        'facts',
        '--full',
      ],
    })).task.links).toHaveLength(1)

    expect((await hydra.task({ key: 'facts' })).status).toBe('idle')
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'status',
        'facts',
        'working',
      ],
    })).code).toBe('VALIDATION_ERROR')
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'completed-worker',
        '--title',
        'Completed outside work',
      ],
    })
    await workerLine({
      hydra,
      key: 'completed-worker',
      line: 'done: outside work complete',
    })
    expect((await hydra.task({ key: 'completed-worker' })).status).toBe('done')
    await hydra.owner({
      args: [
        'task',
        'hide',
        'completed-worker',
      ],
    })
    const completed = await hydra.task({ key: 'completed-worker' })
    const hiddenLog = join(
      process.env.PNYX_HOME!,
      'runtime',
      'tasks',
      completed.id,
      'worker.log',
    )
    await pnyx.restart({
      whileStopped: () => writeFileSync(
        hiddenLog,
        'note: recorded while hidden\n',
        { flag: 'a' },
      ),
    })
    expect(await hydra.task({ key: 'completed-worker' })).toMatchObject({
      status: 'done',
      latest: 'recorded while hidden',
    })
    writeFileSync(
      path,
      'note: truncated\n',
    )
    await until({
      what: 'a visible truncation warning while commands keep working',
      check: async () => (await hydra.task({ key: 'facts' })).latest?.includes('worker.log was truncated'),
    })
    expect((await hydra.owner({
      args: [
        'task',
        'show',
        'facts',
        '--full',
      ],
    })).task.workerLog.status.code).toBe('done')
    renameSync(
      path,
      `${path}.old`,
    )
    writeFileSync(
      path,
      'note: restored append stream\n',
    )
    await until({
      what: 'the replacement log to resume updates',
      check: async () => (await hydra.task({ key: 'facts' })).latest === 'restored append stream',
    })
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--command',
        'printenv PNYX_TASK > launch.txt; test -n "$PNYX_TASK_DIR" && printf "note: command update\\n" >> "$PNYX_TASK_DIR/worker.log"',
      ],
    })
    const commandFolder = hydra.folder({ name: 'command-worker' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'command-worker',
        '--title',
        'Command worker',
        '--folder',
        commandFolder,
      ],
    })
    expect(await hydra.owner({
      args: [
        'task',
        'start',
        'command-worker',
        '--via',
        'command',
        '--event-id',
        'command-worker-launch',
      ],
    })).toMatchObject({
      via: 'command',
      folder: commandFolder,
    })
    await until({
      what: 'the command worker to write through its task directory environment',
      check: async () => (await hydra.task({ key: 'command-worker' })).latest === 'command update',
    })
    const commandTask = await hydra.task({ key: 'command-worker' })
    expect(readFileSync(
      join(
        commandFolder,
        'launch.txt',
      ),
      'utf8',
    ).trim()).toBe(commandTask.id)

    rmSync(
      commandFolder,
      { recursive: true },
    )

    for (const route of [
      'firstmate',
      'paseo',
    ]) {
      expect(await hydra.ownerRefused({
        args: [
          'task',
          'start',
          'command-worker',
          '--via',
          route,
          '--event-id',
          'command-worker-launch',
        ],
      }))
        .toMatchObject({
          code: 'VALIDATION_ERROR',
          error: expect.stringContaining(route),
        })
    }

    expect(await hydra.owner({
      args: [
        'task',
        'start',
        'command-worker',
        '--via',
        'command',
        '--event-id',
        'command-worker-launch',
      ],
    }))
      .toMatchObject({ event: 'none: duplicate' })
  },
)

test(
  'native turn facts ignore compact summaries and root-sidechain records',
  () => {
    for (const [
      type,
      activity,
    ] of [
        [
          'task_started',
          'working',
        ],
        [
          'task_complete',
          'finished',
        ],
        [
          'turn_aborted',
          'finished',
        ],
      ]) {
      expect(readTranscriptRecord({
        record: {
          type: 'event_msg',
          timestamp: '2026-11-19T10:00:00Z',
          payload: { type },
        },
      }).activity).toBe(activity)
    }

    expect(readTranscriptRecord({
      record: {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [],
        },
      },
    }).activity).toBeUndefined()

    const assistant = {
      type: 'assistant',
      message: {
        stop_reason: 'end_turn',
        content: [],
      },
    }
    expect(readTranscriptRecord({ record: assistant }).activity).toBe('finished')
    expect(readTranscriptRecord({
      record: {
        ...assistant,
        isSidechain: true,
      },
    }).activity).toBeUndefined()
    expect(readTranscriptRecord({
      record: {
        ...assistant,
        isSidechain: true,
      },
      subagent: true,
    }).activity).toBe('finished')
    expect(readTranscriptRecord({
      record: {
        type: 'user',
        isCompactSummary: true,
        message: { content: 'Context summary' },
      },
    }).activity).toBeUndefined()
  },
)

test(
  'repeated working observations and child turns do not reset a cut worker’s resume limit',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'resume-limit' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'migration',
        '--title',
        'Resume limit',
        '--folder',
        folder,
      ],
    })
    pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('<pnyx-worker'),
      hold: true,
    })
    await hydra.owner({
      args: [
        'task',
        'start',
        'migration',
      ],
    })
    await hydra.agent({ cwd: folder })
    const agent = (await hydra.owner({
      args: [
        'task',
        'show',
        'migration',
        '--full',
      ],
    })).task.agent

    for (let attempt = 0; attempt < 3; attempt++) {
      await hydra.owner({
        args: [
          'push',
          '--key',
          'migration',
          '--file',
          '-',
        ],
        input: JSON.stringify({
          agent,
          activity: 'working',
        }),
      })
      await hydra.owner({
        args: [
          'push',
          '--key',
          `child-${attempt}`,
          '--file',
          '-',
        ],
        input: JSON.stringify({
          agent: {
            ...agent,
            agentId: `child-${attempt}`,
            host: undefined,
          },
          activity: 'working',
        }),
      })
      pnyx.claude.plan({
        hydra: hydra.id,
        match: ({ text }) => text.includes('Pnyx restarted'),
        hold: true,
      })
      await pnyx.restart()
      await until({
        what: 'the next cut turn to resume',
        check: () => pnyx.claude.sessions.filter(session => session.cwd === folder)
          .length === attempt + 2,
      })
    }

    await hydra.owner({
      args: [
        'push',
        '--key',
        'migration',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent,
        activity: 'working',
      }),
    })
    await pnyx.restart()
    expect(pnyx.claude.sessions.filter(session => session.cwd === folder)).toHaveLength(4)
    expect((await hydra.owner({
      args: [
        'task',
        'show',
        'migration',
        '--full',
      ],
    })).task.activity).toBe('interrupted')

    pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('Pnyx restarted'),
      hold: true,
    })
    const nativeSession = Object.values(loadHydra({
      hydraId: hydra.id,
    }).state.sessions ?? {}).find(session =>
      session.agent.sessionId === agent.sessionId && !session.agent.agentId)!
    await pnyx.restart({
      whileStopped: () => {
        const at = new Date().toISOString()
        const records = [
          {
            type: 'assistant',
            uuid: '3a5f6548-960d-4a17-829b-883fe5160651',
            timestamp: at,
            message: {
              id: 'msg_closed_turn',
              role: 'assistant',
              content: [],
              stop_reason: 'end_turn',
            },
          },
          {
            type: 'user',
            uuid: 'cb825ede-2319-4d3e-83eb-e68b570aa20b',
            timestamp: at,
            message: {
              role: 'user',
              content: 'Start a separate turn after interruption',
            },
          },
        ]
        appendFileSync(
          nativeSession.agent.transcriptPath!,
          `${records.map(record => JSON.stringify(record)).join('\n')}\n`,
        )
      },
    })
    await until({
      what: 'the new cut turn to resume independently after interruption',
      check: () => pnyx.claude.sessions.filter(session => session.cwd === folder).length === 5,
    })
  },
)

test(
  'retired integration commands and launch routes are refused',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'outside-routes',
        '--title',
        'Outside routes',
        '--no-start',
      ],
    })
    expect((await hydra.owner({ args: ['integrations'] })).integrations.map((entry: { name: string }) => entry.name).sort())
      .toEqual([
        'command',
        'github',
        'hooks',
        'skills',
      ])

    for (const [
      args,
      route,
    ] of [
        [
          [
            'task',
            'start',
            'missing-task',
            '--via',
            'unknown',
          ],
          'unknown',
        ],
        [
          [
            'hydra',
            'start',
            '--via',
            'firstmate',
          ],
          'firstmate',
        ],
        [
          [
            'hydra',
            'start',
            '--via',
            'paseo',
          ],
          'paseo',
        ],
      ] as const) {
      expect(await hydra.ownerRefused({ args: [...args] })).toMatchObject({
        code: 'VALIDATION_ERROR',
        error: expect.stringContaining(route),
      })
    }

    for (const args of [
      [
        'hydra',
        'create',
        'removed-home',
        '--firstmate',
        '/unused',
      ],
      [
        'integrations',
        '--paseo-url',
        'ws://127.0.0.1:1/ws',
      ],
      [
        'reply',
        'outside-routes',
        '--text',
        'Retired route',
        '--resolve-key',
        'decision',
      ],
      [
        'hydra',
        'homes',
      ],
      [
        'firstmate',
        'sync',
        '--home',
        '/unused',
      ],
      [
        'task',
        'paseo',
      ],
      [
        'task',
        'start',
        'outside-routes',
        '--paseo-url',
        'ws://127.0.0.1:1/ws',
      ],
    ]) {
      expect((await hydra.ownerRefused({ args })).code).toBe('VALIDATION_ERROR')
    }

    const help = await operation({
      args: ['--help'],
      env: process.env,
    })
    expect(help.status).toBe(0)
    expect(help.stdout).not.toMatch(/\bhomes\b/)
  },
)

test(
  'outside sessions attach by id and by the caller tmux or Herdr pane',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'outside-session' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'outside-task',
        '--title',
        'Outside task',
      ],
    })
    const task = await hydra.task({ key: 'outside-task' })
    await hydra.owner({
      args: [
        'push',
        '--key',
        'outside-session',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent: {
          provider: 'codex',
          sessionId: 'outside-session',
          cwd: folder,
        },
        terminal: {
          tty: '/dev/ttys99999',
          tmux: '/tmp/test-tmux',
          tmuxPane: '%1',
          herdrSession: 'test-session',
          herdrPane: 'pane-1',
        },
        activity: 'finished',
      }),
    })
    await hydra.owner({
      args: [
        'task',
        'attach',
        task.id,
        '--session',
        'codex:outside-session',
      ],
    })
    expect((await hydra.task({ key: task.id })).worker).toBe('codex:outside-session')
    await hydra.owner({
      args: [
        'task',
        'detach',
        task.id,
      ],
    })
    expect((await hydra.task({ key: task.id })).worker).toMatch(/^none(?::|$)/)

    for (const identity of [
      { TMUX_PANE: '%1' },
      { HERDR_PANE_ID: 'pane-1' },
    ]) {
      const attached = await operation({
        args: [
          'task',
          'attach',
          task.id,
          '--session',
          'self',
          '--hydra',
          hydra.id,
        ],
        env: {
          ...process.env,
          TMUX_PANE: undefined,
          HERDR_PANE_ID: undefined,
          ...identity,
        },
      })
      expect(attached.status).toBe(0)
      expect((await hydra.task({ key: task.id })).worker).toBe('codex:outside-session')
      await hydra.owner({
        args: [
          'task',
          'detach',
          task.id,
        ],
      })
    }

    const listed = parsed(await operation({
      args: [
        'task',
        'sessions',
        '--hydra',
        hydra.id,
      ],
      env: process.env,
    }))
    expect(listed.sessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'codex:outside-session' })]))
  },
)

test(
  'Hydra command starts run in the selected folder and replay after it disappears',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'hydra-command' })
    const receipt = join(
      folder,
      'launch.txt',
    )
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--command',
        'printenv PNYX_TASK > launch.txt',
      ],
    })
    expect(await hydra.owner({
      args: [
        'hydra',
        'start',
        '--folder',
        folder,
        '--event-id',
        'hydra-command-launch',
      ],
    }))
      .toMatchObject({
        via: 'command',
        folder,
      })
    await until({
      what: 'the command to receive Hydra context in its launch folder',
      check: () => existsSync(receipt) && readFileSync(
        receipt,
        'utf8',
      ).trim() === '$hydra',
    })
    rmSync(
      folder,
      { recursive: true },
    )

    expect(await hydra.ownerRefused({
      args: [
        'hydra',
        'start',
        '--via',
        'paseo',
        '--event-id',
        'hydra-command-launch',
      ],
    })).toMatchObject({
      code: 'VALIDATION_ERROR',
      error: expect.stringContaining('paseo'),
    })

    expect(await hydra.owner({
      args: [
        'hydra',
        'start',
        '--folder',
        folder,
        '--event-id',
        'hydra-command-launch',
      ],
    }))
      .toMatchObject({ event: 'none: duplicate' })
    expect(await hydra.ownerRefused({
      args: [
        'hydra',
        'start',
        '--folder',
        folder,
      ],
    }))
      .toMatchObject({ code: 'VALIDATION_ERROR' })
  },
)

test(
  'Hydra command starts reject stale revisions before spawning',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'hydra-command-revision' })
    const receipt = join(
      folder,
      'launch.txt',
    )
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--command',
        'printenv PNYX_TASK > launch.txt',
      ],
    })
    expect(await hydra.ownerRefused({
      args: [
        'hydra',
        'start',
        '--folder',
        folder,
        '--if-revision',
        '1',
      ],
    }))
      .toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(existsSync(receipt)).toBe(false)
    expect(await hydra.owner({
      args: [
        'hydra',
        'start',
        '--folder',
        folder,
        '--if-revision',
        '0',
      ],
    }))
      .toMatchObject({
        via: 'command',
        folder,
      })
    await until({
      what: 'the matching revision to launch Hydra',
      check: () => existsSync(receipt) && readFileSync(
        receipt,
        'utf8',
      ).trim() === '$hydra',
    })
  },
)

test(
  'the retired Hydra setup command fails locally while the server is stopped',
  async () => {
    await pnyx.restart({
      whileStopped: async () => {
        const retiredSetup = await operation({
          args: [
            'setup',
            'hydra',
          ],
          env: process.env,
        })
        expect(retiredSetup.status).toBe(2)
        expect(parsed(retiredSetup)).toMatchObject({
          code: 'VALIDATION_ERROR',
          error: expect.stringContaining('hydra'),
        })
      },
    })
  },
)

test.each([
  { opening: false },
  { opening: true },
])(
  'owner input interrupts the previous Codex turn even when its start is pending: $opening',
  async ({ opening }) => {
    const codex = fakeCodex()
    let start = () => {}
    const starting = new Promise<void>(resolve => {
      start = resolve
    })
    const first = codex.plan({
      text: 'first owner input',
      hold: true,
      acknowledgeStartAfter: starting,
    })
    const second = codex.plan({
      text: 'second owner input',
      hold: true,
    })
    onTestFinished(() => {
      start()
      first.release()
      second.release()
    })
    const session = await codexProvider({ spawnCodex: codex.spawnCodex }).open({
      cwd: process.env.TMPDIR!,
      settings: {},
      env: {},
      signal: new AbortController().signal,
    })
    const {
      input,
      events,
    } = await driven({
      session,
      owner: true,
      onEnd: ({ end }) => onTestFinished(end),
    })

    if (!opening) {
      start()
    }

    input.push({
      id: 'first-owner',
      text: 'first owner input',
    })
    await until({
      what: 'the first input to reach the agent',
      check: () => codex.sessions[0]?.received.includes('first owner input'),
    })

    if (!opening) {
      await until({
        what: 'the first turn to start',
        check: () => session.snapshot().work.runningTurns.length === 1,
      })
    }

    input.push({
      id: 'second-owner',
      text: 'second owner input',
    })
    await until({
      what: 'the next owner input to be queued',
      check: () => session.snapshot().work.unsettledInputs.includes('second-owner'),
    })
    start()
    const ended = await until({
      what: 'the first owner turn to be interrupted',
      check: () => events.flatMap(event => typeof event === 'object' && event.type === 'turn-ended'
        && event.outcome.inputIds.includes('first-owner') && event.outcome.status === 'interrupted' ? [event.outcome] : []).at(-1),
    })
    const next = await until({
      what: 'the second input to start its own turn',
      check: () => events.flatMap(event => typeof event === 'object' && event.type === 'input'
        && event.receipt.inputId === 'second-owner' && event.receipt.phase === 'confirmed' ? [event.receipt] : []).at(-1),
    })
    expect(next.turn).not.toBe(ended.turn)
    first.release()
    second.release()
    await until({
      what: 'the second owner turn to finish',
      check: () => events.some(event => typeof event === 'object' && event.type === 'turn-ended'
        && event.outcome.turn === next.turn && event.outcome.status === 'completed'),
    })
    const firstOutcomes = events.filter(event => typeof event === 'object' && event.type === 'turn-ended'
      && event.outcome.turn === ended.turn)
    expect(firstOutcomes).toHaveLength(1)
    expect(codex.sessions[0]?.received).toEqual([
      'first owner input',
      'second owner input',
    ])
  },
)

test(
  'usage stays scoped to its Hydra and follows a moving native worker',
  async () => {
    const source = await pnyx.hydra()
    const peer = await pnyx.hydra()
    const destination = await pnyx.hydra()
    const { worker } = await source.startTask({
      key: 'usage-source',
      harness: 'codex',
    })
    pnyx.codex.reuseNextSession({ id: worker.id })
    const { worker: other } = await peer.startTask({
      key: 'usage-peer',
      harness: 'codex',
    })
    expect(other.id).toBe(worker.id)
    const recorded = pnyx.codex.context.used
    await contextReported({
      hydra: peer,
      key: 'usage-peer',
      what: 'the peer context before compaction',
      check: ({ context }) => context.used === recorded,
    })
    pnyx.codex.plan({
      hydra: source.id,
      match: ({ text }) => text.includes('isolated usage turn'),
      compactTo: 9000,
    })
    await reply({
      hydra: source,
      key: 'usage-source',
      text: 'isolated usage turn',
    })
    await contextReported({
      hydra: source,
      key: 'usage-source',
      what: 'the source compacted context',
      check: ({ context }) => context.used === 9000,
    })
    expect((await peer.owner({
      args: [
        'hydra',
        'usage',
        '--task',
        'usage-peer',
      ],
    })).context.used).toBe(recorded)
    const task = await source.task({ key: 'usage-source' })
    const collision = await source.ownerRefused({
      args: [
        'task',
        'move',
        task.id,
        '--to-hydra',
        peer.id,
      ],
    })
    expect(collision.code).toBe('SESSION_CONFLICT')
    expect(worker.closed).toBe(false)
    expect(other.closed).toBe(false)
    await source.owner({
      args: [
        'task',
        'move',
        task.id,
        '--to-hydra',
        destination.id,
      ],
    })
    await contextReported({
      hydra: destination,
      key: task.id,
      what: 'the moved context before another native report',
      check: ({ context }) => context.used === 9000,
    })
    await source.owner({
      args: [
        'hydra',
        'remove',
        source.id,
      ],
    })
    expect((await destination.owner({
      args: [
        'hydra',
        'usage',
        '--task',
        task.id,
      ],
    })).context.used).toBe(9000)
    expect((await peer.owner({
      args: [
        'hydra',
        'usage',
        '--task',
        'usage-peer',
      ],
    })).context.used).toBe(recorded)
  },
)

test(
  'a queued tool update follows a busy native worker across Hydra moves',
  async () => {
    const source = await pnyx.hydra()
    const middle = await pnyx.hydra()
    const target = await pnyx.hydra()
    const key = 'moving-tools'
    const { worker } = await source.startTask({ key })
    const task = await source.task({ key })
    const held = pnyx.claude.plan({
      hydra: source.id,
      match: ({ text }) => text.includes('pending tools turn'),
      partial: 'Still working before tool refresh',
      hold: true,
    })
    onTestFinished(() => held.release())
    await reply({
      hydra: source,
      key,
      text: 'pending tools turn',
    })
    await until({
      what: 'the busy native turn before moving',
      check: () => worker.received.some(text => text.includes('pending tools turn')),
    })
    await source.owner({
      args: [
        'task',
        'move',
        task.id,
        '--to-hydra',
        middle.id,
      ],
    })
    await source.owner({
      args: [
        'hydra',
        'remove',
        source.id,
      ],
    })
    await middle.owner({
      args: [
        'task',
        'tools',
        task.id,
        '--grant',
        'browser',
      ],
    })
    expect((await middle.owner({
      args: [
        'task',
        'tools',
        task.id,
      ],
    })).selection).toBe('pending')
    expect(worker.closed).toBe(false)
    await middle.owner({
      args: [
        'task',
        'move',
        task.id,
        '--to-hydra',
        target.id,
      ],
    })
    await middle.owner({
      args: [
        'hydra',
        'remove',
        middle.id,
      ],
    })
    expect(worker.closed).toBe(false)
    held.release()
    await until({
      what: 'the queued tools to apply on the final Hydra',
      check: async () => (await target.owner({
        args: [
          'task',
          'tools',
          task.id,
        ],
      })).selection === 'applied',
    })
    const resumed = await until({
      what: 'the same native session to resume with the destination scope',
      check: () => pnyx.claude.sessions.find(session => session.id === worker.id
        && session.resumed && session.env.PNYX_HYDRA === target.id),
    })
    expect(resumed.closed).toBe(false)
    expect((await target.task({ key: task.id })).worker).toBe(`claude-code:${worker.id}`)
  },
)

test(
  'restoring a truncated report keeps discarding its oversized unfinished line',
  async () => {
    const hydra = await pnyx.hydra()
    const { worker } = await hydra.startTask({ key: 'truncated-discard' })
    const task = await hydra.task({ key: 'truncated-discard' })
    const path = join(
      worker.env.PNYX_TASK_DIR!,
      'worker.log',
    )
    const partial = 'note: ' + 'x'.repeat(20 * 1024)
    writeFileSync(
      path,
      partial,
    )
    await until({
      what: 'the oversized partial report is fully discarded',
      check: async () => (await hydra.owner({
        args: [
          'task',
          'show',
          task.id,
          '--full',
        ],
      })).task.workerLog?.latest.off === Buffer.byteLength(partial),
    })
    writeFileSync(
      path,
      '',
    )
    await until({
      what: 'the truncation warning',
      check: async () => (await hydra.task({ key: task.id })).latest?.includes('was truncated'),
    })
    writeFileSync(
      path,
      partial + 'blocked: not a separate report\nnote: valid after restoration\n',
    )
    await until({
      what: 'the restored report continues after the discarded line',
      check: async () => (await hydra.task({ key: task.id })).latest === 'valid after restoration',
    })
    const history = await hydra.owner({
      args: [
        'task',
        'history',
        task.id,
        '--limit',
        '100',
      ],
    })
    expect(JSON.stringify(history.events)).not.toContain('not a separate report')
  },
)

test(
  'a native worker settles provider startup before its task can move',
  async () => {
    const source = await pnyx.hydra()
    const target = await pnyx.hydra()
    const created = await source.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Starting native worker',
        '--folder',
        source.folder({ name: 'starting-native-worker' }),
      ],
    })
    const task = created.card.id as string
    const held = pnyx.codex.holdStart({ task })
    const pending = source.owner({
      args: [
        'task',
        'start',
        task,
        '--harness',
        'codex',
      ],
    })
    onTestFinished(async () => {
      held.release()
      await Promise.allSettled([pending])
    })
    await until({
      what: 'the provider to wait during startup',
      check: held.entered,
    })
    await source.ownerRefused({
      args: [
        'task',
        'move',
        task,
        '--to-hydra',
        target.id,
      ],
    })
    expect((await source.owner({
      args: [
        'task',
        'show',
        task,
        '--full',
      ],
    })).task.id).toBe(task)
    held.release()
    const started = await pending
    const worker = await source.agent({ cwd: started.agent.folder })
    await source.owner({
      args: [
        'task',
        'move',
        task,
        '--to-hydra',
        target.id,
      ],
    })
    expect((await target.task({ key: task })).worker).toBe(`codex:${worker.id}`)
    expect(worker.closed).toBe(false)
  },
)
