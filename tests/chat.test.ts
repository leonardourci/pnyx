import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDigestContext } from '#hydra/digest-context.ts'
import { beforeAll, expect, test } from 'vitest'
import { HYDRA_SKILLS } from '#setup/skill-names.ts'
import { safeEnd } from '../web/src/shared/ui/reveal.ts'
import { rows, startPnyx, until, type Hydra, type Pnyx } from './setup/pnyx.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx()
})

// What the page's queue box reads for this Hydra: updates waiting for it, and its chat.
const queueBox = ({ hydraId }: { hydraId: string }) => rows<{
  value: {
    waiting: { kind: string }[]
    chat: { working: boolean }
  }
}>({
  text: 'select value from hydra_values where hydra_id = $1 and key = \'queue\'',
  values: [hydraId],
})[0]?.value

const queue = ({ hydraId }: { hydraId: string }) => queueBox({ hydraId })?.chat

const heard = ({
  received,
  text,
}: {
  received: string[]
  text: string
}) => received.filter(message => message.endsWith(text)).length

test(
  'messages the owner sends while Hydra works reach it once each, in order, and the queue shows Hydra working until its turn ends',
  async () => {
    const hydra = await pnyx.hydra()
    const turn = pnyx.claude.plan({
      hydra: hydra.id,
      text: 'plan the release',
      reply: 'Release plan ready.',
      partial: 'Release',
      hold: true,
    })
    const session = await hydra.chat({ text: 'plan the release' })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'also check the docs',
      ],
    })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'and the changelog',
      ],
    })

    await until({
      what: 'the queue to show Hydra working',
      check: () => queue({ hydraId: hydra.id })?.working === true,
    })
    expect(session.answered).toBe(0)

    turn.release()
    await until({
      what: 'Hydra to answer all three messages',
      check: () => session.answered === 3,
    })
    await until({
      what: 'the queue to show Hydra idle',
      check: () => queue({ hydraId: hydra.id })?.working === false,
    })

    expect(session.received.map(message => message.split('\n').at(-1))).toEqual([
      'plan the release',
      'also check the docs',
      'and the changelog',
    ])
    expect(pnyx.claude.sessions.filter(s => s.env.PNYX_HYDRA === hydra.id)).toHaveLength(1)

    const { messages } = await hydra.owner({
      args: [
        'hydra',
        'messages',
      ],
    })
    expect(messages.map((message: { text: string }) => message.text)).toEqual([
      'plan the release',
      'also check the docs',
      'and the changelog',
    ])
  },
)

test(
  'Stop ends Hydra\'s running turn without its reply, Hydra takes the next message in the same session, and Stop while idle stops nothing',
  async () => {
    const hydra = await pnyx.hydra()
    pnyx.claude.plan({
      hydra: hydra.id,
      text: 'write the long report',
      reply: 'The long report, finished.',
      partial: 'The long',
      hold: true,
    })
    const session = await hydra.chat({ text: 'write the long report' })

    const stopped = await hydra.owner({
      args: [
        'hydra',
        'stop',
      ],
    })
    expect(stopped.stopped).toBe('hydra')
    await until({
      what: 'the stopped turn to end',
      check: () => session.answered === 1,
    })
    await until({
      what: 'the queue to show Hydra idle after Stop',
      check: () => queue({ hydraId: hydra.id })?.working === false,
    })

    pnyx.claude.plan({
      hydra: hydra.id,
      text: 'just the summary',
      reply: 'Summary only.',
    })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'just the summary',
      ],
    })
    await until({
      what: 'Hydra to answer after Stop',
      check: () => session.answered === 2,
    })

    expect(pnyx.claude.sessions.filter(s => s.env.PNYX_HYDRA === hydra.id)).toEqual([session])
    expect(heard({
      received: session.received,
      text: 'write the long report',
    })).toBe(1)
    expect(heard({
      received: session.received,
      text: 'just the summary',
    })).toBe(1)

    const page = await hydra.page()
    const { thread } = await page.send({
      name: 'thread',
      args: ['$hydra'],
    }) as {
      thread: {
        conversation: {
          entries: {
            role: string
            text: string
          }[]
        }
      }
    }
    const replies = thread.conversation.entries.filter(entry => entry.role === 'assistant').map(entry => entry.text)
    expect(replies).toContain('Summary only.')
    expect(replies).not.toContain('The long report, finished.')
    page.close()

    const idle = await hydra.owner({
      args: [
        'hydra',
        'stop',
      ],
    })
    expect(idle.stopped).toMatch(/^none:/)
  },
)

