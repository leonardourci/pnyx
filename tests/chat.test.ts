import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    chat: {
      working: boolean
      compactInputs: { text: string }[]
    }
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
  'while the routine helper handles a worker\'s update, what the worker\'s transcript records still reaches its card',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--helper',
        'auto',
      ],
    })
    // Updates wake only a Hydra that Pnyx runs.
    const main = await hydra.chat({ text: 'Watch the invoices' })
    await until({
      what: 'Hydra\'s first turn',
      check: () => main.answered === 1,
    })
    const folder = hydra.folder({ name: 'invoices' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Export invoices',
        '--key',
        'invoices',
        '--folder',
        folder,
      ],
    })
    const { id } = await hydra.task({ key: 'invoices' })
    // Planned before the worker starts: when its first turn ends, the helper batch gets this held reply and keeps the task leased until release().
    const helperTurn = pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('Granted tasks:'),
      reply: JSON.stringify({
        outcomes: [
          {
            task: id,
            audience: 'routine',
            summary: 'Told the worker to retry.',
          },
        ],
      }),
      hold: true,
    })
    await hydra.owner({
      args: [
        'task',
        'start',
        'invoices',
      ],
    })
    await hydra.agent({ cwd: folder })
    const helper = await until({
      what: 'the routine helper to take the worker\'s update',
      check: () => pnyx.claude.sessions.find(session => session.env.PNYX_HYDRA === hydra.id
        && session.env.PNYX_ACTOR?.startsWith('helper:') && session.received.length > 0),
    })

    // Pnyx harvests the Claude Code version on a transcript record into the card's settings.
    const { sessions } = await hydra.owner({
      args: [
        'task',
        'history',
        'invoices',
      ],
    })
    appendFileSync(
      sessions[0].transcript,
      `${JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        version: '9.9.9',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Retrying the export.',
            },
          ],
        },
      })}\n`,
    )
    await hydra.owner({
      args: [
        'reply',
        'invoices',
        '--text',
        'Retry the export',
      ],
    })
    await until({
      what: 'the transcript\'s version to reach the card while the helper still works',
      check: async () => (await hydra.owner({
        args: [
          'task',
          'show',
          'invoices',
          '--full',
        ],
      })).task.settings?.version === '9.9.9',
    })
    expect(helper.answered).toBe(0)

    helperTurn.release()
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
  'Remove cancels one message held behind a compaction, Stop on it cancels the rest and leaves Hydra waiting for the owner instead of waking it with a recap',
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
    const removed = await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'removed from the queue',
      ],
    })
    await until({
      what: 'both messages to wait behind the compaction',
      check: () => queue({ hydraId: hydra.id })?.compactInputs.length === 2,
    })
    const page = await hydra.page()
    expect(await page.send({
      name: 'hydra',
      args: [
        'cancel',
        removed.message,
      ],
    })).toMatchObject({ cancelled: removed.message })
    page.close()
    await until({
      what: 'the queued messages to leave out the removed one',
      check: () => queue({ hydraId: hydra.id })?.compactInputs.map(input => input.text)
        .join() === 'held behind the compaction',
    })
    expect((await chatEntry({
      hydra,
      text: 'removed from the queue',
    }))?.receipt).toBe('failed')
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
    expect(session.received.some(message => message.includes('removed from the queue'))).toBe(false)
  },
)

// The texts Hydra's own compaction holds as its inputs, as its card saves them.
const compactionInputs = ({ hydraId }: { hydraId: string }) => rows<{
  data: { compaction?: { inputs: { text: string }[] } }
}>({
  text: 'select data from card_bodies where hydra_id = $1 and card_id = $2',
  values: [
    hydraId,
    '$hydra',
  ],
})[0]?.data.compaction?.inputs.map(input => input.text)

