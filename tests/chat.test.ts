import { randomUUID } from 'node:crypto'
import { loadHydra } from '#app/store.ts'
import { applyDecision } from '#app/decision.ts'
import { hydraSend } from '#hydra/send-cli.ts'
import { failHydraInput } from '#hydra/received.ts'
import { operationEvent } from '#hydra/operations.ts'
import { recordCompaction } from '#workers/compaction/record.ts'
import { hydraConversation } from '#hydra/conversation.ts'
import { workerLine } from './setup/worker-log.ts'
import { constants, openSync, appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withWriter } from '#app/writer.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { createDigestContext } from '#hydra/digest-context.ts'
import { startReviewTimer } from '#hydra/review-timer.ts'
import { beforeAll, expect, onTestFinished, test, vi } from 'vitest'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { ServerMessage } from '#app/server-transport.ts'
import { HYDRA_SKILLS, MANAGE_WORKERS_SKILL, ORCHESTRATE_SKILL } from '#setup/skill-names.ts'
import { parse } from 'yaml'
import { hydraMessages } from '#hydra/chat-messages.ts'
import { splitEntry } from '#hydra/transcripts-read.ts'
import { safeEnd } from '../web/src/shared/ui/reveal.ts'
import { openPage, startPnyx, until, type Hydra, type Pnyx } from './setup/pnyx.ts'
import { appendToolCalls } from './setup/transcripts.ts'

const DOCS_MESSAGE = '3d6b8f20-5a4c-4e1b-9f72-6c8d0e1a2b34'
const CHANGELOG_MESSAGE = '4e7c9031-6b5d-4f2c-8a83-7d9e1f2b3c45'

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
  pnyx = await startPnyx()
})

const queueBox = ({ hydraId }: { hydraId: string }) => pnyx.home().scopes[hydraId]?.queue

const queue = ({ hydraId }: { hydraId: string }) => queueBox({ hydraId })?.chat

const heard = ({
  received,
  text,
}: {
  received: string[]
  text: string
}) => received.filter(message => message.endsWith(text)).length

test(
  'messages the owner sends while Hydra works reach it once each, in order and under their own ids, and the queue shows Hydra working until its turn ends',
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
        '--event-id',
        DOCS_MESSAGE,
      ],
    })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'and the changelog',
        '--event-id',
        CHANGELOG_MESSAGE,
      ],
    })

    await until({
      what: 'Hydra to interrupt and answer the new messages without releasing the old turn',
      check: () => session.answered === 3,
    })
    turn.release()
    await until({
      what: 'the queue to show Hydra idle',
      check: () => queue({ hydraId: hydra.id })?.working === false,
    })

    expect(session.received.map(message => message.split('\n').at(-1))).toEqual([
      'plan the release',
      'also check the docs',
      'and the changelog',
    ])
    expect(session.uuids.slice(1)).toEqual([
      DOCS_MESSAGE,
      CHANGELOG_MESSAGE,
    ])
    expect(pnyx.claude.sessions.filter(s => s.env.PNYX_HYDRA === hydra.id)).toHaveLength(1)
    expect(Object.values(loadHydra({
      hydraId: hydra.id,
    }).state.cards).map(card => ({ key: card.key }))
      .sort((
        a,
        b,
      ) => a.key.localeCompare(b.key))).toEqual([{ key: '$hydra' }])

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
  'worker reports coalesce progress, wait for one wake and survive an interrupted turn',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'export' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
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
        '--kind',
        'progress',
        '--text',
        'Invoices ready to upload',
      ],
    })
    await workerLine({
      hydra,
      key: 'export',
      line: 'note: Upload started',
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
    await workerLine({
      hydra,
      key: 'export',
      line: 'note: Quiet latest line',
    })
    await workerLine({
      hydra,
      key: 'export',
      line: 'blocked: Need the SFTP password',
    })
    const taskHistory = await hydra.owner({
      args: [
        'task',
        'history',
        'export',
        '--full',
      ],
    })
    const statusEvent = taskHistory.events.find((event: {
      type: string
      data?: { text?: string }
    }) =>
      event.type === 'task.worker-line' && event.data?.text === 'Need the SFTP password')
    const waiting = await until({
      what: 'the report and the status to wait for Hydra',
      check: () => {
        const updates = queueBox({ hydraId: hydra.id })?.waiting

        const processed = updates?.some(update => update.seq === statusEvent.seq)

        return processed && updates.map(update => update.kind)
      },
    })
    expect(waiting.filter(kind => kind === 'declared')).toHaveLength(1)
    expect(waiting).toContain('report')
    expect(waiting).not.toContain('progress')
    expect(session.received).toHaveLength(1)

    pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('Export works; ready for review'),
      hold: true,
    })
    turn.release()
    await until({
      what: 'Hydra to read the report wake',
      check: () => session.received.length === 2 && queue({ hydraId: hydra.id })?.working === true,
    })
    const wake = session.received[1]!
    expect(wake.split('Export works; ready for review')).toHaveLength(2)
    expect(wake).not.toContain('Halfway through the invoices')
    expect(wake).toContain('Invoices ready to upload')
    expect(wake).toContain('2 progress reports')
    const progressId = wake.match(/record ("[^"\n]+") \S+ \[unhandled\] \(2 progress reports, latest\): Invoices ready to upload/)?.[1]

    if (progressId === undefined) {
      throw new Error('The wake did not identify the collapsed progress report')
    }

    expect(wake).not.toContain('Upload started')
    expect(wake).not.toContain('Quiet latest line')
    expect(wake).toContain('Need the SFTP password')
    const blockedId = wake.match(/record ("[^"\n]+") \S+ \[unhandled\]: blocked: Need the SFTP password/)?.[1]
    expect(blockedId).toBeDefined()
    await hydra.owner({
      args: [
        'hydra',
        'stop',
      ],
    })
    await until({
      what: 'the interrupted report turn to stop',
      check: () => queue({ hydraId: hydra.id })?.working === false,
    })
    expect(loadHydra({ hydraId: hydra.id }).state.contextNotes)
      .toContainEqual(expect.objectContaining({ text: 'Export works; ready for review' }))
    await hydra.chat({ text: 'Review the interrupted worker reports' })
    await until({
      what: 'the report to be delivered after interruption',
      check: () => session.received.length >= 3,
    })
    const retried = session.received.find(text => text.endsWith('Review the interrupted worker reports'))!
    expect(retried).toContain('Export works; ready for review')
    const reportId = retried.match(/record ("[^"\n]+") \S+ \[unhandled\]: Export works; ready for review/)?.[1]
    expect(reportId).toBeDefined()
    await until({
      what: 'the retried report turn to finish',
      check: () => queue({ hydraId: hydra.id })?.working === false,
    })
    expect(loadHydra({ hydraId: hydra.id }).state.contextNotes)
      .not.toContainEqual(expect.objectContaining({ text: 'Export works; ready for review' }))
  },
)

test(
  '300 queued worker reports stay bounded, preserve owner messages and remain readable in files after interruption',
  async () => {
    const hydra = await pnyx.hydra()
    const turn = pnyx.claude.plan({
      hydra: hydra.id,
      text: 'Hold the report burst',
      hold: true,
    })
    const session = await hydra.chat({ text: 'Hold the report burst' })
    const page = await hydra.page()
    const wakeTurn = pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('Why you are woken') && text.includes('more worker reports'),
      hold: true,
    })
    const replacementTurn = pnyx.claude.plan({
      hydra: hydra.id,
      text: 'Resume after the interrupted read',
      hold: true,
    })
    const overflowTurn = pnyx.claude.plan({
      hydra: hydra.id,
      text: 'Read the remaining reports',
      hold: true,
    })

    try {
      for (let index = 0; index < 300; index++) {
        const body = index === 0 ? '<'.repeat(500) : 'Long report body '.repeat(100)

        await page.send({
          name: 'hydra',
          args: [
            'send',
            '--actor',
            `worker:burst-${index}`,
            '--text',
            `Report ${index}: ${body}`,
          ],
        })
      }

      await hydra.owner({
        args: [
          'task',
          'create',
          '--title',
          'Export format',
          '--key',
          'budget-decision',
        ],
      })
      const decisionTask = await hydra.task({ key: 'budget-decision' })
      await hydra.as({ session }).run({
        args: [
          'task',
          'ask',
          'budget-decision',
          '--to',
          'owner',
          '--question',
          'Which export format?',
          '--context',
          `The format determines the export implementation. [Export format](pnyx-task:${decisionTask.id})`,
          '--choice',
          'CSV',
          '--choice',
          'JSON',
          '--recommend',
          '1',
          '--reason',
          'The format needs an owner choice',
        ],
      })
      await withWriter({
        hydraId: hydra.id,
        fn: ({ writer }) => {
          const decision = hydraEvent({
            state: writer.state,
            meta: {
              actor: 'pnyx',
              at: new Date().toISOString(),
            },
            cardId: HYDRA_CARD,
            change: {
              type: 'hydra.review',
              data: {
                block: `Timed review:\n${'Timed review evidence. '.repeat(1000)}End of timed review evidence`,
                reminders: [],
                flags: ['oversized review fixture'],
                wake: true,
              },
            },
          })

          if ('event' in decision) {
            writer.append({ event: decision.event })
          }
        },
      })
      await until({
        what: 'the timed review to join the report wake',
        check: () => queueBox({ hydraId: hydra.id })?.waiting.some(update => update.kind === 'timed review'),
      })
      await hydra.owner({
        args: [
          'hydra',
          'send',
          '--text',
          'Keep the owner message intact under the report cap',
        ],
      })
      turn.release()
      await until({
        what: 'owner and bounded wake delivered',
        check: () => session.received.some(text => text.includes('more worker reports'))
          && queue({ hydraId: hydra.id })?.working === true,
      })
      expect(session.received.some(text => text.endsWith('Keep the owner message intact under the report cap'))).toBe(true)
      const wake = session.received.find(text => text.includes('Why you are woken') && text.includes('more worker reports'))!
      expect(wake).toContain('- report: from worker:burst-0,')
      expect(wake).not.toContain('- report: from worker:burst-299,')
      expect(wake).toContain('Some wake details were shortened or omitted.')
      const updates = wake.replace(
        /<pnyx-digest[\s\S]*?<\/pnyx-digest>\s*/,
        '',
      )
      expect(updates.length).toBeLessThan(12_000)
      expect(wake).toMatch(/\[unhandled\]: Report 0: [^\n]{1,390}\n/)
      expect(wake).not.toContain('Long report body '.repeat(30))
      expect(wake).toContain('Open decisions (1):')
      expect(wake).toContain('Which export format?')

      expect(wake).toContain('hydra.log')
      expect(wake).toContain('task.log')
      const path = join(
        process.env.PNYX_HOME!,
        'hydras',
        hydra.id,
        'hydra.log',
      )
      const facts = readFileSync(
        path,
        'utf8',
      ).trimEnd()
        .split('\n')
        .map(line => JSON.parse(line))
      const reports = facts.filter(fact => fact.event?.type === 'hydra.message' && /^worker:burst-/.test(fact.event.actor))
      expect(reports.map(fact => fact.event.data.text)).toEqual(Array.from(
        { length: 300 },
        (
          _,
          index,
        ) =>
          `Report ${index}: ${index === 0 ? '<'.repeat(500) : 'Long report body '.repeat(100)}`,
      ))
      expect(facts.some(fact => fact.event?.type === 'hydra.review'
        && fact.event.data.block.includes('End of timed review evidence'))).toBe(true)
      const pendingState = loadHydra({ hydraId: hydra.id }).state
      const pending = pendingState.contextNotes?.filter(note => note.report) ?? []
      expect(pending).toHaveLength(300)
      await hydra.owner({
        args: [
          'hydra',
          'stop',
        ],
      })
      await until({
        what: 'the interrupted report turn to stop',
        check: () => queue({ hydraId: hydra.id })?.working === false,
      })
      expect(loadHydra({ hydraId: hydra.id }).state.contextNotes?.filter(note => note.report))
        .toHaveLength(300)
      await hydra.chat({ text: 'Resume after the interrupted read' })
      await until({
        what: 'the replacement turn to receive pending reports',
        check: () => session.received.some(text => text.endsWith('Resume after the interrupted read')),
      })
      const recovered = session.received.find(text => text.endsWith('Resume after the interrupted read'))!
      expect(recovered).toContain('Report 0:')
      replacementTurn.release()
      await until({
        what: 'the replacement turn to finish',
        check: () => queue({ hydraId: hydra.id })?.working === false,
      })
      const remainingState = loadHydra({ hydraId: hydra.id }).state
      const remaining = remainingState.contextNotes?.filter(note => note.report) ?? []
      expect(remaining.length).toBeGreaterThan(0)
      expect(remaining.length).toBeLessThan(300)
      await hydra.chat({ text: 'Read the remaining reports' })
      await until({
        what: 'the next turn to receive the remaining reports',
        check: () => session.received.some(text => text.endsWith('Read the remaining reports')),
      })
      const next = session.received.find(text => text.endsWith('Read the remaining reports'))!
      expect(next).not.toContain('[unhandled]: Report 0:')
      expect(next).toContain(remaining[0]!.text.replace(
        /</g,
        '&lt;',
      ))
      expect(readFileSync(
        path,
        'utf8',
      )).toContain('Report 299:')
    } finally {
      turn.release()
      page.close()
      wakeTurn.release()
      replacementTurn.release()
      overflowTurn.release()
    }
  },
)