test(
  'after a restart Hydra resumes its own session with its conversation, and the next message reaches it once',
  async () => {
    const hydra = await pnyx.hydra()
    pnyx.claude.plan({
      hydra: hydra.id,
      text: 'remember the codename',
      reply: 'Noted: Bluebird.',
    })
    const before = await hydra.chat({ text: 'remember the codename' })
    await until({
      what: 'the first answer',
      check: () => before.answered === 1,
    })

    await pnyx.restart()

    pnyx.claude.plan({
      hydra: hydra.id,
      text: 'what was it?',
      reply: 'Bluebird.',
    })
    const after = await hydra.chat({ text: 'what was it?' })
    await until({
      what: 'the answer after the restart',
      check: () => after.answered === 1,
    })

    expect(after.resumed).toBe(true)
    expect(after.id).toBe(before.id)
    expect(heard({
      received: [
        ...before.received,
        ...after.received,
      ],
      text: 'remember the codename',
    })).toBe(1)
    expect(heard({
      received: after.received,
      text: 'what was it?',
    })).toBe(1)

    const page = await hydra.page()
    const { thread } = await page.send({
      name: 'thread',
      args: ['$hydra'],
    }) as {
      thread: {
        conversation: {
          entries: {
            role: string
            text: string
          }[]
        }
      }
    }
    expect(thread.conversation.entries.map(entry => [
      entry.role,
      entry.text,
    ])).toEqual([
      [
        'user',
        'remember the codename',
      ],
      [
        'assistant',
        'Noted: Bluebird.',
      ],
      [
        'user',
        'what was it?',
      ],
      [
        'assistant',
        'Bluebird.',
      ],
    ])
    page.close()
  },
)

test(
  'a worker\'s report and status wait in Hydra\'s queue while it works, then reach it once as one wake, and progress wakes nobody',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'export' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Export invoices',
        '--key',
        'export',
        '--folder',
        folder,
      ],
    })
    const turn = pnyx.claude.plan({
      hydra: hydra.id,
      text: 'review the roadmap',
      reply: 'Roadmap reviewed.',
      partial: 'Roadmap',
      hold: true,
    })
    const session = await hydra.chat({ text: 'review the roadmap' })
    await hydra.owner({
      args: [
        'task',
        'start',
        'export',
      ],
    })
    const worker = await hydra.agent({ cwd: folder })
    await until({
      what: 'the worker\'s first turn',
      check: () => worker.answered === 1,
    })

    await hydra.as({ session: worker }).run({
      args: [
        'hydra',
        'send',
        '--task',
        'export',
        '--kind',
        'progress',
        '--text',
        'Halfway through the invoices',
      ],
    })
    await hydra.as({ session: worker }).run({
      args: [
        'hydra',
        'send',
        '--task',
        'export',
        '--text',
        'Export works; ready for review',
      ],
    })
    await hydra.as({ session: worker }).run({
      args: [
        'task',
        'status',
        'export',
        'blocked',
        '--note',
        'Need the SFTP password',
      ],
    })
    const waiting = await until({
      what: 'the report and the status to wait for Hydra',
      check: () => {
        const kinds = queueBox({ hydraId: hydra.id })?.waiting.map(update => update.kind)

        return kinds?.includes('declared') && kinds
      },
    })
    expect(waiting).toContain('report')
    expect(waiting).not.toContain('progress')
    expect(session.received).toHaveLength(1)

    turn.release()
    await until({
      what: 'Hydra to handle the wake',
      check: () => session.answered === 2 && queueBox({ hydraId: hydra.id })?.waiting.length === 0
      && queue({ hydraId: hydra.id })?.working === false,
    })
    const wake = session.received[1]!
    expect(wake.split('Export works; ready for review')).toHaveLength(2)
    expect(wake).toContain('Halfway through the invoices')
    expect(wake).toContain('Need the SFTP password')
    expect(session.received).toHaveLength(2)
  },
)