test(
  'a message removed from the queue never reaches Hydra once its compaction ends, whether the compaction held it as its input or behind its stop, and the kept ones reach it once',
  async () => {
    const hydra = await pnyx.hydra()
    const send = ({ text }: { text: string }) => hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        text,
      ],
    })
    const cancel = ({ id }: { id: string }) => hydra.owner({
      args: [
        'hydra',
        'cancel',
        id,
      ],
    })
    const queued = () => queue({ hydraId: hydra.id })?.compactInputs.map(input => input.text).join()
    const working = pnyx.claude.plan({
      hydra: hydra.id,
      text: 'long task',
      reply: 'Done.',
      partial: 'Working',
      hold: true,
    })
    const session = await hydra.chat({ text: 'long task' })
    const first = pnyx.claude.plan({
      hydra: hydra.id,
      text: '/compact',
      compacting: true,
      hold: true,
    })
    // Sent while Hydra works, these reach its session before the compaction starts, which then holds them as its inputs.
    await send({ text: '/compact' })
    const removedInput = await send({ text: 'removed input' })
    await send({ text: 'kept input' })
    working.release()
    await until({
      what: 'the compaction to hold both messages as its inputs',
      check: () => compactionInputs({ hydraId: hydra.id })?.length === 2,
    })
    expect(await cancel({ id: removedInput.message })).toMatchObject({
      cancelled: removedInput.message,
    })
    await until({
      what: 'the queued messages to leave out the removed input',
      check: () => queued() === 'kept input',
    })
    first.release()
    await until({
      what: 'Hydra to hear the kept input',
      check: () => heard({
        received: session.received,
        text: 'kept input',
      }) === 1,
    })

    const second = pnyx.claude.plan({
      hydra: hydra.id,
      text: '/compact',
      compacting: true,
      hold: true,
    })
    // Sent once the compaction runs, these wait behind its stop and reach Hydra in its recap.
    await send({ text: '/compact' })
    await until({
      what: 'the second compaction to run',
      check: () => session.received.filter(message => message === '/compact').length === 2,
    })
    const removedHeld = await send({ text: 'removed while held' })
    await send({ text: 'kept while held' })
    await until({
      what: 'both messages to wait behind the compaction',
      check: () => queued() === 'removed while held,kept while held',
    })
    expect(await cancel({ id: removedHeld.message })).toMatchObject({
      cancelled: removedHeld.message,
    })
    second.release()
    const recap = await until({
      what: 'the recap after the compaction',
      check: () => session.received.find(message => message.includes('kept while held')),
    })

    expect(recap).not.toContain('removed while held')
    expect(session.received.filter(message => message.includes('removed'))).toEqual([])
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
  'choosing the model and effort Hydra already runs with asks nothing, and while a change waits a new choice asks again or sends the held messages left to the same session in order',
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
    const removed = await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'held two',
      ],
    })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'held three',
      ],
    })
    await until({
      what: 'the effort change to wait for the owner',
      check: () => agentChange({ hydraId: hydra.id })?.next.effort === 'low',
    })
    expect(await page.send({
      name: 'hydra',
      args: [
        'cancel',
        removed.message,
      ],
    })).toMatchObject({ cancelled: removed.message })
    await until({
      what: 'the queued messages to leave out the removed one',
      check: () => queue({ hydraId: hydra.id })?.compactInputs.map(input => input.text).join() === 'held one,held three',
    })
    await choose({ agent: { effort: 'medium' } })
    await until({
      what: 'the question to name the newly chosen effort',
      check: () => agentChange({ hydraId: hydra.id })?.next.effort === 'medium',
    })
    await choose({ agent: { effort: 'high' } })
    await until({
      what: 'Hydra to hear the held messages',
      check: () => heard({
        received: session.received,
        text: 'held three',
      }) === 1,
    })

    expect(agentChange({ hydraId: hydra.id })).toBeUndefined()
    expect((await chatEntry({
      hydra,
      text: 'held two',
    }))?.receipt).toBe('failed')

    expect(agentChange({ hydraId: hydra.id })).toBeUndefined()
    expect(session.received.map(message => message.split('\n').at(-1))).toEqual([
      'first message',
      'unchanged agent',
      'held one',
      'held three',
    ])
    expect(pnyx.claude.sessions.filter(s => s.env.PNYX_HYDRA === hydra.id)).toEqual([session])
    page.close()
  },
)

test(
  'Stop, or removing its last held message, ends an agent change waiting for the owner, and Stop also ends the turn Hydra was running',
  async () => {
    const hydra = await pnyx.hydra()
    const page = await hydra.page()
    const session = await hydra.chat({ text: 'first message' })

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

    const send = ({ text }: { text: string }) => hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        text,
      ],
    })
    const notDelivered = ({ text }: { text: string }) => until({
      what: `"${text}" to read as not delivered`,
      check: async () => (await chatEntry({
        hydra,
        text,
      }))?.receipt === 'failed',
    })

    await choose({ agent: { effort: 'low' } })
    const alone = await send({ text: 'held alone' })
    await until({
      what: 'the effort change to wait for the owner',
      check: () => agentChange({ hydraId: hydra.id }),
    })
    expect(await page.send({
      name: 'hydra',
      args: [
        'cancel',
        alone.message,
      ],
    })).toMatchObject({ cancelled: alone.message })
    expect(agentChange({ hydraId: hydra.id })).toBeUndefined()
    expect(await page.send({
      name: 'hydra',
      args: [
        'cancel',
        alone.message,
      ],
    })).toMatchObject({
      type: 'error',
      code: 'NO_ROUTE',
    })
    await notDelivered({ text: 'held alone' })

    await choose({ agent: {} })
    pnyx.claude.plan({
      hydra: hydra.id,
      text: 'long turn',
      reply: 'Long turn done.',
      partial: 'Long',
      hold: true,
    })
    await send({ text: 'long turn' })
    await until({
      what: 'the long turn to run',
      check: () => queue({ hydraId: hydra.id })?.working === true,
    })
    await choose({ agent: { effort: 'low' } })
    await send({ text: 'held during the turn' })
    await until({
      what: 'the effort change to wait while the turn runs',
      check: () => agentChange({ hydraId: hydra.id }),
    })
    expect((await hydra.owner({
      args: [
        'hydra',
        'stop',
      ],
    })).stopped).toBe('hydra')
    await until({
      what: 'the running turn to end',
      check: () => session.answered === 2,
    })
    expect(agentChange({ hydraId: hydra.id })).toBeUndefined()
    await notDelivered({ text: 'held during the turn' })

    await send({ text: 'held while idle' })
    await until({
      what: 'the effort change to wait with no turn running',
      check: () => agentChange({ hydraId: hydra.id }),
    })
    expect((await hydra.owner({
      args: [
        'hydra',
        'stop',
      ],
    })).stopped).toBe('agent change')
    expect(agentChange({ hydraId: hydra.id })).toBeUndefined()
    await notDelivered({ text: 'held while idle' })

    await choose({ agent: {} })
    await send({ text: 'after the stops' })
    await until({
      what: 'Hydra to hear the next message',
      check: () => heard({
        received: session.received,
        text: 'after the stops',
      }) === 1,
    })
    expect(session.received.filter(message => message.includes('held'))).toEqual([])
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
