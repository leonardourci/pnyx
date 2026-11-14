import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { inbox } from '#hydra/update-queue.ts'
import { claudeProvider } from '#workers/claude.ts'
import { codexProvider } from '#workers/codex.ts'
import { codexProcesses } from '#workers/codex-processes.ts'
import { confirms, findOption, harnessControls } from '#workers/controls.ts'
import type { HostedEvent, HostedSession } from '#workers/provider.ts'
import { fakeClaude, fakeCodex } from './setup/agents.ts'
import { startPnyx, until, type AgentSession, type Pnyx } from './setup/pnyx.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx()
})

const times = ({
  sessions,
  text,
}: {
  sessions: AgentSession[]
  text: string
}) => sessions.flatMap(session => session.received).filter(message => message.includes(text)).length

test(
  'a started worker runs in its task\'s folder with its brief, and each owner reply reaches it once with a delivered receipt',
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

    const { thread } = await hydra.owner({
      args: [
        'task',
        'chat',
        'export',
      ],
    })
    expect(thread.entries).toContainEqual(expect.objectContaining({
      role: 'You',
      text: 'Use semicolons as separators',
      receipt: 'delivered',
    }))
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
  },
)

test(
  'a worker turn a restart cuts resumes in the same session, and the owner\'s message sent meanwhile waits in its inbox once',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'migration' })
    await hydra.owner({
      args: [
        'task',
        'create',
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
    await hydra.owner({
      args: [
        'reply',
        'migration',
        '--text',
        'Also migrate the archive',
      ],
    })

    await pnyx.restart()
    const resumed = await until({
      what: 'the worker to resume after the restart',
      check: () => pnyx.claude.sessions.find(session => session.cwd === folder && session.resumed),
    })
    await until({
      what: 'the resumed worker to hear of the unread message',
      check: () => resumed.received.some(message => message.includes('inbox')),
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
    const sessions = pnyx.claude.sessions.filter(session => session.cwd === folder)
    expect(sessions).toHaveLength(2)
    expect(times({
      sessions,
      text: '<pnyx-worker',
    })).toBe(1)
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
    expect((await hydra.owner({
      args: [
        'task',
        'chat',
        'codex',
      ],
    })).thread.entries).toContainEqual(expect.objectContaining({
      text: 'Add a test for empty input',
      receipt: 'delivered',
    }))

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
      check: async () => (await receipt()) === 'failed' && 'failed',
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
  'Stop on a worker cancels the owner\'s unread reply as not delivered but keeps Hydra\'s steering, marks the card stopped, and refuses a worker asking to Stop',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'stoppable' })
    await hydra.owner({
      args: [
        'task',
        'create',
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

    for (const args of [
      [
        'task',
        'stop',
        'stoppable',
      ],
      [
        'task',
        'send-now',
        'stoppable',
        'anything',
      ],
      [
        'hydra',
        'stop',
      ],
    ]) {
      expect((await hydra.as({ session: worker }).refused({ args })).code).toBe('OWNER_ONLY')
    }

    expect((await hydra.owner({
      args: [
        'task',
        'stop',
        'stoppable',
      ],
    })).stopped).toMatch(/^task-/)
    await until({
      what: 'the owner\'s reply to read as not delivered',
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
        entry.text === 'owner follow-up' && entry.receipt === 'failed'),
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
    })).toBe(0)
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
}: {
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
  'a Claude interrupt on an idle session does not mark the next turn interrupted',
  async ({ onTestFinished }) => {
    const claude = fakeClaude()
    const session = await claudeProvider({ query: claude.query }).open({
      cwd: process.env.TMPDIR!,
      settings: {},
      env: { PNYX_HOME: process.env.PNYX_HOME! },
      signal: new AbortController().signal,
    })
    const { input } = await driven({
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
    const { input } = await driven({
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
      )) && session.snapshot().work.runningTurns.length === 1,
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
    const tracker = codexProcesses({ pid: process.pid })
    const path = process.env.PATH
    tracker.command({
      id: 'foreground',
      commands: ['sleep 120'],
      completed: false,
    })
    // Without ps, reading the table fails.
    process.env.PATH = '/nonexistent'

    try {
      tracker.begin()
      await tracker.ready()
      expect(await (await tracker.capture())()).toEqual([])
    } finally {
      process.env.PATH = path
    }

    // With the baseline unread, nothing can be told apart, so nothing is ended even once ps works again.
    tracker.command({
      id: 'foreground',
      commands: ['sleep 120'],
      completed: false,
    })
    expect(await (await tracker.capture())()).toEqual([])
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
    await session.interrupt({ cancelQueued: false })
    await until({
      what: 'the continuation turn to start',
      check: () => codex.sessions[0]!.received.length === 3,
    })
    expect(codex.sessions[0]!.received[2]).toContain('Answer their latest message above')
    expect(codex.sessions[0]!.received[2]).not.toContain('LATEST_MESSAGE')
  },
)