test(
  'reports in an owner turn reserve their tasks while the helper takes other work',
  async () => {
    const hydra = await pnyx.hydra()
    const first = pnyx.claude.plan({
      hydra: hydra.id,
      text: 'Hold reservation setup',
      hold: true,
    })
    const main = await hydra.chat({ text: 'Hold reservation setup' })
    const reserved = await hydra.startTask({ key: 'reserved-report' })
    const available = await hydra.startTask({ key: 'available-report' })
    const reservedTask = await hydra.task({ key: 'reserved-report' })
    const availableTask = await hydra.task({ key: 'available-report' })
    await hydra.as({ session: reserved.worker }).run({
      args: [
        'hydra',
        'send',
        '--task',
        reservedTask.id,
        '--text',
        'Reserved owner-turn report',
      ],
    })
    await hydra.owner({
      args: [
        'hydra',
        'stop',
      ],
    })
    first.release()
    const ownerTurn = pnyx.claude.plan({
      hydra: hydra.id,
      text: 'Review reserved owner report',
      hold: true,
    })
    const helperTurn = pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('Granted tasks:'),
      hold: true,
      reply: JSON.stringify({
        outcomes: [
          {
            task: availableTask.id,
            status: 'still_waiting',
            summary: 'No action needed.',
          },
        ],
      }),
    })

    try {
      await hydra.chat({ text: 'Review reserved owner report' })
      await until({
        what: 'main to read the owner-turn report',
        check: () => main.received.some(text => text.includes('Reserved owner-turn report')),
      })
      await hydra.owner({
        args: [
          'hydra',
          'set',
          '--helper',
          'auto',
        ],
      })
      await hydra.as({ session: available.worker }).run({
        args: [
          'hydra',
          'send',
          '--task',
          availableTask.id,
          '--text',
          'Available helper report',
        ],
      })
      const granted = await until({
        what: 'helper to take available work',
        check: () => {
          const helper = loadHydra({ hydraId: hydra.id }).state.helper

          return Object.values(helper?.runs ?? {}).at(-1)?.tasks
        },
      })
      expect(granted).toEqual([availableTask.id])
    } finally {
      await hydra.owner({
        args: [
          'hydra',
          'set',
          '--helper',
          'off',
        ],
      })
      helperTurn.release()
      ownerTurn.release()
    }
  },
)

