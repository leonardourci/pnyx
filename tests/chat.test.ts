import { beforeAll, expect, test } from 'vitest'
import { rows, startPnyx, until, type Pnyx } from './setup/pnyx.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx()
})

// What the page's queue box reads for this Hydra.
const queue = ({ hydraId }: { hydraId: string }) => rows<{
  value: { chat: { working: boolean } }
}>({
  text: 'select value from hydra_values where hydra_id = $1 and key = \'queue\'',
  values: [hydraId],
})[0]?.value.chat

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

    expect(queue({ hydraId: hydra.id })?.working).toBe(true)
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
    expect(idle.stopped).toBe('none: Hydra is not working on a turn')
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
