import { workerLine } from './setup/worker-log.ts'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withWriter } from '#app/writer.ts'
import { runForClient } from '#app/request-context.ts'
import { hydraCheck } from '#workers/workers.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { createDigestContext } from '#hydra/digest-context.ts'
import { startReviewTimer } from '#hydra/review-timer.ts'
import { beforeAll, expect, test } from 'vitest'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { ServerMessage } from '#app/server-transport.ts'
import { HYDRA_SKILLS, MANAGE_WORKERS_SKILL, ORCHESTRATE_SKILL } from '#setup/skill-names.ts'
import { parse } from 'yaml'
import { hydraMessages } from '#hydra/chat-messages.ts'
import { splitEntry } from '#hydra/transcripts-read.ts'
import { safeEnd } from '../web/src/shared/ui/reveal.ts'
import { openPage, pnyxAxi, rows, startPnyx, until, type Hydra, type Pnyx } from './setup/pnyx.ts'
import { appendToolCalls } from './setup/transcripts.ts'

const DOCS_MESSAGE = '3d6b8f20-5a4c-4e1b-9f72-6c8d0e1a2b34'
const CHANGELOG_MESSAGE = '4e7c9031-6b5d-4f2c-8a83-7d9e1f2b3c45'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx()
})

// What the page's queue box reads for this Hydra: updates waiting for it, and its chat.
const queueBox = ({ hydraId }: { hydraId: string }) => rows<{
  value: {
    waiting: {
      seq: number
      kind: string
    }[]
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
    expect(session.uuids.slice(1)).toEqual([
      DOCS_MESSAGE,
      CHANGELOG_MESSAGE,
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
  'worker reports and stored results coalesce progress, wait for one wake and survive an interrupted turn',
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
    const reportFile = join(
      folder,
      'findings.md',
    )
    writeFileSync(
      reportFile,
      'Stored findings: invoices have been verified.\n',
    )
    const storedReport = await hydra.as({ session: worker }).run({
      args: [
        'task',
        'report',
        'export',
        '--file',
        reportFile,
      ],
    })
    await until({
      what: 'the stored report to reach the queue',
      check: () => queueBox({ hydraId: hydra.id })?.waiting
        .some(update => update.seq === storedReport.event.seq),
    })
    const beforeNote = queueBox({ hydraId: hydra.id })?.waiting.length
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
    expect(waiting).toHaveLength((beforeNote ?? 0) + 1)
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
    const progressSeq = wake.match(/seq (\d+) \S+ \[unhandled\] \(2 progress reports, latest\): Invoices ready to upload/)?.[1]

    if (progressSeq === undefined) {
      throw new Error('The wake did not identify the collapsed progress report')
    }

    const progressPage = await hydra.as({ session }).run({
      args: [
        'hydra',
        'check',
        '--after',
        '0',
      ],
    })
    expect(progressPage.changes).not.toContainEqual(expect.objectContaining({
      summary: expect.stringContaining('Halfway through the invoices'),
    }))
    expect(progressPage.changes).toContainEqual(expect.objectContaining({
      seq: Number(progressSeq),
      reportStatus: 'unhandled',
      progressCount: 2,
      summary: 'Invoices ready to upload',
    }))
    expect(wake).not.toContain('Upload started')
    expect(wake).not.toContain('Quiet latest line')
    expect(wake).toContain('Need the SFTP password')
    const blockedSeq = wake.match(/seq (\d+) \S+ \[unhandled\]: blocked: Need the SFTP password/)?.[1]
    expect(blockedSeq).toBeDefined()
    const workerStatusPage = await hydra.as({ session }).run({
      args: [
        'hydra',
        'check',
        '--after',
        String(Number(blockedSeq) - 1),
      ],
    })
    expect(workerStatusPage.changes).toContainEqual(expect.objectContaining({
      type: 'task.worker-line',
      reportStatus: 'unhandled',
      summary: 'blocked: Need the SFTP password',
    }))
    expect(wake).toContain('result: Stored findings: invoices have been verified.')
    const storedResultSeq = wake.match(/seq (\d+) \S+ \[unhandled\]: result: Stored findings/)?.[1]

    if (storedResultSeq === undefined) {
      throw new Error('The wake did not identify the stored result')
    }

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
    const pending = await hydra.owner({
      args: [
        'hydra',
        'check',
        '--after',
        String(Number(storedResultSeq) - 1),
      ],
    })
    expect(pending.changes).toContainEqual(expect.objectContaining({
      type: 'task.report',
      reportStatus: 'unhandled',
      summary: 'result: Stored findings: invoices have been verified.',
    }))
    await hydra.chat({ text: 'Review the interrupted worker reports' })
    await until({
      what: 'the report to be delivered after interruption',
      check: () => session.received.length >= 3,
    })
    const retried = session.received.find(text => text.endsWith('Review the interrupted worker reports'))!
    expect(retried).toContain('Export works; ready for review')
    expect(retried).toContain('result: Stored findings: invoices have been verified.')
    const reportSeq = retried.match(/seq (\d+) \S+ \[unhandled\]: Export works; ready for review/)?.[1]
    expect(reportSeq).toBeDefined()
    await until({
      what: 'the retried report turn to finish',
      check: () => queue({ hydraId: hydra.id })?.working === false,
    })
    const checked = await hydra.owner({
      args: [
        'hydra',
        'check',
        '--after',
        String(Number(reportSeq) - 1),
      ],
    })
    const report = checked.changes.find(
      (change: { seq: number }) => change.seq === Number(reportSeq),
    )
    expect(report).toBeDefined()
    expect(report).not.toHaveProperty('reportStatus')

    writeFileSync(
      reportFile,
      'Standalone result after the previous turn finished.\n',
    )
    await hydra.as({ session: worker }).run({
      args: [
        'task',
        'report',
        'export',
        '--file',
        reportFile,
      ],
    })
    await until({
      what: 'a stored result to wake Hydra on its own',
      check: () => session.received.some(text => text.includes('result: Standalone result after the previous turn finished.')),
    })
  },
)

test(
  '300 queued worker reports stay bounded, preserve owner messages and support complete pagination',
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
      match: ({ text }) => text.includes('more worker reports'),
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
    let releaseRead = () => {}

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
          'hydra',
          'send',
          '--text',
          'Keep the owner message intact under the report cap',
        ],
      })
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
      withWriter({
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
      turn.release()
      await until({
        what: 'owner and bounded wake delivered',
        check: () => session.received.some(text => text.includes('more worker reports'))
          && queue({ hydraId: hydra.id })?.working === true,
      })
      expect(session.received.some(text => text.endsWith('Keep the owner message intact under the report cap'))).toBe(true)
      const wake = session.received.find(text => text.includes('more worker reports'))!
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

      const reviewBefore = wake.match(/history --kind hydra.review --before (\d+) --limit 1 --full/)?.[1]

      if (reviewBefore === undefined) {
        throw new Error('The wake did not provide the timed review history cursor')
      }

      expect(wake).not.toContain('End of timed review evidence')
      const fullReview = await hydra.owner({
        args: [
          'history',
          '--kind',
          'hydra.review',
          '--before',
          reviewBefore,
          '--limit',
          '1',
          '--full',
        ],
      })
      expect(fullReview.events.some((event: { data: { block: string } }) => event.data.block.includes('End of timed review evidence'))).toBe(true)
      const detailsAfter = wake.match(/Run `pnyx-axi hydra check --after (\d+)/)?.[1]

      if (detailsAfter === undefined) {
        throw new Error('The bounded wake did not provide its remaining updates cursor')
      }

      const remainingUpdates = await hydra.owner({
        args: [
          'hydra',
          'check',
          '--after',
          detailsAfter,
        ],
      })
      expect(remainingUpdates.through).toBeGreaterThan(Number(detailsAfter))
      expect(remainingUpdates.help).toContainEqual(expect.stringContaining('for the next page'))

      const after = wake.match(/more worker reports; read `pnyx-axi hydra check --after (\d+)/)?.[1]

      if (after === undefined) {
        throw new Error('The report wake did not give an overflow cursor')
      }

      const ownerPage = await hydra.owner({
        args: [
          'hydra',
          'check',
          '--after',
          after,
        ],
      })
      expect(ownerPage.changes[0]).toMatchObject({ reportStatus: 'unhandled' })

      await hydra.owner({
        args: [
          'task',
          'create',
          '--key',
          'attachment-probe',
          '--title',
          'Attachment probe',
          '--column',
          await hydra.column({ role: 'parked' }),
        ],
      })
      await hydra.owner({
        args: [
          'push',
          '--key',
          'attachment-probe',
          '--file',
          '-',
        ],
        input: JSON.stringify({
          title: 'Attachment probe',
          agent: {
            provider: 'claude',
            sessionId: 'attachment-probe',
            paseoAgentId: 'attachment-probe',
            paseoUrl: 'ws://127.0.0.1:1/ws',
          },
          activity: 'finished',
        }),
      })
      let checkingAttachments = false
      const interruptedRead = runForClient({
        identity: {
          PNYX_ACTOR: session.env.PNYX_ACTOR,
          PNYX_HOSTED: session.env.PNYX_HOSTED,
          PNYX_HYDRA: session.env.PNYX_HYDRA,
        },
        cwd: session.cwd,
        run: () => hydraCheck({
          args: [
            '--after',
            after,
            '--hydra',
            hydra.id,
          ],
          connect: () => new Promise((
            resolve,
            reject,
          ) => {
            checkingAttachments = true
            releaseRead = () => reject(new Error('The attachment probe ended'))
          }),
        }),
      })
      await until({
        what: 'the report read to wait for attachment presence',
        check: () => checkingAttachments,
      })
      await hydra.owner({
        args: [
          'task',
          'detach',
          'attachment-probe',
        ],
      })
      await hydra.owner({
        args: [
          'hydra',
          'stop',
        ],
      })
      await until({
        what: 'the turn with the pending read to stop',
        check: () => queue({ hydraId: hydra.id })?.working === false,
      })
      await hydra.chat({ text: 'Resume after the interrupted read' })
      await until({
        what: 'the replacement turn to be running before the discarded read returns',
        check: () => session.received.some(text => text.endsWith('Resume after the interrupted read'))
          && queue({ hydraId: hydra.id })?.working === true,
      })
      releaseRead()
      const discardedPage = await interruptedRead
      expect(discardedPage.changes).toContainEqual(expect.objectContaining({
        summary: expect.stringContaining('Report 7:'),
        reportStatus: 'unhandled',
      }))
      replacementTurn.release()
      await until({
        what: 'the replacement turn to finish without consuming discarded output',
        check: () => queue({ hydraId: hydra.id })?.working === false,
      })
      await hydra.chat({ text: 'Read the remaining reports' })
      const recovered = session.received.find(text => text.endsWith('Read the remaining reports'))!
      expect(recovered.split('Report 7:')).toHaveLength(2)

      let cursor = after
      const reports: {
        summary: string
        reportStatus?: string
      }[] = []

      for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
        const rest = await hydra.as({ session }).run({
          args: [
            'hydra',
            'check',
            '--after',
            cursor,
          ],
        })
        expect(rest.through).toBeGreaterThan(Number(cursor))
        const pending = rest.changes.filter((change: { actor: string }) => change.actor.startsWith('worker:burst-'))
        reports.push(...pending)
        cursor = String(rest.through)

        if (reports.some(report => report.summary.startsWith('Report 299:'))) {
          break
        }
      }

      expect(reports).toEqual(Array.from(
        { length: 293 },
        (
          _,
          index,
        ) => expect.objectContaining({
          reportStatus: 'unhandled',
          summary: expect.stringMatching(new RegExp(`^Report ${index + 7}:`)),
        }),
      ))
      overflowTurn.release()
      await until({
        what: 'the overflow-reading turn to finish',
        check: () => queue({ hydraId: hydra.id })?.working === false,
      })
      const digest = (await pnyxAxi({
        args: [
          'hydra',
          'digest',
          '--hydra',
          hydra.id,
        ],
        env: process.env,
      })).stdout
      expect(digest).not.toMatch(/\[unhandled\]: Report \d+:/)
      await hydra.chat({ text: 'Confirm the report burst is consumed' })
      const confirmed = session.received.find(text => text.endsWith('Confirm the report burst is consumed'))!
      expect(confirmed).not.toContain('Report 7:')
    } finally {
      releaseRead()
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
        check: () => rows<{ tasks: string[] }>({
          text: "select data->'data'->'tasks' as tasks from events where hydra_id = $1 and type = 'hydra.helper-started' order by seq desc limit 1",
          values: [hydra.id],
        })[0]?.tasks,
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

    const reportHelperTurn = pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('Granted tasks:') && text.includes('Invoice report handled in background'),
      hold: true,
      reply: JSON.stringify({
        outcomes: [
          {
            task: id,
            status: 'handled',
            summary: 'Invoice report is ready.',
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
        `Invoice report handled in background\n${'Supporting invoice detail. '.repeat(100)}End of invoice evidence`,
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
      check: () => rows<{ count: number }>({
        text: "select count(*)::int as count from events where hydra_id = $1 and type = 'hydra.helper-finished'",
        values: [hydra.id],
      })[0]!.count >= 2,
    })
    const digest = (await pnyxAxi({
      args: [
        'hydra',
        'digest',
        '--hydra',
        hydra.id,
      ],
      env: process.env,
    })).stdout
    expect(digest).toContain('Invoice report handled in background')
    expect(digest.split('\n').find(line => line.startsWith(`- ${id} ·`)))
      .toContain('helper: Invoice report is ready.')
    expect(digest).toMatch(/\[unhandled\] \(progress\): New invoice progress during the helper lease/)
    const reportSeq = digest.match(/seq (\d+) \S+ \[handled\]: Invoice report handled in background/)?.[1]
    expect(reportSeq).toBeDefined()
    const checked = await hydra.owner({
      args: [
        'hydra',
        'check',
        '--after',
        String(Number(reportSeq) - 1),
      ],
    })
    expect(checked.changes).toContainEqual(expect.objectContaining({
      seq: Number(reportSeq),
      task: id,
      reportStatus: 'handled',
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
      const earlierReport = await hydra.owner({
        args: [
          'hydra',
          'check',
          '--after',
          String(Number(reportSeq) - 1),
        ],
      })
      expect(earlierReport.changes).toContainEqual(expect.objectContaining({
        seq: Number(reportSeq),
        reportStatus: 'handled',
      }))
      await hydra.chat({ text: 'Summarize the invoice status' })
      await until({
        what: 'main to read the handled report',
        check: () => main.received.some(text => text.includes('Summarize the invoice status')),
      })
      const delivered = main.received.find(text => text.includes('Summarize the invoice status'))!
      expect(delivered.split('\n').find(line => line.startsWith(`- ${id} ·`)))
        .toContain('helper: Invoice report is ready.')
      expect(delivered).toContain('[handled]')
      expect(delivered.split('Invoice report handled in background')).toHaveLength(2)
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
    expect(recoveredReport).toMatch(/seq \d+ \S+ \[unhandled\]: Worker report awaiting restart/)
    expect(recoveredReport).toContain('hydra messages --after <seq minus one> --limit 1')
    expect(recoveredReport).toContain('Open decisions')
    const ownerReads = Array.from(recoveredReport.matchAll(/Read owner message (\d+) in full with `pnyx-axi hydra messages --after (\d+) --limit 1/g))
    const recoveredOwnerMessages = []

    for (const [
      , seq,
      after,
    ] of ownerReads) {
      if (after === undefined) {
        throw new Error('The recovery command did not provide an owner message cursor')
      }

      expect(Number(after) + 1).toBe(Number(seq))
      const { messages } = await hydra.owner({
        args: [
          'hydra',
          'messages',
          '--after',
          after,
          '--limit',
          '1',
        ],
      })
      recoveredOwnerMessages.push(messages[0]?.text)
    }

    expect(recoveredOwnerMessages).toEqual([
      'plan the migration',
      'also check the indexes',
      'and the backups',
    ])

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

    expect(links.length).toBeGreaterThan(0)

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

    await hydra.chat({ text: 'hello again' })

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
  'hydra check never points a Hydra that Pnyx runs at the wait it refuses',
  async () => {
    const hydra = await pnyx.hydra()
    const session = await hydra.chat({ text: 'hello' })
    const hosted = hydra.as({ session })
    const check = await hosted.run({
      args: [
        'hydra',
        'check',
        '--after',
        '0',
      ],
    })

    expect(check.help.join('\n')).not.toContain('--wait')

    const outside = await hydra.as({
      session,
      env: {
        ...session.env,
        PNYX_HOSTED: undefined,
      },
    }).run({
      args: [
        'hydra',
        'check',
        '--after',
        '0',
      ],
    })

    expect(outside.help.join('\n')).toContain('--wait')

    const waited = await hosted.refused({
      args: [
        'hydra',
        'check',
        '--wait',
        '5',
      ],
    })

    expect(waited.code).toBe('VALIDATION_ERROR')
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
  'a stopped message does not take the copy of the same words sent again later, so it shows at its own time and not above the newer rows of the page that holds that copy',
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

type Page = Awaited<ReturnType<Hydra['page']>>

// The agent change waiting for the owner's choice, as the page reads it.
const agentChange = ({ hydraId }: { hydraId: string }) => rows<{
  value: {
    id: string
    state: string
    next: { effort?: string }
  }
}>({
  text: 'select value from hydra_values where hydra_id = $1 and key = \'hydraAgentChange\'',
  values: [hydraId],
})[0]?.value

// The agent Hydra last ran with, as the page's Last used mark reads it.
const lastRan = ({ hydraId }: { hydraId: string }) => rows<{
  value: { effort?: string }
}>({
  text: 'select value from hydra_values where hydra_id = $1 and key = \'hydraAgent\'',
  values: [hydraId],
})[0]?.value

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

    const compaction = () => rows<{ value: { kind: string } }>({
      text: 'select value from hydra_values where hydra_id = $1 and key = \'hydraOperation\'',
      values: [hydra.id],
    })[0]?.value

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
      withWriter({
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
      withWriter({
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
      await timer.check()
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
      line: 'note: Review page is ready',
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
    expect(capped).toContain('pnyx-axi task list')
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
    const provider = harness === 'claude' ? pnyx.claude : pnyx.codex
    const held = provider.plan({
      hydra: hydra.id,
      text: 'Hold a task-aware turn',
      partial: 'Working',
      folds: true,
      hold: true,
    })
    await hydra.chat({ text: 'Hold a task-aware turn' })

    try {
      await workerLine({
        hydra,
        key: 'review-page',
        line: 'link: https://example.com/active-review Active review',
      })
      await hydra.chat({ text: 'Read the update during this turn' })
      const steering = session.received.find(text => text.endsWith('Read the update during this turn'))!
      expect(steering).toContain('https://example.com/active-review')

      if (harness === 'codex') {
        await workerLine({
          hydra,
          key: 'review-page',
          line: 'link: https://example.com/carried-review Carried review',
        })
        pnyx.codex.plan({
          hydra: hydra.id,
          text: 'Read the carried update',
          refuse: true,
        })
        await hydra.chat({ text: 'Read the carried update' })
        await until({
          what: 'Codex to receive the steering attempt',
          check: () => session.received.some(text => text.endsWith('Read the carried update')),
        })
        await workerLine({
          hydra,
          key: 'review-page',
          line: 'note: Review page was updated after steering',
        })
      }
    } finally {
      held.release()
    }

    await until({
      what: 'the held turn to finish',
      check: () => !queue({ hydraId: hydra.id })?.working,
    })

    if (harness === 'codex') {
      await until({
        what: 'the refused input to carry into a new turn',
        check: () => session.received.filter(text => text.endsWith('Read the carried update')).length === 2,
      })
      const carried = session.received.filter(text => text.endsWith('Read the carried update')).at(-1)
      expect(carried).toContain('https://example.com/carried-review')
      expect(carried?.indexOf('Review page was updated after steering')).toBeGreaterThan(
        carried?.indexOf('https://example.com/carried-review') ?? -1,
      )
      await until({
        what: 'the carried turn to finish',
        check: () => !queue({ hydraId: hydra.id })?.working,
      })
    }

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