test.each([
  {
    code: 'done',
    format: 'legacy',
    outcome: { status: 'handled' },
    report: 'Found 41 sales and no errors in production.',
    result: 'The shop is used: 41 sales; no production errors.',
    link: 'https://example.com/reports/shop',
  },
  {
    code: 'blocked',
    format: 'owner',
    outcome: { audience: 'owner' },
    report: 'I cannot sign in to read the production error report.',
    result: 'The production error report needs a working login.',
    link: 'https://example.com/login',
  },
  {
    code: 'needs-you',
    format: 'owner',
    outcome: { audience: 'owner' },
    report: 'Should I count archived sales?',
    result: 'Choose whether to include archived sales.',
    link: 'https://example.com/reports/scope',
  },
  {
    code: 'done',
    format: 'owner',
    outcome: { audience: 'owner' },
    report: 'Finished the shop investigation.',
    result: 'The shop report is ready.',
    link: `https://example.com/reports/shop?filter=${'archived-sales-'.repeat(20)}`,
  },
])(
  'Hydra relays a worker $code result ($format) from the helper into the owner\'s main chat',
  async ({
    code,
    outcome,
    report,
    result,
    link,
  }) => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'hydra',
        'set',
        '--helper',
        'auto',
      ],
    })
    const main = await hydra.chat({ text: 'Check whether the shop is used and has production errors' })
    await until({
      what: 'Hydra to accept the investigation',
      check: () => main.answered === 1,
    })
    const folder = hydra.folder({ name: 'shop' })
    const asHydra = hydra.as({ session: main })
    await asHydra.run({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'shop',
        '--title',
        'Check shop usage',
        '--folder',
        folder,
      ],
    })
    const { id } = await hydra.task({ key: 'shop' })
    const workerReport = `${code}: ${report} ${link}`
    const summary = `${result} ${link}`
    const helperTurn = pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('Granted tasks:') && text.includes(`${code}:`),
      hold: true,
      reply: JSON.stringify({
        outcomes: [
          {
            task: id,
            ...outcome,
            summary,
          },
        ],
      }),
    })
    await asHydra.run({
      args: [
        'task',
        'start',
        'shop',
      ],
    })
    await hydra.agent({ cwd: folder })
    await workerLine({
      hydra,
      key: 'shop',
      line: workerReport,
    })
    await until({
      what: 'the helper to read the worker result',
      check: () => pnyx.claude.sessions.some(session => session.env.PNYX_HYDRA === hydra.id
        && session.env.PNYX_ACTOR?.startsWith('helper:')
        && session.received.some(text => text.includes(workerReport))),
    })
    pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes(summary),
      reply: summary,
    })
    helperTurn.release()
    await until({
      what: 'Hydra to relay the helper outcome',
      check: () => main.received.some(text => text.includes(summary))
        && queue({ hydraId: hydra.id })?.working === false,
    })
    const page = await hydra.page()

    try {
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
      const results = thread.conversation.entries.filter(entry => entry.text.includes(summary))
      expect(results).toEqual([
        expect.objectContaining({
          role: 'assistant',
          text: summary,
        }),
      ])
      const messages = await hydra.owner({
        args: [
          'hydra',
          'messages',
          '--limit',
          '100',
        ],
      })
      expect(messages.messages).not.toContainEqual(expect.objectContaining({
        actor: 'pnyx',
        text: expect.stringContaining(summary),
      }))
    } finally {
      page.close()
    }
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
        '--no-start',
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
    await workerLine({
      hydra,
      key: 'invoices',
      line: 'blocked: Retry the export',
    })
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
    const mainEdit = await hydra.owner({
      args: [
        'task',
        'brief',
        'invoices',
        '--brief',
        'Retry the export without losing its rows',
      ],
    })
    expect(mainEdit.notices).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('leased') }))
    expect((await hydra.owner({
      args: [
        'task',
        'show',
        'invoices',
        '--full',
      ],
    })).task.brief).toBe('Retry the export without losing its rows')
    const ungranted = await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'outside-helper-grant',
        '--title',
        'Check the import log',
      ],
    })
    const helperEdit = await hydra.as({ session: helper }).run({
      args: [
        'task',
        'hold',
        ungranted.card.id,
      ],
    })
    expect(helperEdit.notices).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('default') }))
    expect((await hydra.task({ key: ungranted.card.id })).hold).toBeDefined()

    const reportHelperTurn = pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('Granted tasks:') && text.includes('Invoice checks rerun under existing instructions'),
      hold: true,
      reply: JSON.stringify({
        outcomes: [
          {
            task: id,
            audience: 'routine',
            summary: 'Reran invoice checks.',
          },
        ],
      }),
    })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--task',
        'invoices',
        '--actor',
        `worker:${id}`,
        '--text',
        `Invoice checks rerun under existing instructions\n${'Supporting invoice detail. '.repeat(100)}End of invoice evidence`,
      ],
    })
    helperTurn.release()
    await until({
      what: 'helper to hold the report',
      check: () => pnyx.claude.sessions.some(session => session.env.PNYX_ACTOR?.startsWith('helper:')
        && session.received.some(text => text.includes('End of invoice evidence'))),
    })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--task',
        'invoices',
        '--actor',
        `worker:${id}`,
        '--kind',
        'progress',
        '--text',
        'New invoice progress during the helper lease',
      ],
    })
    await hydra.chat({ text: 'Check the invoice report while the helper works' })
    await until({
      what: 'main to finish reading the leased report',
      check: () => main.received.some(text => text.includes('Check the invoice report while the helper works'))
        && queue({ hydraId: hydra.id })?.working === false,
    })
    expect(main.received.find(text => text.includes('Check the invoice report while the helper works')))
      .toMatch(/\[helper handling\] \(progress\): New invoice progress during the helper lease/)
    reportHelperTurn.release()
    await until({
      what: 'helper to finish the worker report',
      check: () => (loadHydra({ hydraId: hydra.id }).state.helper?.usage?.batches ?? 0) >= 2,
    })
    expect(main.received).toHaveLength(2)
    const routineMessages = await hydra.owner({
      args: [
        'hydra',
        'messages',
        '--limit',
        '100',
      ],
    })
    expect(routineMessages.messages).not.toContainEqual(expect.objectContaining({
      actor: 'pnyx',
      text: expect.stringContaining('Reran invoice checks.'),
    }))
    const pendingNotes = loadHydra({ hydraId: hydra.id }).state.contextNotes ?? []
    expect(pendingNotes).toContainEqual(expect.objectContaining({
      text: expect.stringContaining('Invoice checks rerun under existing instructions'),
      handled: true,
    }))
    expect(pendingNotes).toContainEqual(expect.objectContaining({
      text: 'New invoice progress during the helper lease',
      progress: 1,
    }))
    const scopeTurn = pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('Granted tasks:') && text.includes('Invoice scope needs a decision'),
      hold: true,
      reply: JSON.stringify({
        outcomes: [
          {
            task: id,
            status: 'needs_main',
            summary: 'Invoice scope needs a decision.',
          },
        ],
      }),
    })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--task',
        'invoices',
        '--actor',
        `worker:${id}`,
        '--text',
        'Invoice scope needs a decision',
      ],
    })
    await until({
      what: 'a later helper batch to hold the same task',
      check: () => pnyx.claude.sessions.some(session => session.env.PNYX_ACTOR?.startsWith('helper:')
        && session.received.some(text => text.includes('Invoice scope needs a decision'))),
    })

    try {
      await hydra.chat({ text: 'Summarize the invoice status' })
      await until({
        what: 'main to read the handled report',
        check: () => main.received.some(text => text.includes('Summarize the invoice status')),
      })
      expect(main.received).toHaveLength(3)
      const delivered = main.received.find(text => text.includes('Summarize the invoice status'))!
      expect(delivered.split('\n').find(line => line.startsWith(`- ${id} ·`)))
        .toContain('helper: Reran invoice checks.')
      expect(delivered).toContain('[handled]')
      expect(delivered.split('Invoice checks rerun under existing instructions')).toHaveLength(2)
    } finally {
      scopeTurn.release()
    }

    await until({
      what: 'main to see the escalated report',
      check: () => main.received.some(text => text.includes('[unhandled]: Invoice scope needs a decision')),
    })
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

    pnyx.claude.plan({
      hydra: hydra.id,
      text: 'and the backups',
      partial: 'Checking backups',
      hold: true,
    })

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

    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Restart report',
        '--key',
        'restart-report',
      ],
    })
    const restartTask = await hydra.task({ key: 'restart-report' })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--task',
        restartTask.id,
        '--actor',
        `worker:${restartTask.id}`,
        '--text',
        'Worker report awaiting restart',
      ],
    })

    await pnyx.restart()
    const resumed = await until({
      what: 'Hydra to resume its session after the restart',
      check: () => pnyx.claude.sessions.find(s => s.env.PNYX_HYDRA === hydra.id && s.resumed),
    })
    await until({
      what: 'the resumed Hydra to hear of the cut turn',
      check: () => resumed.received.some(text => text.includes('restart cut your last turn')),
    })
    expect(resumed.received.filter(text => text.includes('restart cut your last turn'))).toHaveLength(1)
    await until({
      what: 'the pending worker report to survive restart',
      check: () => resumed.received.some(text => text.includes('Worker report awaiting restart')),
    })

    const recoveredReport = resumed.received.find(text => text.includes('Worker report awaiting restart'))!
    expect(recoveredReport).toMatch(/record "[^"\n]+" \S+ \[unhandled\]: Worker report awaiting restart/)
    expect(recoveredReport).toContain('hydra.log')
    expect(recoveredReport).toContain('Open decisions')
    const facts = readFileSync(
      join(
        process.env.PNYX_HOME!,
        'hydras',
        hydra.id,
        'hydra.log',
      ),
      'utf8',
    ).trimEnd()
      .split('\n')
      .map(line => JSON.parse(line))
    const recoveredOwnerMessages = Array.from(
      recoveredReport.matchAll(/Read owner message "([^"]+)" in hydra.log in full/g),
      match =>
        facts.find(fact => fact.id === match[1])?.event.data.text,
    )

    expect(recoveredOwnerMessages).toEqual(['and the backups'])

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
      'Worker report awaiting restart',
    ])
  },
)