test(
  'the streaming cut keeps unclosed Markdown out of view and shows all of a final reply',
  () => {
    const shown = ({
      text,
      final = false,
      fenced = false,
    }: {
      text: string
      final?: boolean
      fenced?: boolean
    }) => text.slice(
      0,
      safeEnd({
        text,
        end: text.length,
        final,
        fenced,
      }),
    )

    expect(shown({ text: 'Ship **on Fri' })).toBe('Ship ')
    expect(shown({ text: 'Ship **on Friday** after' })).toBe('Ship **on Friday** after')
    expect(shown({ text: 'Run `pnpm ver' })).toBe('Run ')
    expect(shown({ text: 'See [the docs](https://exa' })).toBe('See ')
    expect(shown({ text: '```s' })).toBe('')
    expect(shown({
      text: '```sh\npnpm build\n``',
      fenced: true,
    })).toBe('```sh\npnpm build\n')
    expect(shown({
      text: 'Ship **on Fri',
      final: true,
    })).toBe('Ship **on Fri')
  },
)

test(
  'owner messages sent while Hydra works survive a restart that cuts its turn: Hydra resumes once, is pointed at what it did not answer, and the messages stay in order',
  async () => {
    const hydra = await pnyx.hydra()
    pnyx.claude.plan({
      hydra: hydra.id,
      text: 'plan the migration',
      reply: 'Migration planned.',
      partial: 'Migration',
      hold: true,
    })
    await hydra.chat({ text: 'plan the migration' })

    for (const text of [
      'also check the indexes',
      'and the backups',
    ]) {
      await hydra.owner({
        args: [
          'hydra',
          'send',
          '--text',
          text,
        ],
      })
    }

    await pnyx.restart()
    // Hydra resumes its session once and is pointed at the messages it did not answer.
    const resumed = await until({
      what: 'Hydra to resume its session after the restart',
      check: () => pnyx.claude.sessions.find(s => s.env.PNYX_HYDRA === hydra.id && s.resumed),
    })
    await until({
      what: 'the resumed Hydra to hear of the cut turn',
      check: () => resumed.received.some(text => text.includes('restart cut your last turn')),
    })
    expect(resumed.received.filter(text => text.includes('restart cut your last turn'))).toHaveLength(1)

    const { messages } = await hydra.owner({
      args: [
        'hydra',
        'messages',
      ],
    })
    expect(messages.map((message: { text: string }) => message.text)).toEqual([
      'plan the migration',
      'also check the indexes',
      'and the backups',
    ])
  },
)

// The skill text under skills/ is what Pnyx writes into Hydra's folder, so a change to it reaches the agent as written.
test(
  'Hydra\'s folder holds the shipped skills as written before its first turn',
  async () => {
    const hydra = await pnyx.hydra()
    const session = await hydra.chat({ text: 'hello' })
    const shipped = join(
      import.meta.dirname,
      '..',
      'skills',
    )

    for (const skill of HYDRA_SKILLS) {
      expect(
        readFileSync(
          join(
            session.cwd,
            '.agents',
            'skills',
            skill,
            'SKILL.md',
          ),
          'utf8',
        ),
        skill,
      ).toBe(readFileSync(
        join(
          shipped,
          skill,
          'SKILL.md',
        ),
        'utf8',
      ))
    }
  },
)

test(
  'Send now ends a running compaction and delivers the message held behind it at once, and only once',
  async () => {
    const hydra = await pnyx.hydra()
    const { worker } = await hydra.startTask({ key: 'compactable' })
    const { id } = await hydra.task({ key: 'compactable' })
    pnyx.claude.plan({
      hydra: hydra.id,
      text: '/compact',
      compacting: true,
      hold: true,
    })
    await hydra.owner({
      args: [
        'reply',
        'compactable',
        '--text',
        '/compact',
      ],
    })
    const held = await hydra.owner({
      args: [
        'reply',
        'compactable',
        '--text',
        'carry on with the plan',
      ],
    })
    const heard = () => worker.received.filter(text => text.includes('carry on with the plan')).length
    // The message waits behind the compaction.
    await until({
      what: 'the message to wait behind the running compaction',
      check: () => rows<{ data: { compaction?: { inputs: { id: string }[] } } }>({
        text: 'select data from card_bodies where hydra_id = $1 and card_id = $2',
        values: [
          hydra.id,
          id,
        ],
      })[0]?.data.compaction?.inputs.some(input => input.id === held.reply.reply),
    })
    expect(heard()).toBe(0)

    const page = await hydra.page()
    expect(await page.send({
      name: 'compact',
      args: [
        id,
        held.reply.reply,
      ],
    })).toMatchObject({ stopped: 'compaction' })
    page.close()

    await until({
      what: 'the held message to reach the worker',
      check: () => heard() === 1,
    })
    expect(heard()).toBe(1)
  },
)

