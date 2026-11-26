import * as eventLog from '#app/event-log.ts'
import { randomUUID } from 'node:crypto'
import { loadTitan } from '#app/store.ts'
import { applyDecision } from '#app/decision.ts'
import { findTitanTurnToResume } from '#titan/wakes.ts'
import { titanSend } from '#titan/send-cli.ts'
import { failTitanInput } from '#titan/received.ts'
import { createTitanOperations, operationEvent } from '#titan/operations.ts'
import { recordCompaction } from '#workers/compaction/record.ts'
import { titanConversation } from '#titan/conversation.ts'
import { workerLine } from './setup/worker-log.ts'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withWriter } from '#app/writer.ts'
import { titanEvent } from '#titan/titan.ts'
import { createDigestContext } from '#titan/digest-context.ts'
import { startReviewTimer } from '#titan/review-timer.ts'
import { fireReminders } from '#tasks/fire-reminders.ts'
import { titanReview } from '#titan/review.ts'
import { beforeAll, expect, onTestFinished, test, vi } from 'vitest'
import { TITAN_CARD } from '#titan/identity.ts'
import type { ServerMessage } from '#app/server-transport.ts'
import { TITAN_SKILLS, MANAGE_WORKERS_SKILL, ORCHESTRATE_SKILL } from '#setup/skill-names.ts'
import { parse } from 'yaml'
import { titanMessages } from '#titan/chat-messages.ts'
import { splitEntry } from '#titan/transcripts-read.ts'
import { safeEnd } from '../web/src/shared/ui/reveal.ts'
import { openPage, startOthrys, until, type Titan, type Othrys } from './setup/othrys.ts'
import { appendToolCalls } from './setup/transcripts.ts'

const DOCS_MESSAGE = '3d6b8f20-5a4c-4e1b-9f72-6c8d0e1a2b34'
const CHANGELOG_MESSAGE = '4e7c9031-6b5d-4f2c-8a83-7d9e1f2b3c45'

let othrys: Othrys

beforeAll(async () => {
  othrys = await startOthrys()
})

const queueBox = ({ titanId }: { titanId: string }) => othrys.home().scopes[titanId]?.queue

const queue = ({ titanId }: { titanId: string }) => queueBox({ titanId })?.chat

const heard = ({
  received,
  text,
}: {
  received: string[]
  text: string
}) => received.filter(message => message.endsWith(text)).length