// The skill text under skills/ is what Pnyx writes into Hydra's folder, so a change to it reaches the agent as written.
test(
  'Hydra\'s folder holds the shipped skills as written and every reference its contract links before its first turn, and loses a reference the skills dropped by its next',
  async () => {
    const hydra = await pnyx.hydra()
    const session = await hydra.chat({ text: 'hello' })
    const shipped = join(
      import.meta.dirname,
      '..',
      'skills',
    )

    for (const skill of HYDRA_SKILLS) {
      const installed = readFileSync(
        join(
          session.cwd,
          '.agents',
          'skills',
          skill,
          'SKILL.md',
        ),
        'utf8',
      )

      expect(
        installed,
        skill,
      ).toBe(readFileSync(
        join(
          shipped,
          skill,
          'SKILL.md',
        ),
        'utf8',
      ))
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(installed)?.[1] ?? ''

      expect(
        parse(frontmatter),
        `${skill} frontmatter`,
      ).toMatchObject({
        name: skill,
        description: expect.any(String),
      })
    }

    const contract = readFileSync(
      join(
        session.cwd,
        'AGENTS.md',
      ),
      'utf8',
    )
    const links = [...contract.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)].map(match => match[1])

    for (const link of links) {
      expect(
        existsSync(join(
          session.cwd,
          link,
        )),
        link,
      ).toBe(true)
    }

    const references = ({ skill }: { skill: string }) => join(
      session.cwd,
      '.agents',
      'skills',
      skill,
      'references',
    )
    const withReferences = references({ skill: ORCHESTRATE_SKILL })
    const withoutReferences = references({ skill: MANAGE_WORKERS_SKILL })
    mkdirSync(
      withReferences,
      { recursive: true },
    )
    mkdirSync(
      withoutReferences,
      { recursive: true },
    )

    for (const folder of [
      withReferences,
      withoutReferences,
    ]) {
      writeFileSync(
        join(
          folder,
          'dropped.md',
        ),
        'old guidance',
      )
    }

    const retiredSkills = [
      'pnyx-firstmate-as-hydra',
      'pnyx-hydra-firstmate',
    ].map(name => join(
      session.cwd,
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

    await hydra.chat({ text: 'hello again' })

    for (const folder of retiredSkills) {
      expect(existsSync(folder)).toBe(false)
    }

    for (const folder of [
      withReferences,
      withoutReferences,
    ]) {
      expect(
        existsSync(join(
          folder,
          'dropped.md',
        )),
        folder,
      ).toBe(false)
    }
  },
)

test(
  'cancelling compaction delivers held input once',
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
      check: () => (loadHydra({
        hydraId: hydra.id,
      }).state.cards[id]).compaction?.inputs.some(input => input.id === held.reply.reply),
    })
    expect(heard()).toBe(0)

    const page = await hydra.page()
    expect(await page.send({
      name: 'compact',
      args: [id],
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
      text: '/compact',
      compacting: true,
      hold: true,
    })
    const session = await hydra.chat({ text: '/compact' })
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
  'a stopped message does not take the copy of the same words sent again later, so it shows at its own time and not above the newer rows of the page that holds that copy',
  async () => {
    const hydra = await pnyx.hydra()
    pnyx.claude.plan({
      hydra: hydra.id,
      text: '/compact',
      compacting: true,
      hold: true,
    })
    const session = await hydra.chat({ text: '/compact' })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        '/inscribe',
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

    // A long stretch of tool calls between the stopped message and the same words sent again.
    await appendToolCalls({
      session,
      tools: 50,
    })
    pnyx.claude.plan({
      hydra: hydra.id,
      text: '/inscribe',
      reply: 'inscribed',
    })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        '/inscribe',
      ],
    })
    await until({
      what: 'the message sent again to be answered',
      check: () => session.answered === 2,
    })

    type Page = {
      thread: {
        entries: { at: string }[]
        older?: string
        messages: {
          id: string
          stopped?: boolean
        }[]
        conversation: {
          entries: {
            role: string
            text: string
            at: string
            receipt?: string
          }[]
        }
      }
    }
    const page = await hydra.page()
    const latest = await page.send({
      name: 'thread',
      args: ['$hydra'],
    }) as Page
    const oldest = latest.thread.entries[0]!.at

    expect(latest.thread.older).toBeDefined()
    // Nothing shows above the oldest message the page holds, while older ones are still to load.
    expect(latest.thread.conversation.entries.filter(entry => entry.at < oldest)).toEqual([])
    expect(latest.thread.messages.filter(message => message.stopped)).toEqual([])

    const stopped = new Set<string>()
    let cursor = latest.thread.older

    while (cursor) {
      const older = await page.send({
        name: 'thread',
        args: [
          '$hydra',
          cursor,
        ],
      }) as Page

      for (const message of older.thread.messages.filter(item => item.stopped)) {
        stopped.add(message.id)
      }

      cursor = older.thread.older
    }

    page.close()
    expect(stopped.size).toBe(1)
    const sentAgain = latest.thread.conversation.entries.findLast(entry => entry.role === 'user')

    expect(sentAgain).toMatchObject({ receipt: 'delivered' })
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
const compactionInputs = ({ hydraId }: { hydraId: string }) => (loadHydra({
  hydraId,
}).state.cards['$hydra']).compaction?.inputs.map(input => input.text)

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

type Page = Awaited<ReturnType<Hydra['page']>>

// The agent change waiting for the owner's choice, as the page reads it.
const agentChange = ({ hydraId }: { hydraId: string }) => (loadHydra({
  hydraId,
}).state.hydraAgentChange)

// The agent Hydra last ran with, as the page's Last used mark reads it.
const lastRan = ({ hydraId }: { hydraId: string }) => (loadHydra({ hydraId }).state.hydraAgent)

