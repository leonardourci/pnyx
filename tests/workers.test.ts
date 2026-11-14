import { beforeAll, expect, test } from 'vitest'
import { startPnyx, until, type AgentSession, type Hydra, type Pnyx } from './setup/pnyx.ts'

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

const startedTask = async ({
  hydra,
  key,
  harness = 'claude',
}: {
  hydra: Hydra
  key: string
  harness?: 'claude' | 'codex'
}) => {
  const folder = hydra.folder({ name: key })
  await hydra.owner({
    args: [
      'task',
      'create',
      '--title',
      `Task ${key}`,
      '--key',
      key,
      '--folder',
      folder,
      '--brief',
      `Brief for ${key}`,
    ],
  })
  await hydra.owner({
    args: [
      'task',
      'start',
      key,
      '--harness',
      harness,
    ],
  })
  const worker = await hydra.agent({ cwd: folder })
  await until({
    what: `${key}'s first turn`,
    check: () => worker.answered === 1,
  })

  return {
    folder,
    worker,
  }
}

test(
  'a started worker runs in its task\'s folder with its brief, and each owner reply reaches it once with a delivered receipt',
  async () => {
    const hydra = await pnyx.hydra()
    const {
      folder,
      worker,
    } = await startedTask({
      hydra,
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
    const { worker } = await startedTask({
      hydra,
      key: 'cleanup',
    })
    const needsYou = (await hydra.owner({
      args: [
        'column',
        'list',
      ],
    })).columns.find((column: { role: string }) => column.role === 'needs_you').id

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
    })).messages).toBe('none: no pending steering')

    expect(resumed.id).toBe(cut.id)
    expect(resumed.received[0]).toContain('Pnyx restarted during your turn')
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
    } = await startedTask({
      hydra,
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