test(
  'messages the owner sends while Titan works reach it once each, in order and under their own ids, and the queue shows Titan working until its turn ends',
  async () => {
    const titan = await othrys.titan()
    const turn = othrys.claude.plan({
      titan: titan.id,
      text: 'plan the release',
      reply: 'Release plan ready.',
      partial: 'Release',
      hold: true,
    })
    const session = await titan.chat({ text: 'plan the release' })
    await titan.owner({
      args: [
        'titan',
        'send',
        '--text',
        'also check the docs',
        '--event-id',
        DOCS_MESSAGE,
      ],
    })
    await titan.owner({
      args: [
        'titan',
        'send',
        '--text',
        'and the changelog',
        '--event-id',
        CHANGELOG_MESSAGE,
      ],
    })

    await until({
      what: 'the queue to show Titan working',
      check: () => queue({ titanId: titan.id })?.working === true,
    })
    expect(session.answered).toBe(0)

    turn.release()
    await until({
      what: 'Titan to answer all three messages',
      check: () => session.answered === 3,
    })
    await until({
      what: 'the queue to show Titan idle',
      check: () => queue({ titanId: titan.id })?.working === false,
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
    expect(othrys.claude.sessions.filter(s => s.env.OTHRYS_TITAN === titan.id)).toHaveLength(1)
    expect(Object.values(loadTitan({
      titanId: titan.id,
    }).state.cards).map(card => ({ key: card.key }))
      .sort((
        a,
        b,
      ) => a.key.localeCompare(b.key))).toEqual([{ key: '$titan' }])

    const { messages } = await titan.owner({
      args: [
        'titan',
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
  'a message the owner sends while Titan runs a tool reaches that turn without stopping the tool, and the turn ends with its own reply',
  async () => {
    const titan = await othrys.titan()
    const turn = othrys.claude.plan({
      titan: titan.id,
      text: 'run the test suite',
      reply: 'Suite passed.',
      tool: {
        id: 'toolu_suite',
        name: 'Bash',
        input: { command: 'pnpm test' },
      },
      hold: true,
      folds: true,
    })
    const session = await titan.chat({ text: 'run the test suite' })
    await titan.owner({
      args: [
        'titan',
        'send',
        '--text',
        'and report the coverage',
      ],
    })

    await until({
      what: 'Titan to take the message into the running turn',
      check: () => heard({
        received: session.received,
        text: 'and report the coverage',
      }) === 1,
    })
    expect(session.answered).toBe(0)
    expect(queue({ titanId: titan.id })?.working).toBe(true)

    turn.release()
    await until({
      what: 'the turn to end with its own reply',
      check: () => session.answered === 2 && queue({ titanId: titan.id })?.working === false,
    })
    expect(heard({
      received: session.received,
      text: 'and report the coverage',
    })).toBe(1)
    const page = await titan.page()
    const { thread } = await page.send({
      name: 'thread',
      args: ['$titan'],
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
    page.close()
    expect(thread.conversation.entries.filter(entry => entry.role === 'assistant').map(entry => entry.text)).toContain('Suite passed.')
    expect(loadTitan({ titanId: titan.id }).state.cards[TITAN_CARD]!.attention
      .some(item => item.kind === 'interrupted')).toBe(false)
  },
)

test(
  'Stop ends Titan\'s running turn without its reply, Titan takes the next message in the same session, and Stop while idle stops nothing',
  async () => {
    const titan = await othrys.titan()
    othrys.claude.plan({
      titan: titan.id,
      text: 'write the long report',
      reply: 'The long report, finished.',
      partial: 'The long',
      hold: true,
    })
    const session = await titan.chat({ text: 'write the long report' })

    const stopped = await titan.owner({
      args: [
        'titan',
        'stop',
      ],
    })
    expect(stopped.stopped).toBe('titan')
    await until({
      what: 'the stopped turn to end',
      check: () => session.answered === 1,
    })
    await until({
      what: 'the queue to show Titan idle after Stop',
      check: () => queue({ titanId: titan.id })?.working === false,
    })

    othrys.claude.plan({
      titan: titan.id,
      text: 'just the summary',
      reply: 'Summary only.',
    })
    await titan.owner({
      args: [
        'titan',
        'send',
        '--text',
        'just the summary',
      ],
    })
    await until({
      what: 'Titan to answer after Stop',
      check: () => session.answered === 2,
    })

    expect(othrys.claude.sessions.filter(s => s.env.OTHRYS_TITAN === titan.id)).toEqual([session])
    expect(heard({
      received: session.received,
      text: 'write the long report',
    })).toBe(1)
    expect(heard({
      received: session.received,
      text: 'just the summary',
    })).toBe(1)

    const page = await titan.page()
    const { thread } = await page.send({
      name: 'thread',
      args: ['$titan'],
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

    const idle = await titan.owner({
      args: [
        'titan',
        'stop',
      ],
    })
    expect(idle.stopped).toMatch(/^none:/)
    const configured = structuredClone(loadTitan({ titanId: titan.id }).state.cards[TITAN_CARD]!)
    await titan.owner({
      args: [
        'titan',
        'set',
        '--identity',
        'replacement-titan',
      ],
    })
    const detached = loadTitan({ titanId: titan.id }).state.cards[TITAN_CARD]!
    expect(detached.agent).toBeUndefined()
    expect(detached.terminal).toBeUndefined()
    expect(detached.activity).toBeUndefined()
    expect(detached.sessionActivity).toBeUndefined()
    expect(detached.workingSince).toBeUndefined()
    expect(detached.turnStartedAt).toBeUndefined()
    expect(detached.turnEndedSeq).toBeUndefined()
    expect(detached.settings).toEqual(configured.settings)
  },
)

test(
  'after a restart Titan resumes its own session with its conversation, and the next message reaches it once',
  async () => {
    const titan = await othrys.titan()
    othrys.claude.plan({
      titan: titan.id,
      text: 'remember the codename',
      reply: 'Noted: Bluebird.',
    })
    const before = await titan.chat({ text: 'remember the codename' })
    await until({
      what: 'the first answer',
      check: () => before.answered === 1,
    })

    await othrys.restart()

    othrys.claude.plan({
      titan: titan.id,
      text: 'what was it?',
      reply: 'Bluebird.',
    })
    const after = await titan.chat({ text: 'what was it?' })
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

    const page = await titan.page()
    const { thread } = await page.send({
      name: 'thread',
      args: ['$titan'],
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
  'worker reports wait for one wake and survive an interrupted turn while note lines stay quiet',
  async () => {
    const titan = await othrys.titan()
    const folder = titan.folder({ name: 'export' })
    await titan.owner({
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
    const turn = othrys.claude.plan({
      titan: titan.id,
      text: 'review the roadmap',
      reply: 'Roadmap reviewed.',
      partial: 'Roadmap',
      hold: true,
    })
    const session = await titan.chat({ text: 'review the roadmap' })
    await titan.owner({
      args: [
        'task',
        'start',
        'export',
      ],
    })
    const worker = await titan.agent({ cwd: folder })
    await until({
      what: 'the worker\'s first turn',
      check: () => worker.answered === 1,
    })

    expect((await titan.as({ session: worker }).refused({
      args: [
        'titan',
        'send',
        '--task',
        'export',
        '--kind',
        'progress',
        '--text',
        'Removed progress writer',
      ],
    })).code).toBe('VALIDATION_ERROR')

    await workerLine({
      titan,
      key: 'export',
      line: 'note: Upload started',
    })
    await titan.as({ session: worker }).run({
      args: [
        'titan',
        'send',
        '--task',
        'export',
        '--text',
        'Export works; ready for review',
      ],
    })
    await workerLine({
      titan,
      key: 'export',
      line: 'note: Quiet latest line',
    })
    await workerLine({
      titan,
      key: 'export',
      line: 'blocked: Need the SFTP password',
    })
    const taskHistory = await titan.owner({
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
      what: 'the report and the status to wait for Titan',
      check: () => {
        const updates = queueBox({ titanId: titan.id })?.waiting

        const processed = updates?.some(update => update.seq === statusEvent.seq)

        return processed && updates.map(update => update.kind)
      },
    })
    expect(waiting.filter(kind => kind === 'declared')).toHaveLength(1)
    expect(waiting).toContain('report')
    expect(waiting).not.toContain('progress')
    expect(session.received).toHaveLength(1)

    othrys.claude.plan({
      titan: titan.id,
      match: ({ text }) => text.includes('Export works; ready for review'),
      hold: true,
    })
    turn.release()
    await until({
      what: 'Titan to read the report wake',
      check: () => session.received.length === 2 && queue({ titanId: titan.id })?.working === true,
    })
    const wake = session.received[1]!
    expect(wake.split('Export works; ready for review')).toHaveLength(2)
    expect(wake).not.toContain('Upload started')
    expect(wake).not.toContain('Quiet latest line')
    expect(wake).toContain('Need the SFTP password')
    const blockedId = wake.match(/record ("[^"\n]+") \S+ \[unhandled\]: blocked: Need the SFTP password/)?.[1]
    expect(blockedId).toBeDefined()
    const task = await titan.task({ key: 'export' })
    const root = join(
      process.env.OTHRYS_HOME!,
      'titans',
      titan.id,
    )
    const facts = [
      join(
        root,
        'titan.log',
      ),
      join(
        root,
        'tasks',
        task.id,
        'task.log',
      ),
    ]
      .flatMap(path => readFileSync(
        path,
        'utf8',
      ).trimEnd()
        .split('\n')
        .map(line => JSON.parse(line)))
    const blocked = facts.find(fact => fact.id === JSON.parse(blockedId!))
    expect(blocked?.event?.data).toMatchObject({
      code: 'blocked',
      text: 'Need the SFTP password',
    })
    await titan.owner({
      args: [
        'titan',
        'stop',
      ],
    })
    await until({
      what: 'the interrupted report turn to stop',
      check: () => queue({ titanId: titan.id })?.working === false,
    })
    await titan.chat({ text: 'Review the interrupted worker reports' })
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
      check: () => queue({ titanId: titan.id })?.working === false,
    })
    await titan.chat({ text: 'Continue after reading the worker reports' })
    const following = session.received.find(text => text.endsWith('Continue after reading the worker reports'))!
    expect(following).not.toContain('[unhandled]: Export works; ready for review')
  },
)

test(
  'a worker report Titan handled before a restart neither wakes it again nor comes back as unhandled',
  async () => {
    const titan = await othrys.titan()
    const folder = titan.folder({ name: 'ledger' })
    await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Close the ledger',
        '--key',
        'ledger',
        '--folder',
        folder,
      ],
    })
    othrys.claude.plan({
      titan: titan.id,
      text: 'watch the ledger',
      reply: 'Watching.',
    })
    const session = await titan.chat({ text: 'watch the ledger' })
    await titan.owner({
      args: [
        'task',
        'start',
        'ledger',
      ],
    })
    const worker = await titan.agent({ cwd: folder })
    await until({
      what: 'the worker\'s first turn',
      check: () => worker.answered === 1,
    })
    othrys.claude.plan({
      titan: titan.id,
      match: ({ text }) => text.includes('Ledger closed'),
      reply: 'Ledger noted.',
    })
    await workerLine({
      titan,
      key: 'ledger',
      line: 'done: Ledger closed',
    })
    await until({
      what: 'Titan to finish the report wake',
      check: () => session.received.some(text => text.includes('Ledger closed'))
        && queue({ titanId: titan.id })?.working === false
        && !queueBox({ titanId: titan.id })?.waiting.length,
    })

    await othrys.restart()

    othrys.claude.plan({
      titan: titan.id,
      text: 'anything new?',
      reply: 'Nothing new.',
    })
    const after = await titan.chat({ text: 'anything new?' })
    await until({
      what: 'Titan to answer after the restart',
      check: () => after.answered >= 1,
    })
    await until({
      what: 'Titan to settle after the restart',
      check: () => queue({ titanId: titan.id })?.working === false,
    })
    expect(queueBox({ titanId: titan.id })?.waiting).toEqual([])
    expect(after.received.join('\n')).not.toMatch(/<othrys-wake>|\[unhandled\]/)
  },
)

test(
  '300 queued worker reports stay bounded, preserve owner messages and remain readable in files after interruption',
  async () => {
    const titan = await othrys.titan()
    const reportIds = ({ text }: { text: string }) => [...text.matchAll(/^- record ("[^"\n]+").*\[unhandled\]/gm)]
      .map(match => JSON.parse(match[1]!))
    const turn = othrys.claude.plan({
      titan: titan.id,
      text: 'Hold the report burst',
      hold: true,
    })
    const session = await titan.chat({ text: 'Hold the report burst' })
    const page = await titan.page()
    const wakeTurn = othrys.claude.plan({
      titan: titan.id,
      match: ({ text }) => text.includes('Why you are woken') && text.includes('more worker reports'),
      hold: true,
    })
    const replacementTurn = othrys.claude.plan({
      titan: titan.id,
      text: 'Resume after the interrupted read',
      hold: true,
    })
    const overflowTurn = othrys.claude.plan({
      titan: titan.id,
      text: 'Read the remaining reports',
      hold: true,
    })

    try {
      for (let index = 0; index < 300; index++) {
        const body = index === 0 ? '<'.repeat(500) : 'Long report body '.repeat(100)

        await page.send({
          name: 'titan',
          args: [
            'send',
            '--actor',
            `worker:burst-${index}`,
            '--text',
            `Report ${index}: ${body}`,
          ],
        })
      }

      await titan.owner({
        args: [
          'task',
          'create',
          '--title',
          'Export format',
          '--key',
          'budget-decision',
        ],
      })
      const decisionTask = await titan.task({ key: 'budget-decision' })
      await titan.as({ session }).run({
        args: [
          'task',
          'ask',
          'budget-decision',
          '--to',
          'owner',
          '--question',
          'Which export format?',
          '--context',
          `The format determines the export implementation. [Export format](othrys-task:${decisionTask.id})`,
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
        titanId: titan.id,
        fn: ({ writer }) => {
          const decision = titanEvent({
            state: writer.state,
            meta: {
              actor: 'othrys',
              at: new Date().toISOString(),
            },
            cardId: TITAN_CARD,
            change: {
              type: 'titan.review',
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
        check: () => queueBox({ titanId: titan.id })?.waiting.some(update => update.kind === 'timed review'),
      })
      await titan.owner({
        args: [
          'titan',
          'send',
          '--text',
          'Keep the owner message intact under the report cap',
        ],
      })
      turn.release()
      await until({
        what: 'owner and bounded wake delivered',
        check: () => session.received.some(text => text.includes('Why you are woken') && text.includes('more worker reports'))
          && queue({ titanId: titan.id })?.working === true,
      })
      expect(session.received.some(text => text.endsWith('Keep the owner message intact under the report cap'))).toBe(true)
      const wake = session.received.find(text => text.includes('Why you are woken') && text.includes('more worker reports'))!
      expect(wake).toContain('- report: from worker:burst-0,')
      expect(wake).not.toContain('- report: from worker:burst-299,')
      const updates = wake.replace(
        /<othrys-digest[\s\S]*?<\/othrys-digest>\s*/,
        '',
      )
      expect(updates.length).toBeLessThan(12_000)
      expect(wake).not.toContain('Long report body '.repeat(30))
      expect(wake).toContain('Which export format?')

      expect(wake).toContain('titan.log')
      expect(wake).toContain('task.log')
      const path = join(
        process.env.OTHRYS_HOME!,
        'titans',
        titan.id,
        'titan.log',
      )
      const facts = readFileSync(
        path,
        'utf8',
      ).trimEnd()
        .split('\n')
        .map(line => JSON.parse(line))
      const reports = facts.filter(fact => fact.event?.type === 'titan.message' && /^worker:burst-/.test(fact.event.actor))
      const pendingLine = wake.split('\n').find(line => line.startsWith('Pending reports: '))
      const pending: {
        id: string
        file: string
        status: string
      }[] = JSON.parse(pendingLine?.slice('Pending reports: '.length) ?? '[]')
      const reportIdsInTitanLog = new Set(reports.map(report => report.id))
      const advertised = pending.filter(report => reportIdsInTitanLog.has(report.id))
      expect(advertised.length).toBeGreaterThan(0)
      expect(advertised.every(report => report.file === 'titan.log' && report.status === 'unhandled')).toBe(true)
      expect(reports.map(fact => fact.event.data.text)).toEqual(Array.from(
        { length: 300 },
        (
          _,
          index,
        ) =>
          `Report ${index}: ${index === 0 ? '<'.repeat(500) : 'Long report body '.repeat(100)}`,
      ))
      const timedReview = facts.find(fact => fact.event?.type === 'titan.review'
        && fact.event.data.block.includes('End of timed review evidence'))
      expect(timedReview).toBeDefined()
      expect(wake).toContain(JSON.stringify(timedReview.id))
      await titan.owner({
        args: [
          'titan',
          'stop',
        ],
      })
      await until({
        what: 'the interrupted report turn to stop',
        check: () => queue({ titanId: titan.id })?.working === false,
      })
      await titan.chat({ text: 'Resume after the interrupted read' })
      await until({
        what: 'the replacement turn to receive pending reports',
        check: () => session.received.some(text => text.endsWith('Resume after the interrupted read')),
      })
      const recovered = session.received.find(text => text.endsWith('Resume after the interrupted read'))!
      const interrupted = reportIds({ text: wake })
      const presented = reportIds({ text: recovered })
      expect(interrupted.length).toBeGreaterThan(0)
      expect(presented).toEqual(expect.arrayContaining(interrupted))
      replacementTurn.release()
      await until({
        what: 'the replacement report turn to finish',
        check: () => queue({ titanId: titan.id })?.working === false,
      })
      const submitted = reports.map(report => report.id)
      const wakeIndex = session.received.indexOf(wake)
      const earlier = session.received.slice(
        0,
        wakeIndex,
      ).flatMap(text => reportIds({ text }))
      expect(presented.every(id => !earlier.includes(id))).toBe(true)
      const delivered: string[] = [
        ...earlier,
        ...presented,
      ]
      let remaining = submitted.filter(id => !delivered.includes(id))
      expect(remaining.length).toBeGreaterThan(0)

      for (let pass = 0; pass < 300 && remaining.length; pass++) {
        const text = pass === 0 ? 'Read the remaining reports' : `Continue reading remaining reports ${pass}`
        await titan.chat({ text })
        const next = session.received.find(message => message.endsWith(text))!
        const nextIds = reportIds({ text: next })
        expect(nextIds.length).toBeGreaterThan(0)
        expect(nextIds.every(id => remaining.includes(id))).toBe(true)
        delivered.push(...nextIds)
        remaining = remaining.filter(id => !nextIds.includes(id))
        overflowTurn.release()
        await until({
          what: 'the bounded report turn to finish',
          check: () => queue({ titanId: titan.id })?.working === false,
        })
      }

      expect(delivered.sort()).toEqual(submitted.sort())
      expect(remaining).toEqual([])
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
    const titan = await othrys.titan()
    const first = othrys.claude.plan({
      titan: titan.id,
      text: 'Hold reservation setup',
      hold: true,
    })
    const main = await titan.chat({ text: 'Hold reservation setup' })
    const reserved = await titan.startTask({ key: 'reserved-report' })
    await titan.startTask({ key: 'available-report' })
    const reservedTask = await titan.task({ key: 'reserved-report' })
    const availableTask = await titan.task({ key: 'available-report' })
    await titan.as({ session: reserved.worker }).run({
      args: [
        'titan',
        'send',
        '--task',
        reservedTask.id,
        '--text',
        'Reserved owner-turn report',
      ],
    })
    await titan.owner({
      args: [
        'titan',
        'stop',
      ],
    })
    first.release()
    const ownerTurn = othrys.claude.plan({
      titan: titan.id,
      text: 'Review reserved owner report',
      hold: true,
    })
    const helperTurn = othrys.claude.plan({
      titan: titan.id,
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
      await titan.chat({ text: 'Review reserved owner report' })
      await until({
        what: 'main to read the owner-turn report',
        check: () => main.received.some(text => text.includes('Reserved owner-turn report')),
      })
      await titan.owner({
        args: [
          'titan',
          'set',
          '--helper',
          'auto',
        ],
      })
      await workerLine({
        titan,
        key: 'available-report',
        line: 'blocked: Available helper report',
      })
      const granted = await until({
        what: 'helper to take available work',
        check: () => {
          const helper = loadTitan({ titanId: titan.id }).state.helper

          return Object.values(helper?.runs ?? {}).at(-1)?.tasks
        },
      })
      expect(granted).toEqual([availableTask.id])
      const helperSession = await until({
        what: 'the helper to receive its bounded file grant',
        check: () => othrys.claude.sessions.find(session => session.env.OTHRYS_TITAN === titan.id
          && session.env.OTHRYS_ACTOR?.startsWith('helper:') && session.received.length > 0),
      })
      expect(helperSession.received.at(-1)).toContain('Only handle the granted tasks and selected updates')
      const pendingReports = JSON.parse(helperSession.received.at(-1)!.match(/Pending reports: ([^\n]+)/)![1]!)
      expect(pendingReports.length).toBeGreaterThan(0)
      const withinGrant = pendingReports.every(
        ({ file }: { file: string }) => file.includes(availableTask.id),
      )
      expect(withinGrant).toBe(true)
      const root = join(
        process.env.OTHRYS_HOME!,
        'titans',
        titan.id,
      )

      for (const path of [
        join(
          root,
          'titan.log',
        ),
        join(
          root,
          'tasks',
          availableTask.id,
          'task.log',
        ),
        join(
          root,
          'tasks',
          availableTask.id,
          'worker.log',
        ),
      ]) {
        const command = `cat -- '${path}'`
        expect(helperSession.received.at(-1)).toContain(command)
        expect(await helperSession.useTool!({
          tool: 'Bash',
          input: { command },
        }))
          .toMatchObject({ behavior: 'allow' })
        expect(await helperSession.useTool!({
          tool: 'Bash',
          input: { command: command + ' > /tmp/untrusted' },
        }))
          .toMatchObject({ behavior: 'deny' })
      }

      expect(await helperSession.useTool!({
        tool: 'Bash',
        input: {
          command: `cat -- '${join(
            root,
            'tasks',
            reservedTask.id,
            'task.log',
          )}'`,
        },
      })).toMatchObject({ behavior: 'deny' })
      expect(await helperSession.useTool!({
        tool: 'Bash',
        input: { command: "cat -- '/etc/passwd'" },
      }))
        .toMatchObject({ behavior: 'deny' })
    } finally {
      await titan.owner({
        args: [
          'titan',
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
  'Titan relays a worker $code result ($format) from the helper into the owner\'s main chat',
  async ({
    code,
    outcome,
    report,
    result,
    link,
  }) => {
    const titan = await othrys.titan()
    await titan.owner({
      args: [
        'titan',
        'set',
        '--helper',
        'auto',
      ],
    })
    const main = await titan.chat({ text: 'Check whether the shop is used and has production errors' })
    await until({
      what: 'Titan to accept the investigation',
      check: () => main.answered === 1,
    })
    const folder = titan.folder({ name: 'shop' })
    const asTitan = titan.as({ session: main })
    await asTitan.run({
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
    const { id } = await titan.task({ key: 'shop' })
    const workerReport = `${code}: ${report} ${link}`
    const summary = `${result} ${link}`
    const helperTurn = othrys.claude.plan({
      titan: titan.id,
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
    await asTitan.run({
      args: [
        'task',
        'start',
        'shop',
      ],
    })
    await titan.agent({ cwd: folder })
    await workerLine({
      titan,
      key: 'shop',
      line: workerReport,
    })
    await until({
      what: 'the helper to read the worker result',
      check: () => othrys.claude.sessions.some(session => session.env.OTHRYS_TITAN === titan.id
        && session.env.OTHRYS_ACTOR?.startsWith('helper:')
        && session.received.some(text => text.includes(workerReport))),
    })
    othrys.claude.plan({
      titan: titan.id,
      match: ({ text }) => text.includes(summary),
      reply: summary,
    })
    helperTurn.release()
    await until({
      what: 'Titan to relay the helper outcome',
      check: () => main.received.some(text => text.includes(summary))
        && queue({ titanId: titan.id })?.working === false,
    })
    const page = await titan.page()

    try {
      const { thread } = await page.send({
        name: 'thread',
        args: ['$titan'],
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
      const messages = await titan.owner({
        args: [
          'titan',
          'messages',
          '--limit',
          '100',
        ],
      })
      expect(messages.messages).not.toContainEqual(expect.objectContaining({
        actor: 'othrys',
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
    const titan = await othrys.titan()
    await titan.owner({
      args: [
        'titan',
        'set',
        '--helper',
        'auto',
      ],
    })
    // Updates wake only a Titan that Othrys runs.
    const main = await titan.chat({ text: 'Watch the invoices' })
    await until({
      what: 'Titan\'s first turn',
      check: () => main.answered === 1,
    })
    const folder = titan.folder({ name: 'invoices' })
    await titan.owner({
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
    const { id } = await titan.task({ key: 'invoices' })
    // Planned before the worker starts: when its first turn ends, the helper batch gets this held reply and keeps the task leased until release().
    const helperTurn = othrys.claude.plan({
      titan: titan.id,
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
    await titan.owner({
      args: [
        'task',
        'start',
        'invoices',
      ],
    })
    await titan.agent({ cwd: folder })
    await workerLine({
      titan,
      key: 'invoices',
      line: 'blocked: Retry the export',
    })
    const helper = await until({
      what: 'the routine helper to take the worker\'s update',
      check: () => othrys.claude.sessions.find(session => session.env.OTHRYS_TITAN === titan.id
        && session.env.OTHRYS_ACTOR?.startsWith('helper:') && session.received.length > 0),
    })

    // Othrys harvests the Claude Code version on a transcript record into the card's settings.
    const { sessions } = await titan.owner({
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
    await titan.owner({
      args: [
        'reply',
        'invoices',
        '--text',
        'Retry the export',
      ],
    })
    await until({
      what: 'the transcript\'s version to reach the card while the helper still works',
      check: async () => (await titan.owner({
        args: [
          'task',
          'show',
          'invoices',
          '--full',
        ],
      })).task.settings?.version === '9.9.9',
    })
    expect(helper.answered).toBe(0)
    const mainEdit = await titan.owner({
      args: [
        'task',
        'brief',
        'invoices',
        '--brief',
        'Retry the export without losing its rows',
      ],
    })
    expect(mainEdit.notices).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('leased') }))
    expect((await titan.owner({
      args: [
        'task',
        'show',
        'invoices',
        '--full',
      ],
    })).task.brief).toBe('Retry the export without losing its rows')
    const ungranted = await titan.owner({
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
    const helperEdit = await titan.as({ session: helper }).run({
      args: [
        'task',
        'hold',
        ungranted.card.id,
      ],
    })
    expect(helperEdit.notices).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('default') }))
    expect((await titan.task({ key: ungranted.card.id })).hold).toBeDefined()

    const reportHelperTurn = othrys.claude.plan({
      titan: titan.id,
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
    await titan.owner({
      args: [
        'titan',
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
      check: () => othrys.claude.sessions.some(session => session.env.OTHRYS_ACTOR?.startsWith('helper:')
        && session.received.some(text => text.includes('End of invoice evidence'))),
    })
    await workerLine({
      titan,
      key: 'invoices',
      line: 'note: New invoice progress during the helper lease',
    })
    await titan.chat({ text: 'Check the invoice report while the helper works' })
    await until({
      what: 'main to finish reading the leased report',
      check: () => main.received.some(text => text.includes('Check the invoice report while the helper works'))
        && queue({ titanId: titan.id })?.working === false,
    })
    expect(main.received.find(text => text.includes('Check the invoice report while the helper works')))
      .toContain('latest: New invoice progress during the helper lease')
    reportHelperTurn.release()
    await until({
      what: 'helper to finish the worker report',
      check: () => (loadTitan({ titanId: titan.id }).state.helper?.usage?.batches ?? 0) >= 2,
    })
    expect(main.received).toHaveLength(2)
    const routineMessages = await titan.owner({
      args: [
        'titan',
        'messages',
        '--limit',
        '100',
      ],
    })
    expect(routineMessages.messages).not.toContainEqual(expect.objectContaining({
      actor: 'othrys',
      text: expect.stringContaining('Reran invoice checks.'),
    }))
    const pendingNotes = loadTitan({ titanId: titan.id }).state.contextNotes ?? []
    expect(pendingNotes).toContainEqual(expect.objectContaining({
      text: expect.stringContaining('Invoice checks rerun under existing instructions'),
      handled: true,
    }))
    const scopeTurn = othrys.claude.plan({
      titan: titan.id,
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
    await titan.owner({
      args: [
        'titan',
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
      check: () => othrys.claude.sessions.some(session => session.env.OTHRYS_ACTOR?.startsWith('helper:')
        && session.received.some(text => text.includes('Invoice scope needs a decision'))),
    })

    try {
      await titan.chat({ text: 'Summarize the invoice status' })
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
  'owner messages sent while Titan works survive a restart that cuts its turn: Titan resumes once, is pointed at what it did not answer, and the messages stay in order',
  async () => {
    const titan = await othrys.titan()
    const answered = await titan.chat({ text: 'Check the completed inventory' })
    await until({
      what: 'the inventory reply to finish',
      check: () => answered.answered === 1 && queue({ titanId: titan.id })?.working === false,
    })
    const inventoryAgent = loadTitan({ titanId: titan.id }).state.cards[TITAN_CARD]!.agent
    await titan.owner({
      args: [
        'push',
        '--key',
        TITAN_CARD,
        '--actor',
        'othrys',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent: inventoryAgent,
        activity: 'finished',
        title: 'Inventory checked',
      }),
    })
    othrys.claude.plan({
      titan: titan.id,
      text: 'plan the migration',
      reply: 'Migration planned.',
      partial: 'Migration',
      hold: true,
    })
    await titan.chat({ text: 'plan the migration' })

    for (const text of [
      'also check the indexes',
      'and the backups',
    ]) {
      await titan.owner({
        args: [
          'titan',
          'send',
          '--text',
          text,
        ],
      })
    }

    await titan.owner({
      args: [
        'task',
        'create',
        '--title',
        'Restart report',
        '--key',
        'restart-report',
      ],
    })
    const restartTask = await titan.task({ key: 'restart-report' })
    await titan.owner({
      args: [
        'titan',
        'send',
        '--task',
        restartTask.id,
        '--actor',
        `worker:${restartTask.id}`,
        '--text',
        'Worker report awaiting restart',
      ],
    })

    const withoutCache = structuredClone(loadTitan({ titanId: titan.id }).state)
    const activeSession = withoutCache.sessions![withoutCache.config!.titan.session!]!
    delete activeSession.titanTurn
    const scan = eventLog.scanChanges
    const evicted = vi.spyOn(
      eventLog,
      'scanChanges',
    ).mockImplementation(function* ({ ...selection }) {
      yield* [...scan(selection)].filter(event => event.type !== 'session.observed')
    })
    let recovery: ReturnType<typeof findTitanTurnToResume>

    try {
      recovery = findTitanTurnToResume({
        titanId: titan.id,
        state: withoutCache,
        agent: activeSession.agent,
      })
    } finally {
      evicted.mockRestore()
    }

    const savedMessages = (await titan.owner({
      args: [
        'titan',
        'messages',
      ],
    })).messages
    const inventory = savedMessages.find((message: { text: string }) => message.text === 'Check the completed inventory')!
    expect(inventory.id).toBeTypeOf('string')
    expect(recovery).toBeDefined()
    expect(recovery!.resumeMessage).not.toContain(`Read owner message ${JSON.stringify(inventory.id)}`)

    await othrys.restart()
    const resumed = await until({
      what: 'Titan to resume its session after the restart',
      check: () => othrys.claude.sessions.find(s => s.env.OTHRYS_TITAN === titan.id && s.resumed),
    })
    await until({
      what: 'the resumed Titan to hear of the cut turn',
      check: () => resumed.received.some(text => text.includes('restart cut your last turn')),
    })
    expect(resumed.received.filter(text => text.includes('restart cut your last turn'))).toHaveLength(1)
    await until({
      what: 'the pending worker report to survive restart',
      check: () => resumed.received.some(text => text.includes('Worker report awaiting restart')),
    })

    const recoveredReport = resumed.received.find(text => text.includes('Worker report awaiting restart'))!
    expect(recoveredReport).toMatch(/record "[^"\n]+" \S+ \[unhandled\]: Worker report awaiting restart/)
    expect(recoveredReport).toContain('titan.log')
    expect(recoveredReport).toContain('Open decisions')
    const facts = readFileSync(
      join(
        process.env.OTHRYS_HOME!,
        'titans',
        titan.id,
        'titan.log',
      ),
      'utf8',
    ).trimEnd()
      .split('\n')
      .map(line => JSON.parse(line))
    const recoveredOwnerMessages = Array.from(
      recoveredReport.matchAll(/Read owner message "([^"]+)" in titan.log in full/g),
      match =>
        facts.find(fact => fact.id === match[1])?.event.data.text,
    )

    expect(recoveredOwnerMessages).toEqual([
      'plan the migration',
      'also check the indexes',
      'and the backups',
    ])

    const { messages } = await titan.owner({
      args: [
        'titan',
        'messages',
      ],
    })
    expect(messages.map((message: { text: string }) => message.text)).toEqual([
      'Check the completed inventory',
      'plan the migration',
      'also check the indexes',
      'and the backups',
      'Worker report awaiting restart',
    ])
  },
)

// The skill text under skills/ is what Othrys writes into Titan's folder, so a change to it reaches the agent as written.
test(
  'Titan\'s folder holds the shipped skills as written and every reference its contract links before its first turn, and loses a reference the skills dropped by its next',
  async () => {
    const titan = await othrys.titan()
    const session = await titan.chat({ text: 'hello' })
    const shipped = join(
      import.meta.dirname,
      '..',
      'skills',
    )

    for (const skill of TITAN_SKILLS) {
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

    await titan.chat({ text: 'hello again' })

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
    const titan = await othrys.titan()
    const { worker } = await titan.startTask({ key: 'compactable' })
    const { id } = await titan.task({ key: 'compactable' })
    othrys.claude.plan({
      titan: titan.id,
      text: '/compact',
      compacting: true,
      hold: true,
    })
    await titan.owner({
      args: [
        'reply',
        'compactable',
        '--text',
        '/compact',
      ],
    })
    const held = await titan.owner({
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
      check: () => (loadTitan({
        titanId: titan.id,
      }).state.cards[id]).compaction?.inputs.some(input => input.id === held.reply.reply),
    })
    expect(heard()).toBe(0)

    const page = await titan.page()
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

// A message of the owner's as the page shows it in Titan's chat.
const chatEntry = async ({
  titan,
  text,
}: {
  titan: Titan
  text: string
}) => {
  const page = await titan.page()
  const { thread } = await page.send({
    name: 'thread',
    args: ['$titan'],
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
  'Stop cancels the message Titan had not taken as not delivered, and the same text sent again reaches Titan once',
  async () => {
    const titan = await othrys.titan()
    othrys.claude.plan({
      titan: titan.id,
      text: '/compact',
      compacting: true,
      hold: true,
    })
    const session = await titan.chat({ text: '/compact' })
    await titan.owner({
      args: [
        'titan',
        'send',
        '--text',
        'also list the risks',
      ],
    })
    await titan.owner({
      args: [
        'titan',
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
        titan,
        text: 'also list the risks',
      }))?.receipt === 'failed',
    })
    expect(await chatEntry({
      titan,
      text: 'also list the risks',
    })).toMatchObject({ waiting: 'stopped' })
    expect(heard({
      received: session.received,
      text: 'also list the risks',
    })).toBe(0)

    await titan.owner({
      args: [
        'titan',
        'send',
        '--text',
        'also list the risks',
      ],
    })
    await until({
      what: 'the message sent again to reach Titan',
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
    const titan = await othrys.titan()
    othrys.claude.plan({
      titan: titan.id,
      text: '/compact',
      compacting: true,
      hold: true,
    })
    const session = await titan.chat({ text: '/compact' })
    await titan.owner({
      args: [
        'titan',
        'send',
        '--text',
        '/inscribe',
      ],
    })
    await titan.owner({
      args: [
        'titan',
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
    othrys.claude.plan({
      titan: titan.id,
      text: '/inscribe',
      reply: 'inscribed',
    })
    await titan.owner({
      args: [
        'titan',
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
    const page = await titan.page()
    const latest = await page.send({
      name: 'thread',
      args: ['$titan'],
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
          '$titan',
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
  'Stop leaves the message Titan had already taken as received, even though its confirmation arrives after Stop',
  async () => {
    const titan = await othrys.titan()
    othrys.claude.plan({
      titan: titan.id,
      text: 'check the build',
      partial: 'Checking',
      hold: true,
      folds: true,
    })
    const session = await titan.chat({ text: 'check the build' })
    await titan.owner({
      args: [
        'titan',
        'send',
        '--text',
        'and the lint run',
      ],
    })
    await until({
      what: 'Titan to take the message into its turn',
      check: () => heard({
        received: session.received,
        text: 'and the lint run',
      }) === 1,
    })
    await titan.owner({
      args: [
        'titan',
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
        titan,
        text: 'and the lint run',
      }))?.receipt === 'delivered',
    })
  },
)

test(
  'Remove cancels one message held behind a compaction, Stop on it cancels the rest and leaves Titan waiting for the owner instead of waking it with a recap',
  async () => {
    const titan = await othrys.titan()
    othrys.claude.plan({
      titan: titan.id,
      text: 'warm up',
      reply: 'Ready.',
    })
    const session = await titan.chat({ text: 'warm up' })
    await until({
      what: 'the warm-up answer',
      check: () => session.answered === 1,
    })
    othrys.claude.plan({
      titan: titan.id,
      text: '/compact',
      compacting: true,
      hold: true,
    })
    await titan.owner({
      args: [
        'titan',
        'send',
        '--text',
        '/compact',
      ],
    })
    await until({
      what: 'the compaction to run',
      check: () => session.received.includes('/compact'),
    })
    await titan.owner({
      args: [
        'titan',
        'send',
        '--text',
        'held behind the compaction',
      ],
    })
    const removed = await titan.owner({
      args: [
        'titan',
        'send',
        '--text',
        'removed from the queue',
      ],
    })
    await until({
      what: 'both messages to wait behind the compaction',
      check: () => queue({ titanId: titan.id })?.compactInputs.length === 2,
    })
    const page = await titan.page()
    expect(await page.send({
      name: 'titan',
      args: [
        'cancel',
        removed.message,
      ],
    })).toMatchObject({ cancelled: removed.message })
    page.close()
    await until({
      what: 'the queued messages to leave out the removed one',
      check: () => queue({ titanId: titan.id })?.compactInputs.map(input => input.text)
        .join() === 'held behind the compaction',
    })
    expect((await chatEntry({
      titan,
      text: 'removed from the queue',
    }))?.receipt).toBe('failed')
    expect((await titan.owner({
      args: [
        'titan',
        'stop',
      ],
    })).stopped).toBe('compaction')
    await until({
      what: 'the held message to read as stopped',
      check: async () => (await chatEntry({
        titan,
        text: 'held behind the compaction',
      }))?.receipt === 'failed',
    })

    othrys.claude.plan({
      titan: titan.id,
      text: 'carry on',
      reply: 'Carrying on.',
    })
    await titan.owner({
      args: [
        'titan',
        'send',
        '--text',
        'carry on',
      ],
    })
    await until({
      what: 'Titan to answer the owner\'s next message',
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

// The texts Titan's own compaction holds as its inputs, as its card saves them.
const compactionInputs = ({ titanId }: { titanId: string }) => (loadTitan({
  titanId,
}).state.cards['$titan']).compaction?.inputs.map(input => input.text)

test(
  'a message removed from the queue never reaches Titan once its compaction ends, whether the compaction held it as its input or behind its stop, and the kept ones reach it once',
  async () => {
    const titan = await othrys.titan()
    const send = ({ text }: { text: string }) => titan.owner({
      args: [
        'titan',
        'send',
        '--text',
        text,
      ],
    })
    const cancel = ({ id }: { id: string }) => titan.owner({
      args: [
        'titan',
        'cancel',
        id,
      ],
    })
    const queued = () => queue({ titanId: titan.id })?.compactInputs.map(input => input.text).join()
    const working = othrys.claude.plan({
      titan: titan.id,
      text: 'long task',
      reply: 'Done.',
      partial: 'Working',
      hold: true,
    })
    const session = await titan.chat({ text: 'long task' })
    const first = othrys.claude.plan({
      titan: titan.id,
      text: '/compact',
      compacting: true,
      hold: true,
    })
    // Sent while Titan works, these reach its session before the compaction starts, which then holds them as its inputs.
    await send({ text: '/compact' })
    const removedInput = await send({ text: 'removed input' })
    await send({ text: 'kept input' })
    working.release()
    await until({
      what: 'the compaction to hold both messages as its inputs',
      check: () => compactionInputs({ titanId: titan.id })?.length === 2,
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
      what: 'Titan to hear the kept input',
      check: () => heard({
        received: session.received,
        text: 'kept input',
      }) === 1,
    })

    const second = othrys.claude.plan({
      titan: titan.id,
      text: '/compact',
      compacting: true,
      hold: true,
    })
    // Sent once the compaction runs, these wait behind its stop and reach Titan in its recap.
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

type Page = Awaited<ReturnType<Titan['page']>>

// The agent Titan last ran with, as the page's Last used mark reads it.
const lastRan = ({ titanId }: { titanId: string }) => (loadTitan({ titanId }).state.titanAgent)

// Claude's catalog runs "opus" at "high" effort when Titan names neither.
const chooseAgent = async ({
  page,
  agent,
}: {
  page: Page
  agent: Record<string, string>
}) => {
  expect((await page.send({
    name: 'titan-agent',
    args: [
      JSON.stringify({
        harness: 'claude',
        ...agent,
      }),
    ],
  })).type).toBe('receipt')
}

const sendToTitan = ({
  titan,
  text,
}: {
  titan: Titan
  text: string
}) => titan.owner({
  args: [
    'titan',
    'send',
    '--text',
    text,
  ],
})

test(
  'choosing the model and effort Titan already runs with keeps its session, and a changed effort applies to the next messages in order',
  async () => {
    const titan = await othrys.titan()
    const page = await titan.page()
    const session = await titan.chat({ text: 'first message' })

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
    await titan.owner({
      args: [
        'titan',
        'send',
        '--text',
        'unchanged agent',
      ],
    })
    await until({
      what: 'Titan to hear the message sent with its agent chosen again',
      check: () => heard({
        received: session.received,
        text: 'unchanged agent',
      }) === 1,
    })
    await chooseAgent({
      page,
      agent: { effort: 'low' },
    })
    await sendToTitan({
      titan,
      text: 'first after the change',
    })
    await sendToTitan({
      titan,
      text: 'second after the change',
    })
    const received = () => othrys.claude.sessions.filter(s => s.env.OTHRYS_TITAN === titan.id)
      .flatMap(s => s.received.map(message => message.split('\n').at(-1)))
    await until({
      what: 'Titan to hear both messages sent after the effort change',
      check: () => received().includes('second after the change'),
    })
    expect(received()).toEqual([
      'first message',
      'unchanged agent',
      'first after the change',
      'second after the change',
    ])
    expect(lastRan({ titanId: titan.id })).toMatchObject({ effort: 'low' })
    page.close()
  },
)

test(
  'a queued operation recap waits for a later operation and keeps the first stop boundary',
  async () => {
    const titan = await othrys.titan()
    let now = Date.now()
    const firstSince = new Date(now).toISOString()
    const recaps: {
      id: string
      text: string
    }[] = []
    const operations = createTitanOperations({
      titanId: titan.id,
      queuedTitan: new Set(),
      at: () => new Date(now).toISOString(),
      note: ({ fn }) => withWriter({
        titanId: titan.id,
        fn,
      }),
      armWake: () => {},
      host: () => ({
        titan: async ({
          id,
          text,
        }) => {
          recaps.push({
            id,
            text,
          })

          return { state: 'queued' }
        },
      }),
    })
    await operations.startOperation({
      id: 'first-review-operation',
      kind: 'compaction',
    })
    operations.endOperation({
      id: 'first-review-operation',
      error: 'first operation failed',
    })
    await until({
      what: 'the first recap to enter the turn queue',
      check: () => recaps.length === 1,
    })
    now += 1
    await operations.startOperation({
      id: 'second-review-operation',
      kind: 'compaction',
    })
    expect(operations.stoppedFor({ id: recaps[0]!.id })).toBe(true)
    operations.endOperation({
      id: 'second-review-operation',
      error: 'second operation failed',
    })
    await until({
      what: 'the final recap to enter the turn queue',
      check: () => recaps.length === 2,
    })
    expect(recaps[1]!.text).toContain(`waited from ${firstSince}`)
    expect(operations.stoppedFor({ id: recaps[0]!.id })).toBe(true)
    expect(operations.stoppedFor({ id: recaps[1]!.id })).toBe(false)
  },
)

test(
  'timed reviews wake for changed work and include overdue task and Titan questions',
  async () => {
    const titan = await othrys.titan()
    const previous = (await titan.owner({
      args: [
        'settings',
        'show',
      ],
    })).settings.reviewMinutes
    await titan.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"reviewMinutes":1}',
      ],
    })
    await titan.owner({
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
    await titan.owner({
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
    const task = await titan.task({ key: 'heartbeat-worker' })
    await workerLine({
      titan,
      key: 'heartbeat-worker',
      line: 'note: Worker started preparing the change',
    })
    expect((await titan.task({ key: 'heartbeat-worker' })).status).toBe('running')
    let now = Date.now()
    let wakes = 0
    const timer = startReviewTimer({
      titanId: titan.id,
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
      const review = await titan.owner({
        args: [
          'history',
          '--kind',
          'titan.review',
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
        titanId: titan.id,
        fn: ({ writer }) => {
          writer.append({
            event: {
              v: writer.state.v,
              seq: writer.state.seq + 1,
              id: 'heartbeat-green-pr',
              cardId: task.id,
              actor: 'othrys',
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
      const green = await titan.owner({
        args: [
          'history',
          '--kind',
          'titan.review',
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
      await titan.owner({
        args: [
          'task',
          'ask',
          'heartbeat-worker',
          '--to',
          'owner',
          '--question',
          'Which account?',
          '--context',
          `An account choice is needed. [Heartbeat](othrys-task:${task.id})`,
          '--choice',
          'Personal',
          '--choice',
          'Team',
          '--recommend',
          '1',
          '--actor',
          'titan',
        ],
      })
      now += 4 * 60 * 60_000
      const overdue = titanReview({
        state: loadTitan({ titanId: titan.id }).state,
        now,
      })
      expect(overdue.flags).toContainEqual(expect.objectContaining({
        kind: 'question reminder',
        task: task.id,
      }))
      expect(overdue.block).toContain('Which account?')
      const remindedAt = new Date(now).toISOString()
      expect(await fireReminders({
        titanId: titan.id,
        at: remindedAt,
      })).toBe(1)
      const reminders = loadTitan({ titanId: titan.id }).state.titanMessages
        ?.filter(message => message.at === remindedAt && message.reminderQuestions?.length)
      expect(reminders).toHaveLength(1)
      expect(reminders?.[0]?.text).toContain('1 question waiting on you')
      await withWriter({
        titanId: titan.id,
        fn: ({ writer }) => {
          writer.append({
            event: {
              v: writer.state.v,
              seq: writer.state.seq + 1,
              id: 'heartbeat-titan-question',
              cardId: TITAN_CARD,
              actor: 'titan',
              at: new Date(now).toISOString(),
              type: 'task.asked',
              data: {
                id: 'titan-account',
                audience: 'owner',
                question: 'Can Titan use the team account?',
              },
            },
          })
        },
      })
      now += 4 * 60 * 60_000
      const ownQuestion = titanReview({
        state: loadTitan({ titanId: titan.id }).state,
        now,
      })
      expect(ownQuestion.flags).toContainEqual(expect.objectContaining({
        kind: 'question reminder',
        task: TITAN_CARD,
      }))
      expect(ownQuestion.block).toContain('Can Titan use the team account?')
    } finally {
      timer.close()
      await titan.owner({
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
  'each Titan turn receives changed task cards with worker links and skips unchanged cards ($harness)',
  async ({ harness }) => {
    const titan = await othrys.titan()
    const page = await titan.page()
    await chooseAgent({
      page,
      agent: { harness },
    })
    const { worker: reviewWorker } = await titan.startTask({ key: 'review-page' })
    await titan.startTask({ key: 'unchanged-card' })

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

    const session = await titan.chat({ text: 'Read the initial cards' })
    expect(session.received[0]).toContain('Snapshot card 40')
    await until({
      what: 'the initial turn to finish',
      check: () => !queue({ titanId: titan.id })?.working,
    })
    await workerLine({
      titan,
      key: 'review-page',
      line: 'link: https://example.com/lavish Design review',
    })
    await workerLine({
      titan,
      key: 'review-page',
      line: 'link: https://example.com/preview App preview',
    })
    await titan.owner({
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
      check: async () => (await titan.task({ key: 'review-page' })).status === 'idle',
    })
    await workerLine({
      titan,
      key: 'review-page',
      line: 'note: Review page is in progress',
    })
    await workerLine({
      titan,
      key: 'review-page',
      line: 'note: Review page is ready',
    })
    await titan.chat({ text: 'Read the changed cards' })
    const changed = session.received.find(text => text.endsWith('Read the changed cards'))!
    const digest = changed.slice(
      0,
      changed.indexOf('</othrys-digest>'),
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
      check: () => !queue({ titanId: titan.id })?.working,
    })
    await titan.chat({ text: 'Read the unchanged cards' })
    const unchanged = session.received.find(text => text.endsWith('Read the unchanged cards'))!
    const nextDigest = unchanged.slice(
      0,
      unchanged.indexOf('</othrys-digest>'),
    )
    expect(nextDigest).not.toContain('Review page is ready')
    expect(nextDigest).not.toContain('Use the blue layout on the review page')
    expect(nextDigest).not.toContain('https://example.com/lavish')
    expect(nextDigest).not.toContain('more changed cards')
    expect(nextDigest).toContain('Open cards: 2 idle, 41 not started, no reason given')
    await until({
      what: 'the unchanged turn to finish',
      check: () => !queue({ titanId: titan.id })?.working,
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

    await titan.owner({
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
    const overflowCard = await titan.task({ key: 'new-overflow-card' })
    await titan.chat({ text: 'Read the capped changes' })
    const capped = session.received.find(text => text.endsWith('Read the capped changes'))!
    expect(capped).toContain('2 more changed cards')
    expect(capped).toContain('task.log')
    expect(capped).toContain('Changed snapshot card 39')
    expect(capped).not.toContain('Changed snapshot card 40')
    await until({
      what: 'the capped turn to finish',
      check: () => !queue({ titanId: titan.id })?.working,
    })
    await titan.owner({
      args: [
        'task',
        'hide',
        'new-overflow-card',
      ],
    })
    await titan.chat({ text: 'Read the remaining change' })
    const remainder = session.received.find(text => text.endsWith('Read the remaining change'))!
    expect(remainder).toContain('Changed snapshot card 40')
    expect(remainder).not.toContain('Changed snapshot card 39')
    expect(remainder).toContain(`${overflowCard.id} is no longer listed`)
    await until({
      what: 'the remaining-change turn to finish',
      check: () => !queue({ titanId: titan.id })?.working,
    })
    await workerLine({
      titan,
      key: 'review-page',
      line: 'link: https://example.com/active-review Active review',
    })
    await titan.chat({ text: 'Read the first review update' })
    const firstUpdate = session.received.find(text => text.endsWith('Read the first review update'))!
    expect(firstUpdate).toContain('https://example.com/active-review')
    await until({
      what: 'the first review update turn to finish',
      check: () => !queue({ titanId: titan.id })?.working,
    })

    await workerLine({
      titan,
      key: 'review-page',
      line: 'link: https://example.com/second-review Second review',
    })
    await workerLine({
      titan,
      key: 'review-page',
      line: 'note: Review page was updated after the first turn',
    })
    await titan.chat({ text: 'Read the second review update' })
    const secondUpdate = session.received.find(text => text.endsWith('Read the second review update'))!
    expect(secondUpdate).toContain('https://example.com/second-review')
    expect(secondUpdate).toContain('Review page was updated after the first turn')
    await until({
      what: 'the second review update turn to finish',
      check: () => !queue({ titanId: titan.id })?.working,
    })

    const provider = harness === 'claude' ? othrys.claude : othrys.codex
    provider.plan({
      titan: titan.id,
      text: 'Compact task context',
      compacting: true,
      compactTo: 500,
    })
    const answers = session.answered
    const previousCompactions = new Set(queue({ titanId: titan.id })?.compactOperations
      .map(operation => operation.id))
    await titan.chat({ text: 'Compact task context' })
    await until({
      what: 'the compacted turn to finish',
      check: () => {
        const current = queue({ titanId: titan.id })
        const completed = current?.compactOperations.some(operation =>
          !previousCompactions.has(operation.id) && operation.state === 'done')

        return session.answered > answers && completed && !current?.working
          && current?.holding === false
      },
    })
    await titan.chat({ text: 'Read the full snapshot after compaction' })
    const afterCompact = session.received.find(text => text.endsWith('Read the full snapshot after compaction'))!
    const snapshot = harness === 'claude' ? session.contexts?.at(-1) : afterCompact
    expect(snapshot).toContain('Task cards (all open cards):')
    expect(snapshot).toContain('Changed snapshot card 0')
    expect(snapshot).toContain('Changed snapshot card 40')
    expect(snapshot).toContain('https://example.com/lavish')
    expect(snapshot).toContain('https://example.com/active-review')
    await until({
      what: 'the post-compaction turn to finish',
      check: () => !queue({ titanId: titan.id })?.working,
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

    await titan.chat({ text: 'Read the hidden-card changes' })
    const hidden = session.received.find(text => text.endsWith('Read the hidden-card changes'))!
    expect(hidden.match(/is no longer listed/g)).toHaveLength(40)
    expect(hidden).toContain('1 more changed cards')
    await until({
      what: 'the hidden-card turn to finish',
      check: () => !queue({ titanId: titan.id })?.working,
    })
    await titan.chat({ text: 'Read the last hidden-card change' })
    const lastHidden = session.received.find(text => text.endsWith('Read the last hidden-card change'))!
    expect(lastHidden.match(/is no longer listed/g)).toHaveLength(1)
    await until({
      what: 'the last hidden-card turn to finish',
      check: () => !queue({ titanId: titan.id })?.working,
    })
    page.close()

    expect(lastHidden).toContain('titan.log')
    const logPath = join(
      process.env.OTHRYS_HOME!,
      'titans',
      titan.id,
      'titan.log',
    )
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
      'othrys-digest-tail-',
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
    const digest = `<othrys-digest>${'é'.repeat(70_000)}</othrys-digest>`
    writeFileSync(
      path,
      [
        JSON.stringify({
          type: 'user',
          message: { content: '<othrys-digest>old</othrys-digest>' },
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
  'clearing task threads stops every task stream while Titan and another tab keep following',
  async () => {
    const titan = await othrys.titan()
    const first = await titan.startTask({ key: 'first-thread' })
    const second = await titan.startTask({ key: 'second-thread' })
    const ids = [
      (await titan.task({ key: 'first-thread' })).id,
      (await titan.task({ key: 'second-thread' })).id,
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
      port: othrys.port(),
      titanId: titan.id,
      receive: observe({ cards: received }),
    })
    const other = await openPage({
      port: othrys.port(),
      titanId: titan.id,
      receive: observe({ cards: watched }),
    })

    try {
      await page.send({
        name: 'thread',
        args: [TITAN_CARD],
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
        await titan.owner({
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
      const session = await titan.chat({ text: 'The Titan conversation stays subscribed' })
      await until({
        what: 'the cleared tab still receives Titan live replies',
        check: () => session.answered > 0 && received.has(TITAN_CARD),
      })
      expect([...received]).toEqual([TITAN_CARD])
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
      titan: 'h',
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
    const rows = titanMessages({
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
  'a failed Titan input remains retryable while its host is down and concurrent retries deliver once',
  async () => {
    const titan = await othrys.titan()
    const page = await titan.page()
    await page.send({
      name: 'titan-agent',
      args: [JSON.stringify({ harness: 'codex' })],
    })
    page.close()
    const text = 'retry this saved input'
    const id = randomUUID()
    const args = [
      'titan',
      'send',
      '--text',
      text,
      '--event-id',
      id,
    ]
    othrys.codex.plan({
      titan: titan.id,
      text,
      refuse: true,
    })
    await titan.owner({ args })

    const message = () => {
      const state = loadTitan({ titanId: titan.id }).state

      return state.titanMessages!.find(input => input.id === id)!
    }

    await until({
      what: 'the refusal to be saved',
      check: () => message().failure,
    })
    const failure = message().failure
    let stoppedMessage: ReturnType<typeof message> | undefined
    await othrys.restart({
      whileStopped: async () => {
        await titanSend({
          titanId: titan.id,
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
    const turn = othrys.codex.plan({
      titan: titan.id,
      text,
      hold: true,
    })
    onTestFinished(() => turn.release())
    await Promise.all([
      titan.owner({ args }),
      titan.owner({ args }),
    ])
    await until({
      what: 'the retry to be taken',
      check: () => message().received,
    })
    expect(message().attempt).toBe(1)
    const attempts = othrys.codex.sessions.flatMap(session => session.received)
      .filter(input => input.endsWith(text))
    expect(attempts).toHaveLength(2)
  },
)

test(
  'a refused recovery recap fails every owner message it carries',
  async () => {
    const titan = await othrys.titan()
    const page = await titan.page()
    await page.send({
      name: 'titan-agent',
      args: [JSON.stringify({ harness: 'codex' })],
    })
    page.close()
    const messages: string[] = []
    othrys.codex.plan({
      titan: titan.id,
      match: ({ text }) => text.includes('first held request') && text.includes('second held request'),
      refuse: true,
    })
    await othrys.restart({
      whileStopped: async () => {
        await withWriter({
          titanId: titan.id,
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
                actor: 'othrys',
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
          await titanSend({
            titanId: titan.id,
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
        const saved = loadTitan({ titanId: titan.id }).state.titanMessages!

        return messages.every(id => saved.find(message => message.id === id)?.failure?.includes('refused'))
      },
    })

    for (const text of [
      'first held request',
      'second held request',
    ]) {
      expect(await chatEntry({
        titan,
        text,
      })).toMatchObject({ receipt: 'failed' })
    }
  },
)

test(
  'recovery drains a retried compaction input and the input after it exactly once',
  async () => {
    const titan = await othrys.titan()
    const session = await titan.chat({ text: 'prepare compaction recovery' })
    await until({
      what: 'the preparation to finish',
      check: () => session.answered === 1,
    })
    const texts = [
      'retried compaction request',
      'next compaction request',
    ]
    await othrys.restart({
      whileStopped: async () => {
        for (const text of texts) {
          const id = randomUUID()
          await titanSend({
            titanId: titan.id,
            values: {
              text,
              'event-id': id,
            },
          })
          await withWriter({
            titanId: titan.id,
            fn: ({ writer }) => {
              const at = new Date().toISOString()

              if (text === texts[0]) {
                failTitanInput({
                  writer,
                  input: id,
                  error: 'The agent refused this input',
                  at,
                })
                applyDecision({
                  writer,
                  decision: titanEvent({
                    state: writer.state,
                    cardId: TITAN_CARD,
                    meta: {
                      actor: 'web',
                      at,
                    },
                    change: {
                      type: 'titan.input',
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
                card: TITAN_CARD,
                at,
                change: {
                  kind: 'held',
                  input: {
                    id,
                    text,
                    actor: 'web',
                    route: 'titan',
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
      check: () => compactionInputs({ titanId: titan.id })?.length === 0,
    })

    for (const text of texts) {
      await until({
        what: 'the drained input to be confirmed',
        check: async () => (await chatEntry({
          titan,
          text,
        }))?.receipt === 'delivered',
      })
      const delivered = othrys.claude.sessions.flatMap(session => session.received)
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
      titan: 'titan',
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
    const conversation = titanConversation({
      messages,
      transcript: [
        before,
        after,
        reply,
      ],
      held: new Set(['held']),
      actions: [],
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