// Claude's catalog runs "opus" at "high" effort when Hydra names neither.
const chooseAgent = async ({
  page,
  agent,
}: {
  page: Page
  agent: Record<string, string>
}) => {
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

const sendToHydra = ({
  hydra,
  text,
}: {
  hydra: Hydra
  text: string
}) => hydra.owner({
  args: [
    'hydra',
    'send',
    '--text',
    text,
  ],
})

const answerAgentChange = async ({
  hydra,
  page,
  choice,
}: {
  hydra: Hydra
  page: Page
  choice: 'compact' | 'neither'
}) => {
  const change = await until({
    what: 'the agent change to wait for the owner',
    check: () => agentChange({ hydraId: hydra.id }),
  })
  expect((await page.send({
    name: 'hydra-agent-change',
    args: [
      change.id,
      choice,
    ],
  })).type).toBe('receipt')
}

const SUMMARY = 'Handoff summary.'

// The summary turn of an agent change's compaction.
const planSummary = ({ hydra }: { hydra: Hydra }) => pnyx.claude.plan({
  hydra: hydra.id,
  match: ({ text }) => text.includes('Compact the recorded conversation'),
  reply: SUMMARY,
  hold: true,
})

// The session that heard a message after it started from an agent change's summary.
const heardFromSummary = ({
  hydra,
  text,
}: {
  hydra: Hydra
  text: string
}) => until({
  what: `a session started from the summary to hear "${text}"`,
  check: () => pnyx.claude.sessions.find(s => s.env.PNYX_HYDRA === hydra.id
    && s.received[0]?.includes(SUMMARY) && s.received.some(message => message.includes(text))),
})

test(
  'choosing the model and effort Hydra already runs with asks nothing, and while a change waits a new choice asks again or sends the held messages left to the same session in order',
  async () => {
    const hydra = await pnyx.hydra()
    const page = await hydra.page()
    const session = await hydra.chat({ text: 'first message' })

    await chooseAgent({
      page,
      agent: { model: 'sonnet' },
    })
    await chooseAgent({
      page,
      agent: {
        model: 'sonnet',
        effort: 'low',
      },
    })
    await chooseAgent({
      page,
      agent: {
        model: 'opus',
        effort: 'low',
      },
    })
    await chooseAgent({
      page,
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

    await chooseAgent({
      page,
      agent: { effort: 'low' },
    })
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
    await chooseAgent({
      page,
      agent: { effort: 'medium' },
    })
    await until({
      what: 'the question to name the newly chosen effort',
      check: () => agentChange({ hydraId: hydra.id })?.next.effort === 'medium',
    })
    await chooseAgent({
      page,
      agent: { effort: 'high' },
    })
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
  'an agent change answered with Compact only applies at the next turn, and choosing back while it compacts asks nothing afterwards, also after a restart',
  async () => {
    const hydra = await pnyx.hydra()
    const page = await hydra.page()
    await hydra.chat({ text: 'first message' })

    const compaction = () => (loadHydra({ hydraId: hydra.id }).state.hydraOperation)

    // The owner changes the agent, answers Compact only, and can act while the compaction runs.
    const compactOnly = async ({
      agent,
      held,
      whileCompacting,
    }: {
      agent: Record<string, string>
      held: string
      whileCompacting?({ message }: { message: string }): Promise<void>
    }) => {
      await chooseAgent({
        page,
        agent,
      })
      const sent = await sendToHydra({
        hydra,
        text: held,
      })
      const summary = planSummary({ hydra })
      await answerAgentChange({
        hydra,
        page,
        choice: 'compact',
      })
      await until({
        what: 'the compaction to run',
        check: () => compaction()?.kind === 'compaction',
      })
      const summarySession = await until({
        what: 'the held summary session',
        check: () => pnyx.claude.sessions.find(session => !session.closed && session.env.PNYX_HYDRA === hydra.id && session.received.at(-1)?.includes('Compact the recorded conversation')),
      })
      const path = join(
        process.env.PNYX_HOME!,
        'hydras',
        hydra.id,
        'hydra.log',
      )
      const command = `cat -- '${path.replace(
        /'/g,
        "'\\''",
      )}'`
      expect(summarySession.received.at(-1)).toContain(command)
      expect(await summarySession.useTool!({
        tool: 'Bash',
        input: { command },
      })).toMatchObject({ behavior: 'allow' })
      expect(await summarySession.useTool!({
        tool: 'Bash',
        input: { command: 'pnyx task create --title untrusted' },
      })).toMatchObject({ behavior: 'deny' })
      expect(await summarySession.useTool!({
        tool: 'Read',
        input: {
          file_path: path,
          offset: 1,
          limit: 10,
        },
      })).toMatchObject({ behavior: 'allow' })
      expect(await summarySession.useTool!({
        tool: 'Read',
        input: { file_path: '/etc/passwd' },
      })).toMatchObject({ behavior: 'deny' })
      expect(await summarySession.useTool!({
        tool: 'Bash',
        input: { command: command + '; touch /tmp/untrusted' },
      })).toMatchObject({ behavior: 'deny' })
      expect(await summarySession.useTool!({
        tool: 'Bash',
        input: {
          command: command.replace(
            'cat -- ',
            "sed -n '1,10p' ",
          ),
        },
      })).toMatchObject({ behavior: 'allow' })
      await whileCompacting?.({ message: sent.message })
      summary.release()
      await until({
        what: 'the agent change to end',
        check: () => !agentChange({ hydraId: hydra.id }) && !compaction(),
      })
    }

    await compactOnly({
      agent: { effort: 'low' },
      held: 'held for low',
    })
    const low = await heardFromSummary({
      hydra,
      text: 'held for low',
    })
    expect(lastRan({ hydraId: hydra.id })?.effort).toBe('low')
    expect((await hydra.chat({ text: 'after low' })).id).toBe(low.id)

    const chooseLow = () => chooseAgent({
      page,
      agent: { effort: 'low' },
    })
    await compactOnly({
      agent: {},
      held: 'held for high',
      whileCompacting: chooseLow,
    })
    const back = await heardFromSummary({
      hydra,
      text: 'held for high',
    })
    expect(back.id).not.toBe(low.id)
    expect(lastRan({ hydraId: hydra.id })?.effort).toBe('low')
    expect((await hydra.chat({ text: 'after choosing back' })).id).toBe(back.id)

    // With its only held message removed, no recap follows, so the owner's message after the restart is the first turn.
    await compactOnly({
      agent: {},
      held: 'removed while compacting',
      whileCompacting: async ({ message }) => {
        expect(await page.send({
          name: 'hydra',
          args: [
            'cancel',
            message,
          ],
        })).toMatchObject({ cancelled: message })
        await chooseLow()
      },
    })
    page.close()
    await pnyx.restart()
    await sendToHydra({
      hydra,
      text: 'after the restart',
    })
    const restarted = await heardFromSummary({
      hydra,
      text: 'after the restart',
    })

    expect(restarted.id).not.toBe(back.id)
    expect(lastRan({ hydraId: hydra.id })?.effort).toBe('low')
    expect(agentChange({ hydraId: hydra.id })).toBeUndefined()
    expect(pnyx.claude.sessions.filter(s => s.received.some(text => text.includes('removed while compacting')))).toEqual([])
  },
)

test(
  'choosing back while an answered agent change waits for Hydra\'s turn withdraws it, and its held message reaches the same session',
  async () => {
    const hydra = await pnyx.hydra()
    const page = await hydra.page()
    const session = await hydra.chat({ text: 'first message' })

    for (const choice of [
      'neither',
      'compact',
    ] as const) {
      const turn = pnyx.claude.plan({
        hydra: hydra.id,
        text: `${choice} turn`,
        partial: 'Working',
        hold: true,
      })
      await hydra.chat({ text: `${choice} turn` })
      await chooseAgent({
        page,
        agent: { effort: 'low' },
      })
      await sendToHydra({
        hydra,
        text: `held for ${choice}`,
      })
      await answerAgentChange({
        hydra,
        page,
        choice,
      })
      await until({
        what: 'the agent change to wait for Hydra\'s turn',
        check: () => agentChange({ hydraId: hydra.id })?.state === 'running',
      })
      await chooseAgent({
        page,
        agent: {},
      })
      turn.release()
      await until({
        what: `Hydra to hear "held for ${choice}"`,
        check: () => heard({
          received: session.received,
          text: `held for ${choice}`,
        }) === 1,
      })
      expect(agentChange({ hydraId: hydra.id })).toBeUndefined()
      expect(lastRan({ hydraId: hydra.id })?.effort).toBeUndefined()
    }

    expect(pnyx.claude.sessions.filter(s => s.env.PNYX_HYDRA === hydra.id)).toEqual([session])
    page.close()
  },
)

test(
  'Stop, or removing its last held message, ends an agent change waiting for the owner, Stop also ends the turn Hydra was running, and the next change still delivers what it holds',
  async () => {
    const hydra = await pnyx.hydra()
    const page = await hydra.page()
    const session = await hydra.chat({ text: 'first message' })

    const choose = ({ agent }: { agent: Record<string, string> }) => chooseAgent({
      page,
      agent,
    })
    const send = ({ text }: { text: string }) => sendToHydra({
      hydra,
      text,
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

    // The next change after a Stop still delivers what it held once its compaction ends.
    await choose({ agent: { effort: 'low' } })
    await send({ text: 'cancelled by the stop' })
    await until({
      what: 'the effort change to wait for the owner',
      check: () => agentChange({ hydraId: hydra.id }),
    })
    expect((await hydra.owner({
      args: [
        'hydra',
        'stop',
      ],
    })).stopped).toBe('agent change')
    await send({ text: 'held after the stop' })
    planSummary({ hydra }).release()
    await answerAgentChange({
      hydra,
      page,
      choice: 'compact',
    })
    await heardFromSummary({
      hydra,
      text: 'held after the stop',
    })
    page.close()
  },
)

test(
  'timed reviews wake Hydra for a quiet running card and stay quiet for healthy or unchanged work',
  async () => {
    const hydra = await pnyx.hydra()
    const previous = (await hydra.owner({
      args: [
        'settings',
        'show',
      ],
    })).settings.reviewMinutes
    await hydra.chat({ text: 'Prepare heartbeat review' })
    await until({
      what: 'Hydra to finish preparing',
      check: () => !queue({ hydraId: hydra.id })?.working,
    })
    await hydra.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"reviewMinutes":1}',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'heartbeat-worker',
        '--title',
        'Heartbeat fixture',
        '--no-start',
      ],
    })
    await hydra.owner({
      args: [
        'push',
        '--key',
        'heartbeat-worker',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        title: 'Heartbeat fixture',
        agent: {
          provider: 'claude-code',
          sessionId: 'heartbeat-fixture',
        },
        activity: 'working',
      }),
    })
    const task = await hydra.task({ key: 'heartbeat-worker' })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--task',
        task.id,
        '--actor',
        `worker:${task.id}`,
        '--kind',
        'progress',
        '--text',
        'Worker started preparing the change',
      ],
    })
    expect((await hydra.task({ key: 'heartbeat-worker' })).status).toBe('running')
    let now = Date.now()
    await hydra.owner({
      args: [
        'task',
        'remind',
        'heartbeat-worker',
        new Date(now + 30 * 60_000).toISOString(),
      ],
    })
    let wakes = 0
    const timer = startReviewTimer({
      hydraId: hydra.id,
      now: () => now,
      wake: () => {
        wakes++
      },
      interval: () => () => {},
    })

    try {
      now += 60_000
      await timer.check()
      expect(wakes).toBe(0)
      now += 60 * 60_000
      await timer.check()
      expect(wakes).toBe(1)
      const review = await hydra.owner({
        args: [
          'history',
          '--kind',
          'hydra.review',
          '--limit',
          '1',
          '--full',
        ],
      })
      expect(review.events[0].data.block).toContain('quiet worker: Running with no update since')
      now += 60_000
      await timer.check()
      expect(wakes).toBe(1)
      await withWriter({
        hydraId: hydra.id,
        fn: ({ writer }) => {
          writer.append({
            event: {
              v: writer.state.v,
              seq: writer.state.seq + 1,
              id: 'heartbeat-green-pr',
              cardId: task.id,
              actor: 'pnyx',
              at: new Date(now).toISOString(),
              type: 'card.linked',
              data: {
                url: 'https://github.com/example/app/pull/42',
                before: null,
                after: {
                  kind: 'github_pr',
                  url: 'https://github.com/example/app/pull/42',
                  state: 'open',
                  draft: false,
                  checks: '1 passed, 0 failed, 1 total',
                  checkedAt: new Date(now).toISOString(),
                },
              },
            },
          })
        },
      })
      now += 60_000
      await timer.check()
      expect(wakes).toBe(2)
      const green = await hydra.owner({
        args: [
          'history',
          '--kind',
          'hydra.review',
          '--limit',
          '1',
          '--full',
        ],
      })
      expect(green.events[0].data.block).toContain('green unmerged PR: https://github.com/example/app/pull/42')
      expect(green.events[0].data.block).toContain('quiet worker: Running with no update since')
      now += 60_000
      await timer.check()
      expect(wakes).toBe(2)
      await hydra.owner({
        args: [
          'task',
          'ask',
          'heartbeat-worker',
          '--to',
          'owner',
          '--question',
          'Which account?',
          '--context',
          `An account choice is needed. [Heartbeat](pnyx-task:${task.id})`,
          '--choice',
          'Personal',
          '--choice',
          'Team',
          '--recommend',
          '1',
          '--actor',
          'hydra',
        ],
      })
      now += 4 * 60 * 60_000
      await timer.check()
      await until({
        what: 'Hydra to finish the task question reminder',
        check: () => !queue({ hydraId: hydra.id })?.working,
      })
      await timer.check()
      expect(wakes).toBe(3)
      const overdue = await hydra.owner({
        args: [
          'history',
          '--kind',
          'hydra.review',
          '--limit',
          '1',
          '--full',
        ],
      })
      expect(overdue.events[0].data.block).toContain('question reminder:')
      expect(overdue.events[0].data.block).toContain('Which account?')
      now += 60_000
      await timer.check()
      expect(wakes).toBe(3)
      await withWriter({
        hydraId: hydra.id,
        fn: ({ writer }) => {
          writer.append({
            event: {
              v: writer.state.v,
              seq: writer.state.seq + 1,
              id: 'heartbeat-hydra-question',
              cardId: HYDRA_CARD,
              actor: 'hydra',
              at: new Date(now).toISOString(),
              type: 'task.asked',
              data: {
                id: 'hydra-account',
                audience: 'owner',
                question: 'Can Hydra use the team account?',
              },
            },
          })
        },
      })
      now += 4 * 60 * 60_000
      await until({
        what: 'the periodic review to wake Hydra for its question reminder',
        check: async () => {
          await timer.check()

          return wakes === 4
        },
      })
      expect(wakes).toBe(4)
      const ownQuestion = await hydra.owner({
        args: [
          'history',
          '--kind',
          'hydra.review',
          '--limit',
          '1',
          '--full',
        ],
      })
      expect(ownQuestion.events[0].data.block).toContain('Can Hydra use the team account?')
      now += 60_000
      await timer.check()
      now += 4 * 60 * 60_000
      await timer.check()
      expect(wakes).toBe(4)
    } finally {
      timer.close()
      await hydra.owner({
        args: [
          'settings',
          'set',
          '--json',
          JSON.stringify({ reviewMinutes: previous }),
        ],
      })
    }
  },
)

