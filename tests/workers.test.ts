import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
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

    // Every account is read once a minute, so each case names the accounts it reads.
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