// A message of the owner's as the page shows it in Hydra's chat.
const chatEntry = async ({
  hydra,
  text,
}: {
  hydra: Hydra
  text: string
}) => {
  const page = await hydra.page()
  const { thread } = await page.send({
    name: 'thread',
    args: ['$hydra'],
  }) as {
    thread: {
      conversation: {
        entries: {
          role: string
          text: string
          receipt?: string
          waiting?: string
        }[]
      }
    }
  }
  page.close()

  return thread.conversation.entries.find(entry => entry.role === 'user' && entry.text === text)
}

test(
  'Stop cancels the message Hydra had not taken as not delivered, and the same text sent again reaches Hydra once',
  async () => {
    const hydra = await pnyx.hydra()
    pnyx.claude.plan({
      hydra: hydra.id,
      text: 'draft the notes',
      partial: 'Draft',
      hold: true,
    })
    const session = await hydra.chat({ text: 'draft the notes' })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'also list the risks',
      ],
    })
    await hydra.owner({
      args: [
        'hydra',
        'stop',
      ],
    })
    await until({
      what: 'the stopped turn to end',
      check: () => session.answered === 1,
    })

    await until({
      what: 'the unread message to read as stopped',
      check: async () => (await chatEntry({
        hydra,
        text: 'also list the risks',
      }))?.receipt === 'failed',
    })
    expect(await chatEntry({
      hydra,
      text: 'also list the risks',
    })).toMatchObject({ waiting: 'stopped' })
    expect(heard({
      received: session.received,
      text: 'also list the risks',
    })).toBe(0)

    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'also list the risks',
      ],
    })
    await until({
      what: 'the message sent again to reach Hydra',
      check: () => heard({
        received: session.received,
        text: 'also list the risks',
      }) === 1,
    })
  },
)

test(
  'Stop leaves the message Hydra had already taken as received, even though its confirmation arrives after Stop',
  async () => {
    const hydra = await pnyx.hydra()
    pnyx.claude.plan({
      hydra: hydra.id,
      text: 'check the build',
      partial: 'Checking',
      hold: true,
      folds: true,
    })
    const session = await hydra.chat({ text: 'check the build' })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'and the lint run',
      ],
    })
    await until({
      what: 'Hydra to take the message into its turn',
      check: () => heard({
        received: session.received,
        text: 'and the lint run',
      }) === 1,
    })
    await hydra.owner({
      args: [
        'hydra',
        'stop',
      ],
    })
    await until({
      what: 'the stopped turn to end',
      check: () => session.answered === 2,
    })

    await until({
      what: 'the taken message to read as received',
      check: async () => (await chatEntry({
        hydra,
        text: 'and the lint run',
      }))?.receipt === 'delivered',
    })
  },
)

test(
  'Stop on a compaction cancels the messages held behind it and leaves Hydra waiting for the owner instead of waking it with a recap',
  async () => {
    const hydra = await pnyx.hydra()
    pnyx.claude.plan({
      hydra: hydra.id,
      text: 'warm up',
      reply: 'Ready.',
    })
    const session = await hydra.chat({ text: 'warm up' })
    await until({
      what: 'the warm-up answer',
      check: () => session.answered === 1,
    })
    pnyx.claude.plan({
      hydra: hydra.id,
      text: '/compact',
      compacting: true,
      hold: true,
    })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        '/compact',
      ],
    })
    await until({
      what: 'the compaction to run',
      check: () => session.received.includes('/compact'),
    })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'held behind the compaction',
      ],
    })
    expect((await hydra.owner({
      args: [
        'hydra',
        'stop',
      ],
    })).stopped).toBe('compaction')
    await until({
      what: 'the held message to read as stopped',
      check: async () => (await chatEntry({
        hydra,
        text: 'held behind the compaction',
      }))?.receipt === 'failed',
    })

    pnyx.claude.plan({
      hydra: hydra.id,
      text: 'carry on',
      reply: 'Carrying on.',
    })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'carry on',
      ],
    })
    await until({
      what: 'Hydra to answer the owner\'s next message',
      check: () => heard({
        received: session.received,
        text: 'carry on',
      }) === 1,
    })
    expect(session.received.filter(message => message.includes('back after a stop'))).toEqual([])
    expect(heard({
      received: session.received,
      text: 'held behind the compaction',
    })).toBe(0)
  },
)