test.each([
  { harness: 'claude' },
  { harness: 'codex' },
])(
  'each Hydra turn receives changed task cards with worker links and skips unchanged cards ($harness)',
  async ({ harness }) => {
    const hydra = await pnyx.hydra()
    const page = await hydra.page()
    await chooseAgent({
      page,
      agent: { harness },
    })
    const { worker: reviewWorker } = await hydra.startTask({ key: 'review-page' })
    await hydra.startTask({ key: 'unchanged-card' })

    for (let index = 0; index < 41; index++) {
      expect((await page.send({
        name: 'task',
        args: [
          'create',
          '--key',
          `snapshot-${index}`,
          '--title',
          `Snapshot card ${index}`,
          '--no-start',
        ],
      })).type).toBe('receipt')
    }

    const session = await hydra.chat({ text: 'Read the initial cards' })
    expect(session.received[0]).toContain('Snapshot card 40')
    await until({
      what: 'the initial turn to finish',
      check: () => !queue({ hydraId: hydra.id })?.working,
    })
    await workerLine({
      hydra,
      key: 'review-page',
      line: 'link: https://example.com/lavish Design review',
    })
    await workerLine({
      hydra,
      key: 'review-page',
      line: 'link: https://example.com/preview App preview',
    })
    await hydra.owner({
      args: [
        'task',
        'send',
        'review-page',
        '--text',
        'Use the blue layout on the review page',
        '--harness',
        'claude',
      ],
    })
    await until({
      what: 'the owner message to reach the worker',
      check: () => reviewWorker.received.some(text => text.includes('Use the blue layout on the review page')) && reviewWorker.answered === 2,
    })
    await until({
      what: 'the worker to finish its reply',
      check: async () => (await hydra.task({ key: 'review-page' })).status === 'idle',
    })
    await workerLine({
      hydra,
      key: 'review-page',
      line: 'note: Review page is in progress',
    })
    const reviewTask = await hydra.task({ key: 'review-page' })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--task',
        reviewTask.id,
        '--actor',
        `worker:${reviewTask.id}`,
        '--kind',
        'progress',
        '--text',
        'Review page is ready',
      ],
    })
    await hydra.chat({ text: 'Read the changed cards' })
    const changed = session.received.find(text => text.endsWith('Read the changed cards'))!
    const digest = changed.slice(
      0,
      changed.indexOf('</pnyx-digest>'),
    )
    expect(digest).toContain('Task cards (changed since your last turn):')
    expect(digest).toContain('Review page is ready')
    expect(digest).toContain('owner: Use the blue layout on the review page')
    expect(digest.indexOf('owner: Use the blue layout')).toBeLessThan(digest.indexOf('latest: Review page is ready'))
    expect(digest).toContain('https://example.com/lavish')
    expect(digest).toContain('https://example.com/preview')
    expect(digest).not.toContain('unchanged-card')
    expect(digest).toContain('Open cards: 2 idle, 41 not started, no reason given')
    await until({
      what: 'the changed turn to finish',
      check: () => !queue({ hydraId: hydra.id })?.working,
    })
    await hydra.chat({ text: 'Read the unchanged cards' })
    const unchanged = session.received.find(text => text.endsWith('Read the unchanged cards'))!
    const nextDigest = unchanged.slice(
      0,
      unchanged.indexOf('</pnyx-digest>'),
    )
    expect(nextDigest).not.toContain('Review page is ready')
    expect(nextDigest).not.toContain('Use the blue layout on the review page')
    expect(nextDigest).not.toContain('https://example.com/lavish')
    expect(nextDigest).not.toContain('more changed cards')
    expect(nextDigest).toContain('Open cards: 2 idle, 41 not started, no reason given')
    await until({
      what: 'the unchanged turn to finish',
      check: () => !queue({ hydraId: hydra.id })?.working,
    })

    for (let index = 0; index < 41; index++) {
      expect((await page.send({
        name: 'task',
        args: [
          'rename',
          `snapshot-${index}`,
          '--title',
          `Changed snapshot card ${index}`,
        ],
      })).type).toBe('receipt')
    }

    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'new-overflow-card',
        '--title',
        'New overflow card',
        '--no-start',
      ],
    })
    const overflowCard = await hydra.task({ key: 'new-overflow-card' })
    await hydra.chat({ text: 'Read the capped changes' })
    const capped = session.received.find(text => text.endsWith('Read the capped changes'))!
    expect(capped).toContain('2 more changed cards')
    expect(capped).toContain('task.log')
    expect(capped).toContain('Changed snapshot card 39')
    expect(capped).not.toContain('Changed snapshot card 40')
    await until({
      what: 'the capped turn to finish',
      check: () => !queue({ hydraId: hydra.id })?.working,
    })
    await hydra.owner({
      args: [
        'task',
        'hide',
        'new-overflow-card',
      ],
    })
    await hydra.chat({ text: 'Read the remaining change' })
    const remainder = session.received.find(text => text.endsWith('Read the remaining change'))!
    expect(remainder).toContain('Changed snapshot card 40')
    expect(remainder).not.toContain('Changed snapshot card 39')
    expect(remainder).toContain(`${overflowCard.id} is no longer listed`)
    await until({
      what: 'the remaining-change turn to finish',
      check: () => !queue({ hydraId: hydra.id })?.working,
    })
    await workerLine({
      hydra,
      key: 'review-page',
      line: 'link: https://example.com/active-review Active review',
    })
    await hydra.chat({ text: 'Read the first review update' })
    const firstUpdate = session.received.find(text => text.endsWith('Read the first review update'))!
    expect(firstUpdate).toContain('https://example.com/active-review')
    await until({
      what: 'the first review update turn to finish',
      check: () => !queue({ hydraId: hydra.id })?.working,
    })

    await workerLine({
      hydra,
      key: 'review-page',
      line: 'link: https://example.com/second-review Second review',
    })
    await workerLine({
      hydra,
      key: 'review-page',
      line: 'note: Review page was updated after the first turn',
    })
    await hydra.chat({ text: 'Read the second review update' })
    const secondUpdate = session.received.find(text => text.endsWith('Read the second review update'))!
    expect(secondUpdate).toContain('https://example.com/second-review')
    expect(secondUpdate).toContain('Review page was updated after the first turn')
    await until({
      what: 'the second review update turn to finish',
      check: () => !queue({ hydraId: hydra.id })?.working,
    })

    const provider = harness === 'claude' ? pnyx.claude : pnyx.codex
    provider.plan({
      hydra: hydra.id,
      text: 'Compact task context',
      compacting: true,
      compactTo: 500,
    })
    const answers = session.answered
    await hydra.chat({ text: 'Compact task context' })
    await until({
      what: 'the compacted turn to finish',
      check: () => session.answered > answers && !queue({ hydraId: hydra.id })?.working,
    })
    await hydra.chat({ text: 'Read the full snapshot after compaction' })
    const afterCompact = session.received.find(text => text.endsWith('Read the full snapshot after compaction'))!
    const snapshot = harness === 'claude' ? session.contexts?.at(-1) : afterCompact
    expect(snapshot).toContain('Task cards (all open cards):')
    expect(snapshot).toContain('Changed snapshot card 0')
    expect(snapshot).toContain('Changed snapshot card 40')
    expect(snapshot).toContain('https://example.com/lavish')
    expect(snapshot).toContain('https://example.com/active-review')
    await until({
      what: 'the post-compaction turn to finish',
      check: () => !queue({ hydraId: hydra.id })?.working,
    })

    for (let index = 0; index < 41; index++) {
      expect((await page.send({
        name: 'task',
        args: [
          'hide',
          `snapshot-${index}`,
        ],
      })).type).toBe('receipt')
    }

    await hydra.chat({ text: 'Read the hidden-card changes' })
    const hidden = session.received.find(text => text.endsWith('Read the hidden-card changes'))!
    expect(hidden.match(/is no longer listed/g)).toHaveLength(40)
    expect(hidden).toContain('1 more changed cards')
    await until({
      what: 'the hidden-card turn to finish',
      check: () => !queue({ hydraId: hydra.id })?.working,
    })
    await hydra.chat({ text: 'Read the last hidden-card change' })
    const lastHidden = session.received.find(text => text.endsWith('Read the last hidden-card change'))!
    expect(lastHidden.match(/is no longer listed/g)).toHaveLength(1)
    await until({
      what: 'the last hidden-card turn to finish',
      check: () => !queue({ hydraId: hydra.id })?.working,
    })
    page.close()

    expect(lastHidden).toContain('hydra.log')
    const countArgs = [
      'hydra',
      'history',
      '--since',
      'last-compaction',
      '--count',
    ]
    const beforeRestart = await hydra.owner({ args: countArgs })
    expect(beforeRestart.totalTokens).toBeGreaterThan(0)
    const logPath = join(
      process.env.PNYX_HOME!,
      'hydras',
      hydra.id,
      'hydra.log',
    )
    expect(readFileSync(
      logPath,
      'utf8',
    )).toContain('Read the full snapshot after compaction')
    await pnyx.restart()
    expect((await hydra.owner({ args: countArgs })).totalTokens).toBe(beforeRestart.totalTokens)
    expect(readFileSync(
      logPath,
      'utf8',
    )).toContain('Read the full snapshot after compaction')
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

test(
  'clearing task threads stops every task stream while Hydra and another tab keep following',
  async () => {
    const hydra = await pnyx.hydra()
    const first = await hydra.startTask({ key: 'first-thread' })
    const second = await hydra.startTask({ key: 'second-thread' })
    const ids = [
      (await hydra.task({ key: 'first-thread' })).id,
      (await hydra.task({ key: 'second-thread' })).id,
    ]
    const received = new Set<string>()
    const watched = new Set<string>()

    const observe = ({ cards }: { cards: Set<string> }) => {
      return ({ message }: { message: ServerMessage }) => {
        if (message.type === 'thread') {
          cards.add(message.thread.card)
        } else if (message.type === 'thread.delta') {
          cards.add(message.delta.page.card)
        }
      }
    }

    const page = await openPage({
      port: pnyx.port(),
      hydraId: hydra.id,
      receive: observe({ cards: received }),
    })
    const other = await openPage({
      port: pnyx.port(),
      hydraId: hydra.id,
      receive: observe({ cards: watched }),
    })

    try {
      await page.send({
        name: 'thread',
        args: [HYDRA_CARD],
      })

      for (const id of ids) {
        await page.send({
          name: 'thread',
          args: [id],
        })
        await other.send({
          name: 'thread',
          args: [id],
        })
      }

      const cleared = await page.send({
        name: 'thread',
        args: [],
      })
      expect(cleared.type).toBe('receipt')
      received.clear()
      watched.clear()

      for (const id of ids) {
        await hydra.owner({
          args: [
            'reply',
            id,
            '--text',
            'Reply after this tab stopped following',
          ],
        })
      }

      await until({
        what: 'both workers answer and the other tab receives both live threads',
        check: () => first.worker.answered === 2 && second.worker.answered === 2
          && ids.every(id => watched.has(id)),
      })
      const session = await hydra.chat({ text: 'The Hydra conversation stays subscribed' })
      await until({
        what: 'the cleared tab still receives Hydra live replies',
        check: () => session.answered > 0 && received.has(HYDRA_CARD),
      })
      expect([...received]).toEqual([HYDRA_CARD])
    } finally {
      page.close()
      other.close()
    }
  },
)

test(
  'a message the harness recorded under its own id is paired by that id and delivered by it, even when its words differ, a later message has the same words or its line is long enough to be split',
  () => {
    const first = {
      id: '6f1c2a4e-0b7d-4c55-9a3e-1d2b3c4d5e6f',
      action: 'send' as const,
      actor: 'web',
      hydra: 'h',
      text: 'yes',
      at: '2026-11-20T10:00:00.000Z',
    }
    const second = {
      ...first,
      id: '7a2d3b5f-1c8e-4d66-8b4f-2e3c4d5e6f70',
      at: '2026-11-20T10:00:01.000Z',
    }
    const redacted = {
      ...first,
      id: '8b3e4c60-2d9f-4e77-9c50-3f4d5e6f7081',
      text: 'the key is hunter2',
      at: '2026-11-20T10:00:02.000Z',
    }
    const long = {
      ...first,
      id: '9c4f5d71-3ea0-4f88-8d61-405e6f708192',
      text: 'Ship the release notes. '.repeat(60),
      at: '2026-11-20T10:00:05.000Z',
    }
    const rows = hydraMessages({
      messages: [
        first,
        second,
        redacted,
        long,
      ],
      transcript: [
        {
          id: '10:m0',
          kind: 'message',
          role: 'user',
          text: 'yes',
          at: '2026-11-20T10:00:03.000Z',
          inputUuid: first.id,
        },
        {
          id: '20:m0',
          kind: 'message',
          role: 'user',
          text: 'the key is [redacted]',
          at: '2026-11-20T10:00:04.000Z',
          inputUuid: redacted.id,
        },
        ...splitEntry({
          entry: {
            id: '30:m0',
            kind: 'message',
            role: 'user',
            text: long.text,
            at: '2026-11-20T10:00:06.000Z',
            inputUuid: long.id,
          },
        }),
      ],
    })

    expect(rows.toSorted((
      a,
      b,
    ) => a.id.localeCompare(b.id)).map(row => [
      row.id,
      row.reference,
      row.text,
      row.receipt,
    ])).toEqual([
      [
        '10:m0',
        first.id,
        'yes',
        'delivered',
      ],
      [
        '20:m0',
        redacted.id,
        'the key is hunter2',
        'delivered',
      ],
      [
        '30:m0.0',
        long.id,
        long.text,
        'delivered',
      ],
      [
        second.id,
        second.id,
        'yes',
        undefined,
      ],
    ])
  },
)