// The agent change waiting for the owner's choice, as the page reads it.
const agentChange = ({ hydraId }: { hydraId: string }) => rows<{
  value: { next: { effort?: string } }
}>({
  text: 'select value from hydra_values where hydra_id = $1 and key = \'hydraAgentChange\'',
  values: [hydraId],
})[0]?.value

test(
  'choosing again the model and effort Hydra runs with asks nothing, even after the question showed, and its held messages reach the same session in order',
  async () => {
    const hydra = await pnyx.hydra()
    const page = await hydra.page()
    const session = await hydra.chat({ text: 'first message' })

    // Claude's catalog runs "opus" at "high" effort when Hydra names neither, as it did for the first message.
    const choose = async ({ agent }: { agent: Record<string, string> }) => {
      expect((await page.send({
        name: 'hydra-agent',
        args: [
          JSON.stringify({
            harness: 'claude',
            ...agent,
          }),
        ],
      })).type).toBe('receipt')
    }

    await choose({ agent: { model: 'sonnet' } })
    await choose({
      agent: {
        model: 'sonnet',
        effort: 'low',
      },
    })
    await choose({
      agent: {
        model: 'opus',
        effort: 'low',
      },
    })
    await choose({
      agent: {
        model: 'opus',
        effort: 'high',
      },
    })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'unchanged agent',
      ],
    })
    await until({
      what: 'Hydra to hear the message sent with its agent chosen again',
      check: () => heard({
        received: session.received,
        text: 'unchanged agent',
      }) === 1,
    })
    expect(agentChange({ hydraId: hydra.id })).toBeUndefined()

    await choose({ agent: { effort: 'low' } })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'held one',
      ],
    })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'held two',
      ],
    })
    await until({
      what: 'the effort change to wait for the owner',
      check: () => agentChange({ hydraId: hydra.id })?.next.effort === 'low',
    })
    await choose({ agent: { effort: 'medium' } })
    await until({
      what: 'the question to name the newly chosen effort',
      check: () => agentChange({ hydraId: hydra.id })?.next.effort === 'medium',
    })
    await choose({ agent: { effort: 'high' } })
    await until({
      what: 'Hydra to hear both held messages',
      check: () => heard({
        received: session.received,
        text: 'held two',
      }) === 1,
    })

    expect(agentChange({ hydraId: hydra.id })).toBeUndefined()
    expect(session.received.map(message => message.split('\n').at(-1))).toEqual([
      'first message',
      'unchanged agent',
      'held one',
      'held two',
    ])
    expect(pnyx.claude.sessions.filter(s => s.env.PNYX_HYDRA === hydra.id)).toEqual([session])
    page.close()
  },
)

test(
  'digest recovery reads the latest checkpoint across read boundaries, partial records and a line far longer than a read',
  async ({ onTestFinished }) => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-digest-tail-',
    ))
    onTestFinished(() => rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    ))
    const path = join(
      root,
      'session.jsonl',
    )
    const digest = `<pnyx-digest>${'é'.repeat(70_000)}</pnyx-digest>`
    writeFileSync(
      path,
      [
        JSON.stringify({
          type: 'user',
          message: { content: '<pnyx-digest>old</pnyx-digest>' },
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
        }),
        JSON.stringify({
          type: 'user',
          message: { content: digest },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { content: 'x'.repeat(3_000_000) },
        }),
        '{"partial":',
      ].join('\n'),
    )
    const context = createDigestContext({
      agent: {
        provider: 'claude-code',
        sessionId: 'synthetic',
        transcriptPath: path,
      },
      render: async ({
        previousDigest,
        compacted,
      }) => {
        expect(compacted).toBe(false)

        return previousDigest ?? ''
      },
    })
    expect(await context()).toBe(digest)
  },
)