test(
  'a failed Hydra input remains retryable while its host is down and concurrent retries deliver once',
  async () => {
    const hydra = await pnyx.hydra()
    const page = await hydra.page()
    await page.send({
      name: 'hydra-agent',
      args: [JSON.stringify({ harness: 'codex' })],
    })
    page.close()
    const text = 'retry this saved input'
    const id = randomUUID()
    const args = [
      'hydra',
      'send',
      '--text',
      text,
      '--event-id',
      id,
    ]
    pnyx.codex.plan({
      hydra: hydra.id,
      text,
      refuse: true,
    })
    await hydra.owner({ args })

    const message = () => {
      const state = loadHydra({ hydraId: hydra.id }).state

      return state.hydraMessages!.find(input => input.id === id)!
    }

    await until({
      what: 'the refusal to be saved',
      check: () => message().failure,
    })
    const failure = message().failure
    let stoppedMessage: ReturnType<typeof message> | undefined
    await pnyx.restart({
      whileStopped: async () => {
        await hydraSend({
          hydraId: hydra.id,
          values: {
            text,
            'event-id': id,
          },
        })
        stoppedMessage = { ...message() }
      },
    })
    expect(stoppedMessage?.failure).toBe(failure)
    expect(stoppedMessage?.attempt).toBeUndefined()
    const turn = pnyx.codex.plan({
      hydra: hydra.id,
      text,
      hold: true,
    })
    onTestFinished(() => turn.release())
    await Promise.all([
      hydra.owner({ args }),
      hydra.owner({ args }),
    ])
    await until({
      what: 'the retry to be taken',
      check: () => message().received,
    })
    expect(message().attempt).toBe(1)
    const attempts = pnyx.codex.sessions.flatMap(session => session.received)
      .filter(input => input.endsWith(text))
    expect(attempts).toHaveLength(2)
  },
)

test(
  'a refused recovery recap fails every owner message it carries',
  async () => {
    const hydra = await pnyx.hydra()
    const page = await hydra.page()
    await page.send({
      name: 'hydra-agent',
      args: [JSON.stringify({ harness: 'codex' })],
    })
    page.close()
    const messages: string[] = []
    pnyx.codex.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('first held request') && text.includes('second held request'),
      refuse: true,
    })
    await pnyx.restart({
      whileStopped: async () => {
        await withWriter({
          hydraId: hydra.id,
          fn: ({ writer }) => applyDecision({
            writer,
            decision: operationEvent({
              state: writer.state,
              operation: {
                id: randomUUID(),
                kind: 'restart',
                state: 'started',
              },
              meta: {
                actor: 'pnyx',
                at: new Date().toISOString(),
              },
            }),
          }),
        })

        for (const text of [
          'first held request',
          'second held request',
        ]) {
          const id = randomUUID()
          messages.push(id)
          await hydraSend({
            hydraId: hydra.id,
            values: {
              text,
              'event-id': id,
            },
          })
        }
      },
    })
    await until({
      what: 'both carried messages to show the refusal',
      check: () => {
        const saved = loadHydra({ hydraId: hydra.id }).state.hydraMessages!

        return messages.every(id => saved.find(message => message.id === id)?.failure?.includes('refused'))
      },
    })

    for (const text of [
      'first held request',
      'second held request',
    ]) {
      expect(await chatEntry({
        hydra,
        text,
      })).toMatchObject({ receipt: 'failed' })
    }
  },
)

test(
  'recovery drains a retried compaction input and the input after it exactly once',
  async () => {
    const hydra = await pnyx.hydra()
    const session = await hydra.chat({ text: 'prepare compaction recovery' })
    await until({
      what: 'the preparation to finish',
      check: () => session.answered === 1,
    })
    const texts = [
      'retried compaction request',
      'next compaction request',
    ]
    await pnyx.restart({
      whileStopped: async () => {
        for (const text of texts) {
          const id = randomUUID()
          await hydraSend({
            hydraId: hydra.id,
            values: {
              text,
              'event-id': id,
            },
          })
          await withWriter({
            hydraId: hydra.id,
            fn: ({ writer }) => {
              const at = new Date().toISOString()

              if (text === texts[0]) {
                failHydraInput({
                  writer,
                  input: id,
                  error: 'The agent refused this input',
                  at,
                })
                applyDecision({
                  writer,
                  decision: hydraEvent({
                    state: writer.state,
                    cardId: HYDRA_CARD,
                    meta: {
                      actor: 'web',
                      at,
                    },
                    change: {
                      type: 'hydra.input',
                      data: {
                        message: id,
                        state: 'retrying',
                      },
                    },
                  }),
                })
              }

              recordCompaction({
                writer,
                card: HYDRA_CARD,
                at,
                change: {
                  kind: 'held',
                  input: {
                    id,
                    text,
                    actor: 'web',
                    route: 'hydra',
                    accepted: true,
                    at,
                  },
                },
              })
            },
          })
        }
      },
    })
    await until({
      what: 'both compaction inputs to drain',
      check: () => compactionInputs({ hydraId: hydra.id })?.length === 0,
    })

    for (const text of texts) {
      await until({
        what: 'the drained input to be confirmed',
        check: async () => (await chatEntry({
          hydra,
          text,
        }))?.receipt === 'delivered',
      })
      const delivered = pnyx.claude.sessions.flatMap(session => session.received)
        .filter(input => input.endsWith(text))
      expect(delivered).toHaveLength(1)
    }
  },
)

test(
  'held and refused owner messages stay visible without taking the active turn folds or timing',
  () => {
    const at = ({ second }: { second: number }) => `2026-01-01T00:00:0${second}.000Z`
    const messages = [
      {
        id: 'active',
        text: 'active request',
        at: at({ second: 1 }),
      },
      {
        id: 'held',
        text: 'held request',
        at: at({ second: 3 }),
      },
      {
        id: 'refused',
        text: 'refused request',
        at: at({ second: 4 }),
        failure: 'The agent refused the interrupt',
      },
    ].map(message => ({
      ...message,
      action: 'send' as const,
      actor: 'web',
      hydra: 'hydra',
    }))
    const before = {
      id: 'before',
      kind: 'tool' as const,
      role: 'assistant',
      text: 'earlier work',
      at: at({ second: 2 }),
    }
    const after = {
      id: 'after',
      kind: 'tool' as const,
      role: 'assistant',
      text: 'later work',
      at: at({ second: 4 }),
    }
    const reply = {
      id: 'reply',
      kind: 'message' as const,
      role: 'assistant',
      text: 'finished active request',
      final: true,
      at: at({ second: 5 }),
    }
    const conversation = hydraConversation({
      messages,
      transcript: [
        before,
        after,
        reply,
      ],
      held: new Set(['held']),
      actions: [],
      columns: [],
      working: false,
      tools: true,
      thinking: false,
    })
    expect(conversation.entries.map(entry => entry.id)).toEqual([
      'active',
      'held',
      'refused',
      'reply',
    ])
    expect(conversation.folds.get('reply')?.notes).toEqual([
      before,
      after,
    ])
    expect(conversation.timings.get('reply')?.start).toBe(at({ second: 1 }))
  },
)

test(
  'a refused initial agent-change write returns an error before compaction can begin',
  async () => {
    const hydra = await pnyx.hydra()
    const page = await hydra.page()
    await hydra.chat({text: 'First message before changing model'})
    await chooseAgent({
      page,
      agent: {model: 'sonnet'},
    })
    await sendToHydra({
      hydra,
      text: 'Held for the selected model',
    })
    const change = await until({
      what: 'the pending model choice',
      check: () => agentChange({hydraId: hydra.id}),
    })
    const sessions = pnyx.claude.sessions.length
    const filesystem = await vi.importActual<typeof import('node:fs')>('node:fs')
    const path = join(
      process.env.PNYX_HOME!,
      'hydras',
      hydra.id,
      'hydra.log',
    )
    let failed = false
    // eslint-disable-next-line pnyx/object-params -- Node owns openSync's positional signature.
    vi.mocked(openSync).mockImplementation((...args) => {
      const [
        file,
        flags,
      ] = args

      if (!failed && String(file) === path && typeof flags === 'number' && (flags & constants.O_APPEND)) {
        failed = true
        throw Object.assign(
          new Error('injected native append failure'),
          { code: 'EIO' },
        )
      }

      return filesystem.openSync(...args)
    })

    try {
      const answer = await page.send({
        name: 'hydra-agent-change',
        args: [
          change.id,
          'compact',
        ],
      })
      expect(answer).toMatchObject({
        type: 'error',
        code: 'WRITE_FAILED',
      })
      expect(agentChange({hydraId: hydra.id})?.state).toBe(change.state)
      expect(pnyx.claude.sessions.length).toBe(sessions)
    } finally {
      vi.mocked(openSync).mockImplementation(filesystem.openSync)
      page.close()
    }
  },
)
